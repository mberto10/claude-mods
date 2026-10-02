/** One open piece of work the suggestions may point at. */
export type WorkItem = {
  source: 'github' | 'linear'
  ref: string
  title: string
  detail: string
  url: string
}

export const DEFAULT_LINEAR_SERVERS = ['claude.ai Linear', 'Linear', 'linear']
const CLOSED_LINEAR_STATES = new Set(['completed', 'canceled', 'duplicate'])
/**
 * The servers whose `list_issues` tool is Linear's, from the tool list as
 * the model sees it: `mcp__<server>__list_issues` named or described as
 * Linear. The desktop app names a connector by an id, the CLI as
 * `claude.ai Linear` (tool spelling `claude_ai_Linear`), so names alone
 * cannot be guessed.
 */
export function linearServersOf(tools: readonly { name: string; description: string }[]): string[] {
  return tools
    .map(tool => ({ tool, match: /^mcp__(.+)__list_issues$/.exec(tool.name) }))
    .filter(({ tool, match }) => match !== null && /linear/i.test(`${tool.name} ${tool.description}`))
    .map(({ match }) => match![1]!)
}

export const LINEAR_FIELDS = ['id', 'title', 'status', 'statusType', 'priority', 'project', 'url']

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
    : []
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `gh issue list --json number,title,url,labels` output as work items. */
export function githubIssuesOf(stdout: string): WorkItem[] {
  return recordsOf(parsed(stdout)).map(issue => {
    const labels = recordsOf(issue.labels).map(label => stringOf(label.name)).filter(Boolean)

    return {
      source: 'github',
      ref: `#${String(issue.number)}`,
      title: stringOf(issue.title),
      detail: labels.length > 0 ? `issue, ${labels.join(', ')}` : 'issue',
      url: stringOf(issue.url),
    }
  })
}

/** `gh pr list --json number,title,url,isDraft` output as work items. */
export function githubPullsOf(stdout: string): WorkItem[] {
  return recordsOf(parsed(stdout)).map(pull => ({
    source: 'github',
    ref: `#${String(pull.number)}`,
    title: stringOf(pull.title),
    detail: pull.isDraft === true ? 'draft pull request' : 'pull request',
    url: stringOf(pull.url),
  }))
}

const STATE_RANK: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3 }

/**
 * The Linear MCP server's `list_issues` text as work items in one of the
 * `states` (state types), most important first: started before unstarted
 * before backlog, then urgent before high, medium, low and no priority,
 * then as listed (most recently updated first).
 */
export function linearIssuesOf(text: string, states: readonly string[] = ['started', 'unstarted', 'backlog', 'triage']): WorkItem[] {
  const answer = parsed(text)
  const issues = typeof answer === 'object' && answer !== null && 'issues' in answer ? answer.issues : answer

  return recordsOf(issues)
    .filter(issue => states.includes(stringOf(issue.statusType)) && !CLOSED_LINEAR_STATES.has(stringOf(issue.statusType)))
    .map((issue, index) => {
      const priority = typeof issue.priority === 'object' && issue.priority !== null ? issue.priority as Record<string, unknown> : {}
      const name = stringOf(priority.name)
      const value = typeof priority.value === 'number' && priority.value > 0 ? priority.value : 5
      const detail = [stringOf(issue.status), name === 'No priority' ? '' : name, stringOf(issue.project)]
        .filter(Boolean)
        .join(', ')
      const item: WorkItem = {
        source: 'linear',
        ref: stringOf(issue.id),
        title: stringOf(issue.title),
        detail,
        url: stringOf(issue.url),
      }

      return { item, key: [STATE_RANK[stringOf(issue.statusType)] ?? 4, value, index] }
    })
    .sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.key[2]! - b.key[2]!)
    .map(one => one.item)
}
