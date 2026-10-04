import { describe, expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'token-weather',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { top: 0, bodyRows: 10, totalRows: 1 },
    view: {},
  },
} as const

// Stands for the engine beneath: it draws nothing in the band itself.
const EMPTY_BAND = ($: any, e: any) => {
  const { Box } = $.ui.resolve(e)
  return <Box />
}

describe('token-weather', () => {
  test('the forecast follows the context window', async ($, on) => {
    let tokens = 30_000
    let usd = 0.12
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.render', { component: 'AbovePrompt' }, EMPTY_BAND)
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        rateLimits: [],
        context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) },
        cost: { usd },
      },
    }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as any)
      expect(await ui.find({ type: 'Text', text: /Clear/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /15% of context/ })).toBeDefined()
      await ui.unmount()
    }

    tokens = 140_000
    usd = 1.5
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as any)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Showers/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /70% of context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /140k \/ 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▲ \+110k last turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    await ui.unmount()
  })

  test('subagent turns do not take a reading', async ($, on) => {
    let tokens = 10_000
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.render', { component: 'AbovePrompt' }, EMPTY_BAND)
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) } },
    }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    tokens = 190_000
    await $.turn.complete({
      reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub-1',
    } as any)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /5% of context/ })).toBeDefined()
    await ui.unmount()
  })

  test('yields the band to a survey', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.render', { component: 'AbovePrompt' }, EMPTY_BAND)
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { tokens: 1, window: 200_000, percent: 0 } },
    }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Clear/ })).toBeUndefined()
    await ui.unmount()
  })
})
