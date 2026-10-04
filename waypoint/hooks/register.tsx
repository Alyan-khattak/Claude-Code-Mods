// Waypoint: a snapshot of the whole project before every prompt and after
// its turn, kept in a shadow git repository outside the project. /waypoints
// opens a timeline: pick a prompt, preview what it changed, and restore all
// files to just before or just after it. Changes made by Bash, subagents and
// your own editor are caught too, because it snapshots the folder itself.
//
// Before any restore it takes a safety snapshot, so a restore can be undone.
// It cannot undo what lives outside the project folder: databases, installed
// packages, pushed commits, deployments.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { WaypointCheckpoint, WaypointDetail, WaypointRepo } from '../types'
import { DEFAULT_EXCLUDES, gitArgv, parseNumstat, parsePatch, repoDir, shortHash } from './git'
import type { Stats } from './git'

const PANE = 'waypoint'
const KEEP = 300
const PREVIEW_FILES = 8
const PREVIEW_CHARS = 9000

const repo = atom({ plugin: 'waypoint', key: 'repo' } as const, null)
const offReason = atom({ plugin: 'waypoint', key: 'offReason' } as const, null)
const checkpoints = atom({ plugin: 'waypoint', key: 'checkpoints' } as const, [])
const selected = atom({ plugin: 'waypoint', key: 'selected' } as const, null)
const cursor = atom({ plugin: 'waypoint', key: 'cursor' } as const, null)
const action = atom({ plugin: 'waypoint', key: 'action' } as const, null)
const detail = atom({ plugin: 'waypoint', key: 'detail' } as const, null)
const isWorking = atom({ plugin: 'waypoint', key: 'isWorking' } as const, false)
const note = atom({ plugin: 'waypoint', key: 'note' } as const, null)
const message = atom({ plugin: 'waypoint', key: 'message' } as const, null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    for (const spec of COMMANDS) {
      try {
        await $.command.register({ ...spec, immediate: true })
      } catch (error) {
        $.ui.log(`waypoint: could not register /${spec.name} (${String(error)})`, { to: 'debug' })
      }
    }
    await start($, e.cwd)
    return result
  })

  on('turn.start', async ($, e, next) => {
    const r = await read($, repo)
    await update($, isWorking, () => true)
    if (r === null) return next(e)
    try {
      const at = await $.clock.now()
      const n = nextNumber(await read($, checkpoints))
      const label = e.text.trim() === '' ? '(continued without a new prompt)' : e.text.trim()
      const before = await snapshot($, r, `before #${n}: ${oneLine(label, 200)}`)
      await save($, r, list => [...list, { n, kind: 'prompt', label, at, before, turnId: e.turnId }])
    } catch (error) {
      $.ui.log(`waypoint: snapshot before the prompt failed (${String(error)})`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await update($, isWorking, () => false)
    const r = await read($, repo)
    if (r === null) return result
    const list = await read($, checkpoints)
    const cp = [...list].reverse().find(c => c.turnId === e.turnId)
    if (cp === undefined) return result
    try {
      const after = await snapshot($, r, `after #${cp.n}: ${oneLine(cp.label, 200)}`)
      const s = await stats($, r, cp.before, after)
      await save($, r, all => all.map(c => (c.n === cp.n ? { ...c, after, ...s } : c)))
    } catch (error) {
      $.ui.log(`waypoint: snapshot after the turn failed (${String(error)})`)
    }
    return result
  })

  // After a restore, tell Claude once, with the next prompt, that the files moved under it.
  on('prompt.submit', async ($, e, next) => {
    const text = await read($, note)
    if (text === null) return next(e)
    await update($, note, () => null)
    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  // /waypoints [args], plus one command per action so they show up as you type /waypoints.
  on('command.run', { command: 'waypoints' }, ($, e) => runWaypoints($, e.args.trim()))
  on('command.run', { command: 'waypoints-open' }, ($, e) => runWaypoints($, e.args.trim() || ''))
  on('command.run', { command: 'waypoints-restore' }, ($, e) =>
    e.args.trim() === '' ? { text: 'Which one? For example: /waypoints-restore 11  or  /waypoints-restore 11 before' } : runWaypoints($, `restore ${e.args.trim()}`),
  )
  on('command.run', { command: 'waypoints-save' }, ($, e) => runWaypoints($, `save ${e.args.trim()}`))

  // The highlight moved onto a row (arrows, Tab, autoFocus): remember it and scroll it to the middle.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    const key = e.element
    if (result.deny === undefined && key !== undefined && key in ACTIONS) {
      await update($, action, () => ACTIONS[key]!)
    }
    if (result.deny === undefined && key !== undefined && key.startsWith('cp-')) {
      await update($, cursor, () => Number(key.slice(3)))
      try {
        await $.ui.scroll({ in: PANE, to: { key }, block: 'center' })
      } catch {
        // nothing to scroll: the list fits
      }
    }
    return result
  })

  // Where the arrows would scroll the list instead of moving the highlight, move the highlight.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || e.pointer !== undefined || Math.abs(e.by) !== 1) return next(e)

    // Detail view: up/down walks the a/b/c options.
    const sel = await read($, selected)
    if (sel !== null) {
      const list = await read($, checkpoints)
      const cp = list.find(c => c.n === sel)
      if (cp === undefined) return next(e)
      const ids: string[] = []
      if (cp.after !== undefined) ids.push('after')
      if (cp.kind === 'prompt') ids.push('before')
      ids.push('back')
      const keyFor: Record<string, string> = { after: 'restore-after', before: 'restore-before', back: 'back' }
      const cur = (await read($, action)) ?? ids[0]!
      const at = Math.max(0, ids.indexOf(cur))
      const to = Math.max(0, Math.min(ids.length - 1, at + Math.sign(e.by)))
      const nextId = ids[to]!
      await update($, action, () => nextId)
      try {
        await $.ui.focus({ requestId: PANE, key: keyFor[nextId]! })
      } catch {}
      return next(e)
    }

    const rows = [...(await read($, checkpoints))].reverse()
    if (rows.length === 0) return next(e)
    const current = (await read($, cursor)) ?? rows[0]!.n
    const at = Math.max(0, rows.findIndex(c => c.n === current))
    const to = Math.max(0, Math.min(rows.length - 1, at + Math.sign(e.by)))
    const n = rows[to]!.n
    await update($, cursor, () => n)
    try {
      await $.ui.focus({ requestId: PANE, key: `cp-${n}` })
    } catch {
      // the pane does not hold the keyboard
    }
    // Keep the highlighted row in the middle of the window.
    const top = ((await read($, message)) !== null ? 1 : 0) + ((await read($, isWorking)) ? 1 : 0) + 2
    const offset = Math.max(0, Math.min(Math.max(0, e.contentRows - e.bodyRows), top + to - Math.floor(e.bodyRows / 2)))
    return next({ ...e, offset })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const off = await read($, offReason)
    if (off !== null) return <Text color="yellow">Waypoint is off: {off}</Text>
    const list = await read($, checkpoints)
    const n = await read($, selected)
    const msg = await read($, message)
    const working = await read($, isWorking)
    const width = e.props.bodyColumns

    const top = (
      <Box flexDirection="column">
        {msg !== null && <Text color="green">{msg}</Text>}
        {working && <Text color="yellow">Claude is working: restores wait until the turn ends.</Text>}
      </Box>
    )

    if (n !== null) {
      const cp = list.find(c => c.n === n)
      if (cp !== undefined) {
        return (
          <Box flexDirection="column" width={width}>
            {top}
            {detailView($, els, cp, await read($, detail), list, await read($, action))}
          </Box>
        )
      }
    }
    const at = await read($, cursor)
    return (
      <Box flexDirection="column" width={width}>
        {top}
        {listView($, els, list, width, at)}
      </Box>
    )
  })
}

