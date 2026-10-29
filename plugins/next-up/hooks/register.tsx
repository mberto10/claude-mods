import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NextStep } from '../types'
import { budgeted, DEFAULT_MODE, digestOf, modeOf, MODES, pickOf, rankPromptOf, shouldRank, stepsOf, type Mode } from './rank'
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
const MODEL_TIMEOUT_MS = 30_000
const MODEL = 'haiku'
const PER_SOURCE = 12
/** The kind tag column: the longest kind, "continue", and two spaces. */
const TAG_COLUMNS = 10

const steps = atom({ plugin: 'next-up', key: 'steps' } as const, [])
const isThinking = atom({ plugin: 'next-up', key: 'isThinking' } as const, false)

type SourceRead = { count: number; note: string }

/** How a band that showed steps ended. */
type Outcome = 'used' | 'dismissed' | 'ignored'
type Counts = Record<Outcome, number>

/** The key in the plugin's own store that keeps the counts of all sessions. */
const COUNTS_KEY = 'outcomes'
const NO_COUNTS: Counts = { used: 0, dismissed: 0, ignored: 0 }

type Settings = {
  mode: Mode
  linearProject: string
}

const runtime: {
  settings: Settings
  mode: Mode
  cache: { items: WorkItem[]; at: number } | null
  linearServer: string | null
  reads: { github: SourceRead; linear: SourceRead } | null
  lastPrompt: string
  drawn: NextStep[]
  isDismissed: boolean
  generation: number
  isWarned: boolean
  /** The band whose outcome is open: its steps, and whether one was clicked into the box. */
  band: { key: string; isClicked: boolean } | null
  counts: Counts
  /** The tools the main loop called in the current turn, by name. */
  turnTools: string[]
} = {
  settings: { mode: DEFAULT_MODE, linearProject: '' },
  mode: DEFAULT_MODE,
  cache: null,
  linearServer: null,
  reads: null,
  lastPrompt: '',
  drawn: [],
  isDismissed: false,
  generation: 0,
  isWarned: false,
  band: null,
  counts: { ...NO_COUNTS },
  turnTools: [],
}

function countsOf(value: unknown): Counts {
  const kept = typeof value === 'object' && value !== null ? value as Partial<Record<Outcome, unknown>> : {}
  const count = (outcome: Outcome) => {
    const n = kept[outcome]

    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  }

  return { used: count('used'), dismissed: count('dismissed'), ignored: count('ignored') }
}

/**
 * Ends the open band with its one outcome: the only place outcomes are
 * recorded. Counts this session's in memory and all sessions' in the
 * plugin's own store; with no band open it does nothing, so no band is
 * counted twice. A store that fails leaves the session's count standing.
 */
async function settle($: EngineInterface, outcome: Outcome): Promise<void> {
  if (runtime.band === null) {
    return
  }

  runtime.band = null
  runtime.counts = { ...runtime.counts, [outcome]: runtime.counts[outcome] + 1 }

  try {
    const kept = countsOf(await $.store.get(COUNTS_KEY))
    await $.store.set(COUNTS_KEY, { ...kept, [outcome]: kept[outcome] + 1 })
  } catch {
    // The session's count stands.
  }
}

/**
 * The band drew `shown`. Steps other than the open band's start a new band,
 * and the one they replace, unused, counts as ignored.
 */
async function opened($: EngineInterface, shown: NextStep[]): Promise<void> {
  const key = JSON.stringify(shown.map(step => step.prompt))

  if (runtime.band !== null && runtime.band.key === key && !runtime.band.isClicked) {
    return
  }

  await settle($, 'ignored')
  runtime.band = { key, isClicked: false }
}

const tallyOf = (counts: Counts) => `${counts.used} used · ${counts.dismissed} dismissed · ${counts.ignored} ignored`

