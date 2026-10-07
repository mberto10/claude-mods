import type { TreeActivity, TreeIssue, TreeModel } from '../types'
import { flowSvg } from './flow'
import { fit, plainLines, wrapped } from './text'
import { AGENT, avatarSvg, CANCELED, DONE, prioritySvg, progressSvg, pulseSvg, ringSvg, STARTED, statusSvg, TODO, URGENT } from './icons'
import { barOf, type Row, STATE_FILTER_LABELS, STATE_FILTERS } from './tree'

/** The surface's element table, as `$.ui.resolve(e)` answers it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ui = Record<string, any>

export type PaneActions = {
  toggle: (id: string) => void
  press: (issue: TreeIssue) => void
  setStates: (value: string) => void
  search: (value: string) => void
  step: (by: number) => void
  close: () => void
  work: (issue: TreeIssue) => void
  workSelected: () => void
  openDetails: () => void
  toggleView: () => void
  zoom: (step: number) => void
  /** One step on the views: 0 the list, 1 to 3 the flowchart's zoom levels. */
  level: (step: number) => void
  fold: (isOpen: boolean) => void
  focusSearch: () => void
  cycleFilter: () => void
  refresh: () => void
  toggleKeys: () => void
}

/**
 * The shortcut overview: plain buttons whose hotkeys work while the pane
 * holds the keyboard. Folded away it stays mounted, hidden, so the keys
 * still work; the Shortcuts button shows it.
 */
function keysLine(ui: Ui, actions: PaneActions, isList: boolean, isShown: boolean, extra: [string, string, () => void][] = []) {
  const { Box, Button } = ui
  const keys: [string, string, () => void][] = [
    ['j', 'next', () => actions.step(1)],
    ['k', 'previous', () => actions.step(-1)],
    ...(isList
      ? [
        ['h', 'fold', () => actions.fold(false)],
        ['l', 'unfold', () => actions.fold(true)],
        ['s', 'search', actions.focusSearch],
        ['f', 'filter', actions.cycleFilter],
      ] as [string, string, () => void][]
      : []),
    ['o', 'work on it', actions.workSelected],
    ['d', 'details', actions.openDetails],
    ['v', isList ? 'flowchart' : 'list', actions.toggleView],
    ['r', 'refresh', actions.refresh],
    ...extra,
  ]

  return (
    <Box key="keys" gap={2} flexWrap="wrap" display={isShown ? 'flex' : 'none'}>
      {keys.map(([hotkey, label, onPress]) => (
        <Button key={`key:${hotkey}`} plain dimColor hotkey={hotkey} label={label} onPress={onPress} />
      ))}
    </Box>
  )
}

const LEVELS = ['list', 'overview', 'normal', 'detail']

/** − list / overview / normal / detail +: the list, then the flowchart from far to near. */
function levelStepper(ui: Ui, level: number, actions: PaneActions) {
  const { Box, Button, Text } = ui

  return (
    <Box key="levels" alignItems="center">
      <Button key="level:out" plain dimColor={level === 0} label=" − " onPress={() => actions.level(level - 1)} />
      <Text dimColor>{` ${LEVELS[level] ?? ''} `}</Text>
      <Button key="level:in" plain dimColor={level === LEVELS.length - 1} label=" + " onPress={() => actions.level(level + 1)} />
    </Box>
  )
}

/** The selected issue as the info box shows it. */
export type Info = {
  issue: TreeIssue
  milestone: string | null
  activity: TreeActivity | null
}


export type PaneData = {
  surface: string
  columns: number
  tree: TreeModel
  rows: Row[]
  states: string
  query: string
  status: string
  activity: Record<string, TreeActivity>
  focusName: string | null
  selected: string | null
  info: Info | null
  showKeys: boolean
}


function counts(tree: TreeModel): { done: number; started: number; total: number } {
  let done = 0
  let started = 0
  let total = 0

  for (const issue of Object.values(tree.issues)) {
    if (issue.statusType === 'canceled' || issue.statusType === 'duplicate') {
      continue
    }

    total += 1
    done += issue.statusType === 'completed' ? 1 : 0
    started += issue.statusType === 'started' ? 1 : 0
  }

  return { done, started, total }
}

