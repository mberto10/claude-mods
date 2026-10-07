import type { TreeActivity, TreeIssue, TreeModel } from '../types'
import type { Row } from './tree'
import { AGENT, avatarSvg, DONE, prioritySvg, REVIEW, STARTED, statusSvg, TODO } from './icons'
import { plainLines, wrapped } from './text'

const PAD = 14

const STYLE = [
  'text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:12px}',
  '.t{fill:#1d1d1f}.s{fill:#86868b;font-size:10.5px}.b{font-weight:600}',
  '.card{fill:#fff;stroke:#dcdce1;stroke-width:1}.head{fill:#f5f5f8}.chip{fill:#ececf1}',
  '.e{fill:none;stroke:#c4c4cc;stroke-width:1.3}',
  '.closed .t{fill:#9a9aa0}',
      '@media (prefers-color-scheme:dark){.t{fill:#ececf0}.s{fill:#9a9aa3}.card{fill:#232327;stroke:#3a3a40}.head{fill:#2b2b31}.chip{fill:#33333a}.e{stroke:#4c4c55}.closed .t{fill:#6e6e76}}',
].join('')

/** Card sizes per zoom step of the left-to-right chart: 1 overview, 2 normal. */
type Size = { row: number; box: number; column: number; gap: number; isCompact: boolean }

const SIZES: Record<1 | 2, Size> = {
  1: { row: 38, box: 30, column: 172, gap: 22, isCompact: true },
  2: { row: 62, box: 52, column: 196, gap: 26, isCompact: false },
}
const MAX_NODES = 160

type FlowNode = {
  key: string
  kind: 'project' | 'milestone' | 'issue'
  depth: number
  title: string
  sub: string
  issue: TreeIssue | null
  done: number
  total: number
  hidden: number
  activity: TreeActivity | null
  children: FlowNode[]
  y: number
}

export type Flow = { source: string; width: number; height: number; nodes: number; cut: number; tops: Record<string, number> }

/** A window onto the chart (pixels from its top) and the card to mark as selected. */
export type FlowView = { top?: number; height?: number; selected?: string | null; zoom?: number }

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clip(value: string, chars: number): string {
  return value.length > chars ? `${value.slice(0, Math.max(1, chars - 1))}…` : value
}

/** A title in at most two lines of `chars`, the second cut with an ellipsis. */
function linesOf(title: string, chars: number): string[] {
  const words = title.split(/\s+/)
  const first: string[] = []

  while (words.length > 0 && [...first, words[0]].join(' ').length <= chars) {
    first.push(words.shift()!)
  }

  if (first.length === 0) {
    return [clip(title, chars)]
  }

  const rest = words.join(' ')

  return rest === '' ? [first.join(' ')] : [first.join(' '), clip(rest, chars)]
}

function stateColor(issue: TreeIssue): string {
  if (issue.statusType === 'completed') {
    return DONE
  }

  if (issue.statusType === 'started') {
    return /review/i.test(issue.status) ? REVIEW : STARTED
  }

  return TODO
}

/** The visible rows as a forest under one project node: milestones, then issues by depth. */
function forestOf(tree: TreeModel, rows: readonly Row[], done: number, total: number): { root: FlowNode; count: number; cut: number } {
  const root: FlowNode = {
    key: 'project',
    kind: 'project',
    depth: 0,
    title: tree.project,
    sub: `${done}/${total} done`,
    issue: null,
    done,
    total,
    hidden: 0,
    activity: null,
    children: [],
    y: 0,
  }
  const stack: FlowNode[] = [root]
  let count = 0
  let cut = 0

  for (const row of rows) {
    if (count >= MAX_NODES) {
      cut += 1
      continue
    }

    if (row.kind === 'milestone') {
      const node: FlowNode = {
        key: `m:${row.id}`,
        kind: 'milestone',
        depth: 0,
        title: row.name,
        sub: row.total === 0 ? 'no issues' : `${row.done}/${row.total}${row.targetDate !== null ? ` · ${row.targetDate}` : ''}`,
        issue: null,
        done: row.done,
        total: row.total,
        hidden: row.isOpen ? 0 : row.total,
        activity: null,
        children: [],
        y: 0,
      }
      root.children.push(node)
      stack.length = 1
      stack.push(node)
      count += 1
      continue
    }

    const depth = 1 + Math.max(0, row.prefix.length / 3 - 1)
    const node: FlowNode = {
      key: row.id,
      kind: 'issue',
      depth,
      title: row.issue.title,
      sub: row.issue.id,
      issue: row.issue,
      done: row.done,
      total: row.total,
      hidden: row.hasChildren && !row.isOpen ? row.total : 0,
      activity: row.activity,
      children: [],
      y: 0,
    }

    while (stack.length > depth + 1) {
      stack.pop()
    }

    stack[stack.length - 1]!.children.push(node)
    stack.push(node)
    count += 1
  }

  return { root, count, cut }
}

