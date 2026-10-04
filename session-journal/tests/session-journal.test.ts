import { describe, expect, mock, test } from 'claude-code/testing'

// 2026-10-04 12:00 local time; the journal names files by the local date.
const NOON = new Date(2026, 9, 4, 12, 0, 0).getTime()

function fakeDisk(on: any, files: Map<string, string>) {
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', ($: any, e: any) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
}

describe('session-journal', () => {
  test('writes one entry per main-loop turn', async ($, on) => {
    const files = new Map<string, string>([['/work/src/old.ts', 'x']])
    const clock = mock.clock(on, { now: NOON })
    fakeDisk(on, files)
    on('env.get', () => ({ value: undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', ($, e) =>
      String(e.tool) === 'Bash' && String((e as any).command).includes('build')
        ? { result: 'boom', text: 'boom', isError: true }
        : { result: 'ok', text: 'ok' },
    )

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'add login validation\nand tests', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/old.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/work/src/new.ts', content: 'c', tool_use_id: 'u2' } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u3' } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'u4' } as any)
    await clock.advance(72_000)
    await $.turn.complete({ reason: 'answer', answer: 'Added validation.', durationMs: 72_000, isAborted: false, turnId: 't1' } as any)

    const journal = files.get('/work/.claude/journal/2026-10-04.md')
    expect(journal).toBeDefined()
    expect(journal).toContain('# Session journal · work · 2026-10-04')
    expect(journal).toContain('## 12:00 · add login validation and tests')
    expect(journal).toContain('> add login validation\n> and tests')
    expect(journal).toContain('- `src/old.ts` (edited)')
    expect(journal).toContain('- `src/new.ts` (created)')
    expect(journal).toContain('- ✓ `npm test`')
    expect(journal).toContain('- ✗ `npm run build`')
    expect(journal).toContain('**Outcome:** answered in 1m 12s')
    expect(journal).toContain('**Reply:** Added validation.')

    // A second turn appends below the first.
    await $.turn.start({ text: 'rename helper', turnId: 't2' })
    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 3_000, isAborted: true, turnId: 't2' } as any)
    const again = files.get('/work/.claude/journal/2026-10-04.md')!
    expect(again.indexOf('add login validation')).toBeLessThan(again.indexOf('rename helper'))
    expect(again).toContain('**Outcome:** interrupted in 3s')

    const standup = await $.command.run({ command: 'standup', args: '' } as any)
    expect(standup.text).toContain('Standup for 2026-10-04: 2 prompts, 2 files changed')
    expect(standup.text).toContain('- 12:00 add login validation and tests (2 files, 1 failed command)')
    expect(standup.text).toContain('Files: src/old.ts, src/new.ts')
  })

  test('honours SESSION_JOURNAL_DIR', async ($, on) => {
    const files = new Map<string, string>()
    mock.clock(on, { now: NOON })
    fakeDisk(on, files)
    on('env.get', ($, e) => ({ value: e.name === 'SESSION_JOURNAL_DIR' ? 'notes/log' : undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ cwd: '/code/app', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await $.turn.complete({ reason: 'answer', answer: 'hi', durationMs: 1000, isAborted: false, turnId: 't1' } as any)

    expect([...files.keys()]).toEqual(['/code/app/notes/log/2026-10-04.md'])
  })

  test('subagent turns are not written on their own', async ($, on) => {
    const files = new Map<string, string>()
    mock.clock(on, { now: NOON })
    fakeDisk(on, files)
    on('env.get', () => ({ value: undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'research', turnId: 't1' })
    await $.turn.complete({ reason: 'answer', answer: 'sub', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1' } as any)
    expect(files.size).toBe(0)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    expect(files.size).toBe(1)
  })
})
