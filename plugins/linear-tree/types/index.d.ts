export type TreeIssue = {
  id: string
  title: string
  status: string
  statusType: string
  priority: number
  priorityName: string
  parentId: string | null
  milestoneId: string | null
  milestoneName: string | null
  assignee: string | null
  updatedAt: string
  description: string
  url: string
  children: string[]
}

export type TreeMilestone = {
  id: string
  name: string
  targetDate: string | null
  roots: string[]
}

export type TreeModel = {
  project: string
  milestones: TreeMilestone[]
  issues: Record<string, TreeIssue>
  loadedAt: number
}

/** Who is working on an issue right now: the main session or a subagent. */
export type TreeActivity = {
  agentId: string
  agent: string
}

declare module 'claude-code' {
  interface PluginState {
    'linear-tree': {
      model: TreeModel | null
      collapsed: string[]
      status: string
      sort: string
      query: string
      stateFilter: string
      activity: Record<string, TreeActivity>
      searchFolded: string[]
      selected: string | null
      zoom: number
      view: string
      focus: string
      restoredFor: string
      showKeys: boolean
    }
  }
}
