import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextStep } from '../types'
import { CONFIG_PATH, configOf, OPEN_STATES, summaryOf, withSetting, type ProjectConfig } from './config'
import { asksPerson, budgeted, digestOf, modeOf, MODES, pickOf, rankPromptOf, stepsOf, type Mode } from './rank'
import {
  DEFAULT_LINEAR_SERVERS,
  githubIssuesOf,
  githubPullsOf,
  LINEAR_FIELDS,
  linearIssuesOf,
  linearServersOf,
  type WorkItem,
} from './sources'

const COMMAND = 'next'
const ITEMS_TTL_MS = 5 * 60 * 1000
const SOURCE_TIMEOUT_MS = 20_000
const RANKER_TIMEOUT_MS = 30_000
const MAX_LINEAR_CALLS = 6

const steps = atom({ plugin: 'next-up', key: 'steps' } as const, [])
const isThinking = atom({ plugin: 'next-up', key: 'isThinking' } as const, false)

type SourceRead = { count: number; note: string }

type Settings = {
  mode: Mode
  githubItems: string
  linearServer: string
  linearProject: string
  ranker: string
  rankerModel: string
  perSource: number
}

const runtime: {
  settings: Settings
  cache: { items: WorkItem[]; at: number } | null
  linearServer: string | null
  reads: { github: SourceRead; linear: SourceRead } | null
  lastPrompt: string
  generation: number
  isWarned: boolean
  root: string | null
} = {
  settings: {
    mode: 'mixed',
    githubItems: 'issues-and-prs',
    linearServer: '',
    linearProject: '',
    ranker: 'light',
    rankerModel: 'haiku',
    perSource: 12,
  },
  cache: null,
  linearServer: null,
  reads: null,
  lastPrompt: '',
  generation: 0,
  isWarned: false,
  root: null,
}

/** Resolves `work`, or `fallback` once `ms` have passed without it. */
async function within<T>($: EngineInterface, work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: { cancel: () => void } | null = null
  const late = new Promise<T>(resolve => {
    timer = $.clock.after(ms, () => resolve(fallback))
  })

  try {
    return await Promise.race([work, late])
  } finally {
    timer?.cancel()
  }
}

/** The project's config file: `.claude/next-up.json` at the repository's top, else the session's folder. */
async function configPath($: EngineInterface): Promise<string> {
  if (runtime.root === null) {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => null)
    runtime.root = git !== null && git.exitCode === 0 && git.stdout.trim() !== '' ? git.stdout.trim() : await $.session.cwd()
  }

  return `${runtime.root}/${CONFIG_PATH}`
}

/** The project's criteria from `.claude/next-up.json`, the plugin settings filling the gaps. */
async function projectConfig($: EngineInterface): Promise<ProjectConfig> {
  const text = await $.fs.read(await configPath($)).catch(() => null)
  const config = configOf(typeof text === 'string' ? text : null)
  const { linearProject, githubItems } = runtime.settings

  return {
    ...config,
    linear: { ...(linearProject !== '' ? { projects: [linearProject] } : {}), ...config.linear },
    github: { items: githubItems, ...config.github },
  }
}

async function modeNow($: EngineInterface): Promise<Mode> {
  const config = await projectConfig($)

  return modeOf(config.mode ?? '') ?? runtime.settings.mode
}

async function readGithub($: EngineInterface, config: ProjectConfig): Promise<{ items: WorkItem[]; read: SourceRead }> {
  const github = config.github ?? {}
  const filters = [
    ...(github.labels ?? []).flatMap(label => ['--label', label]),
    ...(github.assignee ? ['--assignee', github.assignee] : []),
  ]
  const issues = await $.process.run([
    'gh', 'issue', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,url,labels', ...filters,
  ], { timeoutMs: SOURCE_TIMEOUT_MS })

  if (issues.exitCode !== 0) {
    return { items: [], read: { count: 0, note: `gh failed: ${issues.stderr.trim().split('\n')[0] ?? 'no output'}` } }
  }

  const pulls = github.items === 'issues'
    ? null
    : await $.process.run([
      'gh', 'pr', 'list', '--state', 'open', '--limit', '10', '--json', 'number,title,url,isDraft', ...filters,
    ], { timeoutMs: SOURCE_TIMEOUT_MS })
  const items = [
    ...(pulls !== null && pulls.exitCode === 0 ? githubPullsOf(pulls.stdout) : []),
    ...githubIssuesOf(issues.stdout),
  ]

  return { items, read: { count: items.length, note: 'gh' } }
}

