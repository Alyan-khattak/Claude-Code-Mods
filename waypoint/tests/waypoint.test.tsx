import { describe, expect, mock, test } from 'claude-code/testing'

import { parseNumstat, parsePatch, repoDir } from '../hooks/git'

const PANE = {
  plugin: 'waypoint',
  component: 'Pane',
  requestId: 'waypoint',
  props: { title: 'Waypoint', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { top: 0, bodyRows: 40, totalRows: 40 }, view: {} },
} as const

/**
 * The world beneath the plugin: a project folder in memory and a tiny git
 * that understands exactly the commands Waypoint runs against its shadow
 * repository (snapshot, diff, restore).
 */
function world(on: any, opts: { answer?: string; hasGit?: boolean } = {}) {
  const disk = new Map<string, string>([
    ['src/app.js', 'console.log("v1")\n'],
    ['README.md', '# App\n'],
  ])
  const commits = new Map<string, Map<string, string>>()
  let head = ''
  let seq = 0
  const store = new Map<string, unknown>()
  const notes: string[] = []
  const contexts: (readonly string[] | undefined)[] = []

  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

  function numstat(a: Map<string, string>, b: Map<string, string>) {
    const out: string[] = []
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(path)
      const y = b.get(path)
      if (x === y) continue
      const xl = x === undefined ? [] : x.trimEnd().split('\n')
      const yl = y === undefined ? [] : y.trimEnd().split('\n')
      out.push(`${yl.filter(l => !xl.includes(l)).length}\t${xl.filter(l => !yl.includes(l)).length}\t${path}`)
    }
    return out.join('\n')
  }

  function unified(a: Map<string, string>, b: Map<string, string>) {
    const out: string[] = []
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(path)
      const y = b.get(path)
      if (x === y) continue
      const xl = x === undefined ? [] : x.trimEnd().split('\n')
      const yl = y === undefined ? [] : y.trimEnd().split('\n')
      out.push(`diff --git a/${path} b/${path}`)
      out.push(x === undefined ? '--- /dev/null' : `--- a/${path}`)
      out.push(y === undefined ? '+++ /dev/null' : `+++ b/${path}`)
      out.push(`@@ -${xl.length ? 1 : 0},${xl.length} +${yl.length ? 1 : 0},${yl.length} @@`)
      out.push(...xl.map(l => `-${l}`), ...yl.map(l => `+${l}`))
    }
    return out.join('\n') + '\n'
  }

  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($: any, e: any) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($: any, e: any) => {
    notes.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    const q = e.questions[0].question
    return { result: { questions: e.questions, answers: { [q]: opts.answer ?? 'Restore' } }, text: 'answered' }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    if (argv[0] !== 'git' || opts.hasGit === false) return fail('not found')
    const args = argv.slice(1).filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c' && !a.startsWith('--git-dir=') && !a.startsWith('--work-tree='))
    const [cmd, ...rest] = args
    switch (cmd) {
      case '--version':
        return ok('git version 2.46.0\n')
      case 'init':
      case 'config':
      case 'add':
      case 'gc':
        return ok()
      case 'commit':
        seq += 1
        head = `c${seq}`
        commits.set(head, new Map(disk))
        return ok()
      case 'rev-parse':
        return ok(`${head}\n`)
      case 'diff': {
        const [from, to] = rest.filter(a => !a.startsWith('-'))
        const a = commits.get(from!)!
        const b = commits.get(to!)!
        return ok(rest.includes('--numstat') ? numstat(a, b) : unified(a, b))
      }
      case 'read-tree': {
        const target = commits.get(rest[rest.length - 1]!)
        if (!target) return fail('bad tree')
        disk.clear()
        for (const [k, v] of target) disk.set(k, v)
        return ok()
      }
    }
    return fail(`unknown git ${cmd}`)
  })
  return { disk, commits, store, notes, contexts }
}

const turn = async ($: any, id: string, text: string, work: () => void) => {
  await $.turn.start({ text, turnId: id })
  work()
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: id })
}