/** The details pane: the selected issue's title, facts and whole description, with its actions. */
export function detailsPane(ui: Ui, info: Info | null, columns: number, isTerminal: boolean, actions: PaneActions) {
  const { Box, Button, Link, Text } = ui

  if (info === null) {
    return <Text dimColor>Select an issue in /tree (click or j/k) to see it here.</Text>
  }

  const inner = Math.max(30, columns - 2)
  const issue = info.issue
  const facts = [
    issue.status,
    issue.priority < 5 ? issue.priorityName : '',
    issue.assignee ?? '',
    info.milestone ?? '',
  ].filter(Boolean).join(' · ')
  const body = wrapped(plainLines(issue.description), inner)

  return (
    <Box key="info" flexDirection="column">
      <Box alignItems="center">
        <Text dimColor>{issue.id}</Text>
        {info.activity !== null && <Text color={AGENT}>{`  ● ${info.activity.agent}`}</Text>}
        <Box flexGrow={1} />
        <Button key="info:prev" plain label=" ‹ " onPress={() => actions.step(-1)} />
        <Button key="info:next" plain label=" › " onPress={() => actions.step(1)} />
        <Button key="info:close" plain hotkey="x" label=" × " onPress={actions.close} />
      </Box>
      {wrapped([issue.title], inner).map((line, index) => <Text key={`info:t${index}`} bold>{line}</Text>)}
      <Text dimColor>{facts}</Text>
      <Box marginTop={1} gap={2} alignItems="center">
        <Button key="info:work" plain={isTerminal ? true : undefined} variant="primary" hotkey="o" label="Work on it" onPress={() => actions.work(issue)} />
        {Link !== undefined && issue.url !== '' && <Link href={issue.url} label="Open in Linear" />}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {body.length === 0
          ? <Text dimColor>No description.</Text>
          : body.map((line, index) => <Text key={`info:d${index}`}>{line === '' ? ' ' : line}</Text>)}
      </Box>
    </Box>
  )
}


