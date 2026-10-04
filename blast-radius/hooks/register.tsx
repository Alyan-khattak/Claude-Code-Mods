// Blast Radius: before Claude runs a destructive shell command, hold it,
// work out what it would delete or overwrite, show that, and ask
// Proceed or Cancel. Cancel refuses the call and tells Claude why.
//
// A safety net, not a permission system: it reads the command text, so a
// script that deletes files, an alias or $(...) gets past it. Use permission
// rules in settings for a hard block. Set BLAST_RADIUS=off to switch it off.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { BlastReport } from '../types'

const PANE = 'blast-radius'
const MAX_LINES = 40
const WALK_LIMIT = 20_000

const held = atom({ plugin: 'blast-radius', key: 'held' } as const, null)
const interactive = atom({ plugin: 'blast-radius', key: 'isInteractive' } as const, true)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, interactive, () => e.isInteractive)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as unknown as { command?: unknown }).command ?? '')
    const risks = classify(command)
    if (risks.length === 0) return next(e)
    if ((await $.env.get('BLAST_RADIUS')) === 'off') return next(e)
    // Nobody to ask (claude -p, the SDK): stay out of the way of automation.
    if (!(await read($, interactive))) return next(e)

    let report: BlastReport
    try {
      report = await measure($, command, risks)
    } catch (error) {
      report = {
        command,
        title: risks.map(r => r.title).join(' + '),
        summary: 'could not be previewed',
        lines: [],
        warnings: [`The preview failed: ${String(error)}`],
      }
    }

    await update($, held, () => ({ report, where: 'pane' }))
    try {
      const opened = await $.ui.open({ id: PANE, title: 'Blast Radius' })
      if (!opened.isPlaced) await update($, held, h => (h === null ? h : { ...h, where: 'band' as const }))
    } catch {
      await update($, held, h => (h === null ? h : { ...h, where: 'band' as const }))
    }

    let answer = 'Cancel'
    try {
      answer = await $.ui.ask(`Blast Radius: this ${report.summary}. Run it anyway?`, {
        header: 'Blast Radius',
        options: ['Proceed', 'Cancel'],
      })
    } catch {
      answer = 'Cancel' // dismissed (Esc) counts as Cancel
    } finally {
      await update($, held, () => null)
      try {
        await $.ui.close({ id: PANE })
      } catch {
        // the pane may already be gone
      }
    }

    if (answer === 'Proceed') return next(e)
    return {
      deny:
        `Blast Radius held this command and the user chose Cancel. It ${report.summary}.` +
        ' Do not retry it as written: ask the user how they want to proceed, or find a narrower command.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const h = await read($, held)
    const { Box, Text } = $.ui.resolve(e)
    if (h === null) return <Text dimColor>Nothing held.</Text>
    return report({ Box, Text }, h.report)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const h = await read($, held)
    if (h === null || h.where !== 'band') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>
          Blast Radius
        </Text>
        {report({ Box, Text }, h.report)}
      </Box>
    )
  })
}

type Parts = Pick<Elements['terminal'], 'Box' | 'Text'>

function report({ Box, Text }: Parts, r: BlastReport) {
  return (
    <Box flexDirection="column">
      <Text bold>$ {r.command}</Text>
      <Text color="red">
        {r.title}: {r.summary}
      </Text>
      {r.warnings.map((w, i) => (
        <Text key={`w${i}`} color="yellow">
          ⚠ {w}
        </Text>
      ))}
      {r.lines.map((l, i) => (
        <Text key={`l${i}`} dimColor wrap="truncate-end">
          {l}
        </Text>
      ))}
    </Box>
  )
}

// ---------- what counts as risky ----------

export type Risk =
  | { kind: 'rm'; title: string; targets: string[] }
  | { kind: 'reset'; title: string; ref: string }
  | { kind: 'clean'; title: string; flags: string[] }
  | { kind: 'push'; title: string; remote?: string; branch?: string }
  | { kind: 'discard'; title: string; paths: string[] }
  | { kind: 'branch'; title: string; branch: string }
  | { kind: 'data'; title: string }

export function classify(command: string): Risk[] {
  const risks: Risk[] = []
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = tokenize(segment.trim())
    while (words[0] === 'sudo' || words[0] === 'command' || words[0] === 'exec') words.shift()
    const risk = classifySegment(words, segment)
    if (risk) risks.push(risk)
  }
  return risks
}

