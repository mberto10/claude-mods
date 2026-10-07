/** Text cut to `width` characters with an ellipsis. */
export function fit(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value
}

/** Markdown as plain lines: headings, emphasis, code marks and link targets dropped, bullets kept. */
export function plainLines(markdown: string | undefined): string[] {
  return (markdown ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map(line => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '• ')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
      .trimEnd())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
}

/** Lines wrapped to `width` characters at word boundaries. */
export function wrapped(lines: readonly string[], width: number): string[] {
  const out: string[] = []

  for (const line of lines) {
    if (line === '') {
      out.push('')
      continue
    }

    let current = ''

    for (const word of line.split(/\s+/)) {
      if (current !== '' && `${current} ${word}`.length > width) {
        out.push(current)
        current = word.length > width ? fit(word, width) : word
      } else {
        current = current === '' ? (word.length > width ? fit(word, width) : word) : `${current} ${word}`
      }
    }

    out.push(current)
  }

  return out
}
