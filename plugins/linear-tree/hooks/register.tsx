import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { TreeActivity, TreeIssue, TreeMilestone, TreeModel } from '../types'
import {
  collapsibleOf,
  SORTS,
  STATE_FILTERS,
  idsIn,
  issuePageOf,
  linearServersOf,
  milestonesOf,
  promptOf,
  type Row,
  rowsOf,
  treeOf,
} from './tree'
import { detailsPane, flowPane, type Info, paneView } from './view'

const PANE = 'linear-tree'
const DETAILS_PANE = 'linear-details'
const COMMAND = 'tree'
const FLOW_COMMAND = 'flow'
const PROJECT_KEY = 'project'
const DEFAULT_SERVERS = ['claude.ai Linear', 'Linear', 'linear']
const FIELDS = ['id', 'title', 'status', 'statusType', 'priority', 'parentId', 'projectMilestone', 'assignee', 'updatedAt', 'description', 'url']
const MAIN = 'main'
const MAX_PAGES = 20
/** Issues per call: small enough that a page with long descriptions still arrives whole. */
const PAGE_SIZE = 50
const CALL_TIMEOUT_MS = 30_000

const model = atom({ plugin: 'linear-tree', key: 'model' } as const, null)
const collapsed = atom({ plugin: 'linear-tree', key: 'collapsed' } as const, [])
const status = atom({ plugin: 'linear-tree', key: 'status' } as const, '')
const sort = atom({ plugin: 'linear-tree', key: 'sort' } as const, 'work')
const query = atom({ plugin: 'linear-tree', key: 'query' } as const, '')
const stateFilter = atom({ plugin: 'linear-tree', key: 'stateFilter' } as const, 'open')
const activity = atom({ plugin: 'linear-tree', key: 'activity' } as const, {})
const searchFolded = atom({ plugin: 'linear-tree', key: 'searchFolded' } as const, [])
const focus = atom({ plugin: 'linear-tree', key: 'focus' } as const, '')
const selected = atom({ plugin: 'linear-tree', key: 'selected' } as const, null)
const zoom = atom({ plugin: 'linear-tree', key: 'zoom' } as const, 2)
const view = atom({ plugin: 'linear-tree', key: 'view' } as const, 'list')
/** The project whose saved view state this session already restored; kept across reloads of the mod. */
const restoredFor = atom({ plugin: 'linear-tree', key: 'restoredFor' } as const, '')
const showKeys = atom({ plugin: 'linear-tree', key: 'showKeys' } as const, false)

const DOUBLE_CLICK_MS = 700

/** What the last drawings listed, for stepping between issues, and the last click, for double clicks. */
const layout: { ids: string[]; flowIds: string[]; foldable: Set<string>; lastPress: { id: string; at: number } | null } = { ids: [], flowIds: [], foldable: new Set(), lastPress: null }

const runtime: {
  settings: { defaultProject: string; linearServer: string; refreshMinutes: number }
  server: string | null
  isLoading: boolean
  pendingFocus: string | null
  lastSaved: string
} = {
  settings: { defaultProject: '', linearServer: '', refreshMinutes: 5 },
  server: null,
  isLoading: false,
  pendingFocus: null,
  lastSaved: '',
}

const SAVE_EVERY_MS = 3000

/** What is kept per project across sessions: the view and how it is filtered, sorted, zoomed, folded and selected. */
type Saved = { view: string; stateFilter: string; sort: string; zoom: number; collapsed: string[]; focus: string; selected: string | null }

/** The current view state, as saved. */
async function snapshotOf($: EngineInterface): Promise<Saved> {
  return {
    view: await read($, view),
    stateFilter: await read($, stateFilter),
    sort: await read($, sort),
    zoom: await read($, zoom),
    collapsed: await read($, collapsed),
    focus: await read($, focus),
    selected: await read($, selected),
  }
}

/** Saves the view state of the project shown, when it changed since the last save. */
async function saveState($: EngineInterface): Promise<void> {
  const tree = await read($, model)

  if (tree === null || (await read($, restoredFor)) !== tree.project) {
    return
  }

  const text = JSON.stringify(await snapshotOf($))

  if (text !== runtime.lastSaved) {
    runtime.lastSaved = text
    await $.store.set(`state:${tree.project}`, JSON.parse(text))
  }
}

