import type { TreeActivity, TreeIssue, TreeMilestone, TreeModel } from '../types'

export const NO_MILESTONE = 'none'

const STATE_RANK: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3, completed: 4, canceled: 5, duplicate: 5 }
const CLOSED = new Set(['completed', 'canceled', 'duplicate'])

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
    : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/** One `list_issues` page: its issues and the cursor of the next page, if any; throws when the answer is not such a page (say, cut short). */
export function issuePageOf(body: string): { issues: TreeIssue[]; cursor: string | null } {
  const answer = parsed(body)

  if (!Array.isArray(field(answer, 'issues'))) {
    throw new Error(`Linear's answer was not a list of issues (${body.length} characters): ${body.slice(0, 160)}`)
  }

  const issues = records(field(answer, 'issues')).map(issue => {
    const priority = field(issue, 'priority')
    const value = field(priority, 'value')

    return {
      id: text(issue.id),
      title: text(issue.title),
      status: text(issue.status),
      statusType: text(issue.statusType),
      priority: typeof value === 'number' && value > 0 ? value : 5,
      priorityName: text(field(priority, 'name')),
      parentId: text(issue.parentId) || null,
      milestoneId: text(field(issue.projectMilestone, 'id')) || null,
      milestoneName: text(field(issue.projectMilestone, 'name')) || null,
      assignee: text(issue.assignee) || null,
      updatedAt: text(issue.updatedAt),
      description: text(issue.description).slice(0, 4000),
      url: text(issue.url),
      children: [],
    }
  }).filter(issue => issue.id !== '')
  const cursor = field(answer, 'hasNextPage') === true ? text(field(answer, 'cursor')) || null : null

  return { issues, cursor }
}

/** `list_milestones` as milestones in Linear's own order. */
export function milestonesOf(body: string): TreeMilestone[] {
  return records(field(parsed(body), 'milestones'))
    .map(one => ({
      milestone: { id: text(one.id), name: text(one.name), targetDate: text(one.targetDate) || null, roots: [] as string[] },
      order: typeof one.sortOrder === 'number' ? one.sortOrder : 0,
    }))
    .filter(({ milestone }) => milestone.id !== '')
    .sort((a, b) => a.order - b.order)
    .map(({ milestone }) => milestone)
}

function idNumber(id: string): number {
  return Number(/(\d+)$/.exec(id)?.[1] ?? 0)
}

function compare(a: TreeIssue, b: TreeIssue): number {
  return (STATE_RANK[a.statusType] ?? 4) - (STATE_RANK[b.statusType] ?? 4)
    || a.priority - b.priority
    || idNumber(a.id) - idNumber(b.id)
}

export const SORTS = ['work', 'priority', 'updated', 'id'] as const
export const SORT_LABELS: Record<string, string> = { work: 'working order', priority: 'priority', updated: 'recently updated', id: 'id' }