function desktopPane(ui: Ui, data: PaneData, actions: PaneActions) {
  const { Box, Button, Input, Select, Svg, Text } = ui
  const { tree, rows, columns } = data
  const total = counts(tree)
  const agents = new Set(Object.entries(data.activity).filter(([id]) => tree.issues[id] !== undefined).map(([, who]) => who.agentId)).size
  const barWidth = Math.max(160, Math.min(640, columns * 7 - 16))
  return (
    <Box flexDirection="column">
      <Box alignItems="center">
        <Text bold>{fit(data.focusName !== null ? `${tree.project} · ${data.focusName}` : tree.project, columns - 26)}</Text>
        <Box flexGrow={1} />
        {agents > 0 && (
          <Box alignItems="center">
            <Svg source={pulseSvg()} alt="agents at work" width={12} height={12} />
            <Text color={AGENT}>{` ${agents}   `}</Text>
          </Box>
        )}
        <Text dimColor>{`${total.done}/${total.total}   `}</Text>
        {levelStepper(ui, 0, actions)}
      </Box>
      <Svg source={progressSvg(total.done, total.started, total.total, barWidth)} alt={`${total.done} of ${total.total} done, ${total.started} in progress`} width={barWidth} height={8} />
      <Box marginTop={1} gap={1} alignItems="center">
        <Box flexGrow={1}>
          <Input
            key="search"
            placeholder="Search"
            value={data.query}
            onInput={(value: string) => actions.search(value)}
            onSubmit={(value: string) => actions.search(value)}
          />
        </Box>
        <Button key="keys:toggle" plain dimColor={!data.showKeys} label={data.showKeys ? 'Shortcuts ▴' : 'Shortcuts ▾'} onPress={actions.toggleKeys} />
        <Select
          key="states"
          value={data.states}
          options={STATE_FILTERS.map(value => ({ value, label: STATE_FILTER_LABELS[value] ?? value }))}
          onSelect={(value: string) => actions.setStates(value)}
        />
      </Box>
      {keysLine(ui, actions, true, data.showKeys)}
      {data.status !== '' && <Text dimColor>{fit(data.status, columns)}</Text>}
      {rows.length === 0 && <Text dimColor>Nothing matches.</Text>}
      {rows.flatMap(row => {
        if (row.kind === 'milestone') {
          return (
            <Box key={`row:m:${row.id}`} marginTop={1} alignItems="center">
              <Button key={`t:m:${row.id}`} plain label={row.isEmpty ? '   ' : row.isOpen ? ' ▾ ' : ' ▸ '} onPress={() => actions.toggle(`m:${row.id}`)} />
              <Svg source={ringSvg(row.done, row.total)} alt={`${row.done} of ${row.total} done`} width={16} height={16} />
              <Text bold>{` ${fit(row.name, columns - 30)}`}</Text>
              {row.targetDate !== null && <Text dimColor>{`  ${row.targetDate}`}</Text>}
              <Box flexGrow={1} />
              {!row.isOpen && row.activeBelow > 0 && <Text color={AGENT}>{`● ${row.activeBelow}  `}</Text>}
              <Text dimColor>{row.total === 0 ? 'no issues' : `${row.done}/${row.total}`}</Text>
            </Box>
          )
        }

        const issue = row.issue
        const closed = issue.statusType === 'completed' || issue.statusType === 'canceled' || issue.statusType === 'duplicate'
        const guide = '    '.repeat(Math.max(0, row.prefix.length / 3 - 1))
        const room = columns - guide.length - issue.id.length - 22 - (row.activity !== null ? row.activity.agent.length + 3 : 0)

        const element = (
          <Box key={`row:${row.id}`} alignItems="center" hover={{ backgroundColor: '#8881' }} {...(data.selected === row.id ? { backgroundColor: '#5E6AD233' } : {})}>
            <Text dimColor>{guide}</Text>
            {row.hasChildren
              ? <Button key={`t:${row.id}`} plain label={row.isOpen ? ' ▾ ' : ' ▸ '} onPress={() => actions.toggle(row.id)} />
              : <Text>{'   '}</Text>}
            <Svg source={statusSvg(issue)} alt={issue.status} width={14} height={14} />
            <Text dimColor>{` ${issue.id}  `}</Text>
            <Button key={`i:${row.id}`} plain dimColor={closed && !row.isMatch} label={fit(issue.title, Math.max(12, room))} onPress={() => actions.press(issue)} />
            {row.activity !== null && (
              <Box>
                <Text> </Text>
                <Svg source={pulseSvg()} alt={`${row.activity.agent} is working on it`} width={12} height={12} isInteractive />
                <Text color={AGENT}>{` ${row.activity.agent}`}</Text>
              </Box>
            )}
            {row.activity === null && !row.isOpen && row.activeBelow > 0 && <Text color={AGENT}>{`  ● ${row.activeBelow}`}</Text>}
            <Box flexGrow={1} />
            {row.hasChildren && row.total > 0 && <Text dimColor>{`${row.done}/${row.total}  `}</Text>}
            <Svg source={prioritySvg(issue.priority)} alt={issue.priorityName || 'No priority'} width={14} height={14} />
            <Text> </Text>
            {issue.assignee !== null
              ? <Svg source={avatarSvg(issue.assignee)} alt={issue.assignee} width={16} height={16} />
              : <Text>{'  '}</Text>}
          </Box>
        )

        return [element]
      })}
    </Box>
  )
}

const TEXT_STATUS: Record<string, { glyph: string; color?: string }> = {
  completed: { glyph: '✔', color: DONE },
  canceled: { glyph: '✕', color: CANCELED },
  duplicate: { glyph: '✕', color: CANCELED },
  started: { glyph: '◐', color: STARTED },
  backlog: { glyph: '◌', color: TODO },
  triage: { glyph: '◌', color: TODO },
  unstarted: { glyph: '○', color: TODO },
}