/** Restores a project's saved view state, keeping only what still fits the tree. */
async function restoreState($: EngineInterface, tree: TreeModel): Promise<void> {
  const saved = await $.store.get(`state:${tree.project}`)

  if (typeof saved !== 'object' || saved === null) {
    return
  }

  const value = saved as Partial<Saved>
  const text = (one: unknown, allowed: readonly string[]) => (typeof one === 'string' && allowed.includes(one) ? one : null)
  const nextView = text(value.view, ['list', 'flow'])
  const nextFilter = text(value.stateFilter, STATE_FILTERS)
  const nextSort = text(value.sort, SORTS)

  if (nextView !== null) {
    await update($, view, () => nextView)
  }

  if (nextFilter !== null) {
    await update($, stateFilter, () => nextFilter)
  }

  if (nextSort !== null) {
    await update($, sort, () => nextSort)
  }

  if (typeof value.zoom === 'number' && value.zoom >= 1 && value.zoom <= 3) {
    await update($, zoom, () => value.zoom!)
  }

  if (Array.isArray(value.collapsed)) {
    await update($, collapsed, () => value.collapsed!.filter((id): id is string => typeof id === 'string'))
  }

  if (typeof value.focus === 'string' && (value.focus === '' || tree.milestones.some(one => one.id === value.focus))) {
    await update($, focus, () => value.focus!)
  }

  if (typeof value.selected === 'string' && tree.issues[value.selected] !== undefined) {
    await update($, selected, () => value.selected!)
  }

  runtime.lastSaved = ''
}

/** Resolves `work`, or rejects once `ms` have passed without it. */
async function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T> {
  let timer: { cancel: () => void } | null = null
  const late = new Promise<T>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`no answer within ${ms / 1000}s`)))
  })

  try {
    return await Promise.race([work, late])
  } finally {
    timer?.cancel()
  }
}

/** One call to a Linear tool: through the server directly, or as the tool the model sees. */
async function callLinear($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await within($, $.mcp.call(server, tool, args), CALL_TIMEOUT_MS)
    const body = result.content.map(block => block.text ?? '').join('')

    if (result.isError) {
      throw new Error(body.slice(0, 200) || `${tool} failed`)
    }

    return body
  } catch (error) {
    if (!(error instanceof Error) || !/no connected MCP tool/i.test(error.message)) {
      throw error
    }

    const ran = await within($, $.tool.call({ tool: `mcp__${server}__${tool}`, ...args }), CALL_TIMEOUT_MS)

    if (ran.deny !== undefined || ran.isError) {
      throw new Error(ran.deny ?? ran.text ?? `${tool} failed`)
    }

    return ran.text ?? ''
  }
}

