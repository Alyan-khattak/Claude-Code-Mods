import { describe, expect, test } from 'claude-code/testing'

import { diffLines } from '../hooks/diff'

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  props: { title: 'Replay', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { top: 0, bodyRows: 40, totalRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'replay-theater',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { top: 0, bodyRows: 10, totalRows: 1 }, view: {} },
} as const

// The engine beneath: a disk in memory that the Edit and Write tools change.
function world(on: any) {
  const disk = new Map<string, string>([['/work/greet.js', 'function greet() {\n  return "hi"\n}\n']])
  const opened: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('fs.read', ($: any, e: any) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('missing')
    return { value: text }
  })
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'Edit') {
      const text = disk.get(e.file_path)
      if (text === undefined || !text.includes(e.old_string)) return { result: 'no match', text: 'no match', isError: true }
      disk.set(e.file_path, text.replace(e.old_string, e.new_string))
    }
    if (e.tool === 'Write') disk.set(e.file_path, e.content)
    return { result: 'ok', text: 'ok' }
  })
  return { disk, opened }
}

describe('replay-theater', () => {
  test('records a turn of edits and steps through them', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'say hello', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/greet.js', old_string: '"hi"', new_string: '"hello"', tool_use_id: 'u1' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/work/README.md', content: '# Greeter\n', tool_use_id: 'u2' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/work/greet.js', old_string: 'nope', new_string: 'x', tool_use_id: 'u3' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as any)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    expect(await band.find({ type: 'Text', text: /2 edits in 2 files/ })).toBeDefined()
    await band.press({ key: 'open-replay' })
    expect(w.opened).toEqual(['replay-theater'])
    await band.unmount()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect(await ui.find({ type: 'Text', text: /greet\.js/ })).toBeDefined()
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.source).toBe('@@ -1,3 +1,3 @@\n function greet() {\n-  return "hi"\n+  return "hello"\n }')
      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /step 2 of 2/ })).toBeDefined()
      await ui.press({ key: 'prev' })
      await ui.unmount()
    }
  })

  test('a new turn starts a fresh recording; /replay keeps the last finished one', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'one', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/greet.js', old_string: '"hi"', new_string: '"hey"', tool_use_id: 'u1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await $.turn.start({ text: 'two, no edits', turnId: 't2' })
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't2' } as any)

    const result = await $.command.run({ command: 'replay', args: '' } as any)
    expect(result.text).toBe('Replaying 1 edit in 1 file.')
  })

  test('/replay with nothing recorded says so', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const result = await $.command.run({ command: 'replay', args: '' } as any)
    expect(result.text).toContain('No edits to replay yet')
  })
})

describe('diffLines', () => {
  test('writes hunks with context and counts', async () => {
    const d = diffLines('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nD\ne\nf\ng\nh\ni\n')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.hunks).toBe('@@ -1,8 +1,9 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n h\n+i')
    expect(diffLines('', 'x\n').hunks).toBe('@@ -0,0 +1,1 @@\n+x')
    expect(diffLines('same\n', 'same\n').hunks).toBe('')
  })
})
