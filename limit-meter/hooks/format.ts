// Pure formatting for Limit Meter: labels, bars, colors and countdowns.

import type { LimitReading } from '../types'

export function label(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'spend_limit') return 'Spend'
  const m = /^seven_day_(\w+)$/.exec(kind)
  if (m) return `Weekly ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`
  return kind.replace(/_/g, ' ')
}

/** Short label for the one-line band. */
export function shortLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'week'
  if (kind === 'spend_limit') return 'spend'
  const m = /^seven_day_(\w+)$/.exec(kind)
  return m ? `week ${m[1]}` : kind.replace(/_/g, ' ')
}

export function color(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 75) return 'magenta'
  if (percent >= 50) return 'yellow'
  return 'green'
}

export function bar(percent: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((Math.min(percent, 100) / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function pct(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`
}

/** "42m", "2h 13m", or past a day "Thu 09:00". */
export function untilReset(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'resetting'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return when(resetsAt)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

/** "Thu 09:00" in local time. */
export function when(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function day(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** Short windows first: 5-hour, then weekly ones, then the rest. */
export function order(limits: readonly LimitReading[]): LimitReading[] {
  const rank = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : k.startsWith('seven_day') ? 2 : 3)
  return [...limits].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
}

/** The warning thresholds a reading has crossed, highest last. */
export function crossed(percent: number): number[] {
  return [75, 90, 100].filter(t => percent >= t)
}