/** Leaves take consecutive rows; a parent sits midway between its first and last child. */
function place(node: FlowNode, next: { slot: number }, row: number): void {
  if (node.children.length === 0) {
    node.y = next.slot * row
    next.slot += 1

    return
  }

  node.children.forEach(child => place(child, next, row))
  node.y = (node.children[0]!.y + node.children[node.children.length - 1]!.y) / 2
}

function walk(node: FlowNode, visit: (node: FlowNode) => void): void {
  visit(node)
  node.children.forEach(child => walk(child, visit))
}

/**
 * The tree as a left-to-right flowchart: milestones, their issues and sub-issues as cards joined by curves. Each card shows
 * its state, id and title, progress over what is under it, and, when an
 * agent works on it, a pulsing outline and the agent's name. Hovering a
 * card shows the whole title and its details.
 */
export function flowSvg(tree: TreeModel, rows: readonly Row[], slotWidth: number, done: number, total: number, view: FlowView = {}): Flow {
  if ((view.zoom ?? 2) >= 3) {
    return detailFlowSvg(tree, rows, slotWidth, view)
  }

  const size = SIZES[view.zoom === 1 ? 1 : 2]
  const ROW = size.row
  const BOX_HEIGHT = size.box
  const COLUMN = size.column
  const GAP = size.gap
  const { root, count, cut } = forestOf(tree, rows, done, total)
  place(root, { slot: 0 }, ROW)

  let deepest = 0
  root.children.forEach(top => walk(top, node => {
    deepest = Math.max(deepest, node.depth)
  }))

  const columns = deepest + 1
  const column = Math.round(Math.max(COLUMN, Math.min(250, (slotWidth - PAD * 2 + GAP) / columns)))
  const boxWidth = column - GAP
  const width = PAD * 2 + columns * column - GAP
  let leaves = 0
  root.children.forEach(top => walk(top, node => {
    leaves += node.children.length === 0 ? 1 : 0
  }))
  const height = PAD * 2 + Math.max(1, leaves) * ROW - (ROW - BOX_HEIGHT)
  const x = (node: FlowNode) => PAD + node.depth * column
  const y = (node: FlowNode) => PAD + node.y
  const chars = Math.floor((boxWidth - 20) / 6.2)
  const edges: string[] = []
  const cards: string[] = []
  const tops: Record<string, number> = {}
  const everyNode = (visit: (node: FlowNode) => void) => root.children.forEach(top => walk(top, visit))

  everyNode(parent => {
    for (const child of parent.children) {
      const x1 = x(parent) + boxWidth
      const y1 = y(parent) + BOX_HEIGHT / 2
      const x2 = x(child)
      const y2 = y(child) + BOX_HEIGHT / 2
      const middle = (x1 + x2) / 2
      edges.push(`<path class="e" d="M${x1} ${y1}C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}"/>`)
    }
  })

  everyNode(node => {
    const left = x(node)
    const top = y(node)
    const isIssue = node.issue !== null
    const accent = isIssue ? stateColor(node.issue!) : DONE
    const share = node.total === 0 ? 0 : node.done / node.total
    const isClosed = isIssue && (node.issue!.statusType === 'completed' || node.issue!.statusType === 'canceled')
    const isSelected = isIssue && view.selected === node.issue!.id

    if (isIssue) {
      tops[node.issue!.id] = top
    }
    const tooltip = isIssue
      ? `${node.issue!.id} · ${node.issue!.title}\n${node.issue!.status}${node.issue!.priority < 5 ? ` · ${node.issue!.priorityName}` : ''}${node.issue!.assignee !== null ? ` · ${node.issue!.assignee}` : ''}${node.total > 0 ? `\n${node.done}/${node.total} sub-issues done` : ''}`
      : `${node.title}\n${node.sub}`
    const parts = [
      `<g class="n${isClosed ? ' closed' : ''}"><title>${escape(tooltip)}</title>`,
      `<rect class="card${node.kind !== 'issue' ? ' head' : ''}" x="${left}" y="${top}" width="${boxWidth}" height="${BOX_HEIGHT}" rx="7"/>`,
      `<rect x="${left}" y="${top + 6}" width="3" height="${BOX_HEIGHT - 12}" rx="1.5" fill="${accent}"/>`,
    ]

    if (size.isCompact) {
      if (isIssue) {
        parts.push(statusSvg(node.issue!).replace('<svg ', `<svg x="${left + 9}" y="${top + 8}" `))
        parts.push(`<text class="t" x="${left + 27}" y="${top + 19.5}"><tspan class="s">${escape(node.issue!.id)}</tspan> ${escape(clip(node.title, chars - node.issue!.id.length + (node.activity !== null ? -1 : 2)))}</text>`)
      } else {
        parts.push(`<text class="t b" x="${left + 10}" y="${top + 19.5}">${escape(clip(node.title, chars - 6))} <tspan class="s">${escape(node.sub.split(' · ')[0] ?? '')}</tspan></text>`)
      }
    } else if (isIssue) {
      parts.push(statusSvg(node.issue!).replace('<svg ', `<svg x="${left + 10}" y="${top + 6}" `))
      parts.push(`<text class="s" x="${left + 28}" y="${top + 17}">${escape(node.sub)}</text>`)
      linesOf(node.title, chars).forEach((line, index) => {
        parts.push(`<text class="t" x="${left + 10}" y="${top + 32 + index * 13.5}">${escape(line)}</text>`)
      })
    } else {
      parts.push(`<text class="t b" x="${left + 10}" y="${top + 21}">${escape(clip(node.title, chars))}</text>`)
      parts.push(`<text class="s" x="${left + 10}" y="${top + 37}">${escape(node.sub)}</text>`)
    }

    if (node.total > 0 && !size.isCompact) {
      const barWidth = boxWidth - 20

      parts.push(`<rect x="${left + 10}" y="${top + BOX_HEIGHT - 3}" width="${barWidth}" height="2" rx="1" fill="${TODO}" fill-opacity="0.25"/>`)
      parts.push(`<rect x="${left + 10}" y="${top + BOX_HEIGHT - 3}" width="${(barWidth * share).toFixed(1)}" height="2" rx="1" fill="${DONE}"/>`)
    }

    if (node.hidden > 0) {
      parts.push(`<g><rect x="${left + boxWidth + 4}" y="${top + BOX_HEIGHT / 2 - 8}" width="22" height="16" rx="8" class="chip"/><text class="s" x="${left + boxWidth + 15}" y="${top + BOX_HEIGHT / 2 + 4}" text-anchor="middle">+${node.hidden}</text></g>`)
    }

    if (isSelected) {
      parts.push(`<rect x="${left - 1.5}" y="${top - 1.5}" width="${boxWidth + 3}" height="${BOX_HEIGHT + 3}" rx="8.5" fill="none" stroke="${DONE}" stroke-width="2.2"/>`)
    }

    if (node.activity !== null) {
      parts.push(`<rect x="${left - 2}" y="${top - 2}" width="${boxWidth + 4}" height="${BOX_HEIGHT + 4}" rx="9" fill="none" stroke="${AGENT}" stroke-width="2"><animate attributeName="stroke-opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite"/></rect>`)
      parts.push(size.isCompact
        ? `<circle cx="${left + boxWidth - 10}" cy="${top + BOX_HEIGHT / 2}" r="3.5" fill="${AGENT}"><title>${escape(node.activity.agent)}</title></circle>`
        : `<text x="${left + boxWidth - 8}" y="${top + 17}" text-anchor="end" font-size="10.5" font-weight="600" fill="${AGENT}">● ${escape(clip(node.activity.agent, 14))}</text>`)
    }

    parts.push('</g>')
    cards.push(parts.join(''))
  })

  const style = STYLE
  const windowHeight = view.height !== undefined ? Math.max(40, Math.min(view.height, height)) : height
  const windowTop = Math.max(0, Math.min(view.top ?? 0, height - windowHeight))
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${windowHeight}" viewBox="0 ${windowTop} ${width} ${windowHeight}"><style>${style}</style>${edges.join('')}${cards.join('')}</svg>`

  return { source, width, height, nodes: count, cut, tops }
}

