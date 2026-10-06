import { describe, expect, test } from 'claude-code/testing'
import { cleanName } from '../hooks/clean-view'

// ── Test 1: name cleaner ──────────────────────────────────────────────────────

describe('cleanName', () => {
  test('strips backtick spans', async () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  })

  test('removes a path from the middle of a sentence', async () => {
    expect(cleanName('Update the file src/components/Button.tsx with changes')).toBe('Update with changes')
  })

  test('trims an 80-char name at a word boundary to 40 or fewer chars', async () => {
    const long = 'Build the very wonderful and amazing pricing section for the homepage layout now'
    const result = cleanName(long)
    expect(result.replace('…', '').length).toBeLessThanOrEqual(40)
    expect(result.endsWith('…')).toBe(true)
  })

  test('falls back to "Working on it" when nothing survives the clean', async () => {
    expect(cleanName('`code` /path/to/file src/index.tsx')).toBe('Working on it')
  })
})

// ── Shared band props ─────────────────────────────────────────────────────────

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { top: 0, bodyRows: 18, totalRows: 18 },
    view: {} as any,
  },
}

// ── Test 2: todo list + 60% report renders correctly ─────────────────────────

describe('checklist rendering', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`todo list + 60% report on ${surface}`, async ($, on) => {
      on('store.get', () => ({ value: true }))
      on('store.set', () => ({ value: undefined }))
      on('clock.now', () => ({ value: Date.now() }))
      on('model.complete', () => ({ value: { isAnswered: false } }))
      on('tool.register', () => ({ value: undefined }))
      on('command.register', () => ({ value: undefined }))

      await $.session.start({ cwd: '/work', surface, isInteractive: true })

      // Simulate TodoWrite setting up a 3-step plan
      await $.tool.call({
        tool: 'TodoWrite',
        tool_use_id: 'tw1',
        todos: [
          { content: 'Read your notes', status: 'completed', activeForm: '' },
          { content: 'Build the section', status: 'in_progress', activeForm: '' },
          { content: 'Add the contact form', status: 'pending', activeForm: '' },
          { content: 'Polish the footer', status: 'pending', activeForm: '' },
        ],
      } as any)

      // Simulate report_progress at 60%
      await $.tool.call({
        tool: 'mcp__clean-view__plan_steps',
        tool_use_id: 'ps1',
        steps: ['Read your notes', 'Build the section', 'Add the contact form', 'Polish the footer'],
      } as any)
      await $.tool.call({
        tool: 'mcp__clean-view__report_progress',
        tool_use_id: 'rp1',
        task: 'Read your notes',
        percent: 100,
      } as any)
      await $.tool.call({
        tool: 'mcp__clean-view__report_progress',
        tool_use_id: 'rp2',
        task: 'Build the section',
        percent: 60,
      } as any)

      const ui = await $.ui.mount({ plugin: 'clean-view', surface, ...BAND } as any)

      const done = await ui.find({ type: 'Text', text: /✓/ })
      expect(done).toBeDefined()

      const active = await ui.find({ type: 'Text', text: /▶/ })
      expect(active).toBeDefined()

      const meter60 = await ui.find({ type: 'Text', text: /60%/ })
      expect(meter60).toBeDefined()

      const next = await ui.find({ type: 'Text', text: /Next/ })
      expect(next).toBeDefined()

      const upNext = await ui.find({ type: 'Text', text: /Up next/ })
      expect(upNext).toBeDefined()

      await ui.unmount()
    })
  }
})

// ── Test 3: permission prompt shows Needs you ─────────────────────────────────

