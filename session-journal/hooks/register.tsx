// Session Journal: after every main-loop turn, appends what you asked, which
// files changed and which commands ran to .claude/journal/YYYY-MM-DD.md.
// /standup turns a day's journal into a short "what I did" list.
//
// Set SESSION_JOURNAL_DIR to write somewhere else (absolute, or relative to
// the project).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { JournalFile, JournalTurn } from '../types'

const current = atom({ plugin: 'session-journal', key: 'current' } as const, null)
const cwd = atom({ plugin: 'session-journal', key: 'cwd' } as const, '')
const dir = atom({ plugin: 'session-journal', key: 'dir' } as const, '')

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PROMPT_LIMIT = 1200
const REPLY_LIMIT = 300

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const root = e.cwd
    const custom = await $.env.get('SESSION_JOURNAL_DIR')
    await update($, cwd, () => root)
    await update($, dir, () => resolveDir(root, custom))
    await registerCommand($, {
      name: 'standup',
      description: "Summarize today's session journal (or: /standup yesterday)",
      argumentHint: '[yesterday|YYYY-MM-DD]',
    })
    await registerCommand($, {
      name: 'journal',
      description: "Show where today's session journal is written",
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const turn: JournalTurn = { prompt: e.text, startedAt, files: [], commands: [] }
    await update($, current, () => turn)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isEdit = EDIT_TOOLS.has(tool)
    const isBash = tool === 'Bash'
    if (!isEdit && !isBash) return next(e)
    if ((await read($, current)) === null) return next(e)

    const path = isEdit ? pathOf(input) : undefined
    const existed = path !== undefined && tool === 'Write' ? await exists($, path) : true
    const ran = await next(e)
    const ok = ran.deny === undefined && ran.isError !== true

    if (isEdit && path !== undefined && ok) {
      const root = await read($, cwd)
      const shown = relative(path, root)
      await update($, current, turn => {
        if (turn === null) return turn
        if (turn.files.some(f => f.path === shown)) return turn
        const file: JournalFile = { path: shown, kind: existed ? 'edited' : 'created' }
        return { ...turn, files: [...turn.files, file] }
      })
    }

    if (isBash && ran.deny === undefined) {
      const command = oneLine(String(input.command ?? ''), 200)
      const byAgent = (input as { agentId?: string }).agentId !== undefined
      await update($, current, turn =>
        turn === null ? turn : { ...turn, commands: [...turn.commands, { command, ok, byAgent }] },
      )
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const turn = await read($, current)
    if (turn === null) return result
    await update($, current, () => null)

    try {
      const now = await $.clock.now()
      const file = `${await read($, dir)}/${day(now)}.md`
      const project = basename(await read($, cwd))
      const before = (await exists($, file)) ? await $.fs.read(file) : header(project, now)
      const outcome = e.isAborted ? 'interrupted' : e.reason === 'answer' ? 'answered' : e.reason
      const entry = formatEntry(turn, {
        at: turn.startedAt,
        outcome,
        durationMs: e.durationMs,
        reply: e.answer,
      })
      await $.fs.write(file, before.replace(/\s*$/, '\n\n') + entry)
    } catch (error) {
      $.ui.log(`session-journal: could not write the journal (${String(error)})`, { to: 'debug' })
    }
    return result
  })

  on('command.run', { command: 'journal' }, async $ => {
    const file = `${await read($, dir)}/${day(await $.clock.now())}.md`
    if (!(await exists($, file))) return { text: `No journal yet today. It will be written to ${file}` }
    const entries = parseEntries(await $.fs.read(file))
    return { text: `Today's journal: ${file} (${entries.length} ${plural(entries.length, 'prompt')})` }
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const now = await $.clock.now()
    const which = e.args.trim()
    const date = which === 'yesterday' ? day(now - 86_400_000) : /^\d{4}-\d{2}-\d{2}$/.test(which) ? which : day(now)
    const file = `${await read($, dir)}/${date}.md`
    if (!(await exists($, file))) return { text: `No journal for ${date} (${file}).` }
    return { text: standup(date, parseEntries(await $.fs.read(file)), file) }
  })
}

