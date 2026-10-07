import type { On, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { flowSvg } from '../hooks/flow'
import { plainLines, wrapped } from '../hooks/text'
import { barOf, idsIn, issuePageOf, milestonesOf, progressOf, rowsOf, treeOf } from '../hooks/tree'

tier('user')

const SESSION: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }
const SERVER = 'abc123'

const issue = (id: string, statusType: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  status: statusType === 'completed' ? 'Done' : statusType === 'started' ? 'In Progress' : 'Todo',
  statusType,
  priority: { value: 0, name: 'No priority' },
  url: `https://linear.app/acme/issue/${id}`,
  ...extra,
})

const OCT = { id: 'm-oct', name: 'October' }
const PAGE_ONE = JSON.stringify({
  issues: [
    issue('ENG-1', 'started', { projectMilestone: OCT, priority: { value: 2, name: 'High' } }),
    issue('ENG-2', 'completed', { parentId: 'ENG-1' }),
    issue('ENG-3', 'unstarted', { parentId: 'ENG-1', description: '## Goal\n\nMake the **anchors** survive [CRLF](https://example.com) files.\n\n- keep offsets\n- add a test' }),
  ],
  hasNextPage: true,
  cursor: 'next',
})
const PAGE_TWO = JSON.stringify({
  issues: [
    issue('ENG-4', 'backlog', { projectMilestone: OCT, priority: { value: 1, name: 'Urgent' }, assignee: 'Ada', updatedAt: '2026-10-02T10:00:00Z' }),
    issue('ENG-5', 'unstarted', { description: Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long description.`).join('\n') }),
    issue('ENG-6', 'canceled', { parentId: 'ENG-3' }),
  ],
  hasNextPage: false,
})
const MILESTONES = JSON.stringify({
  milestones: [
    { id: 'm-nov', name: 'November', sortOrder: 20, targetDate: '2026-11-30' },
    { id: 'm-oct', name: 'October', sortOrder: -5, targetDate: '2026-10-31' },
  ],
})

const PANE = (surface: 'terminal' | 'desktop') => ({
  plugin: 'linear-tree',
  surface,
  component: 'Pane',
  requestId: 'linear-tree',
  props: { title: 'Linear', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const)

const BAND = { plugin: 'linear-tree', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

const DETAILS = (surface: 'terminal' | 'desktop' = 'desktop') => ({ ...PANE(surface), requestId: 'linear-details' })

function world(on: On, mode: 'answers' | 'refuses' = 'answers', box: 'takes' | 'dialog' = 'takes') {
  const fills: string[] = []
  const toasts: string[] = []
  const copies: string[] = []
  const opened: string[] = []
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const store: Record<string, unknown> = {}
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 2, 12) })

  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('tool.list', () => ({ value: [{ name: `mcp__${SERVER}__list_issues`, description: "List issues in the user's Linear workspace", mcp: true }] }))
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args })

    if (mode === 'refuses') {
      return { deny: `Claude requested permissions to use mcp__${SERVER}__list_issues` }
    }

    const body = e.tool === 'list_milestones' ? MILESTONES : e.args.cursor === 'next' ? PAGE_TWO : PAGE_ONE

    return { value: { content: [{ type: 'text', text: body }], isError: false } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: 'Linear', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.close', ($, e) => {
    const at = opened.indexOf(e.id)

    if (at !== -1) {
      opened.splice(at, 1)
    }

    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    if (box === 'dialog') {
      return { isFilled: false, refusal: 'dialog' }
    }

    fills.push(e.text)

    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.render', { component: 'Pane' }, () => ({ type: 'Text', children: ['(engine pane)'] }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['(engine band)'] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  return { fills, opened, calls, clock, toasts, copies, store }
}

describe('tree', () => {
  const page1 = issuePageOf(PAGE_ONE)
  const page2 = issuePageOf(PAGE_TWO)
  const tree = treeOf('Website', milestonesOf(MILESTONES), [...page1.issues, ...page2.issues], 0)

  test('pages and milestones parse', async () => {
    expect(page1.cursor).toBe('next')
    expect(page2.cursor).toBeNull()
    expect(milestonesOf(MILESTONES).map(one => one.name)).toEqual(['October', 'November'])
    expect(() => issuePageOf(PAGE_ONE.slice(0, 80))).toThrow('not a list of issues')
  })

  test('sub-issues nest under parents, top-level issues under milestones in working order', async () => {
    expect(tree.milestones.map(one => [one.name, one.roots])).toEqual([
      ['October', ['ENG-1', 'ENG-4']],
      ['November', []],
      ['No milestone', ['ENG-5']],
    ])
    expect(tree.issues['ENG-1']?.children).toEqual(['ENG-3', 'ENG-2'])
    expect(tree.issues['ENG-3']?.children).toEqual(['ENG-6'])
  })

  test('without the milestone list, milestones take their names from the issues', async () => {
    const bare = treeOf('Website', [], [...page1.issues, ...page2.issues], 0)

    expect(bare.milestones.map(one => one.name)).toEqual(['October', 'No milestone'])
  })

  test('sorting changes sibling order, not the nesting', async () => {
    const roots = (sort: string) => rowsOf(tree, [], { sort }).filter(row => row.kind === 'issue' && row.prefix.length === 3).map(row => row.id)

    expect(roots('work')).toEqual(['ENG-1', 'ENG-4', 'ENG-5'])
    expect(roots('priority')).toEqual(['ENG-4', 'ENG-1', 'ENG-5'])
    expect(roots('updated')).toEqual(['ENG-4', 'ENG-1', 'ENG-5'])
  })

  test('search keeps the path to a match and opens it even when folded', async () => {
    const found = rowsOf(tree, ['ENG-1', 'm:m-oct'], { query: 'eng-6' }).map(row => row.id)

    expect(found).toEqual(['m-oct', 'ENG-1', 'ENG-3', 'ENG-6'])
    expect(rowsOf(tree, [], { query: 'ada' }).map(row => row.id)).toEqual(['m-oct', 'ENG-4'])
    expect(rowsOf(tree, [], { stateFilter: 'started' }).map(row => row.id)).toEqual(['m-oct', 'ENG-1'])
    expect(rowsOf(tree, [], { query: 'nothing here' })).toEqual([])
  })

  test('activity marks the issue and counts it on folded ancestors', async () => {
    const who = { agentId: 'agent-1', agent: 'researcher' }
    const rows = rowsOf(tree, ['ENG-1'], { activity: { 'ENG-6': who } })
    const parent = rows.find(row => row.id === 'ENG-1')

    expect(parent?.kind === 'issue' && parent.activeBelow).toBe(1)
    expect(idsIn('Work on ENG-3 and ENG-6, not eng-7')).toEqual(['ENG-3', 'ENG-6'])
  })

  test('folding still works while a state filter is on', async () => {
    expect(rowsOf(tree, ['ENG-1'], { stateFilter: 'open' }).map(row => row.id)).not.toContain('ENG-3')
    expect(rowsOf(tree, [], { stateFilter: 'open' }).map(row => row.id)).toContain('ENG-3')
  })

  test('the flowchart draws a card per visible node, joined by curves, with agents outlined', async () => {
    const odd = treeOf('Website', milestonesOf(MILESTONES), issuePageOf(JSON.stringify({ issues: [issue('ENG-9', 'started', { title: 'A <b> & "c"', projectMilestone: OCT })] })).issues, 0)
    const flow = flowSvg(odd, rowsOf(odd, [], { activity: { 'ENG-9': { agentId: 'a', agent: 'researcher' } } }), 800, 0, 1)

    expect(flow.nodes).toBe(3)
    expect(flow.cut).toBe(0)
    expect(flow.source).toContain('A &lt;b&gt; &amp; &quot;c&quot;')
    expect(flow.source).toContain('● researcher')
    expect(flow.source).toContain('<animate attributeName="stroke-opacity"')
    expect(flow.source.match(/class="e"/g)?.length).toBe(1)

    const full = flowSvg(tree, rowsOf(tree, []), 800, 1, 5)

    expect(full.source.match(/class="e"/g)?.length).toBe(6)
    expect(full.source).toContain('October')
  })

  test('a tree kept from an older version, without descriptions or dates, still draws', async () => {
    const old = treeOf('Website', [], issuePageOf(PAGE_ONE).issues.map(one => ({ ...one, description: undefined as unknown as string, updatedAt: undefined as unknown as string })), 0)

    expect(plainLines(old.issues['ENG-1']!.description)).toEqual([])
    expect(rowsOf(old, [], { sort: 'updated' }).length).toBeGreaterThan(0)
  })

  test('description markdown reads as plain wrapped lines', async () => {
    expect(plainLines('## Goal\n\nMake **it** [work](https://x.y).\n- one\n* two')).toEqual(['Goal', '', 'Make it work.', '• one', '• two'])
    expect(wrapped(['one two three four'], 9)).toEqual(['one two', 'three', 'four'])
  })

  test('progress counts everything under a node, canceled left out', async () => {
    expect(progressOf(tree, ['ENG-1'])).toEqual({ done: 1, total: 3 })
    expect(barOf(1, 4, 8)).toBe('▓▓░░░░░░')
  })

  test('rows draw tree guides; folding and hiding done remove rows', async () => {
    const rows = rowsOf(tree, [], false)
    const issueRows = rows.flatMap(row => (row.kind === 'issue' ? [`${row.prefix}${row.id}`] : [`# ${row.name}`]))

    expect(issueRows).toEqual([
      '# October',
      '├─ ENG-1',
      '│  ├─ ENG-3',
      '│  │  └─ ENG-6',
      '│  └─ ENG-2',
      '└─ ENG-4',
      '# November',
      '# No milestone',
      '└─ ENG-5',
    ])
    expect(rowsOf(tree, ['ENG-1'], false).map(row => row.id)).not.toContain('ENG-3')
    expect(rowsOf(tree, [], true).map(row => row.id)).not.toContain('ENG-2')
    expect(rowsOf(tree, ['m:m-oct'], false).map(row => row.id)).toEqual(['m-oct', 'm-nov', 'none', 'ENG-5'])
  })
})

describe('pane', () => {
  test('/tree opens the pane, reads every page, and draws the tree on both surfaces', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    const answer = await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()

    expect(answer.text).toBe('Linear tree for Website in the side pane.')
    expect(w.opened).toEqual(['linear-tree'])
    expect(w.calls.map(call => call.tool)).toEqual(['list_issues', 'list_issues', 'list_milestones'])
    expect(w.calls[0]?.args.project).toBe('Website')

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount(PANE(surface))
      const drawn = JSON.stringify(await pane.drawn())

      expect(drawn).toContain('October')
      expect(drawn).toContain('"label":"Title ENG-1"')
      expect(drawn).toContain(surface === 'terminal' ? '├─ ' : '"alt":"In Progress"')
      expect(drawn).toContain(surface === 'terminal' ? '"  1/2"' : '"1/2  "')
      expect(drawn).not.toContain('0/0"')
      await pane.unmount()
    }
  })

  test('/tree with no name reuses the last project', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const again = await $.command.run({ command: 'tree', args: '', origin: { kind: 'composer' } })

    expect(again.text).toBe('Linear tree for Website in the side pane.')
  })

  test('a refused Linear call says which permission is missing', async ($, on) => {
    const w = world(on, 'refuses')
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()

    const drawn = JSON.stringify(await (await $.ui.mount(PANE('desktop'))).drawn())

    expect(drawn).toContain('Linear refused: allow its list_issues tool in /permissions')
  })

  test('a subagent spawned on an issue is marked until its turn ends, and so is the session prompt', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()

    await $.agent.spawn({ subagentType: 'researcher', description: 'Research ENG-3', prompt: 'Look into ENG-3 and report.' })
    const pane = await $.ui.mount(PANE('desktop'))
    let drawn = JSON.stringify(await pane.drawn())

    expect(drawn).toContain('researcher is working on it')
    expect(drawn).toContain('"alt":"agents at work"')

    await $.turn.complete({ agentId: 'agent-1', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    drawn = JSON.stringify(await pane.drawn())

    expect(drawn).not.toContain('researcher is working on it')

    await $.prompt.submit({ text: 'Work on ENG-5: Title ENG-5' })
    drawn = JSON.stringify(await pane.drawn())

    expect(drawn).toContain('Claude is working on it')

    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
    drawn = JSON.stringify(await pane.drawn())

    expect(drawn).not.toContain('Claude is working on it')
  })

  test('the list stays minimal: one filter and a search; the rest are /tree subcommands', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const desktop = await $.ui.mount(PANE('desktop'))
    let drawn = JSON.stringify(await desktop.drawn())

    expect(drawn.match(/"type":"Select"/g)?.length).toBe(1)
    expect(drawn.match(/"type":"Input"/g)?.length).toBe(1)
    expect(drawn).not.toContain('"label":"Title ENG-2"')

    await desktop.select({ key: 'states', value: 'all' })

    expect(JSON.stringify(await desktop.drawn())).toContain('"label":"Title ENG-2"')

    await desktop.input({ key: 'search', text: 'ENG-4' })
    drawn = JSON.stringify(await desktop.drawn())

    expect(drawn).toContain('"label":"Title ENG-4"')
    expect(drawn).not.toContain('"label":"Title ENG-5"')
    await desktop.unmount()

    const run = async (args: string) => (await $.command.run({ command: 'tree', args, origin: { kind: 'composer' } })).text

    expect(await run('sort priority')).toBe('Sorted by priority.')
    expect(await run('sort size')).toBe('Sort by: work, priority, updated, id.')
    expect(await run('milestone October')).toBe('Showing October.')
    expect(await run('milestone Someday')).toContain('No milestone "Someday"')
    expect(await run('collapse')).toBe('Collapsed.')
    expect(await run('expand')).toBe('Expanded.')

    const terminal = await $.ui.mount(PANE('terminal'))
    await terminal.press({ key: 'states' })

    expect(JSON.stringify(await terminal.drawn())).toContain('"label":"Open"')
  })

  test('Work on it in the details; when the prompt box refuses, the prompt goes to the clipboard', async ($, on) => {
    const w = world(on, 'answers', 'dialog')
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))
    await pane.press({ key: 'i:ENG-3' })
    const details = await $.ui.mount(DETAILS())
    await details.press({ key: 'info:work' })

    expect(w.copies).toEqual(['Work on ENG-3: Title ENG-3 (https://linear.app/acme/issue/ENG-3)'])
    expect(JSON.stringify(await pane.drawn())).toContain('The prompt box did not take it; copied to the clipboard instead.')
  })



  test('a click selects; d opens the details pane; a double click works on it; nothing is drawn above the prompt', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))
    const band = await $.ui.mount(BAND)

    await pane.press({ key: 'i:ENG-3' })

    expect(w.opened).not.toContain('linear-details')
    expect(JSON.stringify(await band.drawn())).toBe('{"type":"Text","children":["(engine band)"]}')

    await pane.press({ key: 'key:j' })
    await pane.press({ key: 'key:d' })

    expect(w.opened).toContain('linear-details')
    expect(JSON.stringify(await (await $.ui.mount(DETAILS())).drawn())).toContain('"children":["ENG-4"]')

    await w.clock.advance(1000)
    await pane.press({ key: 'i:ENG-3' })
    await pane.press({ key: 'i:ENG-3' })

    expect(w.fills).toEqual(['Work on ENG-3: Title ENG-3 (https://linear.app/acme/issue/ENG-3)'])
  })

  test('one pane: v switches between list and flowchart, /flow opens the flowchart there, zoom steps work', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))

    expect(JSON.stringify(await pane.drawn())).toContain('"label":"Title ENG-1"')

    await pane.press({ key: 'key:v' })

    expect(JSON.stringify(await pane.drawn())).toContain('Flowchart of Website')

    await pane.press({ key: 'key:v' })
    await $.command.run({ command: 'tree', args: 'collapse', origin: { kind: 'composer' } })
    const opened = await $.command.run({ command: 'flow', args: 'No milestone', origin: { kind: 'composer' } })
    let drawn = JSON.stringify(await pane.drawn())

    expect(opened.text).toContain('Flowchart of Website')
    expect(w.opened.filter(id => id === 'linear-tree')).toHaveLength(2)
    expect(drawn).toContain('ENG-5')
    expect(drawn).not.toContain('ENG-1')

    await pane.press({ key: 'key:3' })
    drawn = JSON.stringify(await pane.drawn())

    expect(drawn).toContain('Line 1 of a long description.')

    await pane.press({ key: 'key:j' })

    expect(JSON.stringify(await pane.drawn())).toContain('stroke-width=\\"2.2\\"')

    await pane.press({ key: 'key:1' })

    expect(JSON.stringify(await pane.drawn())).toContain('"children":[" overview "]')

    const terminal = JSON.stringify(await (await $.ui.mount(PANE('terminal'))).drawn())

    expect(terminal).toContain('Website · No milestone')
    expect(terminal).not.toContain('Flowchart of')

    await pane.press({ key: 'level:out' })
    drawn = JSON.stringify(await pane.drawn())

    expect(drawn).toContain('"children":[" list "]')
    expect(drawn).not.toContain('Flowchart of')

    await pane.press({ key: 'level:in' })

    expect(JSON.stringify(await pane.drawn())).toContain('"children":[" overview "]')

    const all = await $.command.run({ command: 'flow', args: '', origin: { kind: 'composer' } })

    expect(all.text).toContain('every milestone')
    expect(JSON.stringify(await pane.drawn())).toContain('ENG-1')
  })

  test('/flow picks its milestone even when the tree loads after it, and a reload of the mod does not bring back the saved one', async ($, on) => {
    const w = world(on)
    w.store['state:Website'] = { view: 'list', zoom: 2, stateFilter: 'all', sort: 'work', collapsed: [], focus: 'none', selected: null }
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))

    expect(JSON.stringify(await pane.drawn())).not.toContain('Title ENG-1')

    await $.command.run({ command: 'flow', args: 'all', origin: { kind: 'composer' } })
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'refresh', origin: { kind: 'composer' } })
    await w.clock.settle()

    expect(JSON.stringify(await pane.drawn())).toContain('ENG-1')
  })

  test('shortcuts: j/k walk, h folds and climbs, l unfolds, o works on it, f filters; the overview opens from Shortcuts', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))
    const hotkeys = JSON.stringify(await pane.drawn()).match(/"hotkey":"[a-z]"/g)

    expect(hotkeys).toEqual(['"hotkey":"j"', '"hotkey":"k"', '"hotkey":"h"', '"hotkey":"l"', '"hotkey":"s"', '"hotkey":"f"', '"hotkey":"o"', '"hotkey":"d"', '"hotkey":"v"', '"hotkey":"r"'])

    const selectedRow = async () => (JSON.stringify(await pane.drawn()).match(/"key":"row:([^"]+)","alignItems":"center","backgroundColor"/) ?? [])[1]

    await pane.press({ key: 'key:j' })
    expect(await selectedRow()).toBe('ENG-1')

    await pane.press({ key: 'key:j' })
    expect(await selectedRow()).toBe('ENG-3')

    await pane.press({ key: 'key:h' })
    expect(await selectedRow()).toBe('ENG-1')

    await pane.press({ key: 'key:h' })
    expect(JSON.stringify(await pane.drawn())).not.toContain('"label":"Title ENG-3"')

    await pane.press({ key: 'key:l' })
    expect(JSON.stringify(await pane.drawn())).toContain('"label":"Title ENG-3"')

    await pane.press({ key: 'key:o' })
    expect(w.fills).toEqual(['Work on ENG-1: Title ENG-1 (https://linear.app/acme/issue/ENG-1)'])

    await pane.press({ key: 'key:f' })
    expect(JSON.stringify(await pane.drawn())).toContain('"value":"started"')

    expect(JSON.stringify(await pane.drawn())).toContain('"key":"keys","gap":2,"flexWrap":"wrap","display":"none"')
    await pane.press({ key: 'keys:toggle' })
    expect(JSON.stringify(await pane.drawn())).toContain('"key":"keys","gap":2,"flexWrap":"wrap","display":"flex"')
  })

  test('the view state is saved per project and comes back on the next load', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'tree', args: 'Website', origin: { kind: 'composer' } })
    await w.clock.settle()
    const pane = await $.ui.mount(PANE('desktop'))
    await pane.press({ key: 'i:ENG-4' })
    await pane.press({ key: 'key:f' })
    await $.command.run({ command: 'tree', args: 'sort priority', origin: { kind: 'composer' } })
    await w.clock.advance(3500)

    expect(w.store['state:Website']).toMatchObject({ selected: 'ENG-4', stateFilter: 'started', sort: 'priority', view: 'list' })

    w.store['state:Other'] = { view: 'flow', zoom: 3, stateFilter: 'all', sort: 'id', collapsed: [], focus: 'nope', selected: 'gone' }
    await $.command.run({ command: 'tree', args: 'Other', origin: { kind: 'composer' } })
    await w.clock.settle()
    await w.clock.advance(3500)

    expect(w.store['state:Other']).toMatchObject({ view: 'flow', zoom: 3, stateFilter: 'all', sort: 'id', focus: '', selected: null })
  })
})