/** Every issue of the project, page by page, and the server that answered. */
async function fetchIssues($: EngineInterface, project: string): Promise<{ issues: TreeIssue[]; server: string }> {
  const discovered = runtime.server === null && runtime.settings.linearServer === ''
    ? linearServersOf(await $.tool.list().catch(() => []))
    : []
  const servers = runtime.server !== null
    ? [runtime.server]
    : runtime.settings.linearServer !== ''
      ? [runtime.settings.linearServer]
      : [...new Set([...discovered, ...DEFAULT_SERVERS])]
  const failures: string[] = []

  for (const server of servers) {
    try {
      const issues: TreeIssue[] = []
      let cursor: string | null = null

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = await callLinear($, server, 'list_issues', {
          project,
          limit: PAGE_SIZE,
          includeArchived: false,
          fields: FIELDS,
          ...(cursor !== null ? { cursor } : {}),
        })
        const next = issuePageOf(body)
        issues.push(...next.issues)
        cursor = next.cursor

        if (cursor === null) {
          break
        }
      }

      return { issues, server }
    } catch (error) {
      failures.push(`${server}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
    }
  }

  throw new Error(failures.join('; ') || 'no Linear server found')
}

/** Loads the project's tree into the pane's state; the status line says how it went. */
async function load($: EngineInterface, project: string): Promise<void> {
  if (runtime.isLoading) {
    return
  }

  runtime.isLoading = true
  await update($, status, () => `Loading ${project}…`)

  try {
    const { issues, server } = await fetchIssues($, project)
    runtime.server = server
    let milestones: TreeMilestone[] = []
    let note = ''

    try {
      milestones = milestonesOf(await callLinear($, server, 'list_milestones', { project }))
    } catch (error) {
      note = /permission/i.test(String(error))
        ? ` · allow mcp__${server}__list_milestones in /permissions for milestone order and dates`
        : ''
    }

    const tree = treeOf(project, milestones, issues, await $.clock.now())
    await update($, model, () => tree)

    if ((await read($, restoredFor)) !== project) {
      await update($, restoredFor, () => project)
      await update($, focus, () => '')
      await update($, selected, () => null)
      await restoreState($, tree)
    }

    if (runtime.pendingFocus !== null) {
      const wanted = runtime.pendingFocus
      runtime.pendingFocus = null
      await update($, focus, () => (wanted === '' ? '' : milestoneNamed(tree, wanted) ?? ''))
    }

    await update($, status, () => (issues.length === 0 ? `No issues found in "${project}".${note}` : note.replace(/^ · /, '')))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, status, () => (/permission/i.test(message)
      ? `Linear refused: allow its list_issues tool in /permissions. ${message.slice(0, 160)}`
      : `Could not load "${project}": ${message.slice(0, 200)}`))
  } finally {
    runtime.isLoading = false
  }
}

/** The project's top-level folder: the repository's top, else the session's folder. */
async function rootOf($: EngineInterface): Promise<string> {
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => null)

  return git !== null && git.exitCode === 0 && git.stdout.trim() !== '' ? git.stdout.trim() : $.session.cwd()
}

/** The project to show: named, else the last shown, else the setting, else Next up's first project. */
async function projectOf($: EngineInterface, named: string): Promise<string | null> {
  if (named !== '') {
    return named
  }

  const last = await $.store.get(PROJECT_KEY)

  if (typeof last === 'string' && last !== '') {
    return last
  }

  if (runtime.settings.defaultProject !== '') {
    return runtime.settings.defaultProject
  }

  const nextUp = await $.fs.read(`${await rootOf($)}/.claude/next-up.json`).catch(() => null)

  try {
    const projects = typeof nextUp === 'string' ? JSON.parse(nextUp)?.linear?.projects : null

    return Array.isArray(projects) && typeof projects[0] === 'string' ? projects[0] : null
  } catch {
    return null
  }
}

async function refreshShown($: EngineInterface): Promise<void> {
  const current = await read($, model)
  const panes = await $.ui.panes()

  if (current !== null && panes.some(pane => pane.id === PANE && pane.isShown)) {
    await load($, current.project)
  }
}

/** Folds or unfolds a node: in the tree, or, while a text search runs, in that search alone. */
async function toggle($: EngineInterface, id: string): Promise<void> {
  const flip = (list: string[]) => (list.includes(id) ? list.filter(one => one !== id) : [...list, id])
  const isSearching = (await read($, query)).trim() !== ''

  if (isSearching) {
    await update($, searchFolded, flip)
  } else {
    await update($, collapsed, flip)
  }
}

async function collapseAll($: EngineInterface): Promise<void> {
  const current = await read($, model)
  await update($, collapsed, () => (current === null ? [] : collapsibleOf(current)))
}

/** The rows both panes draw, under the current search, filter, sort and milestone; the flowchart ignores folding. */
async function visibleRows($: EngineInterface, tree: TreeModel, isFlow: boolean): Promise<Row[]> {
  const rows = rowsOf(tree, isFlow ? [] : await read($, collapsed), {
    sort: await read($, sort),
    query: await read($, query),
    stateFilter: await read($, stateFilter),
    activity: await read($, activity),
    searchFolded: isFlow ? [] : await read($, searchFolded),
  })
  const focused = await read($, focus)

  return focused === '' ? rows : focusedRows(rows, focused)
}

/** The name of the focused milestone, or null for all. */
async function focusName($: EngineInterface, tree: TreeModel): Promise<string | null> {
  const focused = await read($, focus)

  return focused === '' ? null : tree.milestones.find(milestone => milestone.id === focused)?.name ?? null
}

/** A milestone by name or id, or null. */
function milestoneNamed(tree: TreeModel, name: string): string | null {
  const wanted = name.trim().toLowerCase()

  return tree.milestones.find(milestone => milestone.name.toLowerCase() === wanted || milestone.id === name.trim())?.id ?? null
}

/** Only one milestone's rows: its heading and everything under it. */
function focusedRows<R extends { kind: string; id: string }>(rows: readonly R[], milestoneId: string): R[] {
  const kept: R[] = []
  let isInside = false

  for (const row of rows) {
    if (row.kind === 'milestone') {
      isInside = row.id === milestoneId
    }

    if (isInside) {
      kept.push(row)
    }
  }

  return kept
}

/** Marks the issues named in `text` as worked on by one agent. */
async function markWork($: EngineInterface, text: string, who: TreeActivity): Promise<void> {
  const ids = idsIn(text)

  if (ids.length > 0) {
    await update($, activity, current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, who])) }))
  }
}

/** Clears what one agent was working on. */
async function endWork($: EngineInterface, agentId: string): Promise<void> {
  await update($, activity, current => Object.fromEntries(Object.entries(current).filter(([, who]) => who.agentId !== agentId)))
}

/** Reloads a tree kept from an older version of the mod that lacks fields this one draws. */
async function reloadIfOutdated($: EngineInterface): Promise<void> {
  const current = await read($, model)

  if (current !== null && Object.values(current.issues).some(issue => issue.description === undefined || issue.updatedAt === undefined)) {
    await load($, current.project)
  }
}

/** Folds the selected issue (h), or, when it is folded already or has nothing under it, selects its parent; unfolds it (l). */
async function foldSelected($: EngineInterface, isOpen: boolean): Promise<void> {
  const tree = await read($, model)
  const id = await read($, selected)
  const issue = tree !== null && id !== null ? tree.issues[id] : undefined

  if (issue === undefined) {
    return
  }

  const folded = await read($, collapsed)

  if (isOpen) {
    await update($, collapsed, list => list.filter(one => one !== issue.id))

    return
  }

  if (layout.foldable.has(issue.id) && !folded.includes(issue.id)) {
    await update($, collapsed, list => [...list, issue.id])
  } else if (issue.parentId !== null && tree!.issues[issue.parentId] !== undefined) {
    await update($, selected, () => issue.parentId)
  }
}


/** Works on the selected issue (the o key). */
async function workOnSelected($: EngineInterface): Promise<void> {
  const tree = await read($, model)
  const id = await read($, selected)
  const issue = tree !== null && id !== null ? tree.issues[id] : undefined

  if (issue !== undefined) {
    await workOn($, issue)
  }
}

/** Reloads the tree shown now. */
async function refreshNow($: EngineInterface): Promise<void> {
  const current = await read($, model)

  if (current !== null) {
    await load($, current.project)
  }
}

/** Shows a failed click in the pane's status line instead of dropping it. */
async function report($: EngineInterface, error: unknown): Promise<void> {
  await update($, status, () => `Something failed: ${error instanceof Error ? error.message : String(error)}`)
}

/** The pane's handlers: each a closure over $, written from a press, never while drawing. */
function actionsOf($: EngineInterface, inFlow: boolean) {
  return {
    toggle: (id: string) => {
      void toggle($, id).catch(error => report($, error))
    },
    press: (issue: TreeIssue) => {
      void pressIssue($, issue).catch(error => report($, error))
    },
    setStates: (value: string) => {
      void update($, stateFilter, () => value)
    },
    search: (value: string) => {
      void update($, query, () => value)
      void update($, searchFolded, () => [])
    },
    step: (by: number) => {
      void stepIssue($, by, inFlow).catch(error => report($, error))
    },
    close: () => {
      void update($, selected, () => null)
      void $.ui.close({ id: DETAILS_PANE })
    },
    work: (issue: TreeIssue) => {
      void workOn($, issue).catch(error => report($, error))
    },
    workSelected: () => {
      void workOnSelected($).catch(error => report($, error))
    },
    openDetails: () => {
      void openDetailsPane($).catch(error => report($, error))
    },
    toggleView: () => {
      void update($, view, value => (value === 'flow' ? 'list' : 'flow'))
    },
    zoom: (step: number) => {
      void update($, zoom, () => Math.max(1, Math.min(3, step)))
    },
    level: (step: number) => {
      void (async () => {
        if (step <= 0) {
          await update($, view, () => 'list')
          return
        }

        await update($, zoom, () => Math.min(3, step))
        await update($, view, () => 'flow')
      })()
    },
    fold: (isOpen: boolean) => {
      void foldSelected($, isOpen).catch(error => report($, error))
    },
    focusSearch: () => {
      void $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)
    },
    cycleFilter: () => {
      void update($, stateFilter, value => STATE_FILTERS[(STATE_FILTERS.indexOf(value as never) + 1) % STATE_FILTERS.length]!)
    },
    refresh: () => {
      void refreshNow($).catch(error => report($, error))
    },
    toggleKeys: () => {
      void update($, showKeys, value => !value)
    },
  }
}

/**
 * Puts "Work on <id>: <title> (<url>)" in the prompt box. When the box will
 * not take it (a dialog holds the keys, say), the text goes to the
 * clipboard instead and the status line says why.
 */
async function workOn($: EngineInterface, issue: TreeIssue): Promise<void> {
  const text = promptOf(issue)
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (filled.isFilled) {
    $.ui.toast(`${issue.id} is in the prompt box`)

    return
  }

  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  await update($, status, () => `The prompt box did not take it${filled.refusal !== undefined ? ` (${filled.refusal})` : ''}${copied.isCopied ? '; copied to the clipboard instead' : ''}.`)
}

/** A click selects an issue and opens its details; a second click on it within 700 ms is a double click and works on it. */
async function pressIssue($: EngineInterface, issue: TreeIssue): Promise<void> {
  const now = await $.clock.now()
  const last = layout.lastPress

  if (last !== null && last.id === issue.id && now - last.at < DOUBLE_CLICK_MS) {
    layout.lastPress = null
    await workOn($, issue)

    return
  }

  layout.lastPress = { id: issue.id, at: now }

  await update($, selected, () => issue.id)
  await showDetails($, false)
}

/** Keeps the selected issue's row in view in the list; the chart follows the selection by itself. */
async function showDetails($: EngineInterface, inFlow: boolean): Promise<void> {
  const id = await read($, selected)

  if (id !== null && !inFlow) {
    await $.ui.scroll({ to: { key: `i:${id}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
  }
}

/** Opens the details pane (d, 7): on the selected issue, or the first visible one when none is selected. */
async function openDetailsPane($: EngineInterface): Promise<void> {
  if ((await read($, selected)) === null) {
    await stepIssue($, 1, (await read($, view)) === 'flow')
  }

  const panes = await $.ui.panes()

  if (!panes.some(pane => pane.id === DETAILS_PANE)) {
    await $.ui.open({ id: DETAILS_PANE, title: 'Issue', rows: 18 })
  }
}



/** Selects the previous or next visible issue, revealing it and its details. */
async function stepIssue($: EngineInterface, by: number, inFlow: boolean): Promise<void> {
  const ids = inFlow ? layout.flowIds : layout.ids

  if (ids.length === 0) {
    return
  }

  const current = await read($, selected)
  const at = current === null ? -1 : ids.indexOf(current)
  const next = ids[at === -1 ? (by > 0 ? 0 : ids.length - 1) : (at + by + ids.length) % ids.length]!
  await update($, selected, () => next)

  await showDetails($, inFlow)
}

/** The info box's content for the selected issue, or null. */
async function infoOf($: EngineInterface, tree: TreeModel): Promise<Info | null> {
  const id = await read($, selected)
  const issue = id !== null ? tree.issues[id] : undefined

  if (issue === undefined) {
    return null
  }

  const working = await read($, activity)
  const milestone = issue.milestoneId !== null ? tree.milestones.find(one => one.id === issue.milestoneId)?.name ?? null : null

  return { issue, milestone, activity: working[issue.id] ?? null }
}

/** `/tree` and its subcommands; anything else names a project. */
async function treeCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.split(/\s+/)
  const value = rest.join(' ')
  const current = await read($, model)
  const needsTree = ['refresh', 'sort', 'milestone', 'collapse', 'expand'].includes(verb)

  if (needsTree && current === null) {
    return 'No tree loaded yet: /tree <project>.'
  }

  if (current !== null) {
    switch (verb) {
      case 'refresh':
        $.clock.after(0, () => {
          void load($, current.project)
        })

        return `Reloading ${current.project}.`
      case 'sort':
        if (!(SORTS as readonly string[]).includes(value)) {
          return `Sort by: ${SORTS.join(', ')}.`
        }

        await update($, sort, () => value)

        return `Sorted by ${value}.`
      case 'milestone': {
        const milestone = value === 'all' || value === '' ? '' : milestoneNamed(current, value)

        if (milestone === null) {
          return `No milestone "${value}": ${current.milestones.map(one => one.name).join(', ')}.`
        }

        await update($, focus, () => milestone)

        return milestone === '' ? 'Showing all milestones.' : `Showing ${value}.`
      }
      case 'collapse':
        await collapseAll($)

        return 'Collapsed.'
      case 'expand':
        await update($, collapsed, () => [])

        return 'Expanded.'
    }
  }

  const project = await projectOf($, args)

  if (project === null) {
    return 'Which Linear project? /tree <project name>'
  }

  await $.store.set(PROJECT_KEY, project)
  await update($, view, () => 'list')
  await $.ui.open({ id: PANE, title: `Linear · ${project}`, focus: true })
  $.clock.after(0, () => {
    void load($, project)
  })

  return `Linear tree for ${project} in the side pane.`
}

