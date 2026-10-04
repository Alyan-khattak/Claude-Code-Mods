import { describe, expect, mock, test } from 'claude-code/testing'

import { face, isTestCommand, level, passedCount, shown } from '../hooks/pet'

const BAND = {
  plugin: 'code-pet',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { top: 0, bodyRows: 10, totalRows: 1 }, view: {} },
} as const

const NOON = new Date(2026, 9, 4, 12, 0, 0).getTime()

function world(on: any, opts: { profile?: object; usage?: { context: number; limit: number }; display?: string; style?: string } = {}) {
  const toasts: string[] = []
  const store = new Map<string, unknown>(opts.profile ? [['profile', opts.profile]] : [])
  const clock = mock.clock(on, { now: NOON })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'CODE_PET' ? opts.display : e.name === 'CODE_PET_STYLE' ? opts.style : undefined }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: opts.usage ? [{ kind: 'five_hour', percentUsed: opts.usage.limit }] : [],
      context: { tokens: 0, window: 200_000, percent: opts.usage?.context ?? 10 },
    },
  }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { store, toasts, clock }
}

function shell(on: any, outcome: Record<string, { ok: boolean; text: string }>) {
  on('tool.call', ($: any, e: any) => {
    const r = outcome[String(e.command)] ?? { ok: true, text: 'ok' }
    return r.ok ? { result: r.text, text: r.text } : { result: r.text, text: r.text, isError: true }
  })
}

const bash = (command: string) => ({ tool: 'Bash', command, tool_use_id: `u-${command}` }) as any
const band = async ($: any) => $.ui.mount({ ...BAND, surface: 'terminal' } as any)
const lineOf = async (ui: any) => {
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map((t: any) => t.text).join(' ')
}