// ---------- formatting ----------

type EntryFacts = { at: number; outcome: string; durationMs: number; reply: string }

export function formatEntry(turn: JournalTurn, facts: EntryFacts): string {
  const prompt = turn.prompt.trim() === '' ? '(continued without a new prompt)' : turn.prompt.trim()
  const title = oneLine(prompt, 80)
  const lines: string[] = [`## ${clock(facts.at)} · ${title}`, '']
  lines.push(...clip(prompt, PROMPT_LIMIT).split('\n').map(l => `> ${l}`), '')

  if (turn.files.length > 0) {
    lines.push(`**Files** (${turn.files.length})`)
    for (const f of turn.files) lines.push(`- \`${f.path}\` (${f.kind})`)
    lines.push('')
  }
  if (turn.commands.length > 0) {
    lines.push(`**Commands** (${turn.commands.length})`)
    for (const c of turn.commands) {
      lines.push(`- ${c.ok ? '✓' : '✗'} \`${c.command.replace(/`/g, "'")}\`${c.byAgent ? ' (subagent)' : ''}`)
    }
    lines.push('')
  }
  lines.push(`**Outcome:** ${facts.outcome} in ${duration(facts.durationMs)}`)
  const reply = oneLine(facts.reply, REPLY_LIMIT)
  if (reply !== '') lines.push(`**Reply:** ${reply}`)
  return lines.join('\n') + '\n'
}

function header(project: string, now: number): string {
  return `# Session journal · ${project} · ${day(now)}\n`
}

type ParsedEntry = { time: string; title: string; files: string[]; failed: number }

export function parseEntries(text: string): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  let entry: ParsedEntry | undefined
  for (const line of text.split('\n')) {
    const head = /^## (\d\d:\d\d) · (.*)$/.exec(line)
    if (head) {
      entry = { time: head[1]!, title: head[2]!, files: [], failed: 0 }
      entries.push(entry)
      continue
    }
    if (!entry) continue
    const file = /^- `(.+)` \((created|edited)\)$/.exec(line)
    if (file) entry.files.push(file[1]!)
    if (line.startsWith('- ✗ ')) entry.failed += 1
  }
  return entries
}

export function standup(date: string, entries: readonly ParsedEntry[], file: string): string {
  if (entries.length === 0) return `The journal for ${date} has no entries yet (${file}).`
  const files = [...new Set(entries.flatMap(e => e.files))]
  const lines = [`Standup for ${date}: ${entries.length} ${plural(entries.length, 'prompt')}, ${files.length} ${plural(files.length, 'file')} changed`, '']
  for (const e of entries) {
    const extra = [
      e.files.length > 0 ? `${e.files.length} ${plural(e.files.length, 'file')}` : '',
      e.failed > 0 ? `${e.failed} failed ${plural(e.failed, 'command')}` : '',
    ].filter(Boolean)
    lines.push(`- ${e.time} ${e.title}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`)
  }
  if (files.length > 0) {
    lines.push('', `Files: ${files.slice(0, 15).join(', ')}${files.length > 15 ? `, +${files.length - 15} more` : ''}`)
  }
  lines.push('', `Full journal: ${file}`)
  return lines.join('\n')
}

// ---------- helpers ----------

async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]) {
  try {
    await $.command.register(spec)
  } catch (error) {
    $.ui.log(`session-journal: could not register /${spec.name} (${String(error)})`, { to: 'debug' })
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

function resolveDir(root: string, custom: string | undefined): string {
  const r = root.replace(/[\\/]+$/, '')
  if (custom === undefined || custom.trim() === '') return `${r}/.claude/journal`
  const c = custom.trim().replace(/[\\/]+$/, '')
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(c) ? c : `${r}/${c}`
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

function relative(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return r !== '' && p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

const pad = (n: number) => String(n).padStart(2, '0')

export function day(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