async function countsLine($: EngineInterface): Promise<string> {
  const all = countsOf(await $.store.get(COUNTS_KEY).catch(() => undefined))

  return `Steps this session: ${tallyOf(runtime.counts)}. All sessions: ${tallyOf(all)}.`
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

/** Open issues and pull requests through the gh CLI, pull requests first. */
async function readGithub($: EngineInterface): Promise<{ items: WorkItem[]; read: SourceRead }> {
  const issues = await $.process.run([
    'gh', 'issue', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,url,labels',
  ], { timeoutMs: SOURCE_TIMEOUT_MS })

  if (issues.exitCode !== 0) {
    return { items: [], read: { count: 0, note: `gh failed: ${issues.stderr.trim().split('\n')[0] ?? 'no output'}` } }
  }

  const pulls = await $.process.run([
    'gh', 'pr', 'list', '--state', 'open', '--limit', '10', '--json', 'number,title,url,isDraft',
  ], { timeoutMs: SOURCE_TIMEOUT_MS })
  const items = [
    ...(pulls.exitCode === 0 ? githubPullsOf(pulls.stdout) : []),
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
 * Reads your open Linear issues, in the Linear project setting when one is
 * set, through a connected Linear MCP server: the one that answered last
 * time, else the servers whose `list_issues` tool is Linear's, else the
 * usual names in turn. The note says which server answered, or why none did.
 */
async function readLinear($: EngineInterface): Promise<{ items: WorkItem[]; read: SourceRead }> {
  const servers = runtime.linearServer !== null
    ? [runtime.linearServer]
    : [...new Set([...linearServersOf(await $.tool.list().catch(() => [])), ...DEFAULT_LINEAR_SERVERS])]
  const { linearProject } = runtime.settings
  const args: Record<string, unknown> = {
    limit: 50,
    orderBy: 'updatedAt',
    fields: LINEAR_FIELDS,
    assignee: 'me',
    ...(linearProject !== '' ? { project: linearProject } : {}),
  }
  const failures: string[] = []

  for (const server of servers) {
    try {
      const items = linearIssuesOf(await listIssues($, server, args))
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

  const off ={ items: [], read: { count: 0, note: 'off in this mode' } }
  const late = { items: [], read: { count: 0, note: `no answer within ${SOURCE_TIMEOUT_MS / 1000}s` } }
  const failed = (error: unknown) => ({
    items: [],
    read: { count: 0, note: error instanceof Error ? error.message.slice(0, 160) : String(error) },
  })
  const [github, linear] = await Promise.all([
    mode === 'github'
      ? within($, readGithub($).catch(failed), SOURCE_TIMEOUT_MS, late)
      : off,
    mode === 'linear'
      ? within($, readLinear($).catch(failed), SOURCE_TIMEOUT_MS, late)
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
 * Picks the steps: Haiku reads the last exchange and the open items, never
 * the transcript. Nothing waits longer than its time limit, so the band
 * never stays on "thinking".
 */
async function propose($: EngineInterface, answer: string, isFresh: boolean): Promise<NextStep[]> {
  const mine = ++runtime.generation
  await update($, isThinking, () => true)

  try {
    const mode = runtime.mode
    const items = mode === 'conversation' ? [] : budgeted(await workItems($, mode, isFresh), PER_SOURCE)
    const prompt = rankPromptOf(items, mode, digestOf(runtime.lastPrompt, answer))
    const result = await within(
      $,
      $.model.complete({ model: MODEL, prompt, maxTokens: 700 }),
      MODEL_TIMEOUT_MS,
      { isAnswered: false as const, reason: 'aborted' as const },
    )
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

/** The session's rate-limit windows; none when the engine cannot say. */
async function rateLimitsOf($: EngineInterface): Promise<{ percentUsed: number }[]> {
  try {
    return (await $.session.usage()).rateLimits
  } catch {
    return []
  }
}

async function clear($: EngineInterface): Promise<void> {
  runtime.generation += 1
  runtime.drawn = []
  await update($, steps, () => [])
  await update($, isThinking, () => false)
}

/**
 * The band's dismiss Button: clicked, or pressed by its `0` hotkey. When
 * the hotkey also leaves the `0` in the prompt box, a box holding only
 * `0` is emptied, and a lone `0` sent right after is dropped. Anything
 * else typed stays. A `0` that arrives as text without pressing the
 * Button is handled in `prompt.submit`.
 */
async function dismiss($: EngineInterface): Promise<void> {
  await settle($, 'dismissed')
  await clear($)
  runtime.isDismissed = true
  const box = await $.prompt.read()

  if (box.text.trim() === '0') {
    await $.prompt.fill({ text: '', mode: 'replace' })
  }
}

const HELP = `/next refresh · /next sources · /next mode <${MODES.join('|')}>`

/**
 * `/next mode <name>` switches the mode for this session, in memory; the
 * Mode setting is where each session starts. A name that is no mode
 * changes nothing and is answered with the current mode and the valid ones.
 */
function switchMode(name: string): string {
  const mode = modeOf(name)

  if (mode === null) {
    return `Next up mode: ${runtime.mode}. Modes: ${MODES.join(', ')}.`
  }

  runtime.mode = mode
  runtime.cache = null

  return `Next up mode: ${mode}, for this session.`
}

async function commandText($: EngineInterface, args: string): Promise<string> {
  const [verb = '', name = ''] = args.trim().split(/\s+/)

  if (verb === 'mode') {
    return switchMode(name)
  }

  if (verb === 'sources') {
    await workItems($, runtime.mode, true)
    const reads = runtime.reads
    const read = reads === null
      ? 'No sources read yet.'
      : `GitHub: ${reads.github.count} open (${reads.github.note}). Linear: ${reads.linear.count} open (${reads.linear.note}).`

    return `${read}\n${await countsLine($)}`
  }

  if (verb === 'refresh') {
    const found = await propose($, '', true)

    return `Next up: ${found.length} step${found.length === 1 ? '' : 's'} above the prompt.`
  }

  const shown = await read($, steps)

  return shown.length === 0 ? `Next up: no steps yet. ${HELP}` : `Next up: ${shown.length} step${shown.length === 1 ? '' : 's'} above the prompt.`
}

/**
 * Next up. When a main turn that changed something (edited a file, ran a
 * command) ends with an answer (not a question to the person), up to three next prompts appear above the prompt: continuations
 * of the current work, open GitHub issues and pull requests (gh CLI) or
 * Linear issues (the connected Linear MCP server), as the mode says. Type
 * 1, 2 or 3 and Enter to send one, or click it to edit it first. Nothing
 * enters the conversation's context except what `/next` prints, one short
 * line.
 */
export const register: Register = (on, options) => {
  runtime.settings = {
    mode: modeOf(String(options.mode ?? DEFAULT_MODE)) ?? DEFAULT_MODE,
    linearProject: String(options.linearProject ?? ''),
  }
  runtime.mode = runtime.settings.mode

  on('session.start', async ($, e, next) => {
    runtime.mode = runtime.settings.mode
    runtime.cache = null
    runtime.band = null
    runtime.counts = { ...NO_COUNTS }
    await update($, isThinking, () => false)
    await $.command.register({
      name: COMMAND,
      description: `Next up: refresh, sources, mode <${MODES.join('|')}>`,
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    return { text: await commandText($, e.args) }
  })

  /**
   * Records the tools the main loop calls in the current turn, so
   * `shouldRank` can tell a turn that changed something from one that only
   * read or answered. A subagent's calls (`agentId` set) and refused calls
   * do not count.
   */
  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && result.deny === undefined) {
      runtime.turnTools.push(e.tool)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    runtime.turnTools = []

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    const tools = runtime.turnTools
    runtime.turnTools = []

    if (shouldRank({ ...e, rateLimits: await rateLimitsOf($), tools })) {
      const answer = e.answer
      $.clock.after(0, () => {
        void propose($, answer, false).catch(() => clear($))
      })
    }

    return result
  })

  /**
   * A slash command passes through and keeps the steps. Any other typed
   * prompt clears them; a bare number picks that row of the set the band
   * last drew, which is what the person sees, not the stored steps.
   *
   * A lone `0` dismisses by either route and is never sent: typed as text
   * while the band shows steps (the desktop delivers it so), it clears
   * them; right after the dismiss Button ran, it is that Button's digit.
   * A `0` with no band drawn passes through.
   *
   * Outcomes: a picked number, or any prompt sent after a step was clicked
   * into the box, uses the band; a `0` dismisses it; any other prompt
   * ignores it. A slash command counts as nothing.
   */
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin' || e.command !== undefined) {
      return next(e)
    }

    const isDismissed = runtime.isDismissed
    runtime.isDismissed = false

    const drawn = runtime.drawn

    if (e.text.trim() === '0' && (isDismissed || drawn.length > 0)) {
      await settle($, 'dismissed')
      await clear($)

      return { drop: 'Next up: steps dismissed' }
    }

    const pick = pickOf(e.text, drawn.length)
    await settle($, pick !== null || runtime.band?.isClicked === true ? 'used' : 'ignored')
    await clear($)
    const text = pick === null ? e.text : drawn[pick]!.prompt
    runtime.lastPrompt = text

    return text === e.text ? next(e) : next({ ...e, text })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) {
      runtime.drawn = []

      return next(e)
    }

    const shown = await read($, steps)
    const thinking = await read($, isThinking)
    runtime.drawn = shown

    if (shown.length > 0) {
      await opened($, shown)
    }

    if (shown.length === 0 && !thinking) {
      return next(e)
    }

    const beneath = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 16)
    const mode = runtime.mode

    if (shown.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{`Next up (${mode}): thinking…`}</Text>
          {beneath}
        </Box>
      )
    }

    runtime.isDismissed = false

    // The kind tags form a muted column ahead of the rows when any step has
    // one; a row without a kind keeps the column blank. A tagged row drops
    // the source word after its label, since the tag already says "continue".
    const isTagged = shown.some(step => step.kind !== null)
    const labelWidth = isTagged ? Math.max(20, width - TAG_COLUMNS) : width

    return (
      <Box flexDirection="column">
        <Text dimColor>{`Next up (${mode}) · type a number and Enter to send it, or click one to edit it first`}</Text>
        {shown.map((step, index) => {
          const trail = [step.ref ?? (step.kind === null ? step.source : null), step.why].filter(part => part !== null).join(' · ')

          return (
            <Box key={`row-${index}`}>
              {isTagged ? <Text dimColor>{(step.kind ?? '').padEnd(TAG_COLUMNS)}</Text> : null}
              <Button
                key={`step-${index}`}
                plain
                hotkey={String(index + 1)}
                label={step.label.length > labelWidth ? `${step.label.slice(0, labelWidth - 1)}…` : step.label}
                onPress={async () => {
                  if (runtime.band !== null) {
                    runtime.band.isClicked = true
                  }

                  await $.prompt.fill({ text: step.prompt, mode: 'replace' })
                  await clear($)
                }}
              />
              {trail !== '' ? <Text dimColor>{`  ${trail}`}</Text> : null}
            </Box>
          )
        })}
        <Button key="dismiss" plain hotkey="0" label="dismiss" onPress={() => dismiss($)} />
        {beneath}
      </Box>
    )
  })
}
