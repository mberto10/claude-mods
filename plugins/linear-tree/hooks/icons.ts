import type { TreeIssue } from '../types'

export const DONE = '#5E6AD2'
export const STARTED = '#F2C94C'
export const REVIEW = '#4CB782'
export const TODO = '#9B9B9B'
export const CANCELED = '#95A2B3'
export const URGENT = '#F2994A'
export const AGENT = '#D16BD9'

// SVG pieces for the desktop surface.

export function svg(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

/** Linear's state icons: dashed circle (backlog), circle (to do), filling circle (in progress, in review), filled check (done), filled cross (canceled). */
export function statusSvg(issue: TreeIssue): string {
  const c = 'cx="7" cy="7"'

  switch (issue.statusType) {
    case 'completed':
      return svg(14, 14, `<circle ${c} r="6" fill="${DONE}"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)
    case 'canceled':
    case 'duplicate':
      return svg(14, 14, `<circle ${c} r="6" fill="${CANCELED}"/><path d="M5 5l4 4M9 5l-4 4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`)
    case 'started': {
      const isReview = /review/i.test(issue.status)
      const color = isReview ? REVIEW : STARTED
      const arc = isReview ? 'M7 7V2.5A4.5 4.5 0 1 1 2.5 7Z' : 'M7 7V2.5A4.5 4.5 0 0 1 7 11.5Z'

      return svg(14, 14, `<circle ${c} r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/><path d="${arc}" fill="${color}"/>`)
    }
    case 'backlog':
    case 'triage':
      return svg(14, 14, `<circle ${c} r="5.5" fill="none" stroke="${TODO}" stroke-width="1.5" stroke-dasharray="1.8 1.6"/>`)
    default:
      return svg(14, 14, `<circle ${c} r="5.5" fill="none" stroke="${TODO}" stroke-width="1.5"/>`)
  }
}

/** Linear's priority icons: urgent square, then three, two or one bars, or dots for none. */
export function prioritySvg(priority: number): string {
  if (priority === 1) {
    return svg(14, 14, `<rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="${URGENT}"/><path d="M7 4v3.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10" r="0.9" fill="#fff"/>`)
  }

  if (priority >= 5) {
    return svg(14, 14, [3, 7, 11].map(x => `<circle cx="${x}" cy="7" r="1" fill="${TODO}" fill-opacity="0.6"/>`).join(''))
  }

  const lit = 4 - priority + 1

  return svg(14, 14, [0, 1, 2].map(i => {
    const height = 4 + i * 3

    return `<rect x="${1.5 + i * 4}" y="${12 - height}" width="3" height="${height}" rx="0.8" fill="${TODO}" fill-opacity="${i < lit ? 1 : 0.3}"/>`
  }).join(''))
}

function hue(name: string): number {
  let sum = 0

  for (const char of name) {
    sum = (sum * 31 + char.charCodeAt(0)) % 360
  }

  return sum
}

/** A round avatar with initials, colored by name. */
export function avatarSvg(name: string): string {
  const initials = name.split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase()

  return svg(16, 16, `<circle cx="8" cy="8" r="7.5" fill="hsl(${hue(name)} 45% 52%)"/><text x="8" y="10.8" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="7" font-weight="600" fill="#fff">${initials}</text>`)
}

/** A rounded progress bar: done in indigo, in progress in yellow. */
export function progressSvg(done: number, started: number, total: number, width: number): string {
  const inner = width - 2
  const doneWidth = total === 0 ? 0 : (done / total) * inner
  const startedWidth = total === 0 ? 0 : (started / total) * inner

  return svg(width, 8, `<rect x="1" y="1" width="${inner}" height="6" rx="3" fill="${TODO}" fill-opacity="0.22"/>`
    + `<rect x="1" y="1" width="${(doneWidth + startedWidth).toFixed(1)}" height="6" rx="3" fill="${STARTED}"/>`
    + `<rect x="1" y="1" width="${doneWidth.toFixed(1)}" height="6" rx="3" fill="${DONE}"/>`)
}

/** A small progress ring for a milestone. */
export function ringSvg(done: number, total: number): string {
  const share = total === 0 ? 0 : done / total
  const length = 2 * Math.PI * 5.5

  return svg(16, 16, `<circle cx="8" cy="8" r="5.5" fill="none" stroke="${TODO}" stroke-opacity="0.3" stroke-width="2.2"/>`
    + `<circle cx="8" cy="8" r="5.5" fill="none" stroke="${DONE}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${(share * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/>`)
}

/** A pulsing dot for an agent at work. */
export function pulseSvg(): string {
  return svg(12, 12, `<circle cx="6" cy="6" r="5" fill="${AGENT}" fill-opacity="0.25"><animate attributeName="r" values="3;5.5;3" dur="1.6s" repeatCount="indefinite"/></circle><circle cx="6" cy="6" r="3" fill="${AGENT}"/>`)
}