function classifySegment(words: string[], raw: string): Risk | undefined {
  const [cmd, ...rest] = words
  if (cmd === undefined) return undefined
  const name = cmd.replace(/^.*[\\/]/, '').toLowerCase()
  const flags = rest.filter(w => w.startsWith('-'))
  const args = rest.filter(w => !w.startsWith('-'))

  if (name === 'rm') {
    const recursive = flags.some(f => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive')
    const force = flags.some(f => /^-[a-zA-Z]*f/.test(f) || f === '--force')
    if (recursive || (force && args.length > 0)) {
      return { kind: 'rm', title: recursive ? 'rm -r' : 'rm -f', targets: args }
    }
  }
  // PowerShell and cmd.exe
  if (/^(remove-item|ri)$/.test(name) && flags.some(f => /^-r(ecurse)?$/i.test(f))) {
    return { kind: 'rm', title: 'Remove-Item -Recurse', targets: args }
  }
  if (/^(rmdir|rd|del|erase)$/.test(name) && rest.some(w => /^\/s$/i.test(w))) {
    return { kind: 'rm', title: `${name} /s`, targets: rest.filter(w => !w.startsWith('/')) }
  }

  if (name === 'git') {
    const sub = args[0]
    if (sub === 'reset' && flags.includes('--hard')) {
      return { kind: 'reset', title: 'git reset --hard', ref: args[1] ?? 'HEAD' }
    }
    if (sub === 'clean' && flags.some(f => /^-[a-zA-Z]*f/.test(f) || f === '--force')) {
      return { kind: 'clean', title: 'git clean', flags }
    }
    if (sub === 'push' && flags.some(f => f === '-f' || f === '--force' || f.startsWith('--force-with-lease') || /^-[a-zA-Z]*f/.test(f))) {
      const risk: Risk = { kind: 'push', title: 'git push --force' }
      if (args[1] !== undefined) risk.remote = args[1]
      if (args[2] !== undefined) risk.branch = args[2].replace(/^\+/, '').split(':').pop()
      return risk
    }
    if (sub === 'checkout' && (rest.includes('--') || args[1] === '.')) {
      const after = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : ['.']
      return { kind: 'discard', title: 'git checkout --', paths: after }
    }
    if (sub === 'restore' && !flags.includes('--staged') && !flags.includes('-S')) {
      return { kind: 'discard', title: 'git restore', paths: args.slice(1) }
    }
    if (sub === 'branch' && flags.some(f => f === '-D' || f === '--delete') && flags.some(f => f === '-D' || f === '--force' || f === '-f')) {
      if (args[1] !== undefined) return { kind: 'branch', title: 'git branch -D', branch: args[1] }
    }
    if (sub === 'stash' && (args[1] === 'clear' || args[1] === 'drop')) {
      return { kind: 'data', title: `git stash ${args[1]}` }
    }
  }

  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(raw)) {
    return { kind: 'data', title: 'SQL that drops data' }
  }
  if (/\b(migrate|db:migrate|db:rollback|migrate:fresh|migrate:reset|db:drop|db:reset)\b/.test(raw) && /\b(manage\.py|rails|rake|artisan|prisma|alembic|knex|sequelize|flyway|dotnet ef|npx|bunx|pnpm|yarn|npm)\b/.test(raw)) {
    return { kind: 'data', title: 'database migration' }
  }
  if (name === 'docker' && (/\b(system|volume|image|container)\s+prune\b/.test(raw) || /\bvolume\s+rm\b/.test(raw) || /\bcompose\s+down\b.*\s(-v|--volumes)\b/.test(raw))) {
    return { kind: 'data', title: 'docker prune / volume removal' }
  }
  return undefined
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// ---------- the dry run ----------

async function measure($: EngineInterface, command: string, risks: Risk[]): Promise<BlastReport> {
  const cwd = await $.session.cwd()
  const parts: { summary: string; lines: string[]; warnings: string[] }[] = []
  for (const risk of risks) parts.push(await measureOne($, cwd, risk))
  const lines = parts.flatMap(p => p.lines)
  return {
    command,
    title: risks.map(r => r.title).join(' + '),
    summary: parts.map(p => p.summary).join('; '),
    lines: lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `… ${lines.length - MAX_LINES + 1} more`] : lines,
    warnings: parts.flatMap(p => p.warnings),
  }
}

async function git($: EngineInterface, args: string[]): Promise<string[]> {
  const run = await $.process.run(['git', ...args], { timeoutMs: 15_000 })
  if (run.exitCode !== 0) return []
  return run.stdout.split('\n').map(l => l.trimEnd()).filter(l => l !== '')
}

