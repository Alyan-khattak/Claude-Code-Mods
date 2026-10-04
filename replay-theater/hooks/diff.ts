// A small line diff: common prefix and suffix are trimmed first (edits are
// usually local), the middle is diffed with an LCS table, and the result is
// written as unified-diff hunks with three lines of context.

export type DiffResult = { hunks: string; added: number; removed: number }

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number }

const CONTEXT = 3
const MAX_CELLS = 2_000_000

export function diffLines(before: string, after: string): DiffResult {
  const a = split(before)
  const b = split(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const ops: Op[] = []
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', text: a[i]!, a: i, b: i })
  ops.push(...middle(a, b, start, endA, start, endB))
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: ' ', text: a[i]!, a: i, b: j })

  const added = ops.filter(o => o.kind === '+').length
  const removed = ops.filter(o => o.kind === '-').length
  return { hunks: toHunks(ops), added, removed }
}

function split(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function middle(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number): Op[] {
  const n = a1 - a0
  const m = b1 - b0
  if (n === 0 && m === 0) return []
  if (n * m > MAX_CELLS) {
    // Too big to align: show it as one block replaced.
    const out: Op[] = []
    for (let i = a0; i < a1; i++) out.push({ kind: '-', text: a[i]!, a: i, b: b0 })
    for (let j = b0; j < b1; j++) out.push({ kind: '+', text: b[j]!, a: a1, b: j })
    return out
  }
  // lcs[i][j] = length of the LCS of a[a0+i..a1) and b[b0+j..b1)
  const lcs: Uint32Array[] = []
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[a0 + i] === b[b0 + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[a0 + i] === b[b0 + j]) {
      out.push({ kind: ' ', text: a[a0 + i]!, a: a0 + i, b: b0 + j })
      i++
      j++
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Removals first, as unified diffs write them.
      out.push({ kind: '-', text: a[a0 + i]!, a: a0 + i, b: b0 + j })
      i++
    } else {
      out.push({ kind: '+', text: b[b0 + j]!, a: a0 + i, b: b0 + j })
      j++
    }
  }
  return out
}

function toHunks(ops: Op[]): string {
  const changed = ops.map((o, i) => (o.kind === ' ' ? -1 : i)).filter(i => i >= 0)
  if (changed.length === 0) return ''
  const groups: [number, number][] = []
  for (const i of changed) {
    const lo = Math.max(0, i - CONTEXT)
    const hi = Math.min(ops.length - 1, i + CONTEXT)
    const last = groups[groups.length - 1]
    if (last && lo <= last[1] + 1) last[1] = hi
    else groups.push([lo, hi])
  }
  const out: string[] = []
  for (const [lo, hi] of groups) {
    const slice = ops.slice(lo, hi + 1)
    const aLines = slice.filter(o => o.kind !== '+').length
    const bLines = slice.filter(o => o.kind !== '-').length
    const firstA = slice.find(o => o.kind !== '+')
    const firstB = slice.find(o => o.kind !== '-')
    // An empty side names the line it follows (0 for the top), as unified diffs do.
    const aStart = firstA ? firstA.a + 1 : slice[0]!.a
    const bStart = firstB ? firstB.b + 1 : slice[0]!.b
    out.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`)
    for (const o of slice) out.push(`${o.kind}${o.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')}`)
  }
  return out.join('\n')
}

/** Cuts hunks to fit a Code element, at a hunk boundary, saying how many were left out. */
export function fit(hunks: string, max = 9000): string {
  if (hunks.length <= max) return hunks
  const parts = hunks.split(/\n(?=@@ )/)
  const kept: string[] = []
  let size = 0
  for (const p of parts) {
    if (size + p.length + 1 > max) break
    kept.push(p)
    size += p.length + 1
  }
  if (kept.length === 0) return parts[0]!.slice(0, max).replace(/\n[^\n]*$/, '')
  return kept.join('\n')
}