const TEXT_PRIORITY: Record<number, { glyph: string; color?: string }> = {
  1: { glyph: '‼', color: URGENT },
  2: { glyph: '▮▮▮' },
  3: { glyph: '▮▮▯' },
  4: { glyph: '▮▯▯' },
}

function terminalPane(ui: Ui, data: PaneData, actions: PaneActions) {
  const { Box, Button, Input, Text } = ui
  const { tree, rows, columns } = data
  const total = counts(tree)
  const agents = new Set(Object.entries(data.activity).filter(([id]) => tree.issues[id] !== undefined).map(([, who]) => who.agentId)).size
  const width = 16
  const doneCells = total.total === 0 ? 0 : Math.round((total.done / total.total) * width)
  const startedCells = total.total === 0 ? 0 : Math.round((total.started / total.total) * width)
  const next = STATE_FILTERS[(STATE_FILTERS.indexOf(data.states as never) + 1) % STATE_FILTERS.length]!

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{fit(data.focusName !== null ? `${tree.project} · ${data.focusName}` : tree.project, columns - 30)}</Text>
        <Text>{'  '}</Text>
        <Text color={DONE}>{'━'.repeat(doneCells)}</Text>
        <Text color={STARTED}>{'━'.repeat(Math.min(startedCells, width - doneCells))}</Text>
        <Text dimColor>{'━'.repeat(Math.max(0, width - doneCells - startedCells))}</Text>
        <Text dimColor>{`  ${total.done}/${total.total}`}</Text>
        {agents > 0 && <Text color={AGENT}>{`  ● ${agents}`}</Text>}
      </Box>
      <Box>
        <Button key="states" plain label={STATE_FILTER_LABELS[data.states] ?? data.states} onPress={() => actions.setStates(next)} />
        <Text dimColor>{'  '}</Text>
        <Box flexGrow={1}>
          <Input
            key="search"
            placeholder="search"
            value={data.query}
            onInput={(value: string) => actions.search(value)}
            onSubmit={(value: string) => actions.search(value)}
          />
        </Box>
        <Text dimColor>{'  '}</Text>
        <Button key="keys:toggle" plain label={data.showKeys ? 'shortcuts ▴' : 'shortcuts ▾'} onPress={actions.toggleKeys} />
      </Box>
      {keysLine(ui, actions, true, data.showKeys)}
      {data.status !== '' && <Text dimColor>{fit(data.status, columns)}</Text>}
      {rows.length === 0 && <Text dimColor>Nothing matches.</Text>}
      {rows.flatMap(row => {
        if (row.kind === 'milestone') {
          return (
            <Box key={`row:m:${row.id}`} marginTop={1}>
              <Button key={`t:m:${row.id}`} plain label={row.isEmpty ? ' ' : row.isOpen ? '▾' : '▸'} onPress={() => actions.toggle(`m:${row.id}`)} />
              <Text bold>{` ${fit(row.name, columns - 34)}`}</Text>
              {row.targetDate !== null && <Text dimColor>{`  ${row.targetDate}`}</Text>}
              <Text dimColor>{row.total === 0 ? '  no issues' : `  ${barOf(row.done, row.total, 8)} ${row.done}/${row.total}`}</Text>
              {!row.isOpen && row.activeBelow > 0 && <Text color={AGENT}>{`  ● ${row.activeBelow}`}</Text>}
            </Box>
          )
        }

        const issue = row.issue
        const closed = issue.statusType === 'completed' || issue.statusType === 'canceled' || issue.statusType === 'duplicate'
        const status = TEXT_STATUS[issue.statusType] ?? { glyph: '○', color: TODO }
        const priority = TEXT_PRIORITY[issue.priority]
        const tail = row.hasChildren && row.total > 0 ? `${row.done}/${row.total}` : ''
        const room = columns - row.prefix.length - issue.id.length - tail.length - 16 - (row.activity !== null ? row.activity.agent.length + 3 : 0)

        const element = (
          <Box key={`row:${row.id}`}>
            <Text dimColor>{row.prefix}</Text>
            {row.hasChildren
              ? <Button key={`t:${row.id}`} plain label={row.isOpen ? '▾' : '▸'} onPress={() => actions.toggle(row.id)} />
              : <Text> </Text>}
            <Text color={status.color}>{` ${status.glyph} `}</Text>
            <Text dimColor>{`${issue.id} `}</Text>
            <Button key={`i:${row.id}`} plain dimColor={closed && !row.isMatch} label={fit(issue.title, Math.max(12, room))} onPress={() => actions.press(issue)} />
            {row.activity !== null && <Text color={AGENT}>{`  ● ${row.activity.agent}`}</Text>}
            {row.activity === null && !row.isOpen && row.activeBelow > 0 && <Text color={AGENT}>{`  ● ${row.activeBelow}`}</Text>}
            {tail !== '' && <Text dimColor>{`  ${tail}`}</Text>}
            {priority !== undefined && <Text color={priority.color} dimColor={priority.color === undefined}>{`  ${priority.glyph}`}</Text>}
          </Box>
        )

        return [element]
      })}
    </Box>
  )
}