// ---------- the shadow repository ----------

type GitRun = { ok: boolean; out: string; err: string }

async function git($: EngineInterface, r: WaypointRepo, args: string[], timeoutMs = 120_000): Promise<GitRun> {
  const run = await $.process.run(gitArgv(r, args), {
    cwd: r.work,
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
}

async function hasGit($: EngineInterface): Promise<boolean> {
  try {
    return (await $.process.run(['git', '--version'], { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

async function repoFor($: EngineInterface, work: string): Promise<WaypointRepo> {
  const custom = await $.env.get('WAYPOINT_HOME')
  const home = custom ?? `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? work}/.claude/waypoint`
  return { dir: repoDir(home, work, await shortHash(work)), work }
}

async function ensureRepo($: EngineInterface, r: WaypointRepo): Promise<GitRun> {
  if (await $.fs.exists(`${r.dir}/HEAD`)) return { ok: true, out: '', err: '' }
  const init = await $.process.run(['git', 'init', '--bare', '-q', r.dir], { timeoutMs: 30_000 })
  if (init.exitCode !== 0) return { ok: false, out: '', err: init.stderr.trim() }
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.longpaths', 'true'],
    ['user.name', 'Waypoint'],
    ['user.email', 'waypoint@localhost'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    await git($, r, ['config', key, value], 15_000)
  }
  await $.fs.write(
    `${r.dir}/info/exclude`,
    ['# Waypoint never snapshots these (your .gitignore files apply too). Edit freely.', ...DEFAULT_EXCLUDES, ''].join('\n'),
  )
  return { ok: true, out: '', err: '' }
}

/** Records the whole work tree as one commit and returns its id. */
async function snapshot($: EngineInterface, r: WaypointRepo, msg: string): Promise<string> {
  const add = await git($, r, ['add', '-A', '--ignore-errors', '.'])
  if (!add.ok && !/warning|ignored/i.test(add.err)) throw new Error(`git add failed: ${add.err}`)
  const commit = await git($, r, ['commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', msg.slice(0, 500)])
  if (!commit.ok) throw new Error(`git commit failed: ${commit.err}`)
  const head = await git($, r, ['rev-parse', 'HEAD'], 15_000)
  if (!head.ok) throw new Error(`git rev-parse failed: ${head.err}`)
  return head.out.trim()
}

/** Puts every snapshotted file back as it was in `commit`, and removes files the commit did not have. */
async function restore($: EngineInterface, r: WaypointRepo, commit: string): Promise<GitRun> {
  return git($, r, ['read-tree', '-u', '--reset', commit])
}

async function stats($: EngineInterface, r: WaypointRepo, from: string, to: string): Promise<Stats> {
  const run = await git($, r, ['diff', '--numstat', '--no-renames', from, to], 60_000)
  return parseNumstat(run.ok ? run.out : '')
}

async function patch($: EngineInterface, r: WaypointRepo, from: string, to: string): Promise<string> {
  const run = await git($, r, ['diff', '-U3', '--no-color', '--no-ext-diff', '--no-renames', from, to], 60_000)
  return run.ok ? run.out : ''
}

// ---------- the pane ----------

// Dialog mode (focus + closeOnEscape + holdToasts): the pane takes the keyboard and the
// arrows walk its rows instead of scrolling the window.
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Waypoint', focus: true, closeOnEscape: true, holdToasts: true, rows: 20 })
}

// ---------- commands ----------

const COMMANDS = [
  { name: 'waypoints', description: 'Waypoint: open the timeline of your prompts (or /waypoints 11, /waypoints restore 11 before)', argumentHint: '[<number> | restore <number> [before] | save <label>]' },
  { name: 'waypoints-open', description: 'Waypoint: show what one prompt changed', argumentHint: '<number>' },
  { name: 'waypoints-restore', description: 'Waypoint: restore all files to after a prompt (add "before" for before it)', argumentHint: '<number> [before]' },
  { name: 'waypoints-save', description: 'Waypoint: save a checkpoint of your files now', argumentHint: '<label>' },
]

async function runWaypoints($: EngineInterface, args: string): Promise<{ text: string }> {
  const off = await read($, offReason)
  if (off !== null) return { text: `Waypoint is off: ${off}` }
  const r = await read($, repo)
  if (r !== null && /^save\b/i.test(args)) {
    if (await read($, isWorking)) return { text: 'Wait for Claude to finish this turn, then save.' }
    const label = args.replace(/^save\s*/i, '') || 'saved by hand'
    const n = nextNumber(await read($, checkpoints))
    const commit = await snapshot($, r, `manual #${n}: ${label}`)
    const at = await $.clock.now()
    await save($, r, list => [...list, { n, kind: 'manual', label, at, before: commit, after: commit }])
    return { text: `Saved waypoint #${n}: ${label}` }
  }
  // /waypoints restore 11 [before]: restore from the prompt, no pane keys needed.
  const restoreArgs = /^restore\s+#?(\d+)(?:\s+(before|after))?\s*$/i.exec(args)
  if (restoreArgs) {
    const n = Number(restoreArgs[1])
    const list = await read($, checkpoints)
    const cp = list.find(c => c.n === n)
    if (cp === undefined) return { text: `There is no checkpoint #${n}. Type /waypoints to see the list.` }
    const wantBefore = (restoreArgs[2] ?? '').toLowerCase() === 'before'
    if (wantBefore && cp.kind !== 'prompt') return { text: `#${n} is not a prompt, so it has no "before": use /waypoints restore ${n}` }
    const commit = wantBefore ? cp.before : cp.after
    if (commit === undefined) {
      return { text: `#${n} never finished, so there is no "after" snapshot: use /waypoints restore ${n} before` }
    }
    const where = cp.kind === 'prompt' ? `${wantBefore ? 'before' : 'after'} #${n}` : `#${n}`
    await update($, message, () => null)
    const done = await confirmRestore($, commit, where, cp, list)
    return { text: (await read($, message)) ?? (done ? `Restored to ${where}.` : 'Restore cancelled.') }
  }

  // /waypoints 11: open straight on checkpoint #11.
  const pick = /^#?(\d+)$/.exec(args)
  await update($, selected, () => null)
  await update($, detail, () => null)
  const newest = (await read($, checkpoints)).reduce<number | null>((max, c) => (max === null || c.n > max ? c.n : max), null)
  await update($, cursor, () => newest)
  await openPane($)
  if (pick) {
    const n = Number(pick[1])
    if (!(await read($, checkpoints)).some(c => c.n === n)) return { text: `There is no checkpoint #${n}.` }
    await select($, n)
    return { text: `Waypoint: checkpoint #${n}. Restore with /waypoints-restore ${n} (or add "before").` }
  }
  const count = (await read($, checkpoints)).length
  return { text: count === 0 ? 'No waypoints yet: one is taken before every prompt.' : `Waypoint: ${count} checkpoints.` }
}

// ---------- startup and saving ----------

async function start($: EngineInterface, work: string) {
  if (!(await hasGit($))) {
    await update($, offReason, () => 'git was not found on PATH. Install git and start a new session.')
    return
  }
  const r = await repoFor($, work)
  const made = await ensureRepo($, r)
  if (!made.ok) {
    await update($, offReason, () => `could not create the snapshot store at ${r.dir} (${made.err})`)
    return
  }
  await update($, offReason, () => null)
  await update($, repo, () => r)
  const stored = await $.store.get(storeKey(r))
  const list = Array.isArray(stored) ? (stored as WaypointCheckpoint[]) : []
  await update($, checkpoints, () => list)
  // Keep the shadow repository compact without slowing the first prompt down.
  $.clock.after(5_000, () => {
    void $.process.run(['git', `--git-dir=${r.dir}`, 'gc', '--auto', '--quiet'], { timeoutMs: 120_000 }).catch(() => {})
  })
}

async function save($: EngineInterface, r: WaypointRepo, change: (list: WaypointCheckpoint[]) => WaypointCheckpoint[]) {
  const list = await update($, checkpoints, current => change([...current]).slice(-KEEP))
  await $.store.set(storeKey(r), list)
}

function storeKey(r: WaypointRepo): string {
  return `checkpoints:${r.dir.replace(/\\/g, '/').split('/').pop()}`
}

function nextNumber(list: readonly WaypointCheckpoint[]): number {
  return list.reduce((max, c) => Math.max(max, c.n), 0) + 1
}

// ---------- the timeline ----------

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

function listView($: EngineInterface, { Box, Text, Button }: Els, list: readonly WaypointCheckpoint[], width: number, at: number | null) {
  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Waypoint</Text>
        <Text dimColor>No checkpoints yet. One is taken before every prompt you send.</Text>
      </Box>
    )
  }
  const rows = [...list].reverse()
  return (
    <Box flexDirection="column">
      <Text bold>
        Waypoint · {list.length} checkpoints <Text dimColor>(newest first)</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑↓ to move, Enter to open, Esc to close. No keys? Press Ctrl+X then Tab, or type /waypoints-open {rows[0]!.n}
      </Text>
      {rows.map(cp => {
        const isHere = cp.n === (at ?? rows[0]!.n)
        return (
          <Button
            key={`cp-${cp.n}`}
            plain
            {...(isHere ? { autoFocus: true as const } : { dimColor: cp.kind === 'safety' })}
            label={`${isHere ? '❯' : ' '} ${rowLabel(cp, width - 2)}`}
            onPress={() => select($, cp.n)}
          />
        )
      })}
    </Box>
  )
}

/** Button keys of a checkpoint's options, and the option each one is. */
const ACTIONS: Record<string, string> = { 'restore-after': 'after', 'restore-before': 'before', back: 'back' }

function detailView(
  $: EngineInterface,
  { Box, Text, Button, Code }: Els,
  cp: WaypointCheckpoint,
  d: WaypointDetail | null,
  list: readonly WaypointCheckpoint[],
  focused: string | null,
) {
  const kind = cp.kind === 'safety' ? 'Safety checkpoint' : cp.kind === 'manual' ? 'Saved by hand' : 'Prompt'
  const after = cp.after
  const isPrompt = cp.kind === 'prompt'

  // The options, in the order shown: a, b, c. A safety or hand-saved checkpoint has one snapshot, so no "before".
  type Option = { key: string; id: string; hotkey: string; label: string; help: string; run: () => unknown }
  const options: Option[] = []
  if (after !== undefined) {
    options.push({
      key: 'restore-after',
      id: 'after',
      hotkey: 'a',
      label: isPrompt ? `Restore to AFTER #${cp.n}` : `Restore #${cp.n}`,
      help: isPrompt
        ? `Every file goes back to how it was right after prompt #${cp.n} finished. Keeps what #${cp.n} did, undoes everything after it.`
        : `Every file goes back to how it was when checkpoint #${cp.n} was taken.`,
      run: () => confirmRestore($, after, isPrompt ? `after #${cp.n}` : `#${cp.n}`, cp, list),
    })
  }
  if (isPrompt) {
    options.push({
      key: 'restore-before',
      id: 'before',
      hotkey: 'b',
      label: `Restore to BEFORE #${cp.n}`,
      help: `Every file goes back to how it was just before you sent prompt #${cp.n}. Undoes #${cp.n} and everything after it.`,
      run: () => confirmRestore($, cp.before, `before #${cp.n}`, cp, list),
    })
  }
  options.push({
    key: 'back',
    id: 'back',
    hotkey: 'c',
    label: 'Back to the list',
    help: 'Goes back to the list of checkpoints. Nothing is changed.',
    run: () => select($, null),
  })
  const here = options.find(o => o.id === focused) ?? options[0]!

  return (
    <Box flexDirection="column">
      <Text bold>
        {kind} #{cp.n} · {clock(cp.at)} {day(cp.at)}
      </Text>
      <Text wrap="truncate-end">{oneLine(cp.label, 300)}</Text>

      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>What do you want to do?</Text>
        {options.map((o, i) => (
          <Button
            key={o.key}
            plain
            hotkey={o.hotkey}
            {...(i === 0 ? { autoFocus: true as const } : {})}
            {...(o.id === here.id ? {} : { dimColor: true })}
            label={`${o.id === here.id ? '❯' : ' '} ${o.label}`}
            onPress={o.run}
          />
        ))}
        <Text color="cyan" wrap="wrap">
          {'→ '}
          {here.help}
        </Text>
        {here.id !== 'back' && (
          <Text dimColor wrap="wrap">
            You are asked to confirm, and your current files are saved first as a ⟲ safety checkpoint, so this can be undone.
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          ↑↓ or a / b / c, Enter to choose. No keys? Type /waypoints-restore {cp.n}
          {isPrompt ? ` (or /waypoints-restore ${cp.n} before)` : ''}
        </Text>
      </Box>

      {isPrompt && (
        <Box marginTop={1}>
          <Text bold>
            What prompt #{cp.n} changed <Text dimColor>({rowStats(cp) || 'still running, or it never finished'})</Text>
          </Text>
        </Box>
      )}
      {isPrompt && d === null && <Text dimColor>Loading the changes…</Text>}
      {isPrompt && d !== null && d.files.length === 0 && <Text dimColor>This prompt changed no files.</Text>}
      {isPrompt &&
        d !== null &&
        d.files.map(f => (
          <Box key={`file-${f.path}`} flexDirection="column" marginTop={1}>
            <Text bold>
              {f.path} <Text color="green">+{f.added}</Text> <Text color="red">−{f.removed}</Text>
            </Text>
            {f.isBinary ? (
              <Text dimColor>binary file changed</Text>
            ) : f.hunks === '' ? (
              <Text dimColor>no line changes (renamed, emptied or mode change)</Text>
            ) : (
              <Code source={f.hunks} format="diff" path={f.path} wrap="truncate-end" />
            )}
          </Box>
        ))}
      {isPrompt && d !== null && d.more > 0 && <Text dimColor>…and {d.more} more files not shown.</Text>}
    </Box>
  )
}

async function select($: EngineInterface, n: number | null) {
  await update($, selected, () => n)
  await update($, action, () => null)
  await update($, detail, () => null)
  await update($, message, () => null)
  if (n === null) return
  const r = await read($, repo)
  const list = await read($, checkpoints)
  const cp = list.find(c => c.n === n)
  if (r === null || cp === undefined || cp.kind !== 'prompt') return
  // What the prompt changed: from before it to after it (or to the newest snapshot if it never finished).
  const to = cp.after ?? (await snapshotHead($, r)) ?? cp.before
  const files = parsePatch(await patch($, r, cp.before, to))
  const shown: typeof files = []
  let size = 0
  for (const f of files) {
    if (shown.length >= PREVIEW_FILES) break
    const hunks = f.hunks.length > PREVIEW_CHARS - size ? cut(f.hunks, Math.max(0, PREVIEW_CHARS - size)) : f.hunks
    size += hunks.length
    shown.push({ ...f, hunks })
  }
  const d: WaypointDetail = { n, files: shown, more: files.length - shown.length }
  if ((await read($, selected)) === n) await update($, detail, () => d)
}

async function snapshotHead($: EngineInterface, r: WaypointRepo): Promise<string | undefined> {
  const run = await git($, r, ['rev-parse', 'HEAD'], 15_000)
  return run.ok ? run.out.trim() : undefined
}

async function confirmRestore(
  $: EngineInterface,
  commit: string,
  where: string,
  cp: WaypointCheckpoint,
  list: readonly WaypointCheckpoint[],
): Promise<boolean> {
  if (await read($, isWorking)) {
    await update($, message, () => 'Claude is still working. Restore once the turn has ended.')
    return false
  }
  let answer = 'Cancel'
  try {
    answer = await $.ui.ask(`Restore every project file to ${where}? Your current files are saved first as a safety checkpoint.`, {
      header: 'Waypoint',
      options: ['Restore', 'Cancel'],
    })
  } catch {
    return false // dismissed
  }
  if (answer !== 'Restore') return false
  return doRestore($, commit, where, cp, list)
}

export async function doRestore(
  $: EngineInterface,
  commit: string,
  where: string,
  cp: WaypointCheckpoint,
  list: readonly WaypointCheckpoint[],
): Promise<boolean> {
  const r = await read($, repo)
  if (r === null) return false
  try {
    const n = nextNumber(list)
    const safety = await snapshot($, r, `safety #${n}: before restoring to ${where}`)
    const at = await $.clock.now()
    await save($, r, all => [...all, { n, kind: 'safety', label: `before restoring to ${where}`, at, before: safety, after: safety }])
    const done = await restore($, r, commit)
    if (!done.ok) throw new Error(done.err || 'git read-tree failed')
    const what = cp.kind === 'prompt' ? ` ("${oneLine(cp.label, 80)}")` : ''
    await update($, note, () =>
      `Waypoint restored the project's files to ${where}${what}. Files changed after that point are back to how they were then, ` +
        'so earlier edits in this conversation may no longer be on disk: re-read a file before editing it.',
    )
    await update($, selected, () => null)
    await update($, detail, () => null)
    await update($, message, () => `Restored to ${where}. To undo, restore safety checkpoint ⟲${n}.`)
    $.ui.toast(`Waypoint: restored to ${where}`)
    return true
  } catch (error) {
    await update($, message, () => `Restore failed: ${String(error)}`)
    return false
  }
}

// ---------- helpers ----------

function rowLabel(cp: WaypointCheckpoint, width: number): string {
  const mark = cp.kind === 'safety' ? '⟲' : cp.kind === 'manual' ? '★' : '#'
  const head = `${mark}${cp.n}  ${clock(cp.at)}  `
  const changed = rowStats(cp)
  const room = Math.max(12, width - head.length - changed.length - 8)
  return `${head}${oneLine(cp.label, room).padEnd(room)}  ${changed}`
}

function rowStats(cp: WaypointCheckpoint): string {
  if (cp.kind !== 'prompt') return ''
  if (cp.files === undefined) return cp.after === undefined ? '…' : ''
  if (cp.files === 0) return 'no changes'
  return `${cp.files} ${cp.files === 1 ? 'file' : 'files'} +${cp.added ?? 0} −${cp.removed ?? 0}`
}

function cut(hunks: string, max: number): string {
  if (max <= 0) return ''
  const parts = hunks.split(/\n(?=@@ )/)
  const kept: string[] = []
  let size = 0
  for (const p of parts) {
    if (size + p.length + 1 > max) break
    kept.push(p)
    size += p.length + 1
  }
  return kept.join('\n')
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

const pad = (n: number) => String(n).padStart(2, '0')

function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function day(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