describe('needs-you state', () => {
  test('classic.Notification switches band to Needs you', async ($, on) => {
    on('store.get', () => ({ value: true }))
    on('store.set', () => ({ value: undefined }))
    on('clock.now', () => ({ value: Date.now() }))
    on('model.complete', () => ({ value: { isAnswered: false } }))
    on('tool.register', () => ({ value: undefined }))
    on('command.register', () => ({ value: undefined }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call({
      tool: 'mcp__clean-view__plan_steps',
      tool_use_id: 'ps1',
      steps: ['Read the file', 'Make the change'],
    } as any)

    // Fire a permission notification
    await $.classic.Notification({
      hook_event_name: 'Notification',
      message: 'Permission required',
      notification_type: 'permission',
      session_id: 's1',
      transcript_path: '',
      cwd: '/work',
    } as any)

    const ui = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as any)
    const badge = await ui.find({ type: 'Text', text: /Needs you/ })
    expect(badge).toBeDefined()
    await ui.unmount()
  })
})

// ── Test 4: /simple off hides the band ────────────────────────────────────────

describe('/simple command', () => {
  test('/simple off hides the band body (only button remains)', async ($, on) => {
    on('store.get', () => ({ value: true }))
    on('store.set', () => ({ value: undefined }))
    on('clock.now', () => ({ value: Date.now() }))
    on('model.complete', () => ({ value: { isAnswered: false } }))
    on('tool.register', () => ({ value: undefined }))
    on('command.register', () => ({ value: undefined }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'simple', args: 'off' } as any)

    const ui = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as any)
    const band = await ui.find({ type: 'Text', text: /Working on it/ })
    expect(band).toBeUndefined()
    await ui.unmount()
  })
})

// ── Test 5: plan_steps + report_progress at 100 checks off step 1 ────────────

describe('plan_steps and report_progress', () => {
  test('report_progress at 100 checks off step 1 and starts step 2', async ($, on) => {
    on('store.get', () => ({ value: true }))
    on('store.set', () => ({ value: undefined }))
    on('clock.now', () => ({ value: Date.now() }))
    on('model.complete', () => ({ value: { isAnswered: false } }))
    on('tool.register', () => ({ value: undefined }))
    on('command.register', () => ({ value: undefined }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const planResult = await $.tool.call({
      tool: 'mcp__clean-view__plan_steps',
      tool_use_id: 'ps1',
      steps: ['Read the notes', 'Write the page'],
    } as any)
    expect(String((planResult as any).result ?? '')).toContain('Planned 2 steps')

    const progressResult = await $.tool.call({
      tool: 'mcp__clean-view__report_progress',
      tool_use_id: 'rp1',
      task: 'Read the notes',
      percent: 100,
    } as any)
    expect(String((progressResult as any).result ?? '')).toContain('100%')

    const ui = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as any)
    const done = await ui.find({ type: 'Text', text: /✓/ })
    expect(done).toBeDefined()
    const active = await ui.find({ type: 'Text', text: /▶/ })
    expect(active).toBeDefined()
    await ui.unmount()
  })
})

// ── Test 6: plan gate ─────────────────────────────────────────────────────────

describe('plan gate', () => {
  test('denies tools before a plan exists and allows them after', async ($, on) => {
    on('store.get', () => ({ value: true }))
    on('store.set', () => ({ value: undefined }))
    on('clock.now', () => ({ value: Date.now() }))
    on('model.complete', () => ({ value: { isAnswered: false } }))
    on('tool.register', () => ({ value: undefined }))
    on('command.register', () => ({ value: undefined }))
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file contents', text: 'file contents', isReadOnly: true }))

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    // Simulate a turn starting (sets hasPlan = false)
    await $.turn.start({ text: 'Do something', turnId: 't1' } as any)

    // Before plan: Read should be denied
    const denied = await $.tool.call({ tool: 'Read', file_path: 'README.md', tool_use_id: 'r1' } as any)
    expect((denied as any).deny).toBeDefined()

    // Call plan_steps
    await $.tool.call({
      tool: 'mcp__clean-view__plan_steps',
      tool_use_id: 'ps1',
      steps: ['Read the file'],
    } as any)

    // After plan: Read should be allowed
    const allowed = await $.tool.call({ tool: 'Read', file_path: 'README.md', tool_use_id: 'r2' } as any)
    expect((allowed as any).deny).toBeUndefined()
  })
})