/** The order of siblings: working order (state, then priority), priority, recently updated, or id. */
export function comparatorOf(sort: string): (a: TreeIssue, b: TreeIssue) => number {
  switch (sort) {
    case 'priority':
      return (a, b) => a.priority - b.priority || compare(a, b)
    case 'updated':
      return (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || compare(a, b)
    case 'id':
      return (a, b) => idNumber(a.id) - idNumber(b.id)
    default:
      return compare
  }
}

export const STATE_FILTERS = ['open', 'started', 'all'] as const
export const STATE_FILTER_LABELS: Record<string, string> = { open: 'Open', started: 'In progress', all: 'All' }

/** Issue ids such as ENG-42 in a text. */
export function idsIn(value: string): string[] {
  return [...new Set(value.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [])]
}

/**
 * Nests the issues: sub-issues under their parent, top-level issues under
 * their milestone (or "No milestone"), each level in working order: in
 * progress, to do, backlog, done; then by priority. Milestones the issues
 * name but `milestones` lacks are added by name.
 */
export function treeOf(project: string, milestones: readonly TreeMilestone[], list: readonly TreeIssue[], loadedAt: number): TreeModel {
  const issues: Record<string, TreeIssue> = {}

  for (const issue of list) {
    issues[issue.id] = { ...issue, children: [] }
  }

  const named = milestones.map(milestone => ({ ...milestone, roots: [] as string[] }))
  const byId = new Map(named.map(milestone => [milestone.id, milestone]))
  const none: TreeMilestone = { id: NO_MILESTONE, name: 'No milestone', targetDate: null, roots: [] }

  for (const issue of Object.values(issues).sort(compare)) {
    const parent = issue.parentId !== null ? issues[issue.parentId] : undefined

    if (parent !== undefined) {
      parent.children.push(issue.id)
      continue
    }

    const milestoneId = issue.milestoneId

    if (milestoneId !== null && !byId.has(milestoneId)) {
      const added = { id: milestoneId, name: issue.milestoneName ?? milestoneId.slice(0, 8), targetDate: null, roots: [] as string[] }
      byId.set(milestoneId, added)
      named.push(added)
    }

    ;(milestoneId !== null ? byId.get(milestoneId)! : none).roots.push(issue.id)
  }

  return {
    project,
    milestones: none.roots.length > 0 ? [...named, none] : named,
    issues,
    loadedAt,
  }
}

export function isClosed(issue: TreeIssue): boolean {
  return CLOSED.has(issue.statusType)
}

/** Done and total over an issue and everything under it; canceled ones do not count. */
export function progressOf(model: TreeModel, ids: readonly string[]): { done: number; total: number } {
  let done = 0
  let total = 0
  const walk = (id: string) => {
    const issue = model.issues[id]

    if (issue === undefined) {
      return
    }

    if (issue.statusType !== 'canceled' && issue.statusType !== 'duplicate') {
      total += 1
      done += issue.statusType === 'completed' ? 1 : 0
    }

    issue.children.forEach(walk)
  }
  ids.forEach(walk)

  return { done, total }
}

/** A bar of `width` cells for done of total. */
export function barOf(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export type Row =
  | { kind: 'milestone'; id: string; name: string; targetDate: string | null; done: number; total: number; isOpen: boolean; isEmpty: boolean; activeBelow: number }
  | {
    kind: 'issue'
    id: string
    prefix: string
    issue: TreeIssue
    done: number
    total: number
    isOpen: boolean
    hasChildren: boolean
    activity: TreeActivity | null
    activeBelow: number
    isMatch: boolean
  }

export type RowOptions = {
  hideDone: boolean
  sort: string
  query: string
  stateFilter: string
  activity: Record<string, TreeActivity>
  searchFolded: readonly string[]
}

const DEFAULT_OPTIONS: RowOptions = { hideDone: false, sort: 'work', query: '', stateFilter: 'all', activity: {}, searchFolded: [] }

/** Whether an issue itself passes the search and the filters. */
export function matches(issue: TreeIssue, options: RowOptions): boolean {
  const query = options.query.trim().toLowerCase()

  if (query !== '' && !`${issue.id} ${issue.title} ${issue.assignee ?? ''}`.toLowerCase().includes(query)) {
    return false
  }

  if (options.hideDone && isClosed(issue)) {
    return false
  }

  if (options.stateFilter === 'open' && isClosed(issue)) {
    return false
  }

  if (options.stateFilter === 'started' && issue.statusType !== 'started') {
    return false
  }

  return true
}

/**
 * The rows to draw, in order, with tree guides. An issue shows when it
 * passes the search and filters, or when something under it does (so a
 * match keeps its path); collapsed nodes hide what is under them. While
 * a text search runs, every path to a match opens, and only what was
 * folded during that search (`searchFolded`) stays closed.
 */
export function rowsOf(model: TreeModel, collapsed: readonly string[], options: Partial<RowOptions> | boolean = {}): Row[] {
  const opts: RowOptions = typeof options === 'boolean' ? { ...DEFAULT_OPTIONS, hideDone: options } : { ...DEFAULT_OPTIONS, ...options }
  const isTextSearch = opts.query.trim() !== ''
  const isSearching = isTextSearch || opts.stateFilter !== 'all'
  const closed = new Set(isTextSearch ? opts.searchFolded : collapsed)
  const order = comparatorOf(opts.sort)
  const shown = new Map<string, boolean>()
  const active = new Map<string, number>()
  const isShownId = (id: string): boolean => {
    const known = shown.get(id)

    if (known !== undefined) {
      return known
    }

    const issue = model.issues[id]
    const result = issue !== undefined && (matches(issue, opts) || issue.children.some(isShownId))
    shown.set(id, result)

    return result
  }
  const activeUnder = (id: string): number => {
    const known = active.get(id)

    if (known !== undefined) {
      return known
    }

    const issue = model.issues[id]
    const count = issue === undefined ? 0 : issue.children.reduce((sum, child) => sum + (opts.activity[child] ? 1 : 0) + activeUnder(child), 0)
    active.set(id, count)

    return count
  }
  const sorted = (ids: readonly string[]) => ids
    .filter(isShownId)
    .map(id => model.issues[id]!)
    .sort(order)
    .map(issue => issue.id)
  const rows: Row[] = []
  const walk = (id: string, lines: readonly boolean[], isLast: boolean) => {
    const issue = model.issues[id]!
    const children = sorted(issue.children)
    const isOpen = !closed.has(id)
    const prefix = `${lines.map(more => (more ? '│  ' : '   ')).join('')}${isLast ? '└─ ' : '├─ '}`
    const { done, total } = progressOf(model, issue.children)
    rows.push({
      kind: 'issue',
      id,
      prefix,
      issue,
      done,
      total,
      isOpen,
      hasChildren: children.length > 0,
      activity: opts.activity[id] ?? null,
      activeBelow: activeUnder(id),
      isMatch: isSearching && matches(issue, opts),
    })

    if (isOpen) {
      children.forEach((child, index) => walk(child, [...lines, !isLast], index === children.length - 1))
    }
  }

  for (const milestone of model.milestones) {
    const roots = sorted(milestone.roots)

    if (isSearching && roots.length === 0) {
      continue
    }

    const { done, total } = progressOf(model, milestone.roots)
    const isOpen = !closed.has(`m:${milestone.id}`)
    const activeBelow = milestone.roots.reduce((sum, id) => sum + (opts.activity[id] ? 1 : 0) + activeUnder(id), 0)
    rows.push({ kind: 'milestone', id: milestone.id, name: milestone.name, targetDate: milestone.targetDate, done, total, isOpen, isEmpty: roots.length === 0, activeBelow })

    if (isOpen) {
      roots.forEach((id, index) => walk(id, [], index === roots.length - 1))
    }
  }

  return rows
}

/** Every node that can be collapsed: milestones and issues with children. */
export function collapsibleOf(model: TreeModel): string[] {
  return [
    ...model.milestones.map(milestone => `m:${milestone.id}`),
    ...Object.values(model.issues).filter(issue => issue.children.length > 0).map(issue => issue.id),
  ]
}

/** The prompt a click on an issue puts in the prompt box. */
export function promptOf(issue: TreeIssue): string {
  return `Work on ${issue.id}: ${issue.title} (${issue.url})`
}

/** The servers whose `list_issues` tool is Linear's, from the tool list. */
export function linearServersOf(tools: readonly { name: string; description: string }[]): string[] {
  return tools
    .map(tool => ({ tool, match: /^mcp__(.+)__list_issues$/.exec(tool.name) }))
    .filter(({ tool, match }) => match !== null && /linear/i.test(`${tool.name} ${tool.description}`))
    .map(({ match }) => match![1]!)
}

