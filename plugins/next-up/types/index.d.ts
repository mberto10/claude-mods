export type NextStepSource = 'continue' | 'github' | 'linear'

export type NextStep = {
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
