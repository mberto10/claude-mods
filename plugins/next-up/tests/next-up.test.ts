import type { On, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { asksPerson, budgeted, pickOf, rankPromptOf, stepsOf } from '../hooks/rank'
import { githubIssuesOf, linearIssuesOf, linearServersOf, type WorkItem } from '../hooks/sources'

tier('user')

const SESSION: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }

const GH_ISSUES = JSON.stringify([
  { number: 12, title: 'Fix CRLF anchors', url: 'https://github.com/acme/app/issues/12', labels: [{ name: 'bug' }] },
])
const GH_PULLS = JSON.stringify([
  { number: 5, title: 'Add release notes', url: 'https://github.com/acme/app/pull/5', isDraft: false },
])
const LINEAR = JSON.stringify({
  issues: [
    { id: 'ENG-42', title: 'Review onboarding copy', status: 'In Progress', statusType: 'started', priority: { value: 2, name: 'High' }, project: 'Website', url: 'https://linear.app/acme/issue/ENG-42' },
    { id: 'ENG-7', title: 'Old thing', status: 'Done', statusType: 'completed', priority: { value: 0, name: 'No priority' }, project: 'Website', url: 'https://linear.app/acme/issue/ENG-7' },
  ],
})
const ANSWER = JSON.stringify([
  { label: 'Add tests for the anchor fix', prompt: 'Add tests for the CRLF anchor fix from #12.', source: 'github', ref: '#12' },
  { label: 'Review the onboarding copy', prompt: 'Review the onboarding copy for ENG-42.', source: 'linear', ref: 'ENG-42' },
  { label: 'Tidy the diff', prompt: 'Tidy up the diff you just made.', source: 'continue', ref: null },
])
const CONFIG = '/work/.claude/next-up.json'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = {
  plugin: 'next-up',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function world(on: On, linear: 'answers' | 'refuses' | 'hangs' = 'answers', initialFiles: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initialFiles }
  const linearArgs: Record<string, unknown>[] = []
  const prompts: string[] = []
  const fills: string[] = []
  const completes: { model: string; prompt: string }[] = []
  const forks: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const store: Record<string, unknown> = {}
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 2, 12) })

  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') {
      return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    }

    commands.push(e.argv.slice(0, 3).join(' '))

    return { value: { exitCode: 0, stdout: e.argv[1] === 'issue' ? GH_ISSUES : GH_PULLS, stderr: '' } }
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: `ENOENT: ${e.path}` } : { value: files[e.path] }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('mcp.call', ($, e) => {
    if (e.server === 'claude.ai Linear') {
      linearArgs.push(e.args)
    }

    if (linear === 'hangs' && e.server === 'claude.ai Linear') {
      return new Promise(() => {})
    }

    if (e.server !== 'claude.ai Linear') {
      return { deny: `no connected MCP tool "list_issues" on a server named "${e.server}"` }
    }

    return linear === 'refuses'
      ? { deny: 'Claude requested permissions to use mcp__claude_ai_Linear__list_issues' }
      : { value: { content: [{ type: 'text', text: LINEAR }], isError: false } }
  })
  on('model.complete', ($, e) => {
    completes.push({ model: e.model, prompt: e.prompt })

    return { value: { isAnswered: true, text: ANSWER, usage: USAGE } }
  })
  on('model.fork', ($, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request_error', usage: USAGE } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    fills.push(e.text)

    return { isFilled: true }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['(engine band)'] }))

  return { prompts, fills, completes, forks, commands, toasts, clock, files, linearArgs }
}

const answered = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const })

describe('parsing', () => {
  test('closed Linear issues are left out; open ones rank by state, then priority', async () => {
    expect(linearIssuesOf(LINEAR).map(item => item.ref)).toEqual(['ENG-42'])
    const mixed = JSON.stringify({ issues: [
      { id: 'A', title: 'backlog urgent', statusType: 'backlog', priority: { value: 1, name: 'Urgent' } },
      { id: 'B', title: 'started none', statusType: 'started', priority: { value: 0, name: 'No priority' } },
      { id: 'C', title: 'started high', statusType: 'started', priority: { value: 2, name: 'High' } },
      { id: 'D', title: 'unstarted low', statusType: 'unstarted', priority: { value: 4, name: 'Low' } },
    ] })
    expect(linearIssuesOf(mixed).map(item => item.ref)).toEqual(['C', 'B', 'D', 'A'])
    expect(linearIssuesOf(mixed, ['started']).map(item => item.ref)).toEqual(['C', 'B'])
    expect(githubIssuesOf(GH_ISSUES)[0]?.detail).toBe('issue, bug')
  })

  test('steps keep only the sources a mode allows', async () => {
    expect(stepsOf(`Here:\n${ANSWER}`).map(step => step.source)).toEqual(['github', 'linear', 'continue'])
    expect(stepsOf(ANSWER, 'linear').map(step => step.ref)).toEqual(['ENG-42'])
    expect(stepsOf(ANSWER, 'conversation').map(step => step.source)).toEqual(['continue'])
    expect(stepsOf('no json')).toEqual([])
  })

  test('the budget keeps a few short items per source', async () => {
    const many: WorkItem[] = Array.from({ length: 30 }, (_, index) => ({
      source: index % 2 === 0 ? 'github' : 'linear',
      ref: `R-${index}`,
      title: 'x'.repeat(300),
      detail: '',
      url: '',
    }))
    const kept = budgeted(many, 5)

    expect(kept.filter(item => item.source === 'github')).toHaveLength(5)
    expect(kept.filter(item => item.source === 'linear')).toHaveLength(5)
    expect(kept[0]!.title.length).toBeLessThanOrEqual(90)
  })

  test('a Linear-only prompt lists only Linear items', async () => {
    const items = [...githubIssuesOf(GH_ISSUES), ...linearIssuesOf(LINEAR)]
    const prompt = rankPromptOf(items, 'linear', null)

    expect(prompt).toContain('linear ENG-42')
    expect(prompt).not.toContain('github #12')
  })

  test('the Linear server is found by its tool, whatever the connector is called', async () => {
    expect(linearServersOf([
      { name: 'Read', description: 'Reads a file' },
      { name: 'mcp__9cae8a51-0385__list_issues', description: "List issues in the user's Linear workspace" },
      { name: 'mcp__github__list_issues', description: 'List issues in a GitHub repository' },
      { name: 'mcp__claude_ai_Linear__list_issues', description: 'List issues' },
    ])).toEqual(['9cae8a51-0385', 'claude_ai_Linear'])
  })

  test('picks and questions', async () => {
    expect(pickOf('2', 3)).toBe(1)
    expect(pickOf('4', 3)).toBeNull()
    expect(pickOf('2 more tests', 3)).toBeNull()
    expect(asksPerson('Should I build it?')).toBe(true)
    expect(asksPerson('Done.')).toBe(false)
  })
})