/** Draws the list pane. */
async function drawList($: EngineInterface, e: RenderInput<'Pane'>, ui: ReturnType<EngineInterface['ui']['resolve']>) {
  const tree = await read($, model)
  const line = await read($, status)

  if (tree === null) {
    const { Text } = ui

    return <Text dimColor>{line || 'No tree yet: /tree <project>'}</Text>
  }

  const rows = await visibleRows($, tree, false)
  layout.ids = rows.flatMap(row => (row.kind === 'issue' ? [row.id] : []))
  layout.foldable = new Set(rows.flatMap(row => (row.kind === 'issue' && row.hasChildren ? [row.id] : [])))

  return paneView(ui, {
    surface: e.surface,
    columns: Math.max(40, e.props.bodyColumns),
    tree,
    rows,
    states: await read($, stateFilter),
    query: await read($, query),
    status: line,
    activity: await read($, activity),
    focusName: await focusName($, tree),
    selected: await read($, selected),
    info: await infoOf($, tree),
    showKeys: await read($, showKeys),
  }, actionsOf($, false))
}

/** Draws the flowchart pane. */
async function drawFlow($: EngineInterface, e: RenderInput<'Pane'>, ui: ReturnType<EngineInterface['ui']['resolve']>) {
  const tree = await read($, model)
  const line = await read($, status)

  if (tree === null) {
    const { Text } = ui

    return <Text dimColor>{line || 'No tree yet: /tree <project>'}</Text>
  }

  const rows = await visibleRows($, tree, true)
  const columns = Math.max(40, e.props.bodyColumns)

  layout.flowIds = rows.flatMap(row => (row.kind === 'issue' ? [row.id] : []))

  return flowPane(ui, {
    surface: e.surface,
    columns,
    tree,
    rows,
    states: await read($, stateFilter),
    focusName: await focusName($, tree),
    status: line,
    selected: await read($, selected),
    zoom: await read($, zoom),
    showKeys: await read($, showKeys),
  }, actionsOf($, true))
}
/**
 * Linear tree. `/tree <project>` opens a side pane with the project's
 * milestones, issues and sub-issues as a tree, each with its state and
 * progress over what is under it. Click a node's arrow to fold it, an
 * issue to put "Work on <id>: <title>" in the prompt box. Sort, search and
 * filter from the pane's header. An issue the session or a subagent is
 * working on (named in its prompt) carries a marker until that agent's
 * turn ends. The tree is read through the connected Linear MCP server,
 * with no model calls, and reloads while the pane is shown.
 */
