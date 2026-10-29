import type { On, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { asksPerson, budgeted, digestOf, MODES, modeOf, pickOf, rankPromptOf, stepsOf } from '../hooks/rank'
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
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = {
  plugin: 'next-up',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function world(on: On, linear: 'answers' | 'refuses' | 'hangs' = 'answers') {
  const writes: string[] = []
  const linearArgs: Record<string, unknown>[] = []
  const prompts: string[] = []
  const fills: string[] = []
  const completes: { model: string; prompt: string }[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const replies: string[] = []
  const box = { text: '' }
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
    commands.push(e.argv.slice(0, 3).join(' '))

    return { value: { exitCode: 0, stdout: e.argv[1] === 'issue' ? GH_ISSUES : GH_PULLS, stderr: '' } }
  })
  on('fs.write', ($, e) => {
    writes.push(e.path)

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

    return { value: { isAnswered: true, text: replies.shift() ?? ANSWER, usage: USAGE } }
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
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    box.text = e.text

    return { isFilled: true }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['(engine band)'] }))

  return { prompts, fills, completes, commands, toasts, clock, writes, linearArgs, replies, box }
}

const continuations = (...labels: string[]) => JSON.stringify(labels.map(label => ({ label, prompt: `${label}, please.`, source: 'continue', ref: null })))

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

  test('there are three modes, and mixed is not one of them', async () => {
    expect([...MODES]).toEqual(['linear', 'github', 'conversation'])
    expect(modeOf(' GitHub ')).toBe('github')
    expect(modeOf('mixed')).toBeNull()
  })

  test('steps keep only the source of their mode', async () => {
    expect(stepsOf(`Here:\n${ANSWER}`, 'linear').map(step => step.ref)).toEqual(['ENG-42'])
    expect(stepsOf(ANSWER, 'github').map(step => step.ref)).toEqual(['#12'])
    expect(stepsOf(ANSWER, 'conversation').map(step => step.source)).toEqual(['continue'])
    expect(stepsOf(ANSWER).map(step => step.source)).toEqual(['continue'])
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
    const prompt = rankPromptOf(items, 'linear', digestOf('Fix it.', 'Done.'))

    expect(prompt).toContain('linear ENG-42')
    expect(prompt).not.toContain('github #12')
  })

  test('the prompt allows no steps, never pads to three, and keeps continuations apart', async () => {
    const digest = digestOf('Fix it.', 'Done.')

    for (const mode of MODES) {
      const prompt = rankPromptOf([], mode, digest)

      expect(prompt).toContain('When no step clearly fits the current work, answer []')
      expect(prompt).toContain('Never pad to three; fewer steps are fine')
    }

    expect(rankPromptOf([], 'conversation', digest)).toContain('Make the steps clearly different from one another')
    expect(rankPromptOf([], 'linear', digest)).not.toContain('clearly different')
    expect(stepsOf('[]', 'conversation')).toEqual([])
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
  test('conversation by default: no source is read and only continuations show', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'Fix the anchors.' })
    await $.turn.complete(answered('Done: the anchors handle CRLF now.'))
    await w.clock.settle()

    expect(w.commands).toEqual([])
    expect(w.linearArgs).toEqual([])
    expect(w.completes[0]?.model).toBe('haiku')
    expect(w.completes[0]?.prompt).toContain('The person asked: Fix the anchors.')
    expect(w.completes[0]?.prompt).not.toContain('Open work items')

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Next up (conversation)')
    expect(drawn).toContain('Tidy the diff')
    expect(drawn).not.toContain('#12')
    expect(drawn).not.toContain('ENG-42')

    await $.prompt.submit({ text: '1' })

    expect(w.prompts.at(-1)).toBe('Tidy up the diff you just made.')
  })

  test('github: Linear is not read and only GitHub steps show', { options: { mode: 'github' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.linearArgs).toEqual([])
    expect(w.commands).toEqual(['gh issue list', 'gh pr list'])
    expect(w.completes[0]?.prompt).toContain('github #12: Fix CRLF anchors [issue, bug]')
    expect(w.completes[0]?.prompt).toContain('github #5: Add release notes')

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Next up (github)')
    expect(drawn).toContain('Add tests for the anchor fix')
    expect(drawn).not.toContain('ENG-42')
    expect(drawn).not.toContain('Tidy the diff')
  })

  test('a configured mixed mode falls back to conversation', { options: { mode: 'mixed' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.commands).toEqual([])
    expect(w.linearArgs).toEqual([])
    expect(JSON.stringify(await (await $.ui.mount(BAND)).drawn())).toContain('Next up (conversation)')
  })

  test('/next mode mixed changes nothing and names the current mode and the valid ones', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    const refused = await $.command.run({ command: 'next', args: 'mode mixed', origin: { kind: 'composer' } })

    expect(refused.text).toBe('Next up mode: conversation. Modes: linear, github, conversation.')
    expect(w.writes).toEqual([])

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.commands).toEqual([])
    expect(w.linearArgs).toEqual([])
    expect(JSON.stringify(await (await $.ui.mount(BAND)).drawn())).toContain('Next up (conversation)')
  })

  test('/next mode linear switches the session without writing a file: only Linear steps show', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    const changed = await $.command.run({ command: 'next', args: 'mode linear', origin: { kind: 'composer' } })

    expect(changed.text).toBe('Next up mode: linear, for this session.')
    expect(w.writes).toEqual([])

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    expect(w.commands).toEqual([])

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Next up (linear)')
    expect(drawn).toContain('ENG-42')
    expect(drawn).not.toContain('#12')

    const shown = await $.command.run({ command: 'next', args: 'mode', origin: { kind: 'composer' } })

    expect(shown.text).toBe('Next up mode: linear. Modes: linear, github, conversation.')
    expect(w.writes).toEqual([])
  })

  test('the light ranker answers in all three modes, with haiku', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    for (const mode of MODES) {
      await $.command.run({ command: 'next', args: `mode ${mode}`, origin: { kind: 'composer' } })
      await $.turn.complete(answered('Done.'))
      await w.clock.settle()

      expect(JSON.stringify(await (await $.ui.mount(BAND)).drawn())).toContain(`Next up (${mode}) · type a number`)
    }

    expect(w.completes.map(one => one.model)).toEqual(['haiku', 'haiku', 'haiku'])
    expect(w.completes[0]?.prompt).toContain('linear ENG-42')
    expect(w.completes[1]?.prompt).toContain('github #12')
    expect(w.completes[2]?.prompt).not.toContain('Open work items')
  })

  test('a refused Linear call is reported once, with the tool to allow', { options: { mode: 'linear' } }, async ($, on) => {
    const w = world(on, 'refuses')
    await $.session.start(SESSION)

    const sources = await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(sources.text).toContain('GitHub: 0 open (off in this mode)')
    expect(sources.text).toContain('Linear: 0 open')
    expect(sources.text).toContain('permissions')
    expect(w.toasts[0]).toContain('mcp__claude_ai_Linear__list_issues')

    await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(w.toasts).toHaveLength(1)
  })

  test('pressing a step fills the prompt box instead of sending', { options: { mode: 'github' } }, async ($, on) => {
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

  test('the Linear project setting goes into the one Linear call', { options: { mode: 'linear', linearProject: 'Website' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    const sources = await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(sources.text).toContain('Linear: 1 open (claude.ai Linear)')
    expect(w.linearArgs).toHaveLength(1)
    expect(w.linearArgs[0]?.project).toBe('Website')
    expect(w.linearArgs[0]?.assignee).toBe('me')
  })

  test('/next linear, /next github and /next config are gone from the command and its help', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    for (const args of ['linear project Website', 'github items issues', 'config']) {
      const answer = await $.command.run({ command: 'next', args, origin: { kind: 'composer' } })

      expect(answer.text).toBe('Next up: no steps yet. /next refresh · /next sources · /next mode <linear|github|conversation>')
    }

    expect(w.writes).toEqual([])
  })

  test('a desktop connector named by an id is found and read as the tool the model sees', { options: { mode: 'linear' } }, async ($, on) => {
    const w = world(on)
    on('tool.list', () => ({ value: [{ name: 'mcp__9cae8a51__list_issues', description: "List issues in the user's Linear workspace", mcp: true }] }))
    on('tool.call', { tool: 'mcp__9cae8a51__list_issues' }, () => ({ result: LINEAR, text: LINEAR }))
    await $.session.start(SESSION)
    const sources = await $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })

    expect(sources.text).toContain('Linear: 1 open (9cae8a51)')
    expect(w.linearArgs).toEqual([])
  })

  test('a Linear call that never answers is given up after its time limit', { options: { mode: 'linear' } }, async ($, on) => {
    const w = world(on, 'hangs')
    await $.session.start(SESSION)
    const sources = $.command.run({ command: 'next', args: 'sources', origin: { kind: 'composer' } })
    await w.clock.advance(20_000)

    expect((await sources).text).toContain('Linear: 0 open (no answer within 20s)')
  })

  test('/next after steps appear reports them and keeps the band', async ($, on) => {
    const w = world(on)
    w.replies.push(continuations('Tidy the diff', 'Run the tests'))
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    await $.prompt.submit({ text: '/next', command: { name: 'next', args: '' } })
    const answer = await $.command.run({ command: 'next', args: '', origin: { kind: 'composer' } })

    expect(answer.text).toBe('Next up: 2 steps above the prompt.')

    const drawn = JSON.stringify(await (await $.ui.mount(BAND)).drawn())

    expect(drawn).toContain('Tidy the diff')
    expect(drawn).toContain('Run the tests')
  })

  test('a number picks the row the band drew, even after the stored steps changed', async ($, on) => {
    const w = world(on)
    w.replies.push(continuations('A one', 'A two'), continuations('B one', 'B two'))
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    const band = await $.ui.mount(BAND)

    expect(JSON.stringify(await band.drawn())).toContain('A two')

    await band.unmount()
    await $.command.run({ command: 'next', args: 'refresh', origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '2' })

    expect(w.prompts.at(-1)).toBe('A two, please.')
  })

  test('a typed prompt clears the steps, a hidden band picks nothing, and 0 dismisses', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    const band = await $.ui.mount(BAND)
    await $.prompt.submit({ text: 'Something else.' })

    expect(JSON.stringify(await band.drawn())).not.toContain('Tidy the diff')

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()
    await band.redraw({ ...BAND.props, isWorking: true })
    await $.prompt.submit({ text: '1' })

    expect(w.prompts.at(-1)).toBe('1')

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()
    await band.redraw(BAND.props)
    await band.press({ key: 'dismiss' })

    expect(JSON.stringify(await band.drawn())).not.toContain('Tidy the diff')
  })

  test('0 after dismiss is not sent', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    await (await $.ui.mount(BAND)).press({ key: 'dismiss' })
    const sent = await $.prompt.submit({ text: '0' })

    expect(sent.drop).toBe('Next up: steps dismissed')
    expect(w.prompts).toEqual([])
  })

  test('dismiss leaves a typed draft alone', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    w.box.text = 'hello'
    await (await $.ui.mount(BAND)).press({ key: 'dismiss' })

    expect(w.fills).toEqual([])
    expect(w.box.text).toBe('hello')
  })

  test('dismiss clears a lone 0 from the box', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    w.box.text = '0'
    await (await $.ui.mount(BAND)).press({ key: 'dismiss' })

    expect(w.fills).toEqual([''])
  })

  test('a 0 with no band shown passes through, as does one after the next prompt', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.prompt.submit({ text: '0' })

    expect(w.prompts).toEqual(['0'])

    await $.turn.complete(answered('Done.'))
    await w.clock.settle()
    await (await $.ui.mount(BAND)).press({ key: 'dismiss' })
    await $.prompt.submit({ text: 'hello' })
    await $.prompt.submit({ text: '0' })

    expect(w.prompts).toEqual(['0', 'hello', '0'])
  })

  test('0 typed while steps show dismisses them and is not sent', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.complete(answered('Done.'))
    await w.clock.settle()

    const band = await $.ui.mount(BAND)
    const sent = await $.prompt.submit({ text: ' 0 ' })

    expect(sent.drop).toBe('Next up: steps dismissed')
    expect(w.prompts).toEqual([])
    expect(JSON.stringify(await band.drawn())).not.toContain('Tidy the diff')
  })
})
