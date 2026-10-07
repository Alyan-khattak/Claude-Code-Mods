// dock-logic.ts — pure functions, zero $ calls, safe to unit-test directly

export function parseSize(s: string): number | null {
  const trimmed = s.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = parseInt(trimmed, 10)
  if (n < 1 || n > 100) return null
  return n
}

export function jobName(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 42) return cleaned
  const cut = cleaned.slice(0, 42)
  const sp = cut.lastIndexOf(' ')
  return (sp > 10 ? cut.slice(0, sp) : cut) + '…'
}

export function initials(description: string): string {
  const words = description.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'AG'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

const COLORS = ['#e07b54', '#d4a855', '#6ab187', '#5b9ed6', '#9b7ec8', '#d66b8a', '#5fada0', '#a0843a']
export function colorFor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]!
}

export function splitInstruction(n: number, helperModel: 'haiku' | 'same'): string {
  const modelNote = helperModel === 'haiku'
    ? 'Helper agents will run on a fast cheap model.'
    : ''
  return `## Agent Dock — split this request across exactly ${n} helpers

Rules (follow precisely):
- Launch exactly ${n} Agent tool calls in ONE message so they run in parallel.
- Find a real split: one helper per item, file, section, store, task or subtopic.
- Give each helper a short plain-English description of 3–5 words, e.g. "Price check: Panera".
- In each helper's prompt include: "As you work, call report_progress with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."
- When all helpers finish, combine their results into one answer.
- Never argue the request cannot be split. Never pad with useless work.
${modelNote}`.trim()
}

export function nudgeText(used: number, total: number): string {
  const remaining = total - used
  return `You used ${used} of ${total} helpers. Split the remaining work across the other ${remaining}, one helper per piece, all in parallel.`
}

export function badgeText(working: number, queued: number, done: number): string {
  const parts: string[] = []
  if (working > 0) parts.push(`${working} working`)
  if (queued > 0) parts.push(`${queued} queued`)
  if (done > 0) parts.push(`${done} done`)
  return parts.length > 0 ? `◆ ${parts.join(' · ')}` : '◆ Dock'
}

export function summaryLine(n: number, job: string, ms: number, stuck: number): string {
  const t = fmtTime(ms)
  const stuckNote = stuck > 0 ? ` (${stuck} got stuck)` : ''
  return `✓ ${n} agent${n !== 1 ? 's' : ''} finished "${job}" in ${t}${stuckNote}`
}

export function meterBar(pct: number, width = 18): string {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) * width / 100)
  return '━'.repeat(filled) + '╌'.repeat(width - filled)
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

export function fmtTimer(startMs: number | null, nowMs: number): string {
  if (startMs === null) return '0:00'
  const s = Math.floor((nowMs - startMs) / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function overallPct(helpers: Array<{ pct: number; status: string }>): number {
  if (helpers.length === 0) return 0
  const sum = helpers.reduce((a, h) => a + (h.status === 'done' ? 100 : h.pct), 0)
  return Math.round(sum / helpers.length)
}

export const ROLE_PRESETS = [
  'Backend', 'Frontend', 'Tester', 'ML Engineer', 'DevOps',
  'Data Analyst', 'Researcher', 'Writer', 'Architect', 'Security', 'Designer',
]

export function nextRole(current: string): string {
  if (!current) return ROLE_PRESETS[0]!
  const i = ROLE_PRESETS.indexOf(current)
  if (i === -1 || i === ROLE_PRESETS.length - 1) return ''
  return ROLE_PRESETS[i + 1]!
}

export function roleInitials(role: string): string {
  const map: Record<string, string> = {
    'Backend': 'BE', 'Frontend': 'FE', 'Tester': 'QA', 'ML Engineer': 'ML',
    'DevOps': 'DV', 'Data Analyst': 'DA', 'Researcher': 'RE', 'Writer': 'WR',
    'Architect': 'AR', 'Security': 'SC', 'Designer': 'DS',
  }
  return map[role] ?? initials(role)
}

export function splitInstructionWithRoles(
  n: number,
  roles: Array<{ name: string; instructions: string }>,
  helperModel: 'haiku' | 'same',
): string {
  const hasRoles = roles.some(r => r.name)
  if (!hasRoles) return splitInstruction(n, helperModel)
  const modelNote = helperModel === 'haiku' ? '\nHelper agents will run on a fast cheap model.' : ''
  const roleLines = roles.map((r, i) => {
    const roleName = r.name || `Helper ${i + 1}`
    const noteStr = r.instructions ? ` Special instructions: "${r.instructions}"` : ''
    return `  - Agent ${i + 1} (${roleName}): approach from the ${roleName} perspective.${noteStr}`
  }).join('\n')
  return `## Agent Dock — split this request across exactly ${n} specialists

Rules (follow precisely):
- Launch exactly ${n} Agent tool calls in ONE message so they run in parallel.
- Assign each agent its specialist role:
${roleLines}
- In each agent's prompt include: "As you work, call report_progress with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."
- When all agents finish, combine their results into one unified answer.
- Never argue the request cannot be split. Never pad with useless work.${modelNote}`.trim()
}