describe('code-pet', () => {
  test('a new pet is an ASCII egg that watches you code', async ($, on) => {
    world(on)
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await band($)
    const line = await lineOf(ui)
    expect(line).toMatch(/^[\x20-\x7e]*$/)
    expect(line).toContain('(^)')
    expect(line).toContain('Mochi')
    expect(line).toContain('is watching you code')
    expect(line).toContain('Lv 1')
    await ui.unmount()
  })

  test('cheers for passing tests, earns XP, hatches and keeps a streak', async ($, on) => {
    const w = world(on, { profile: { name: 'Mochi', species: 'cat', xp: 20, born: NOON, streak: 0, best: 0, today: { date: '2026-10-04', tests: 0 }, pets: 0 } })
    shell(on, { 'npm test': { ok: true, text: 'Tests: 42 passed, 42 total' } })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('npm test'))
    expect(w.toasts).toEqual(['Code Pet: Mochi hatched! level 2'])
    const saved = w.store.get('profile') as any
    expect(saved.xp).toBe(30)
    expect(saved.streak).toBe(1)
    expect(saved.today.tests).toBe(42)
    const ui = await band($)
    expect(await lineOf(ui)).toContain('=*o*=')
    await ui.unmount()
    await w.clock.advance(9_000)
    await $.tool.call(bash('npm test'))
    const ui2 = await band($)
    expect(await lineOf(ui2)).toContain('42 tests passed! +10 XP')
    await ui2.unmount()
  })

  test('worries when a command fails, and gets sad after three in a row', async ($, on) => {
    world(on)
    shell(on, { 'npm run build': { ok: false, text: 'error' } })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('npm run build'))
    let ui = await band($)
    expect(await lineOf(ui)).toContain('uh oh, `npm run build` failed')
    expect(await lineOf(ui)).toContain('(O)')
    await ui.unmount()
    await $.tool.call(bash('npm run build'))
    await $.tool.call(bash('npm run build'))
    ui = await band($)
    expect(await lineOf(ui)).toContain('(T)')
    await ui.unmount()
  })

  test('shows what Claude is doing while it works', async ($, on) => {
    world(on)
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.js', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as any)
    const ui = await band($)
    expect(await lineOf(ui)).toContain('building app.js')
    await ui.unmount()
  })

  test('naps when you are idle for 15 minutes', async ($, on) => {
    const w = world(on)
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await w.clock.advance(16 * 60_000)
    const ui = await band($)
    expect(await lineOf(ui)).toContain('Mochi is asleep')
    await ui.unmount()
  })

  test('/pet pats it, names it, changes species and shows stats', async ($, on) => {
    const w = world(on, { profile: { name: 'Mochi', species: 'cat', xp: 30, born: NOON, streak: 2, best: 5, today: { date: '2026-10-04', tests: 12 }, pets: 0 } })
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect((await $.command.run({ command: 'pet', args: '' } as any)).text).toBe('=^w^= Mochi purrs happily.')
    expect((await $.command.run({ command: 'pet', args: 'name Biscuit' } as any)).text).toBe('Your pet is now called Biscuit.')
    expect((await $.command.run({ command: 'pet', args: 'species dog' } as any)).text).toContain('Biscuit is now a dog U^.^U')
    expect((await $.command.run({ command: 'pet', args: 'species dragon' } as any)).text).toContain('Pick one of')
    const stats = (await $.command.run({ command: 'pet', args: 'stats' } as any)).text
    expect(stats).toContain('U^.^U Biscuit the dog: level 2 (baby), 30 XP')
    expect(stats).toContain('Green test streak: 2 (best 5) | tests passed today: 12')
    expect(stats).toMatch(/^[\x20-\x7e\n]*$/)
    expect((w.store.get('profile') as any).pets).toBe(1)
  })

  test('CODE_PET_STYLE=emoji uses emoji instead of ASCII', async ($, on) => {
    world(on, { style: 'emoji', profile: { name: 'Mochi', species: 'fox', xp: 30, born: NOON, streak: 0, best: 0, today: { date: '2026-10-04', tests: 0 }, pets: 0 } })
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await band($)
    const line = await lineOf(ui)
    expect(line).toContain('🦊')
    expect(line).toContain('👀')
    expect(line).toContain('░')
    await ui.unmount()
  })

  test('CODE_PET=status uses the status line instead of the band', async ($, on) => {
    const statuses: string[] = []
    const w = world(on, { display: 'status' })
    on('ui.status', ($: any, e: any) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    shell(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await w.clock.advance(1_500)
    expect(statuses[statuses.length - 1]).toContain('Mochi')
    const ui = await band($)
    expect(await lineOf(ui)).not.toContain('Mochi')
    await ui.unmount()
  })
})

describe('pet', () => {
  test('knows test runners, counts passes, levels and faces', async () => {
    for (const c of ['npm test', 'pnpm run test', 'pytest -q', 'python -m pytest', 'flutter test', 'go test ./...', 'cargo test', 'npx vitest run']) {
      expect(isTestCommand(c)).toBe(true)
    }
    for (const c of ['npm run build', 'ls', 'git status']) expect(isTestCommand(c)).toBe(false)
    expect(passedCount('====== 17 passed in 0.42s ======')).toBe(17)
    expect(passedCount('Tests:       3 failed, 40 passed, 43 total')).toBe(40)
    expect(passedCount('  12 passing (30ms)')).toBe(12)
    expect([level(0), level(25), level(99), level(100), level(2500)]).toEqual([1, 2, 2, 3, 11])
    const p = { name: 'M', species: 'fox', xp: 2500, born: 0, streak: 0, best: 0, today: { date: '', tests: 0 }, pets: 0 }
    expect(face(p)).toBe('*<^.^>*')
    expect(face(p, 'ascii', 'happy')).toBe('*<^o^>*')
    expect(face({ ...p, xp: 0 }, 'ascii', 'sad')).toBe('(T)')
    expect(face(p, 'emoji')).toBe('🦊👑')
    const base = { flash: null, now: 0, lastActivity: 0, isWorking: false, doing: '', failStreak: 0, contextPercent: 0, limitPercent: 0, hour: 12, name: 'M' }
    expect(shown({ ...base, contextPercent: 80 }).mood).toBe('crowded')
    expect(shown({ ...base, limitPercent: 95 }).mood).toBe('tired')
    expect(shown({ ...base, hour: 2 }).mood).toBe('late')
  })
})