describe('next up', () => {
  test('mixed: the light ranker reads the last exchange and both sources, never the transcript', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'Fix the anchors.' })
    await $.turn.complete(answered('Done: the anchors handle CRLF now.'))
    await w.clock.settle()

    expect(w.forks).toEqual([])
    expect(w.completes[0]?.model).toBe('haiku')
    expect(w.completes[0]?.prompt).toContain('The person asked: Fix the anchors.')
    expect(w.completes[0]?.prompt).toContain('github #12: Fix CRLF anchors [issue, bug]')
    expect(w.completes[0]?.prompt).toContain('linear ENG-42: Review onboarding copy [In Progress, High, Website]')

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Next up (mixed)')
    expect(drawn).toContain('Add tests for the anchor fix')

    await $.prompt.submit({ text: '2' })

    expect(w.prompts.at(-1)).toBe('Review the onboarding copy for ENG-42.')
  })

  test('/next mode linear: GitHub is not read and only Linear steps show', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    const changed = await $.command.run({ command: 'next', args: 'mode linear', origin: { kind: 'composer' } })

    expect(changed.text).toContain('Saved to .claude/next-up.json')
    expect(JSON.parse(w.files[CONFIG]!).mode).toBe('linear')

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.commands).toEqual([])

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Next up (linear)')
    expect(drawn).toContain('ENG-42')
    expect(drawn).not.toContain('#12')
  })

  test('the fork ranker falls back to the light one when it does not answer', { options: { ranker: 'fork' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.forks).toHaveLength(1)
    expect(w.completes).toHaveLength(1)
  })

  test('a refused Linear call is reported once, with the tool to allow', async ($, on) => {
    const w = world(on, 'refuses')
    await $.session.start(SESSION)

    const sources = await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(sources.text).toContain('GitHub: 2 open (gh)')
    expect(sources.text).toContain('Linear: 0 open')
    expect(sources.text).toContain('permissions')
    expect(w.toasts[0]).toContain('mcp__claude_ai_Linear__list_issues')

    await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(w.toasts).toHaveLength(1)
  })

  test('pressing a step fills the prompt box instead of sending', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    await (await $.ui.mount(BAND)).press({ key: 'step-0' })

    expect(w.fills).toEqual(['Add tests for the CRLF anchor fix from #12.'])
  })

  test('a turn that ends with a question proposes nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Should I also add Linear?'))
    await w.clock.settle()

    expect(w.completes).toEqual([])

    await $.prompt.submit({ text: '1' })

    expect(w.prompts).toEqual(['1'])
  })

  test('/next linear project and states go into the project file and into the Linear call', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'next', args: 'linear project Website, Docs', origin: { kind: 'composer' } })
    const saved = await $.command.run({ command: 'next', args: 'linear states started,unstarted', origin: { kind: 'composer' } })

    expect(saved.text).toContain('projects Website, Docs')
    expect(saved.text).toContain('states started, unstarted')
    expect(JSON.parse(w.files[CONFIG]!)).toEqual({ linear: { projects: ['Website', 'Docs'], states: ['started', 'unstarted'] } })

    await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(w.linearArgs.map(args => args.project)).toEqual(['Website', 'Docs'])
    expect(w.linearArgs[0]?.assignee).toBe('me')

    const cleared = await $.command.run({ command: 'next', args: 'linear project off', origin: { kind: 'composer' } })

    expect(cleared.text).toContain('Linear: all projects')
  })

  test('an unknown setting is explained, not saved', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    const answer = await $.command.run({ command: 'next', args: 'linear colour blue', origin: { kind: 'composer' } })

    expect(answer.text).toContain('Unknown linear setting "colour"')
    expect(w.files[CONFIG]).toBeUndefined()
  })

  test('a desktop connector named by an id is found and read as the tool the model sees', async ($, on) => {
    const w = world(on)
    on('tool.list', () => ({ value: [{ name: 'mcp__9cae8a51__list_issues', description: "List issues in the user's Linear workspace", mcp: true }] }))
    on('tool.call', { tool: 'mcp__9cae8a51__list_issues' }, () => ({ result: LINEAR, text: LINEAR }))
    await $.session.start(SESSION)
    const sources = await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(sources.text).toContain('Linear: 1 open (9cae8a51)')
    expect(w.linearArgs).toEqual([])
  })

  test('a Linear call that never answers is given up after its time limit', async ($, on) => {
    const w = world(on, 'hangs')
    await $.session.start(SESSION)
    const sources = $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })
    await w.clock.advance(20_000)

    expect((await sources).text).toContain('Linear: 0 open (no answer within 20s)')
  })
})
