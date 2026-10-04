import { describe, expect, mock, test } from 'claude-code/testing'

import { bar, untilReset } from '../hooks/format'

const BAND = {
  plugin: 'limit-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { top: 0, bodyRows: 10, totalRows: 1 }, view: {} },
} as const

const PANE = {
  plugin: 'limit-meter',
  component: 'Pane',
  requestId: 'limit-meter',
  props: { title: 'Limits', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 30, totalRows: 30 }, view: {} },
} as const

const T0 = new Date(2026, 9, 4, 10, 0, 0).getTime()
const MIN = 60_000

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

function world(on: any, state: { limits: Limit[]; usd?: number; display?: string }) {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  mock.store(on)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'LIMIT_METER' ? state.display : undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: state.limits,
      context: { tokens: 0, window: 200_000, percent: 0 },
      ...(state.usd === undefined ? {} : { cost: { usd: state.usd } }),
    },
  }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { toasts, statuses }
}

const iso = (ms: number) => new Date(ms).toISOString()
const complete = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' } as any

describe('limit-meter', () => {
  test('shows the 5-hour and weekly windows with resets and used today', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const fiveReset = iso(T0 + 133 * MIN)
    const weekReset = iso(T0 + 4 * 24 * 60 * MIN)
    const state = {
      limits: [
        { kind: 'seven_day', percentUsed: 18, resetsAt: weekReset },
        { kind: 'five_hour', percentUsed: 42, resetsAt: fiveReset },
      ],
      usd: 0.5,
    }
    world(on, state)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    state.limits = [
      { kind: 'seven_day', percentUsed: 24, resetsAt: weekReset },
      { kind: 'five_hour', percentUsed: 47.5, resetsAt: fiveReset },
    ]
    await $.turn.complete(complete)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as any)
      expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^47\.5%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /· 2h 13m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /today \+6%/ })).toBeDefined()
      await ui.unmount()
    }

    // A minute later the countdown has moved without any new response.
    await clock.advance(MIN)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /· 2h 12m/ })).toBeDefined()
    await ui.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await pane.find({ type: 'Text', text: /5-hour limit/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Used today: \+6% of the week/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /This session: \$0\.50/ })).toBeDefined()
    await pane.unmount()
  })

  test('warns once per threshold per window', async ($, on) => {
    mock.clock(on, { now: T0 })
    const reset = iso(T0 + 60 * MIN)
    const state = { limits: [{ kind: 'five_hour', percentUsed: 76, resetsAt: reset }] }
    const w = world(on, state)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(w.toasts).toEqual(['Limit Meter: 5-hour limit at 76% · resets in 1h 0m'])

    state.limits = [{ kind: 'five_hour', percentUsed: 80, resetsAt: reset }]
    await $.turn.complete(complete)
    expect(w.toasts).toHaveLength(1)

    state.limits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: reset }]
    await $.turn.complete(complete)
    expect(w.toasts[1]).toBe('Limit Meter: 5-hour limit reached · resets in 1h 0m')
    expect(w.toasts).toHaveLength(2)
  })

  test('with an API key there are no limits: the band stays quiet, the pane says why', async ($, on) => {
    mock.clock(on, { now: T0 })
    world(on, { limits: [], usd: 2.25 })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await band.find({ type: 'Text', text: /%/ })).toBeUndefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await pane.find({ type: 'Text', text: /No plan limits reported yet/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /This session: \$2\.25/ })).toBeDefined()
    await pane.unmount()
  })

  test('LIMIT_METER=status uses the status line instead of the band', async ($, on) => {
    mock.clock(on, { now: T0 })
    const w = world(on, {
      limits: [
        { kind: 'five_hour', percentUsed: 12 },
        { kind: 'seven_day', percentUsed: 30 },
      ],
      display: 'status',
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(w.statuses[w.statuses.length - 1]).toBe('5h 12% · week 30%')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await band.find({ type: 'Text', text: /12%/ })).toBeUndefined()
    await band.unmount()
  })
})

describe('format', () => {
  test('bars and countdowns', async () => {
    expect(bar(50, 8)).toBe('████░░░░')
    expect(bar(130, 4)).toBe('████')
    expect(untilReset(T0 + 42 * MIN, T0)).toBe('42m')
    expect(untilReset(T0 - 1, T0)).toBe('resetting')
  })
})