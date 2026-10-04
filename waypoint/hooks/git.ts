// Pure helpers for the shadow repository: the git argv, the default
// excludes, and parsers for git's output. Everything that calls $ lives in
// register.tsx, since $ is only followed into functions of the same file.

import type { WaypointFileDiff, WaypointRepo } from '../types'

/** Folders that are big, rebuilt from scratch, and never worth a snapshot. */
export const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  'env/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.tox/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  '.gradle/',
  'target/',
  '.dart_tool/',
  'Pods/',
  'coverage/',
  '.cache/',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  // Session Journal's log: a restore must never roll it back.
  '.claude/journal/',
]

/** The argv for one git command against the shadow repository. */
export function gitArgv(repo: WaypointRepo, args: readonly string[]): string[] {
  return ['git', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', `--git-dir=${repo.dir}`, `--work-tree=${repo.work}`, ...args]
}

/** The shadow repository's folder for a project: <home>/<project name>-<hash of its path>. */
export function repoDir(home: string, work: string, hash: string): string {
  const name = (work.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project').replace(/[^\w.-]/g, '_')
  return `${home.replace(/[\\/]+$/, '')}/${name}-${hash}`
}

export type Stats = { files: number; added: number; removed: number }

export function parseNumstat(text: string): Stats {
  let files = 0
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (!m) continue
    files += 1
    added += m[1] === '-' ? 0 : Number(m[1])
    removed += m[2] === '-' ? 0 : Number(m[2])
  }
  return { files, added, removed }
}

/** Splits `git diff` output into one entry per file, hunks only (headers dropped). */
export function parsePatch(text: string): WaypointFileDiff[] {
  const files: WaypointFileDiff[] = []
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n')
    const header = lines[0] ?? ''
    const plus = lines.find(l => l.startsWith('+++ '))
    const minus = lines.find(l => l.startsWith('--- '))
    const fromPlus = plus && plus !== '+++ /dev/null' ? plus.slice(4).replace(/^b\//, '') : undefined
    const fromMinus = minus && minus !== '--- /dev/null' ? minus.slice(4).replace(/^a\//, '') : undefined
    const fromHeader = /^a\/(.*) b\/(.*)$/.exec(header)?.[2]
    const path = fromPlus ?? fromMinus ?? fromHeader ?? header
    const isBinary = lines.some(l => l.startsWith('Binary files '))
    const start = lines.findIndex(l => l.startsWith('@@ '))
    const body = start < 0 ? [] : lines.slice(start).filter(l => l !== '\\ No newline at end of file')
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const added = body.filter(l => l.startsWith('+')).length
    const removed = body.filter(l => l.startsWith('-')).length
    files.push({ path, hunks: body.join('\n'), added, removed, isBinary })
  }
  return files
}

export async function shortHash(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.toLowerCase())))
  return Array.from(bytes.slice(0, 5), b => b.toString(16).padStart(2, '0')).join('')
}