export const register: Register = (on, options) => {
  const minutes = Number(options.refreshMinutes ?? 5)
  runtime.settings = {
    defaultProject: String(options.defaultProject ?? ''),
    linearServer: String(options.linearServer ?? ''),
    refreshMinutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : 5,
  }

  on('session.start', async ($, e, next) => {
    $.clock.after(0, () => {
      $.ui.invalidate('ui.render')
      void reloadIfOutdated($)
    })
    $.clock.every(SAVE_EVERY_MS, () => {
      void saveState($).catch(() => undefined)
    })
    await $.command.register({
      name: COMMAND,
      description: 'Linear project as a tree: /tree <project> · sort <work|priority|updated|id> · milestone <name|all> · collapse · expand · refresh',
    })
    await $.command.register({
      name: FLOW_COMMAND,
      description: 'The Linear tree as a flowchart: /flow shows every milestone, /flow <milestone> just one',
    })

    if (runtime.settings.refreshMinutes > 0) {
      $.clock.every(runtime.settings.refreshMinutes * 60_000, () => {
        void refreshShown($)
      })
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    return { text: await treeCommand($, e.args.trim()) }
  })

  on('command.run', { command: FLOW_COMMAND }, async ($, e) => {
    const current = await read($, model)
    const args = e.args.trim()
    const project = current?.project ?? await projectOf($, '')

    if (project === null) {
      return { text: 'Which Linear project? /tree <project name> first.' }
    }

    const isAll = args === '' || args === 'all' || args.toLowerCase() === project.toLowerCase()

    if (current === null) {
      runtime.pendingFocus = isAll ? '' : args
    } else {
      const milestone = isAll ? '' : milestoneNamed(current, args)

      if (milestone === null) {
        return { text: `No milestone "${args}" in ${current.project}. Try /flow ${current.milestones.map(one => one.name).join(', /flow ')} or /flow for all.` }
      }

      await update($, focus, () => milestone)
    }

    await update($, view, () => 'flow')
    await $.ui.open({ id: PANE, title: `Linear · ${project}`, columns: 150, focus: true })

    if (current === null) {
      $.clock.after(0, () => {
        void load($, project)
      })
    }

    const shown = current === null ? (isAll ? null : args) : await focusName($, current)

    return { text: `Flowchart of ${project}${shown === null ? ', every milestone' : ` · ${shown}`} in the side pane (v switches to the list).` }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    if (result.drop === undefined) {
      await endWork($, MAIN)
      await markWork($, result.text, { agentId: MAIN, agent: 'Claude' })
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined && result.agentId !== undefined) {
      await markWork($, `${e.description}\n${e.prompt}`, { agentId: result.agentId, agent: e.name ?? e.subagentType ?? 'agent' })
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await endWork($, e.agentId ?? MAIN)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const isFlow = (await read($, view)) === 'flow' && e.surface !== 'terminal'

    try {
      return isFlow ? await drawFlow($, e, ui) : await drawList($, e, ui)
    } catch (error) {
      const { Text } = ui

      return <Text color="red">{`linear-tree could not draw the ${isFlow ? 'flowchart' : 'list'}: ${error instanceof Error ? error.message : String(error)}`}</Text>
    }
  })

  on('ui.render', { component: 'Pane', requestId: DETAILS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const tree = await read($, model)

    try {
      return detailsPane(ui, tree === null ? null : await infoOf($, tree), Math.max(30, e.props.bodyColumns), e.surface === 'terminal', actionsOf($, false))
    } catch (error) {
      const { Text } = ui

      return <Text color="red">{`linear-tree could not draw the details: ${error instanceof Error ? error.message : String(error)}`}</Text>
    }
  })
}