const INDENT = 26
const DESCRIPTION_LINES = 4

/**
 * Zoom 3: the visible tree as large cards stacked top to bottom at the
 * pane's width, indented by depth and joined by elbow lines from each
 * parent. A card carries its state, id, priority and assignee, the whole
 * title, its facts and the first lines of its description, so the chart
 * itself is the detail view.
 */
function detailFlowSvg(tree: TreeModel, rows: readonly Row[], slotWidth: number, view: FlowView): Flow {
  const width = Math.max(320, Math.round(slotWidth))
  const parts: string[] = []
  const lines: string[] = []
  const tops: Record<string, number> = {}
  const stack: { depth: number; x: number; bottom: number }[] = []
  let y = PAD
  let count = 0
  let cut = 0

  for (const row of rows) {
    if (count >= 160) {
      cut += 1
      continue
    }

    count += 1

    if (row.kind === 'milestone') {
      stack.length = 0
      const height = 40
      const share = row.total === 0 ? 0 : row.done / row.total
      const barWidth = width - PAD * 2 - 20
      parts.push(`<g><rect class="card head" x="${PAD}" y="${y}" width="${width - PAD * 2}" height="${height}" rx="8"/>`
        + `<text class="t b" x="${PAD + 12}" y="${y + 18}">${escape(row.name)}</text>`
        + `<text class="s" x="${width - PAD - 12}" y="${y + 18}" text-anchor="end">${row.total === 0 ? 'no issues' : `${row.done}/${row.total}${row.targetDate !== null ? ` · ${row.targetDate}` : ''}`}</text>`
        + (row.total > 0 ? `<rect x="${PAD + 12}" y="${y + 28}" width="${barWidth}" height="3" rx="1.5" fill="${TODO}" fill-opacity="0.25"/><rect x="${PAD + 12}" y="${y + 28}" width="${(barWidth * share).toFixed(1)}" height="3" rx="1.5" fill="${DONE}"/>` : '')
        + '</g>')
      stack.push({ depth: -1, x: PAD, bottom: y + height })
      y += height + 10
      continue
    }

    const issue = row.issue
    const depth = Math.max(0, row.prefix.length / 3 - 1)
    const x = PAD + INDENT * (depth + 1)
    const cardWidth = width - x - PAD
    const chars = Math.max(20, Math.floor((cardWidth - 28) / 6.6))
    const title = wrapped([issue.title], chars).slice(0, 3)
    const body = wrapped(plainLines(issue.description).filter(line => line !== ''), chars + 4)
    const description = body.length > DESCRIPTION_LINES ? [...body.slice(0, DESCRIPTION_LINES - 1), `${body[DESCRIPTION_LINES - 1]}…`] : body
    const facts = [issue.status, issue.priority < 5 ? issue.priorityName : '', row.total > 0 ? `${row.done}/${row.total} sub-issues done` : ''].filter(Boolean).join(' · ')
    const height = 30 + title.length * 16 + 16 + (description.length > 0 ? 8 + description.length * 14.5 : 0) + 8
    const accent = stateColor(issue)
    const isClosed = issue.statusType === 'completed' || issue.statusType === 'canceled'

    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]

    if (parent !== undefined) {
      const fromX = parent.x + (parent.depth === -1 ? 14 : 12)
      lines.push(`<path class="e" d="M${fromX} ${parent.bottom}V${y + 18}Q${fromX} ${y + 22} ${fromX + 4} ${y + 22}H${x}"/>`)
    }

    tops[issue.id] = y - PAD
    const card = [
      `<g class="n${isClosed ? ' closed' : ''}">`,
      `<rect class="card" x="${x}" y="${y}" width="${cardWidth}" height="${height}" rx="8"/>`,
      `<rect x="${x}" y="${y + 8}" width="3" height="${height - 16}" rx="1.5" fill="${accent}"/>`,
      statusSvg(issue).replace('<svg ', `<svg x="${x + 12}" y="${y + 10}" `),
      `<text class="s" x="${x + 32}" y="${y + 21}">${escape(issue.id)}</text>`,
      prioritySvg(issue.priority).replace('<svg ', `<svg x="${x + cardWidth - (issue.assignee !== null ? 46 : 26)}" y="${y + 10}" `),
      issue.assignee !== null ? avatarSvg(issue.assignee).replace('<svg ', `<svg x="${x + cardWidth - 26}" y="${y + 9}" `) : '',
      ...title.map((line, index) => `<text class="t b" x="${x + 12}" y="${y + 42 + index * 16}">${escape(line)}</text>`),
      `<text class="s" x="${x + 12}" y="${y + 42 + title.length * 16}">${escape(facts)}</text>`,
      ...description.map((line, index) => `<text class="d" x="${x + 12}" y="${y + 50 + title.length * 16 + 14 + index * 14.5}">${escape(line)}</text>`),
    ]

    if (view.selected === issue.id) {
      card.push(`<rect x="${x - 1.5}" y="${y - 1.5}" width="${cardWidth + 3}" height="${height + 3}" rx="9.5" fill="none" stroke="${DONE}" stroke-width="2.2"/>`)
    }

    if (row.activity !== null) {
      card.push(`<rect x="${x - 2}" y="${y - 2}" width="${cardWidth + 4}" height="${height + 4}" rx="10" fill="none" stroke="${AGENT}" stroke-width="2"><animate attributeName="stroke-opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite"/></rect>`)
      card.push(`<text x="${x + cardWidth - 56}" y="${y + 21}" text-anchor="end" font-size="10.5" font-weight="600" fill="${AGENT}">● ${escape(clip(row.activity.agent, 16))}</text>`)
    }

    card.push('</g>')
    parts.push(card.join(''))
    stack.push({ depth, x, bottom: y + height })
    y += height + 10
  }

  const height = y + PAD - 10
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}.d{fill:#4a4a50;font-size:11.5px}@media (prefers-color-scheme:dark){.d{fill:#b9b9c0}}</style>${lines.join('')}${parts.join('')}</svg>`

  return { source, width, height, nodes: count, cut, tops }
}