/**
 * One `list_issues` call: through the server directly, or, when the engine
 * does not reach it that way, as the tool the model sees.
 */
async function listIssues($: EngineInterface, server: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await $.mcp.call(server, 'list_issues', args)
    const text = result.content.map(block => block.text ?? '').join('')

    if (result.isError) {
      throw new Error(text.slice(0, 160) || 'error')
    }

    return text
  } catch (error) {
    if (!(error instanceof Error) || !/no connected MCP tool/i.test(error.message)) {
      throw error
    }

    const ran = await $.tool.call({ tool: `mcp__${server}__list_issues`, ...args })

    if (ran.deny !== undefined || ran.isError) {
      throw new Error(ran.deny ?? ran.text ?? 'error')
    }

    return ran.text ?? ''
  }
}

/**
 * Reads open Linear issues through a connected Linear MCP server: the one
 * that answered last time, else the configured name, else the usual names
 * in turn. One call per project and label named in the criteria (at most
 * six), merged; the note says which server answered, or why none did.
 */
async function readLinear($: EngineInterface, config: ProjectConfig): Promise<{ items: WorkItem[]; read: SourceRead }> {
  const linear = config.linear ?? {}
  const discovered = runtime.linearServer === null && runtime.settings.linearServer === ''
    ? linearServersOf(await $.tool.list().catch(() => []))
    : []
  const servers = runtime.linearServer !== null
    ? [runtime.linearServer]
    : runtime.settings.linearServer !== ''
      ? [runtime.settings.linearServer]
      : [...new Set([...discovered, ...DEFAULT_LINEAR_SERVERS])]
  const assignee = linear.assignee ?? 'me'
  const base: Record<string, unknown> = {
    limit: 50,
    orderBy: 'updatedAt',
    fields: LINEAR_FIELDS,
    ...(assignee !== 'any' ? { assignee } : {}),
    ...(linear.team ? { team: linear.team } : {}),
    ...(linear.query ? { query: linear.query } : {}),
  }
  const projects = linear.projects?.length ? linear.projects : [null]
  const labels = linear.labels?.length ? linear.labels : [null]
  const calls = projects
    .flatMap(project => labels.map(label => ({ ...base, ...(project ? { project } : {}), ...(label ? { label } : {}) })))
    .slice(0, MAX_LINEAR_CALLS)
  const states = linear.states?.length ? linear.states : OPEN_STATES
  const failures: string[] = []

  for (const server of servers) {
    try {
      const texts: string[] = []

      for (const args of calls) {
        texts.push(await listIssues($, server, args))
      }

      const seen = new Set<string>()
      const items = texts
        .flatMap(text => linearIssuesOf(text, states))
        .filter(item => !seen.has(item.ref) && seen.add(item.ref) !== undefined)
      runtime.linearServer = server

      return { items, read: { count: items.length, note: server } }
    } catch (error) {
      failures.push(`${server}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
    }
  }

  return { items: [], read: { count: 0, note: failures.join('; ') || 'no server tried' } }
}

async function workItems($: EngineInterface, mode: Mode, isFresh: boolean): Promise<WorkItem[]> {
  const now = await $.clock.now()
  const cache = runtime.cache

  if (!isFresh && cache !== null && now - cache.at < ITEMS_TTL_MS) {
    return cache.items
  }

  const config = await projectConfig($)
  const off = { items: [], read: { count: 0, note: 'off in this mode' } }
  const late = { items: [], read: { count: 0, note: `no answer within ${SOURCE_TIMEOUT_MS / 1000}s` } }
  const failed = (error: unknown) => ({
    items: [],
    read: { count: 0, note: error instanceof Error ? error.message.slice(0, 160) : String(error) },
  })
  const [github, linear] = await Promise.all([
    mode === 'mixed' || mode === 'github'
      ? within($, readGithub($, config).catch(failed), SOURCE_TIMEOUT_MS, late)
      : off,
    mode === 'mixed' || mode === 'linear'
      ? within($, readLinear($, config).catch(failed), SOURCE_TIMEOUT_MS, late)
      : off,
  ])
  runtime.reads = { github: github.read, linear: linear.read }

  if (!runtime.isWarned && /permission/i.test(linear.read.note)) {
    runtime.isWarned = true
    $.ui.toast('Next up cannot read Linear: allow its list_issues tool in /permissions, e.g. mcp__claude_ai_Linear__list_issues', { timeoutMs: 10000 })
  }

  runtime.cache = { items: [...github.items, ...linear.items], at: now }

  return runtime.cache.items
}

/**
 * Picks the steps. The light ranker asks a small model about the last
 * exchange and the open items, so no transcript is read; the fork ranker
 * asks the session's own model over its cached transcript, and falls back
 * to the light one when that does not answer (for one, a full context).
 * Nothing waits longer than its time limit, so the band never stays on
 * "thinking".
 */
async function propose($: EngineInterface, answer: string, isFresh: boolean): Promise<NextStep[]> {
  const mine = ++runtime.generation
  await update($, isThinking, () => true)

  try {
    const mode = await modeNow($)
    const items = mode === 'conversation' ? [] : budgeted(await workItems($, mode, isFresh), runtime.settings.perSource)
    const lightPrompt = rankPromptOf(items, mode, digestOf(runtime.lastPrompt, answer))
    const late = { isAnswered: false as const, reason: 'aborted' as const }
    const light = () => within(
      $,
      $.model.complete({ model: runtime.settings.rankerModel, prompt: lightPrompt, maxTokens: 700 }),
      RANKER_TIMEOUT_MS,
      late,
    )
    let result = runtime.settings.ranker === 'fork'
      ? await within($, $.model.fork({ prompt: rankPromptOf(items, mode, null) }), RANKER_TIMEOUT_MS, late)
      : await light()

    if (!result.isAnswered && runtime.settings.ranker === 'fork') {
      result = await light()
    }

    const found = result.isAnswered ? stepsOf(result.text, mode) : []

    if (mine === runtime.generation) {
      await update($, steps, () => found)
    }

    return found
  } finally {
    if (mine === runtime.generation) {
      await update($, isThinking, () => false)
    }
  }
}

async function clear($: EngineInterface): Promise<void> {
  runtime.generation += 1
  await update($, steps, () => [])
  await update($, isThinking, () => false)
}

async function saveSetting($: EngineInterface, section: string, key: string, value: string): Promise<string> {
  const path = await configPath($)
  const text = await $.fs.read(path).catch(() => null)
  const config = configOf(typeof text === 'string' ? text : null)
  const changed = section === 'mode' ? { ...config, mode: key } : withSetting(config, section, key, value)

  if (typeof changed === 'string') {
    return changed
  }

  await $.fs.write(path, `${JSON.stringify(changed, null, 2)}\n`)
  runtime.cache = null

  return `Saved to ${CONFIG_PATH}. ${summaryOf(await projectConfig($), await modeNow($))}.`
}

const HELP = '/next refresh · /next sources · /next config · /next mode <mixed|linear|github|conversation> · '
  + '/next linear <project|team|label|states|assignee|query> <value|off> · /next github <items|label|assignee> <value|off>'

async function commandText($: EngineInterface, args: string): Promise<string> {
  const [verb = '', key = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')

  if (verb === 'mode') {
    return modeOf(key) === null
      ? `Next up mode: ${await modeNow($)}. Modes: ${MODES.join(', ')}.`
      : saveSetting($, 'mode', key, '')
  }

  if (verb === 'linear' || verb === 'github') {
    return key === '' ? HELP : saveSetting($, verb, key, value)
  }

  if (verb === 'config') {
    return `${CONFIG_PATH}: ${summaryOf(await projectConfig($), await modeNow($))}.`
  }

  if (verb === 'sources') {
    await workItems($, await modeNow($), true)
    const reads = runtime.reads

    return reads === null
      ? 'No sources read yet.'
      : `GitHub: ${reads.github.count} open (${reads.github.note}). Linear: ${reads.linear.count} open (${reads.linear.note}).`
  }

  if (verb === 'refresh') {
    const found = await propose($, '', true)

    return `Next up: ${found.length} step${found.length === 1 ? '' : 's'} above the prompt.`
  }

  const shown = await read($, steps)

  return shown.length === 0 ? `Next up: no steps yet. ${HELP}` : `Next up: ${shown.length} step${shown.length === 1 ? '' : 's'} above the prompt.`
}

/**
 * Next up. When a main turn ends with an answer (not a question to the
 * person), up to three next prompts appear above the prompt: continuations
 * of the current work, open GitHub issues and pull requests (gh CLI) or
 * Linear issues (the connected Linear MCP server), as the mode says, under
 * the project's criteria in `.claude/next-up.json`. Type 1, 2 or 3 and
 * Enter to send one, or click it to edit it first. Nothing enters the
 * conversation's context except what `/next` prints, one short line.
 */
export const register: Register = (on, options) => {
  const perSource = Number(options.perSource ?? 12)
  runtime.settings = {
    mode: modeOf(String(options.mode ?? 'mixed')) ?? 'mixed',
    githubItems: String(options.githubItems ?? 'issues-and-prs'),
    linearServer: String(options.linearServer ?? ''),
    linearProject: String(options.linearProject ?? ''),
    ranker: String(options.ranker ?? 'light'),
    rankerModel: String(options.rankerModel ?? 'haiku'),
    perSource: Number.isFinite(perSource) && perSource > 0 ? Math.min(Math.floor(perSource), 50) : 12,
  }

  on('session.start', async ($, e, next) => {
    await update($, isThinking, () => false)
    await $.command.register({
      name: COMMAND,
      description: 'Next up: refresh, sources, config, mode, linear <setting> <value>, github <setting> <value>',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    return { text: await commandText($, e.args) }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.reason === 'answer' && !e.isAborted && !asksPerson(e.answer)) {
      const answer = e.answer
      $.clock.after(0, () => {
        void propose($, answer, false).catch(() => clear($))
      })
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') {
      return next(e)
    }

    const current = await read($, steps)
    const pick = pickOf(e.text, current.length)
    await clear($)
    const text = pick === null ? e.text : current[pick]!.prompt
    runtime.lastPrompt = text

    return text === e.text ? next(e) : next({ ...e, text })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) {
      return next(e)
    }

    const shown = await read($, steps)
    const thinking = await read($, isThinking)

    if (shown.length === 0 && !thinking) {
      return next(e)
    }

    const beneath = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 16)
    const mode = await modeNow($)

    if (shown.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{`Next up (${mode}): thinking…`}</Text>
          {beneath}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{`Next up (${mode}) · type a number and Enter to send it, or click one to edit it first`}</Text>
        {shown.map((step, index) => (
          <Box key={`row-${index}`}>
            <Button
              key={`step-${index}`}
              plain
              hotkey={String(index + 1)}
              label={step.label.length > width ? `${step.label.slice(0, width - 1)}…` : step.label}
              onPress={async () => {
                await $.prompt.fill({ text: step.prompt, mode: 'replace' })
                await clear($)
              }}
            />
            <Text dimColor>{`  ${step.ref ?? step.source}${step.why !== null ? ` · ${step.why}` : ''}`}</Text>
          </Box>
        ))}
        <Button key="dismiss" plain hotkey="0" label="dismiss" onPress={() => clear($)} />
        {beneath}
      </Box>
    )
  })
}
