import type { NextStep, NextStepSource } from '../types'
import type { WorkItem } from './sources'

const MAX_STEPS = 3
const TITLE_CHARS = 90
const DIGEST_CHARS = 1500
const ALL_SOURCES: readonly NextStepSource[] = ['continue', 'github', 'linear']

export const MODES = ['linear', 'github', 'conversation'] as const
export type Mode = (typeof MODES)[number]

/** The mode when none is set, or when the one set is not a mode. */
export const DEFAULT_MODE: Mode = 'conversation'

/** A mode name, or null when the text is not one. */
export function modeOf(text: string): Mode | null {
  const name = text.trim().toLowerCase()

  return (MODES as readonly string[]).includes(name) ? (name as Mode) : null
}

/** The one step source a mode draws on. */
export function sourceOf(mode: Mode): NextStepSource {
  switch (mode) {
    case 'linear':
      return 'linear'
    case 'github':
      return 'github'
    case 'conversation':
      return 'continue'
  }
}

/** True when the answer ends by asking the person something. */
export function asksPerson(answer: string): boolean {
  return /\?\s*$/.test(answer.trim())
}

/** An answer shorter than this, in characters, gets no steps. */
export const MIN_ANSWER_CHARS = 200

/** From this share of a rate-limit window on, in percent, the ranker is not called. */
export const USAGE_LIMIT_PERCENT = 90

/** What `shouldRank` decides from: a finished turn and the session's rate-limit windows. */
export type RankSignals = {
  answer: string
  reason: string
  isAborted: boolean
  agentId?: string
  rateLimits: readonly { percentUsed: number }[]
}

/**
 * Whether a finished turn is worth calling the ranker for: a main-loop
 * answer, not interrupted, not a question to the person, at least
 * MIN_ANSWER_CHARS long, with every rate-limit window below
 * USAGE_LIMIT_PERCENT.
 */
export function shouldRank(turn: RankSignals): boolean {
  return turn.agentId === undefined
    && turn.reason === 'answer'
    && !turn.isAborted
    && turn.answer.trim().length >= MIN_ANSWER_CHARS
    && !asksPerson(turn.answer)
    && turn.rateLimits.every(window => window.percentUsed < USAGE_LIMIT_PERCENT)
}

function clipped(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat
}

/** The newest `perSource` items of each source, titles shortened. */
export function budgeted(items: readonly WorkItem[], perSource: number): WorkItem[] {
  const counts: Record<string, number> = {}

  return items
    .filter(item => {
      counts[item.source] = (counts[item.source] ?? 0) + 1

      return counts[item.source]! <= perSource
    })
    .map(item => ({ ...item, title: clipped(item.title, TITLE_CHARS) }))
}

/** The last exchange, shortened, so the model that picks the steps needs no transcript. */
export function digestOf(prompt: string, answer: string): string {
  const half = Math.floor(DIGEST_CHARS / 2)

  return `The person asked: ${clipped(prompt, half) || '(unknown)'}\nThe assistant answered: ${clipped(answer, half)}`
}

const GOALS: Record<Mode, string> = {
  linear: 'Return up to three Linear items. Prefer items related to the current work; otherwise keep the given order, which lists the most important first. Do not suggest anything that is not one of these items.',
  github: 'Return up to three GitHub items. Prefer items related to the current work; otherwise keep the given order, which lists pull requests first, then the newest issues. Do not suggest anything that is not one of these items.',
  conversation: 'Return up to three natural continuations of what was just done. Make the steps clearly different from one another.',
}

const RESTRAINT = 'When no step clearly fits the current work, answer []. Never pad to three; fewer steps are fine.'

/** The question that picks the steps; `digest` is the last exchange. */
export function rankPromptOf(items: readonly WorkItem[], mode: Mode, digest: string): string {
  const allowed = sourceOf(mode)
  const listed = items.filter(item => item.source === allowed)
  const list = listed.length === 0
    ? '(none)'
    : listed.map(item => `- ${item.source} ${item.ref}: ${item.title}${item.detail !== '' ? ` [${item.detail}]` : ''}`).join('\n')

  return [
    `Suggest what the person could do next in a coding session.\n\n${digest}`,
    GOALS[mode],
    RESTRAINT,
    'Write each step as the prompt the person would send the assistant: an instruction, at most 30 words, self-contained, naming the item\'s id when it is about one. Do not suggest something already done.',
    ...(mode === 'conversation' ? [] : ['', 'Open work items:', list]),
    '',
    'Answer with JSON only, no prose:',
    `[{"label": "<at most 60 characters>", "prompt": "<the prompt>", "source": "${allowed}", "ref": "<item id, or null>", "why": "<why this one, at most 8 words>"}]`,
  ].join('\n')
}

/**
 * The model's answer as at most three valid steps from the mode's source.
 * A step naming another source is dropped; one naming none is the mode's.
 */
export function stepsOf(text: string, mode: Mode = DEFAULT_MODE): NextStep[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')

  if (start === -1 || end <= start) {
    return []
  }

  let value: unknown

  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }

  if (!Array.isArray(value)) {
    return []
  }

  const allowed = sourceOf(mode)
  const steps: NextStep[] = []

  for (const one of value) {
    if (typeof one !== 'object' || one === null) {
      continue
    }

    const { label, prompt, source, ref, why } = one as Record<string, unknown>

    if (typeof label !== 'string' || typeof prompt !== 'string' || label.trim() === '' || prompt.trim() === '') {
      continue
    }

    if (ALL_SOURCES.includes(source as NextStepSource) && source !== allowed) {
      continue
    }

    steps.push({
      label: label.trim().slice(0, 80),
      prompt: prompt.trim(),
      source: allowed,
      ref: typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : null,
      why: typeof why === 'string' && why.trim() !== '' ? clipped(why, 70) : null,
    })
  }

  return steps.slice(0, MAX_STEPS)
}

/** The index a prompt of just "1", "2" or "3" picks, or null. */
export function pickOf(text: string, count: number): number | null {
  const match = /^\s*([1-9])\s*$/.exec(text)

  if (match === null) {
    return null
  }

  const index = Number(match[1]) - 1

  return index < count ? index : null
}