async function measureOne($: EngineInterface, cwd: string, risk: Risk) {
  const warnings: string[] = []
  switch (risk.kind) {
    case 'rm': {
      let files = 0
      let bytes = 0
      const lines: string[] = []
      if (risk.targets.length === 0) return { summary: 'names nothing to delete', lines, warnings }
      for (const target of risk.targets) {
        if (isWholeTree(target, cwd)) warnings.push(`"${target}" is the project folder, its parent, your home folder or the root`)
        if (/[*?[]/.test(target)) {
          lines.push(`${target}  (a pattern: the shell expands it, not previewed)`)
          continue
        }
        const found = await sizeOf($, absolute(target, cwd))
        if (found === undefined) {
          lines.push(`${target}  (not found)`)
          continue
        }
        files += found.files
        bytes += found.bytes
        lines.push(`${target}${found.isDir ? '/' : ''}  ${found.files} ${plural(found.files, 'file')}, ${human(found.bytes)}${found.isPartial ? ' (stopped counting)' : ''}`)
      }
      return { summary: `would delete ${files} ${plural(files, 'file')} (${human(bytes)})`, lines, warnings }
    }
    case 'reset': {
      const changed = (await git($, ['status', '--porcelain'])).filter(l => !l.startsWith('??'))
      const stat = (await git($, ['diff', '--shortstat', 'HEAD']))[0]
      const lines = changed.map(l => `uncommitted: ${l.slice(3)}`)
      let lost: string[] = []
      if (risk.ref !== 'HEAD') {
        lost = await git($, ['log', '--oneline', '-n', '30', `${risk.ref}..HEAD`])
        lines.push(...lost.map(c => `commit dropped from branch: ${c}`))
      }
      const bits = [
        `would discard uncommitted changes in ${changed.length} ${plural(changed.length, 'file')}${stat ? ` (${stat.trim()})` : ''}`,
      ]
      if (lost.length > 0) bits.push(`and drop ${lost.length} ${plural(lost.length, 'commit')} from the branch`)
      return { summary: bits.join(' '), lines, warnings }
    }
    case 'clean': {
      const keep = risk.flags.filter(f => /^-[a-zA-Z]+$/.test(f)).map(f => f.replace(/[fniq]/g, '')).filter(f => f !== '-')
      const removed = (await git($, ['clean', '-n', ...keep])).map(l => l.replace(/^Would remove /, ''))
      return {
        summary: `would delete ${removed.length} untracked ${plural(removed.length, 'path')}`,
        lines: removed.map(p => `untracked: ${p}`),
        warnings,
      }
    }
    case 'push': {
      const upstream =
        risk.remote !== undefined && risk.branch !== undefined
          ? `${risk.remote}/${risk.branch}`
          : (await git($, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))[0]
      if (upstream === undefined) {
        return { summary: 'would force-push (no upstream found to compare with)', lines: [], warnings }
      }
      const gone = await git($, ['log', '--oneline', '-n', '30', `HEAD..${upstream}`])
      warnings.push('Compared with the last fetch: run git fetch first for a fresh picture. --force-with-lease is the safer flag.')
      return {
        summary:
          gone.length === 0
            ? `would force-push to ${upstream} (no remote commits would be lost, as of the last fetch)`
            : `would overwrite ${gone.length} ${plural(gone.length, 'commit')} on ${upstream}`,
        lines: gone.map(c => `remote commit lost: ${c}`),
        warnings,
      }
    }
    case 'discard': {
      const paths = risk.paths.length === 0 ? ['.'] : risk.paths
      const stat = await git($, ['diff', '--stat', '--', ...paths])
      const total = stat.length > 0 ? stat[stat.length - 1]! : ''
      const files = stat.slice(0, -1)
      return {
        summary: files.length === 0 ? 'would discard no unstaged changes' : `would discard unstaged changes (${total.trim()})`,
        lines: files.map(l => `unstaged: ${l.trim()}`),
        warnings,
      }
    }
    case 'branch': {
      const only = await git($, ['log', '--oneline', '-n', '30', risk.branch, '--not', 'HEAD', '--remotes'])
      return {
        summary:
          only.length === 0
            ? `would delete branch ${risk.branch} (its commits are on HEAD or a remote)`
            : `would delete branch ${risk.branch} and ${only.length} ${plural(only.length, 'commit')} found nowhere else`,
        lines: only.map(c => `only on ${risk.branch}: ${c}`),
        warnings,
      }
    }
    case 'data':
      warnings.push('This changes data outside your files (a database, Docker volumes or the stash): there is no preview, and Waypoint cannot undo it.')
      return { summary: `runs a ${risk.title}`, lines: [], warnings }
  }
}

async function sizeOf($: EngineInterface, target: string) {
  let stat
  try {
    stat = await $.fs.stat(target)
  } catch {
    return undefined
  }
  if (stat.kind !== 'dir') return { files: 1, bytes: stat.size, isDir: false, isPartial: false }
  let files = 0
  let bytes = 0
  let seen = 0
  const queue = [target]
  while (queue.length > 0 && seen < WALK_LIMIT) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (entry.kind === 'dir') queue.push(`${dir}/${entry.name}`)
      else if (entry.kind === 'file') {
        files += 1
        bytes += entry.size
      }
    }
  }
  return { files, bytes, isDir: true, isPartial: queue.length > 0 }
}

function absolute(path: string, cwd: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(path)) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`
}

function isWholeTree(target: string, cwd: string): boolean {
  const t = target.replace(/\\/g, '/').replace(/\/+$/, '')
  const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return ['', '.', '..', '~', '/', '$HOME', '${HOME}', '%USERPROFILE%', '*', './*'].includes(t) || t === c || /^[a-zA-Z]:$/.test(t)
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
