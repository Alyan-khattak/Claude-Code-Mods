// Clean View: hides tool rows and puts a plain-English checklist above the
// prompt. Start with /simple on. The button on the right of the band also
// toggles it. Off by default so it only activates on explicit request.

import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Checklist, Phase, Task, TaskStatus } from '../types'

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, false)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null as Checklist | null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// Module-level runtime state — resets on reload, fine since it's per-turn
let hasPlan = false
let consecutiveFailures = 0
let titleReqId = 0
let doneCollapseCancel: (() => void) | undefined

// Tools that bypass the plan gate
const PLAN_EXEMPT = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  'mcp__clean-view__plan_steps',
  'mcp__clean-view__report_progress',
])

// ── Name cleaner ──────────────────────────────────────────────────────────────

export function cleanName(raw: string): string {
  let s = raw
  s = s.replace(/`[^`]*`/g, '')                                                         // strip backtick spans
  s = s.replace(/\S*\/\S*/g, '')                                                        // remove paths
  s = s.replace(/\b\S+\.(tsx?|jsx?|py|rs|go|java|c|cpp|h|css|html?|json|ya?ml|md|sh|rb|php)\b/gi, '') // code filenames
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > 0) s = s[0]!.toUpperCase() + s.slice(1)
  if (s.length > 40) {
    let cut = s.slice(0, 40)
    const sp = cut.lastIndexOf(' ')
    if (sp > 0) cut = cut.slice(0, sp)
    s = cut + '…'
  }
  return s || 'Working on it'
}

// ── Meters ────────────────────────────────────────────────────────────────────

function meter(percent: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function sweepMeter(tick: number): string {
  const pos = tick % 8
  return Array.from({ length: 10 }, (_, i) => (i >= pos && i < pos + 3 ? '▓' : '░')).join('')
}

function elapsed(startMs: number, endMs: number): string {
  const s = Math.floor((endMs - startMs) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

// ── Task helpers ──────────────────────────────────────────────────────────────

function makeTask(id: string, name: string, status: TaskStatus = 'upcoming'): Task {
  return { id, name, status, percent: 0, hasReported: false }
}

function applyProgress(tasks: Task[], reportedName: string, percent: number): Task[] {
  const cleaned = cleanName(reportedName)
  // Find by exact name first, then fall back to current active
  let idx = tasks.findIndex(t => t.name === cleaned || t.name === reportedName)
  if (idx === -1) idx = tasks.findIndex(t => t.status === 'active')

  if (idx === -1) {
    // Not in plan — append as new active step, closing the current active
    const newTask: Task = { id: `dyn-${Date.now()}`, name: cleaned, status: 'active', percent, hasReported: true }
    return [
      ...tasks.map(t => t.status === 'active' ? { ...t, status: 'done' as TaskStatus, percent: 100 } : t),
      newTask,
    ]
  }

  // Check off everything before this step
  let updated = tasks.map((t, i): Task => i < idx ? { ...t, status: 'done', percent: 100 } : t)

  if (percent >= 100) {
    updated = updated.map((t, i): Task => {
      if (i === idx) return { ...t, status: 'done', percent: 100, hasReported: true }
      if (i === idx + 1) return { ...t, status: 'active' }
      return t
    })
  } else {
    updated = updated.map((t, i): Task =>
      i === idx ? { ...t, status: 'active', percent, hasReported: true } : t,
    )
  }

  return updated
}

// ── Main export ───────────────────────────────────────────────────────────────

export function registerCleanView(on: On): void {
  // ── Session start: load persisted toggle, register tools & command, start tick ──

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('cleanViewEnabled')
    await update($, enabledAtom, () => stored === true) // default OFF

    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of this job up front, in order. Call this FIRST before any other tool. Step names must be plain English that a non-technical person understands — no file names, no code, no slashes.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '2–8 step names. Each starts with a verb, under 40 characters, no technical terms.',
            minItems: 1,
            maxItems: 8,
          },
        },
        required: ['steps'],
      },
    })

    await $.tool.register({
      name: 'report_progress',
      description:
        'Report how far along the current step is. Call with percent=100 the moment a step finishes.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name being reported on.' },
          percent: { type: 'number', description: 'How far along, 0–100. Use 100 when this step is done.' },
        },
        required: ['task', 'percent'],
      },
    })

    try {
      await $.command.register({
        name: 'simple',
        description: 'Turn Clean View on or off (/simple on | off, or /simple to toggle)',
        argumentHint: '[on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`clean-view: /simple register failed (${String(err)})`, { to: 'debug' })
    }

    // 250ms tick drives the sweep animation while a job is in progress
    $.clock.every(250, async () => {
      const cl = await read($, checklistAtom)
      if (cl !== null && (cl.phase === 'working' || cl.phase === 'needs-you')) {
        await update($, tickAtom, t => ((t ?? 0) + 1) % 100)
      }
    })

    return next(e)
  })

  // ── plan_steps tool ────────────────────────────────────────────────────────

  on('tool.call', { tool: 'mcp__clean-view__plan_steps' }, async ($, e) => {
    const input = e as unknown as { steps?: unknown }
    const raw = Array.isArray(input.steps) ? input.steps : []
    if (raw.length === 0) return { result: 'Pass at least one step name.' }

    const steps: Task[] = raw.slice(0, 8).map((s, i) =>
      makeTask(`step-${i}`, cleanName(String(s)), i === 0 ? 'active' : 'upcoming'),
    )
    hasPlan = true
    const now = await $.clock.now()

    await update($, checklistAtom, cl => ({
      title: cl?.title ?? 'Working on it',
      phase: 'working' as Phase,
      tasks: steps,
      needsYouReason: null,
      stuckReason: null,
      startedAt: cl?.startedAt ?? now,
      finishedAt: null,
      isCollapsed: false,
    }))

    const lines = steps.map((t, i) => `  ${i === 0 ? '▶' : '○'} ${t.name}`).join('\n')
    return { result: `Planned ${steps.length} steps. The first one has started.\n\n${lines}` }
  })

  // ── report_progress tool ───────────────────────────────────────────────────

  on('tool.call', { tool: 'mcp__clean-view__report_progress' }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const taskName = String(input.task ?? '')
    const raw = Number(input.percent ?? 0)
    const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0))

    await update($, checklistAtom, cl => {
      if (cl === null) return cl
      return { ...cl, tasks: applyProgress(cl.tasks, taskName, pct), phase: 'working' as Phase }
    })

    const cl2 = await read($, checklistAtom)
    let statusLines = ''
    if (cl2 !== null) {
      statusLines = '\n\n' + cl2.tasks.map(t => {
        const icon = t.status === 'done' ? '✓' : t.status === 'active' ? '▶' : '○'
        const label = t.status === 'done' ? '[done]' : t.status === 'active' ? `[${t.hasReported ? `${t.percent}%` : 'working'}]` : '[up next]'
        return `  ${icon} ${t.name}  ${label}`
      }).join('\n')
    }
    return { result: `Progress noted: ${pct}%.${statusLines}` }
  })

  // ── General tool.call: plan gate + failure tracking + needs-you clearing ──

  on('tool.call', async ($, e, next) => {
    const toolName = String(e.tool)

    // Never gate subagents
    if (e.agentId !== undefined) return next(e)

    const enabled = await read($, enabledAtom)
    if (!enabled) return next(e)

    // Clear "needs you" the moment any non-question tool fires
    if (toolName !== 'AskUserQuestion') {
      const cl = await read($, checklistAtom)
      if (cl?.phase === 'needs-you') {
        await update($, checklistAtom, c =>
          c === null ? c : { ...c, phase: 'working' as Phase, needsYouReason: null },
        )
      }
    }

    // Plan gate
    if (!hasPlan && !PLAN_EXEMPT.has(toolName)) {
      return {
        deny: 'Call mcp__clean-view__plan_steps first to lay out the steps. Use ToolSearch to load it if it is deferred.',
      }
    }

    const result = await next(e)

    // Track consecutive tool errors (distinct from user-permission denials)
    if (result.isError === true) {
      consecutiveFailures++
      if (consecutiveFailures >= 3) {
        await update($, checklistAtom, cl =>
          cl === null ? cl : {
            ...cl,
            phase: 'stuck' as Phase,
            stuckReason: 'A step keeps failing, Claude is trying another way',
          },
        )
      }
    } else if (result.deny === undefined) {
      consecutiveFailures = 0
      const cl = await read($, checklistAtom)
      if (cl?.phase === 'stuck' && cl.stuckReason !== 'You said no to a step, so Claude paused') {
        await update($, checklistAtom, c =>
          c === null ? c : { ...c, phase: 'working' as Phase, stuckReason: null },
        )
      }
    }

    return result
  })

  // ── AskUserQuestion → Needs you ───────────────────────────────────────────

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    if (enabled) {
      await update($, checklistAtom, cl =>
        cl === null ? cl : {
          ...cl,
          phase: 'needs-you' as Phase,
          needsYouReason: 'Claude needs your answer to continue',
        },
      )
    }
    return next(e)
  })

  // ── classic.Notification → Needs you ─────────────────────────────────────

  on('classic.Notification', async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    if (enabled) {
      await update($, checklistAtom, cl =>
        cl === null ? cl : {
          ...cl,
          phase: 'needs-you' as Phase,
          needsYouReason: 'Claude needs your OK to continue',
        },
      )
    }
    return next(e)
  })

  // ── classic.PermissionDenied → Stuck ─────────────────────────────────────

  on('classic.PermissionDenied' as 'classic.PermissionDenied', async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    if (enabled) {
      await update($, checklistAtom, cl =>
        cl === null ? cl : {
          ...cl,
          phase: 'stuck' as Phase,
          stuckReason: 'You said no to a step, so Claude paused',
        },
      )
    }
    return next(e)
  })

  // ── classic.StopFailure → Stuck with plain-language reason ───────────────

  on('classic.StopFailure', async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    if (!enabled) return next(e)

    const ev = e as unknown as { error?: string }
    let reason: string
    switch (ev.error) {
      case 'rate_limit':
        reason = 'You hit your usage limit, try again a little later'
        break
      case 'overloaded':
        reason = "Claude's servers are busy, try again in a minute"
        break
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
      case 'billing_error':
        reason = 'Type /login to reconnect'
        break
      default:
        reason = 'Something went wrong, try again in a moment'
    }

    await update($, checklistAtom, cl =>
      cl === null ? cl : { ...cl, phase: 'stuck' as Phase, stuckReason: reason },
    )
    return next(e)
  })

  // ── TodoWrite → replace checklist tasks ───────────────────────────────────

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    const enabled = await read($, enabledAtom)
    if (!enabled) return result

    const input = e as unknown as { todos?: unknown }
    const todos = Array.isArray(input.todos) ? input.todos : []
    hasPlan = true

    let foundActive = false
    const tasks: Task[] = todos.map((todo: unknown, i: number) => {
      const t = (todo ?? {}) as Record<string, unknown>
      const name = cleanName(String(t['content'] ?? 'Working on it'))
      let status: TaskStatus =
        t['status'] === 'completed' ? 'done' :
        t['status'] === 'in_progress' ? 'active' : 'upcoming'
      if (status === 'active') {
        if (foundActive) status = 'upcoming'
        else foundActive = true
      }
      return { id: `todo-${i}`, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
    })

    await update($, checklistAtom, cl => ({
      title: cl?.title ?? 'Working on it',
      phase: 'working' as Phase,
      tasks,
      needsYouReason: null,
      stuckReason: cl?.stuckReason ?? null,
      startedAt: cl?.startedAt ?? null,
      finishedAt: null,
      isCollapsed: false,
    }))

    return result
  })

  // ── TaskCreate → append checklist row ─────────────────────────────────────

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    const enabled = await read($, enabledAtom)
    if (!enabled) return result

    const input = e as unknown as { subject?: unknown }
    const name = cleanName(String(input.subject ?? 'Working on it'))
    hasPlan = true

    await update($, checklistAtom, cl => {
      const tasks = cl?.tasks ?? []
      return {
        title: cl?.title ?? 'Working on it',
        phase: 'working' as Phase,
        tasks: [...tasks, makeTask(`tc-${Date.now()}`, name, 'upcoming')],
        needsYouReason: cl?.needsYouReason ?? null,
        stuckReason: cl?.stuckReason ?? null,
        startedAt: cl?.startedAt ?? null,
        finishedAt: null,
        isCollapsed: false,
      }
    })

    return result
  })

  // ── TaskUpdate → update matching checklist row ────────────────────────────

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    const enabled = await read($, enabledAtom)
    if (!enabled) return result

    const input = e as unknown as { subject?: unknown; status?: unknown }
    if (input.subject === undefined && input.status === undefined) return result

    const newName = input.subject !== undefined ? cleanName(String(input.subject)) : undefined
    const newStatus = String(input.status ?? '')

    await update($, checklistAtom, cl => {
      if (cl === null) return cl
      const tasks = cl.tasks.map(t => {
        if (t.status !== 'active') return t
        const updated = { ...t }
        if (newName !== undefined) updated.name = newName
        if (newStatus === 'completed') { updated.status = 'done'; updated.percent = 100 }
        else if (newStatus === 'in_progress') updated.status = 'active'
        else if (newStatus === 'pending') updated.status = 'upcoming'
        return updated
      })
      return { ...cl, tasks }
    })

    return result
  })

  // ── turn.start → new job with placeholder steps + async title ─────────────

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    hasPlan = false
    consecutiveFailures = 0
    doneCollapseCancel?.()
    doneCollapseCancel = undefined

    const enabled = await read($, enabledAtom)
    if (!enabled) return next(e)

    const now = await $.clock.now()
    const reqId = ++titleReqId

    await update($, checklistAtom, () => ({
      title: 'Working on it',
      phase: 'working' as Phase,
      tasks: [
        makeTask('ph-1', 'Understand your request', 'active'),
        makeTask('ph-2', 'Plan the steps', 'upcoming'),
      ],
      needsYouReason: null,
      stuckReason: null,
      startedAt: now,
      finishedAt: null,
      isCollapsed: false,
    }))

    // Background: ask Haiku for a 2–6 word verb-first title
    const promptText = e.text
    void (async () => {
      try {
        const r = await $.model.complete({
          model: 'claude-haiku-4-5-20251001',
          prompt: `Give a job title for this request in 2-6 plain English words. Start with a verb. No quotes, no punctuation at the end. Never use technical terms, file names, code or slashes. Examples: "Build the pricing section", "Fix the login bug", "Write a short poem". Only output the title itself, nothing else.\n\nRequest: ${promptText.slice(0, 400)}`,
        })
        if (!r.isAnswered) return
        if (reqId !== titleReqId) return // newer job started
        const title = cleanName(r.text.trim().split('\n')[0]?.trim() ?? '')
        if (title && title !== 'Working on it') {
          await update($, checklistAtom, cl => (cl === null ? cl : { ...cl, title }))
        }
      } catch {
        // ignore — placeholder title stays
      }
    })()

    return next(e)
  })

  // ── turn.complete → final state ────────────────────────────────────────────

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const enabled = await read($, enabledAtom)
    if (!enabled) return result

    const now = await $.clock.now()

    if (e.isAborted) {
      await update($, checklistAtom, cl =>
        cl === null ? cl : { ...cl, phase: 'stopped' as Phase, finishedAt: now },
      )
      return result
    }

    if (e.reason === 'refusal') {
      await update($, checklistAtom, cl =>
        cl === null ? cl : {
          ...cl,
          phase: 'stuck' as Phase,
          stuckReason: "Claude couldn't help with that request",
          finishedAt: now,
        },
      )
      return result
    }

    if (e.reason === 'error') {
      // StopFailure already set a message; only set a fallback if nothing set
      const cl = await read($, checklistAtom)
      if (cl?.phase !== 'stuck') {
        await update($, checklistAtom, c =>
          c === null ? c : {
            ...c,
            phase: 'stuck' as Phase,
            stuckReason: 'Something went wrong, try again in a moment',
            finishedAt: now,
          },
        )
      }
      return result
    }

    // Normal answer — mark all tasks done
    await update($, checklistAtom, cl =>
      cl === null ? cl : {
        ...cl,
        phase: 'done' as Phase,
        finishedAt: now,
        tasks: cl.tasks.map(t => ({ ...t, status: 'done' as TaskStatus, percent: 100 })),
      },
    )

    // Collapse to one line after 5 seconds
    doneCollapseCancel = $.clock.after(5_000, async () => {
      await update($, checklistAtom, cl => (cl === null ? cl : { ...cl, isCollapsed: true }))
      doneCollapseCancel = undefined
    })

    return result
  })

  // ── prompt.compose → inject Clean View instructions ───────────────────────

  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    const enabled = await read($, enabledAtom)
    if (!enabled) return base
    return {
      sections: [
        ...base.sections,
        {
          id: 'clean-view:instructions',
          text: `## Clean View — task reporting (follow strictly)

FIRST action for EVERY request (even a quick question): call the tool \`mcp__clean-view__plan_steps\`. If it is not listed in your tools, call ToolSearch first with query "select:mcp__clean-view__plan_steps".

Step name rules (enforced strictly):
- Plain English only. A non-technical person must understand every step name.
- Start each name with a verb: "Build the pricing section", "Check your settings", "Write the intro".
- Under 40 characters. No file paths, file names, slashes, backticks, code, or tool names.
- 2 to 8 steps per job.

Then call \`mcp__clean-view__report_progress\` as work progresses, and with percent=100 the moment each step finishes.

If this session uses TodoWrite or TaskCreate, those can serve as the plan — call them before other tools.`,
          scope: 'session' as const,
        },
      ],
    }
  })

  // ── /simple command ────────────────────────────────────────────────────────

  on('command.run', { command: 'simple' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    const current = await read($, enabledAtom)
    const next = args === 'on' ? true : args === 'off' ? false : !current

    await update($, enabledAtom, () => next)
    await $.store.set('cleanViewEnabled', next)
    $.ui.toast(`Clean View ${next ? 'on' : 'off'}`)

    return { text: `Clean View is now ${next ? 'on' : 'off'}.` }
  })

  // ── Hide tool rows ─────────────────────────────────────────────────────────

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    return enabled ? {} : next(e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    return enabled ? {} : next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    return enabled ? {} : next(e)
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const enabled = await read($, enabledAtom)
    if (!enabled) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // ── AbovePrompt band ───────────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const enabled = await read($, enabledAtom)
    const cl = await read($, checklistAtom)
    const tick = (await read($, tickAtom)) ?? 0
    const nowMs = await $.clock.now()

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns

    const toggle = async () => {
      const cur = await read($, enabledAtom)
      const nxt = !cur
      await update($, enabledAtom, () => nxt)
      await $.store.set('cleanViewEnabled', nxt)
      $.ui.toast(`Clean View ${nxt ? 'on' : 'off'}`)
    }

    const btnLabel = `● Clean View: ${enabled ? 'ON' : 'OFF'}`

    // When off or no active job: show button only
    if (!enabled || cl === null) {
      return (
        <Box flexDirection="column">
          {below}
          <Box key="cv" flexDirection="row" justifyContent="flex-end" width={cols}>
            <Button key="toggle" label={btnLabel} onPress={toggle} />
          </Box>
        </Box>
      )
    }

    // Header text per phase
    const startMs = cl.startedAt ?? nowMs
    const dur = cl.finishedAt !== null ? elapsed(startMs, cl.finishedAt) : elapsed(startMs, nowMs)

    let headerText: string
    let headerColor: string | undefined
    let headerBold = false
    switch (cl.phase) {
      case 'working':
        headerText = `${cl.title} · ${dur}`
        break
      case 'needs-you':
        headerText = `⚑ Needs you · ${cl.needsYouReason ?? 'Claude needs your input'}`
        headerColor = 'yellow'
        headerBold = true
        break
      case 'stuck':
        headerText = `⚠ Stuck: ${cl.stuckReason ?? 'something went wrong'}`
        headerColor = 'red'
        break
      case 'stopped':
        headerText = `■ Stopped · ${cl.title} · you pressed Esc`
        headerColor = 'gray'
        break
      case 'done':
        headerText = `✓ All done · ${cl.title} · took ${dur}`
        headerColor = 'green'
        break
      default:
        headerText = cl.title
    }

    // Collapsed done: one line + button
    if (cl.isCollapsed && cl.phase === 'done') {
      return (
        <Box flexDirection="column">
          {below}
          <Box key="cv" flexDirection="row" justifyContent="space-between" width={cols}>
            <Text color={headerColor} dimColor>{headerText}</Text>
            <Button key="toggle" label={btnLabel} onPress={toggle} />
          </Box>
        </Box>
      )
    }

    // Layout math: icon(2) + name + gap + meter(10) + 2 + label(7)
    // overhead = 21; name column gets the rest, min 10
    const nameWidth = Math.max(10, cols - 23)
    const firstUpcomingIdx = cl.tasks.findIndex(t => t.status === 'upcoming')

    const taskRows = cl.tasks.map((task, i) => {
      const isDone = task.status === 'done'
      const isActive = task.status === 'active'
      const isFirst = task.status === 'upcoming' && i === firstUpcomingIdx

      const icon = cl.phase === 'needs-you' && isActive ? '‖' :
                   isDone ? '✓' : isActive ? '▶' : '○'
      const meterStr = isDone ? meter(100) :
                       isActive && task.hasReported ? meter(task.percent) :
                       isActive ? sweepMeter(tick) :
                       meter(0)
      const labelStr = isDone ? 'Done' :
                       isActive && task.hasReported ? `${task.percent}%` :
                       isActive ? 'Working' :
                       isFirst ? 'Next' : 'Up next'

      const displayName = task.name.length > nameWidth
        ? task.name.slice(0, nameWidth - 1) + '…'
        : task.name

      return (
        <Box key={`t-${task.id}`} flexDirection="row">
          <Text color={isDone ? 'green' : undefined} dimColor={!isActive && !isDone}>
            {icon}{' '}
          </Text>
          <Text dimColor={isDone || !isActive} bold={isActive}>
            {displayName}
          </Text>
          <Box flexGrow={1} />
          <Text dimColor={isDone || !isActive}>{meterStr}</Text>
          <Text dimColor>{'  '}{labelStr}</Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {below}
        <Box key="cv" flexDirection="column" width={cols}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={headerColor} bold={headerBold}>{headerText}</Text>
            <Button key="toggle" label={btnLabel} onPress={toggle} />
          </Box>
          {taskRows}
        </Box>
      </Box>
    )
  })
}
