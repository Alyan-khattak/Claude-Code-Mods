import { describe, expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'files-seen',
  component: 'Pane',
  requestId: 'files-seen',
  props: {
    title: 'Files seen',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { top: 0, bodyRows: 30, totalRows: 30 },
    view: {},
  },
} as const

describe('files-seen', () => {
  test('groups files into edited and read only, newest first', async ($, on) => {
    const statuses: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.status', ($, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'look around', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/a.ts', tool_use_id: 'u1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/b.ts', tool_use_id: 'u2' } as any)
    await $.turn.start({ text: 'fix b', turnId: 't2' })
    await $.tool.call(
      { tool: 'Edit', file_path: '/work/src/b.ts', old_string: 'x', new_string: 'y', tool_use_id: 'u3' } as any,
    )
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u4' } as any)

    expect(statuses[statuses.length - 1]).toBe('◉ 1 read · ✎ 1 edited')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect(await ui.find({ type: 'Text', text: /2 files: 1 edited, 1 read only/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Edited \(1\)/ })).toBeDefined()
      // b.ts was edited this turn, so it is marked; a.ts was only read last turn.
      expect(await ui.find({ type: 'Text', text: /● src\/b\.ts/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ {2}src\/a\.ts$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a failed or denied call is not counted', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', () => ({ result: 'nope', text: 'nope', isError: true }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: '/work/missing.ts', tool_use_id: 'u1' } as any)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Nothing read or edited yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('reset empties the list', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: 'notes.md', tool_use_id: 'u1' } as any)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    await ui.press({ key: 'reset' })
    expect(await ui.find({ type: 'Text', text: /Nothing read or edited yet/ })).toBeDefined()
    await ui.unmount()
  })
})
