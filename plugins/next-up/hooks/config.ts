/** The per-project criteria, kept in `.claude/next-up.json` at the project root. */
export type ProjectConfig = {
  mode?: string
  linear?: {
    projects?: string[]
    team?: string
    labels?: string[]
    states?: string[]
    assignee?: string
    query?: string
  }
  github?: {
    items?: string
    labels?: string[]
    assignee?: string
  }
}

export const CONFIG_PATH = '.claude/next-up.json'

/** Open Linear state types, in the order they rank. */
export const OPEN_STATES = ['started', 'unstarted', 'backlog', 'triage']

const LIST_KEYS: Record<string, string> = { project: 'projects', projects: 'projects', label: 'labels', labels: 'labels', states: 'states', state: 'states' }
const TEXT_KEYS: Record<string, readonly string[]> = {
  linear: ['team', 'assignee', 'query'],
  github: ['items', 'assignee'],
}

/** The file's text as a config; an unreadable file counts as empty. */
export function configOf(text: string | null): ProjectConfig {
  if (text === null) {
    return {}
  }

  try {
    const value: unknown = JSON.parse(text)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ProjectConfig) : {}
  } catch {
    return {}
  }
}

/**
 * Applies `/next linear project Applied Attention` and the like: a section,
 * a key and a value; "off" clears the key, lists are comma-separated.
 * Answers the new config, or why the command was not understood.
 */
export function withSetting(config: ProjectConfig, section: string, key: string, value: string): ProjectConfig | string {
  if (section !== 'linear' && section !== 'github') {
    return `Unknown section "${section}": linear or github.`
  }

  const listKey = section === 'github' && (key === 'states' || key === 'state' || key.startsWith('project')) ? undefined : LIST_KEYS[key]
  const isText = TEXT_KEYS[section]!.includes(key)

  if (listKey === undefined && !isText) {
    const keys = section === 'linear' ? 'project, team, label, states, assignee, query' : 'items, label, assignee'

    return `Unknown ${section} setting "${key}": ${keys}.`
  }

  const name = listKey ?? key
  const current = { ...(config[section] ?? {}) } as Record<string, unknown>
  const trimmed = value.trim()

  if (trimmed === '' || trimmed === 'off') {
    delete current[name]
  } else {
    current[name] = listKey !== undefined ? trimmed.split(',').map(one => one.trim()).filter(Boolean) : trimmed
  }

  return { ...config, [section]: current }
}

/** One line describing the criteria in force. */
export function summaryOf(config: ProjectConfig, mode: string): string {
  const linear = config.linear ?? {}
  const github = config.github ?? {}
  const parts = [
    `mode ${mode}`,
    `Linear: ${linear.projects?.length ? `projects ${linear.projects.join(', ')}` : 'all projects'}`
      + (linear.team ? `, team ${linear.team}` : '')
      + (linear.labels?.length ? `, labels ${linear.labels.join(', ')}` : '')
      + `, states ${(linear.states?.length ? linear.states : OPEN_STATES).join(', ')}`
      + `, assignee ${linear.assignee ?? 'me'}`
      + (linear.query ? `, query "${linear.query}"` : ''),
    `GitHub: ${github.items ?? 'issues-and-prs'}`
      + (github.labels?.length ? `, labels ${github.labels.join(', ')}` : '')
      + (github.assignee ? `, assignee ${github.assignee}` : ''),
  ]

  return parts.join('. ')
}
