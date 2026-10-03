export interface Caption {
  /** Seconds. */
  start: number
  end: number
  text: string
}

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/

function seconds(value: string): number {
  const m = TIME.exec(value)
  if (!m) return NaN
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

/** Parses SubRip text. Tolerates missing indexes and Windows line endings. */
export function parseSrt(srt: string): Caption[] {
  const out: Caption[] = []
  for (const block of srt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const timeLine = lines.findIndex((l) => l.includes('-->'))
    if (timeLine < 0) continue
    const [from, to] = lines[timeLine].split('-->')
    const start = seconds(from)
    const end = seconds(to)
    const text = lines
      .slice(timeLine + 1)
      .join('\n')
      .trim()
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) out.push({ start, end, text })
  }
  return out
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function stamp(s: number): string {
  const ms = Math.round(s * 1000)
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

export function formatSrt(captions: Caption[]): string {
  return captions.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')
}