export type FlowData = {
  surface: string
  columns: number
  tree: TreeModel
  rows: Row[]
  states: string
  focusName: string | null
  status: string
  selected: string | null
  zoom: number
  showKeys: boolean
}

/**
 * The flowchart pane: the chart with the selected card outlined, and the
 * details of that card above it. The chart is a picture, so cards are
 * chosen with ‹ › in the details or by selecting an issue in the list.
 */
export function flowPane(ui: Ui, data: FlowData, actions: PaneActions) {
  const { Box, Button, Svg, Text } = ui
  const title = data.focusName !== null ? `${data.tree.project} · ${data.focusName}` : data.tree.project
  const issues = data.rows.filter(row => row.kind === 'issue').length

  if (data.surface === 'terminal' || Svg === undefined) {
    return <Text dimColor>The flowchart needs the desktop app; /tree shows the list here.</Text>
  }

  const total = counts(data.tree)
  const flow = flowSvg(data.tree, data.rows, Math.max(360, data.columns * 7), total.done, total.total, { selected: data.selected, zoom: data.zoom })

  return (
    <Box flexDirection="column">
      <Box alignItems="center">
        <Text bold>{fit(title, data.columns - 40)}</Text>
        <Box flexGrow={1} />
        <Text dimColor>{`${issues} ${STATE_FILTER_LABELS[data.states]?.toLowerCase() ?? ''}   `}</Text>
        <Button key="keys:toggle" plain dimColor={!data.showKeys} label={data.showKeys ? 'Shortcuts ▴' : 'Shortcuts ▾'} onPress={actions.toggleKeys} />
        <Text>{'   '}</Text>
        {levelStepper(ui, data.zoom, actions)}
      </Box>
      {keysLine(ui, actions, false, data.showKeys, [
        ['0', 'list', () => actions.level(0)],
        ['1', 'overview', () => actions.zoom(1)],
        ['2', 'normal', () => actions.zoom(2)],
        ['3', 'detail', () => actions.zoom(3)],
      ])}
      {data.status !== '' && <Text dimColor>{fit(data.status, data.columns)}</Text>}
      {issues === 0
        ? <Text dimColor>Nothing to draw.</Text>
        : <Svg source={flow.source} alt={`Flowchart of ${title}: ${flow.nodes} cards`} />}
      {flow.cut > 0 && <Text dimColor>{`${flow.cut} more not drawn: /flow <milestone> shows one milestone.`}</Text>}
    </Box>
  )
}

/** The pane: graphics on the desktop, a text tree elsewhere. */
export function paneView(ui: Ui, data: PaneData, actions: PaneActions) {
  return data.surface === 'desktop' && ui.Svg !== undefined && ui.Select !== undefined
    ? desktopPane(ui, data, actions)
    : terminalPane(ui, data, actions)
}