describe('waypoint', () => {
  test('snapshots around every prompt and restores to after an earlier one', async ($, on) => {
    mock.clock(on, { now: new Date(2026, 9, 4, 17, 42).getTime() })
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

    await turn($, 't1', 'add a feature', () => w.disk.set('src/feature.js', 'export const f = 1\n'))
    await turn($, 't2', 'refactor app', () => w.disk.set('src/app.js', 'console.log("v2")\n'))
    // Prompt 3 breaks things, partly through Bash: a file deleted outside the edit tools.
    await turn($, 't3', 'clean up', () => {
      w.disk.delete('README.md')
      w.disk.set('src/app.js', 'broken(\n')
    })

    const saved = [...w.store.values()][0] as any[]
    expect(saved.map(c => [c.n, c.kind, c.files])).toEqual([
      [1, 'prompt', 1],
      [2, 'prompt', 1],
      [3, 'prompt', 2],
    ])

    await $.command.run({ command: 'waypoints', args: '' } as any)
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const newest = await ui.find({ type: 'Button', key: 'cp-3' })
    expect(String(newest?.props.label)).toMatch(/^❯ #3 {2}17:42 {2}clean up +2 files \+1 −2$/)

    await ui.press({ key: 'cp-2' })
    expect(await ui.find({ type: 'Text', text: /Prompt #2/ })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.source).toBe('@@ -1,1 +1,1 @@\n-console.log("v1")\n+console.log("v2")')

    await ui.press({ key: 'restore-after' })
    expect(w.disk.get('src/app.js')).toBe('console.log("v2")\n')
    expect(w.disk.get('README.md')).toBe('# App\n')
    expect(w.disk.has('src/feature.js')).toBe(true)
    expect(w.notes).toEqual(['Waypoint: restored to after #2'])
    expect(await ui.find({ type: 'Text', text: /To undo, restore safety checkpoint ⟲4/ })).toBeDefined()

    // The restore is undoable: the safety checkpoint brings prompt 3's state back.
    await ui.press({ key: 'cp-4' })
    await ui.press({ key: 'restore-after' })
    expect(w.disk.get('src/app.js')).toBe('broken(\n')
    expect(w.disk.has('README.md')).toBe(false)
    await ui.unmount()

    // Claude hears about the restore once, with the next prompt.
    await $.prompt.submit({ text: 'what now?', wait: false, origin: { kind: 'composer' } } as any)
    await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } } as any)
    expect(String(w.contexts[0]?.[0])).toContain('Waypoint restored the project')
    expect(w.contexts[1]).toBeUndefined()
  })

  test('works from the prompt: /waypoints <n> and /waypoints restore <n> [before]', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'first', () => w.disk.set('src/app.js', 'one\n'))
    await turn($, 't2', 'second', () => w.disk.set('src/app.js', 'two\n'))

    const opened = await $.command.run({ command: 'waypoints', args: '2' } as any)
    expect(opened.text).toContain('checkpoint #2')
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Prompt #2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/waypoints-restore 2/ })).toBeDefined()
    await ui.unmount()

    const back = await $.command.run({ command: 'waypoints', args: 'restore 1' } as any)
    expect(back.text).toContain('Restored to after #1')
    expect(w.disk.get('src/app.js')).toBe('one\n')

    const before = await $.command.run({ command: 'waypoints', args: 'restore 1 before' } as any)
    expect(before.text).toContain('Restored to before #1')
    expect(w.disk.get('src/app.js')).toBe('console.log("v1")\n')

    const missing = await $.command.run({ command: 'waypoints', args: 'restore 99' } as any)
    expect(missing.text).toContain('There is no checkpoint #99')
  })

  test('the highlight starts on the newest row and follows the focus ring', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    on('ui.focus', () => ({}))
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'first', () => w.disk.set('src/app.js', 'one\n'))
    await turn($, 't2', 'second', () => w.disk.set('src/app.js', 'two\n'))
    await turn($, 't3', 'third', () => w.disk.set('src/app.js', 'three\n'))
    await $.command.run({ command: 'waypoints', args: '' } as any)
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const newest = await ui.find({ type: 'Button', key: 'cp-3' })
    expect(newest?.props.autoFocus).toBe(true)
    expect(String(newest?.props.label)).toStartWith('❯ #3')

    // The ring moves down to #2 (an arrow or Tab): #2 is highlighted and centered.
    await $.ui.focus({ component: 'Pane', requestId: 'waypoint', element: 'cp-2', plugin: 'waypoint', origin: { kind: 'person' } } as any)
    expect(String((await ui.find({ type: 'Button', key: 'cp-2' }))?.props.label)).toStartWith('❯ #2')
    expect(String((await ui.find({ type: 'Button', key: 'cp-3' }))?.props.label)).toStartWith('  #3')

    // Enter on the highlighted row opens it.
    await ui.press({ key: 'cp-2' })
    expect(await ui.find({ type: 'Text', text: /Prompt #2/ })).toBeDefined()
    await ui.unmount()
  })

  test('a checkpoint shows options a, b, c and describes the highlighted one', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    on('ui.focus', () => ({}))
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'delete readme', () => w.disk.delete('README.md'))
    await $.command.run({ command: 'waypoints', args: '1' } as any)
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

    const a = await ui.find({ type: 'Button', key: 'restore-after' })
    const b = await ui.find({ type: 'Button', key: 'restore-before' })
    const c = await ui.find({ type: 'Button', key: 'back' })
    expect([a?.props.hotkey, b?.props.hotkey, c?.props.hotkey]).toEqual(['a', 'b', 'c'])
    expect(String(a?.props.label)).toBe('❯ Restore to AFTER #1')
    expect(a?.props.autoFocus).toBe(true)
    expect(await ui.find({ type: 'Text', text: /right after prompt #1 finished/ })).toBeDefined()

    await $.ui.focus({ component: 'Pane', requestId: 'waypoint', element: 'restore-before', plugin: 'waypoint', origin: { kind: 'person' } } as any)
    expect(String((await ui.find({ type: 'Button', key: 'restore-before' }))?.props.label)).toBe('❯ Restore to BEFORE #1')
    expect(await ui.find({ type: 'Text', text: /just before you sent prompt #1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /right after prompt #1 finished/ })).toBeUndefined()

    await ui.press({ key: 'restore-before' })
    expect(w.disk.get('README.md')).toBe('# App\n')
    await ui.unmount()
  })

  test('each action also has its own command', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'first', () => w.disk.set('src/app.js', 'one\n'))
    expect((await $.command.run({ command: 'waypoints-open', args: '1' } as any)).text).toContain('checkpoint #1')
    expect((await $.command.run({ command: 'waypoints-restore', args: '1 before' } as any)).text).toContain('Restored to before #1')
    expect(w.disk.get('src/app.js')).toBe('console.log("v1")\n')
    expect((await $.command.run({ command: 'waypoints-restore', args: '' } as any)).text).toContain('Which one?')
    expect((await $.command.run({ command: 'waypoints-save', args: 'checkpoint by hand' } as any)).text).toMatch(/Saved waypoint #\d+: checkpoint by hand/)
  })

  test('Cancel leaves the files alone', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on, { answer: 'Cancel' })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'change it', () => w.disk.set('src/app.js', 'changed\n'))
    await $.command.run({ command: 'waypoints', args: '' } as any)
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    await ui.press({ key: 'cp-1' })
    await ui.press({ key: 'restore-before' })
    expect(w.disk.get('src/app.js')).toBe('changed\n')
    await ui.unmount()
  })

  test('/waypoints save takes a checkpoint by hand', async ($, on) => {
    mock.clock(on, { now: 0 })
    world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const result = await $.command.run({ command: 'waypoints', args: 'save before the big refactor' } as any)
    expect(result.text).toBe('Saved waypoint #1: before the big refactor')
  })

  test('says it is off when git is missing', async ($, on) => {
    mock.clock(on, { now: 0 })
    world(on, { hasGit: false })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const result = await $.command.run({ command: 'waypoints', args: '' } as any)
    expect(result.text).toContain('Waypoint is off: git was not found')
  })
})

describe('git helpers', () => {
  test('parse numstat and patches, and name the shadow folder', async () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.ts\n')).toEqual({ files: 3, added: 13, removed: 1 })
    const files = parsePatch(
      'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n' +
        'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n' +
        'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    )
    expect(files.map(f => [f.path, f.added, f.removed, f.isBinary])).toEqual([
      ['a.ts', 1, 1, false],
      ['gone.ts', 0, 1, false],
      ['logo.png', 0, 0, true],
    ])
    expect(files[0]!.hunks).toBe('@@ -1 +1 @@\n-x\n+y')
    expect(repoDir('C:\\Users\\alyan\\.claude\\waypoint\\', 'C:\\code\\my app', 'abc')).toBe('C:\\Users\\alyan\\.claude\\waypoint/my_app-abc')
  })
})
