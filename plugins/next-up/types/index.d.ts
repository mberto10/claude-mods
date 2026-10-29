export type NextStepSource = 'continue' | 'github' | 'linear'

/** What kind of next move a step is; `issue` starts a Linear or GitHub item. */
export type NextStepKind = 'continue' | 'verify' | 'ship' | 'issue'

export type NextStep = {
  /** Null when the ranker gave no kind, or one outside the set: the row shows no tag. */
  kind: NextStepKind | null
  label: string
  prompt: string
  source: NextStepSource
  ref: string | null
  why: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'next-up': { steps: NextStep[]; isThinking: boolean }
  }
}
