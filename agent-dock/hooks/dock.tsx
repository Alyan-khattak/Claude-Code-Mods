import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import {
  parseSize, jobName, initials, colorFor,
  splitInstructionWithRoles, nextRole, roleInitials,
  nudgeText, badgeText, summaryLine,
  meterBar, fmtTime, fmtTimer, overallPct,
} from './dock-logic'

const PANE = 'agent-dock'
const MAX_CONCURRENT = 10
let dataDir = ''

// ── Types ──────────────────────────────────────────────────────────────────────

type HelperStatus = 'queued' | 'working' | 'done' | 'stuck'
type AgentRole = { name: string; instructions: string }
type Helper = {
  id: string
  description: string
  initials: string
  color: string
  status: HelperStatus
  pct: number
  startMs: number | null
  endMs: number | null
}
type DockPhase = 'idle' | 'live' | 'done'
type DockState = {
  teamSize: number
  helperModel: 'haiku' | 'same'
  job: string
  helpers: Helper[]
  phase: DockPhase
  jobStartMs: number | null
  jobEndMs: number | null
  isFolded: boolean
  pendingBigTeam: number | null
  stuckCount: number
  roles: AgentRole[]
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

const dockAtom = atom({ plugin: 'agent-dock', key: 'dock' } as const, {
  teamSize: 1,
  helperModel: 'haiku' as const,
  job: '',
  helpers: [] as Helper[],
  phase: 'idle' as DockPhase,
  jobStartMs: null as number | null,
  jobEndMs: null as number | null,
  isFolded: false,
  pendingBigTeam: null as number | null,
  stuckCount: 0,
  roles: [] as AgentRole[],
} satisfies DockState)

const tickAtom = atom({ plugin: 'agent-dock', key: 'tick' } as const, 0)

// ── Module-level ephemeral state ───────────────────────────────────────────────

let activeCount = 0
let turnAgentCount = 0
let nudgeSentThisTurn = false
let clockCancel: (() => void) | undefined
let sessionId = ''
const agentIdToCardId = new Map<string, string>()

// ── Helpers ────────────────────────────────────────────────────────────────────

async function writeStatusFile($: Parameters<Parameters<On>[2]>[0]): Promise<void> {
  if (!sessionId) return
  try {
    const state = await read($, dockAtom)
    const working = state.helpers.filter(h => h.status === 'working').length
    const queued = state.helpers.filter(h => h.status === 'queued').length
    const done = state.helpers.filter(h => h.status === 'done').length
    await $.fs.write(
      `${dataDir}/${sessionId}.json`,
      JSON.stringify({ working, queued, done, total: state.helpers.length }),
    )
  } catch { /* non-critical */ }
}

// ── Register ───────────────────────────────────────────────────────────────────

export function registerDock(on: On): void {

  // ── Session start ──────────────────────────────────────────────────────────
  on('session.start', async ($, e, next) => {
    activeCount = 0
    turnAgentCount = 0
    nudgeSentThisTurn = false
    agentIdToCardId.clear()
    clockCancel?.()
    clockCancel = undefined

    try { sessionId = await $.session.id() } catch { sessionId = '' }
    try {
      const r = await $.process.run(['sh', '-c', 'echo $HOME'])
      dataDir = `${r.stdout.trim()}/.claude/ai-employee-kit-data/agents-now`
    } catch { dataDir = '' }

    // Load persisted settings
    try {
      const size = await $.store.get({ key: 'dock-team-size' })
      const hm = await $.store.get({ key: 'dock-helper-model' })
      const storedRoles = await $.store.get({ key: 'dock-roles' })
      const storedSize = typeof size?.value === 'number' ? size.value : 1
      // Big team sizes (>20) never carry over
      const safeSize = storedSize > 20 ? 1 : storedSize
      const helperModel = hm?.value === 'same' ? 'same' as const : 'haiku' as const
      const roles = Array.isArray(storedRoles?.value) ? storedRoles.value as AgentRole[] : []
      await update($, dockAtom, s => ({ ...s, teamSize: safeSize, helperModel, roles }))
    } catch { /* keep defaults */ }

    try {
      await $.command.register({
        name: 'dock',
        description: 'Open Agent Dock. /dock N sets team size.',
        argumentHint: '[N|on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`agent-dock: /dock register failed (${String(err)})`, { to: 'debug' })
    }

    return next(e)
  })

  // ── /dock command ──────────────────────────────────────────────────────────
  on('command.run', { command: 'dock' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const state = await read($, dockAtom)

    // /dock role N name ["instructions"] — assign role to a slot
    if (args.startsWith('role ')) {
      const rest = args.slice(5).trim()
      const numMatch = rest.match(/^(\d+)\s+(.+)$/)
      if (!numMatch) return { text: 'Usage: /dock role N rolename ["instructions"]  e.g. /dock role 1 backend "use REST"' }
      const slot = parseInt(numMatch[1]!, 10) - 1
      if (slot < 0 || slot >= 100) return { text: 'Slot must be 1–100.' }
      const remainder = numMatch[2]!.trim()
      const instrMatch = remainder.match(/^(.*?)\s*"([^"]*)"$/)
      const roleName = instrMatch ? instrMatch[1]!.trim() : remainder
      const instructions = instrMatch ? instrMatch[2]! : ''
      await update($, dockAtom, s => {
        const roles = [...s.roles]
        while (roles.length <= slot) roles.push({ name: '', instructions: '' })
        roles[slot] = { name: roleName, instructions }
        return { ...s, roles }
      })
      try {
        const s2 = await read($, dockAtom)
        await $.store.set({ key: 'dock-roles', value: s2.roles })
      } catch { /* ignore */ }
      return { text: `Agent ${slot + 1}: ${roleName}${instructions ? ` — "${instructions}"` : ''}` }
    }

    // /dock N — set size
    if (args !== '') {
      const n = parseSize(args)
      if (n === null) {
        return { text: 'Team Size is a whole number from 1 to 100, e.g. /dock 10.' }
      }
      if (n > 20) {
        await update($, dockAtom, s => ({ ...s, pendingBigTeam: n }))
        void (async () => {
          try {
            const panes = await $.ui.panes()
            if (!panes.some(p => p.id === PANE)) {
              const res = await $.ui.open({ id: PANE, title: 'Agent Dock', focus: true, closeOnEscape: true, columns: 54 })
              if (!res.isPlaced) $.ui.toast('Widen the window to see Agent Dock.')
            }
          } catch { /* ignore */ }
        })()
        return { text: `Confirm the team of ${n} in the Agent Dock.` }
      }
      await update($, dockAtom, s => ({ ...s, teamSize: n, pendingBigTeam: null }))
      try { await $.store.set({ key: 'dock-team-size', value: n }) } catch { /* ignore */ }
      $.ui.toast(`Team size: ${n}`)
      void (async () => {
        try {
          const panes = await $.ui.panes()
          if (!panes.some(p => p.id === PANE)) {
            const res = await $.ui.open({ id: PANE, title: 'Agent Dock', focus: true, closeOnEscape: true, columns: 54 })
            if (!res.isPlaced) $.ui.toast('Widen the window to see Agent Dock.')
          }
        } catch { /* ignore */ }
      })()
      return { text: `Team size set to ${n}.` }
    }

    // /dock — toggle
    void (async () => {
      try {
        const panes = await $.ui.panes()
        const isOpen = panes.some(p => p.id === PANE)
        if (isOpen) {
          await $.ui.close({ id: PANE })
          await update($, dockAtom, s => ({ ...s, isFolded: true }))
        } else {
          await update($, dockAtom, s => ({ ...s, isFolded: false }))
          const res = await $.ui.open({ id: PANE, title: 'Agent Dock', focus: true, closeOnEscape: true, columns: 54 })
          if (!res.isPlaced) $.ui.toast('The window is too narrow to show the Agent Dock. Widen it or watch the status bar.')
        }
      } catch { /* ignore */ }
    })()

    const isFolded = state.isFolded
    const working = state.helpers.filter(h => h.status === 'working').length
    const queued = state.helpers.filter(h => h.status === 'queued').length
    const done = state.helpers.filter(h => h.status === 'done').length
    return { text: isFolded ? 'Agent Dock opened.' : badgeText(working, queued, done) }
  })

  // ── ui.close — pane closed (X or ESC) ─────────────────────────────────────
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await update($, dockAtom, s => ({ ...s, isFolded: true }))
    return result
  })

  // ── prompt.submit — inject split instruction ───────────────────────────────
  on('prompt.submit', async ($, e, next) => {
    if ((e as unknown as Record<string, unknown>)['agentId'] !== undefined) return next(e)

    const state = await read($, dockAtom)
    const { teamSize } = state

    // Reset per-turn counters
    turnAgentCount = 0
    nudgeSentThisTurn = false

    if (teamSize <= 1) return next(e)

    const job = jobName(e.text)
    const now = await $.clock.now()
    await update($, dockAtom, s => ({
      ...s,
      job,
      helpers: [],
      phase: 'live',
      jobStartMs: now,
      jobEndMs: null,
      stuckCount: 0,
    }))

    // Build per-slot roles, cycling if fewer defined than teamSize
    const { roles, helperModel } = state
    const effectiveRoles = Array.from({ length: teamSize }, (_, i) =>
      roles.length > 0 ? (roles[i % roles.length] ?? { name: '', instructions: '' }) : { name: '', instructions: '' }
    )
    const instruction = splitInstructionWithRoles(teamSize, effectiveRoles, helperModel)
    return next({ ...e, context: [...(e.context ?? []), instruction] })
  })

  // ── turn.start — start tick clock ─────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    if ((e as unknown as Record<string, unknown>)['agentId'] !== undefined) return next(e)

    if (!clockCancel) {
      clockCancel = $.clock.every(500, async () => {
        const state = await read($, dockAtom)
        if (state.phase !== 'live') return
        await update($, tickAtom, t => ((t ?? 0) + 1) % 1000)
        if (state.isFolded) {
          const w = state.helpers.filter(h => h.status === 'working').length
          const q = state.helpers.filter(h => h.status === 'queued').length
          const d = state.helpers.filter(h => h.status === 'done').length
          $.ui.status(badgeText(w, q, d))
        }
        void writeStatusFile($)
      })
    }

    return next(e)
  })

  // ── agent.spawn — queue, cap, track ───────────────────────────────────────
  on('agent.spawn', async ($, e, next) => {
    // Only intercept top-level (main-thread) spawns
    if (e.parentAgentId !== undefined) return next(e)

    const state = await read($, dockAtom)
    const { teamSize, helperModel } = state
    if (teamSize <= 1) return next(e)

    turnAgentCount++

    // Cap check
    if (turnAgentCount > teamSize) {
      return { deny: `Team Size is ${teamSize}: this request already has ${teamSize} helpers. Finish with the helpers you have.` }
    }

    // Add queued card — use assigned role if available
    const cardId = e.tool_use_id
    const slotIndex = turnAgentCount - 1
    const roleForSlot = state.roles.length > 0
      ? (state.roles[slotIndex % state.roles.length] ?? { name: '', instructions: '' })
      : { name: '', instructions: '' }
    const desc = roleForSlot.name || e.description || `Helper ${turnAgentCount}`
    const inits = roleForSlot.name ? roleInitials(roleForSlot.name) : initials(desc)
    const color = colorFor(inits)
    const helper: Helper = {
      id: cardId,
      description: desc,
      initials: inits,
      color,
      status: 'queued',
      pct: 0,
      startMs: null,
      endMs: null,
    }
    await update($, dockAtom, s => ({ ...s, helpers: [...s.helpers, helper] }))

    // Queue while over concurrent limit
    while (activeCount >= MAX_CONCURRENT) {
      await $.process.run(['/bin/sleep', '0.5'])
    }

    activeCount++
    const nowMs = await $.clock.now()
    await update($, dockAtom, s => ({
      ...s,
      helpers: s.helpers.map(h => h.id === cardId
        ? { ...h, status: 'working' as HelperStatus, startMs: nowMs }
        : h),
    }))

    // Override model for Fast & Cheap
    let ev: typeof e = e
    if (helperModel === 'haiku' && !e.model) {
      ev = { ...e, model: 'claude-haiku-4-5-20251001' }
    }

    const result = await next(ev)
    // Track agentId for turn.complete mapping
    if (!result.deny && result.agentId) {
      agentIdToCardId.set(result.agentId, cardId)
    } else {
      // spawn refused — card goes stuck, free the slot
      activeCount--
      const endMs = await $.clock.now()
      await update($, dockAtom, s => ({
        ...s,
        helpers: s.helpers.map(h => h.id === cardId
          ? { ...h, status: 'stuck' as HelperStatus, endMs }
          : h),
        stuckCount: s.stuckCount + 1,
      }))
    }

    return result
  })

  // ── turn.complete — subagent cards + main nudge/summary ──────────────────
  on('turn.complete', async ($, e, next) => {
    const agId = e.agentId

    // Subagent finished — update its card
    if (agId) {
      const cardId = agentIdToCardId.get(agId)
      if (cardId) {
        agentIdToCardId.delete(agId)
        activeCount = Math.max(0, activeCount - 1)
        const endMs = await $.clock.now()
        const status: HelperStatus = e.isAborted ? 'stuck' : 'done'
        await update($, dockAtom, s => ({
          ...s,
          helpers: s.helpers.map(h => h.id === cardId
            ? { ...h, status, pct: status === 'done' ? 100 : h.pct, endMs }
            : h),
          stuckCount: status === 'stuck' ? s.stuckCount + 1 : s.stuckCount,
        }))
        void writeStatusFile($)
      }
      return next(e)
    }

    // Main turn finished
    const state = await read($, dockAtom)
    const { teamSize, job, jobStartMs } = state

    if (teamSize > 1) {
      const nowMs = await $.clock.now()
      const durationMs = jobStartMs !== null ? nowMs - jobStartMs : 0

      if (turnAgentCount > 0 && turnAgentCount < teamSize && !nudgeSentThisTurn) {
        nudgeSentThisTurn = true
        void $.prompt.submit({ text: nudgeText(turnAgentCount, teamSize) })
      }

      if (turnAgentCount > 0) {
        await update($, dockAtom, s => ({
          ...s,
          phase: 'done' as DockPhase,
          jobEndMs: nowMs,
          helpers: s.helpers.map(h =>
            h.status === 'queued' || h.status === 'working'
              ? { ...h, status: 'done' as HelperStatus, pct: 100 }
              : h,
          ),
        }))
        clockCancel?.()
        clockCancel = undefined
        const finalState = await read($, dockAtom)
        $.ui.toast(summaryLine(finalState.helpers.length, job, durationMs, finalState.stuckCount))
        $.ui.status(undefined)
      } else {
        await update($, dockAtom, s => ({ ...s, phase: 'idle' }))
      }
      void writeStatusFile($)
    }

    return next(e)
  })

  // ── tool.call report_progress from helpers ─────────────────────────────────
  on('tool.call', { tool: /report_progress/ as unknown as 'mcp__clean-view__report_progress' }, async ($, e, next) => {
    const agId = (e as unknown as Record<string, unknown>)['agentId'] as string | undefined
    if (!agId) return next(e)

    const cardId = agentIdToCardId.get(agId)
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const rawPct = Number(input.percent ?? 0)
    const pct = Math.max(0, Math.min(100, Number.isFinite(rawPct) ? rawPct : 0))

    if (cardId) {
      await update($, dockAtom, s => ({
        ...s,
        helpers: s.helpers.map(h =>
          h.id === cardId ? { ...h, pct, status: 'working' as HelperStatus } : h,
        ),
      }))
    }

    return { result: `Progress noted: ${pct}%.` }
  })

  // ── ui.render Pane ─────────────────────────────────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    const state = await read($, dockAtom)
    const tick = (await read($, tickAtom)) ?? 0
    const nowMs = await $.clock.now()
    const cols = e.props.bodyColumns
    const { teamSize, helpers, phase, job, jobStartMs, jobEndMs, pendingBigTeam, helperModel, roles } = state

    // ── Big team confirmation ──────────────────────────────────────────────
    if (pendingBigTeam !== null) {
      const confirmBig = async () => {
        await update($, dockAtom, s => ({ ...s, teamSize: pendingBigTeam!, pendingBigTeam: null }))
        try { await $.store.set({ key: 'dock-team-size', value: pendingBigTeam! }) } catch { /* ignore */ }
        $.ui.toast(`Team size: ${pendingBigTeam}`)
      }
      const cancelBig = async () => {
        await update($, dockAtom, s => ({ ...s, pendingBigTeam: null }))
      }
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text bold>◆  A G E N T   D O C K</Text>
          <Text> </Text>
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow" bold>⚠ Big team: this uses your plan quickly.</Text>
            <Text>Running {pendingBigTeam} helpers per request.</Text>
            <Text> </Text>
            <Box flexDirection="row" gap={2}>
              <Button key="confirm" label={`Continue with ${pendingBigTeam}`} onPress={confirmBig} />
              <Button key="cancel" label="Cancel" onPress={cancelBig} />
            </Box>
          </Box>
        </Box>
      )
    }

    // ── Team size presets ──────────────────────────────────────────────────
    // hotkeys: 1 3 5 t(en) w(enty) f(ifty) c(entury)
    const SIZES = [1, 3, 5, 10, 20, 50, 100]
    const SIZE_KEYS = ['1', '3', '5', 't', 'w', 'f', 'c'] as const
    const sizeButtons = SIZES.map((n, idx) => {
      const setSize = async () => {
        if (n > 20) {
          await update($, dockAtom, s => ({ ...s, pendingBigTeam: n }))
          return
        }
        await update($, dockAtom, s => ({ ...s, teamSize: n, pendingBigTeam: null }))
        try { await $.store.set({ key: 'dock-team-size', value: n }) } catch { /* ignore */ }
        $.ui.toast(`Team size: ${n}`)
      }
      const isActive = teamSize === n
      return (
        <Button
          key={`sz-${n}`}
          label={isActive ? `[${n}]` : ` ${n} `}
          hotkey={SIZE_KEYS[idx]}
          {...(isActive ? { autoFocus: true as const } : {})}
          onPress={setSize}
        />
      )
    })

    const toggleModel = async () => {
      const next: 'haiku' | 'same' = helperModel === 'haiku' ? 'same' : 'haiku'
      await update($, dockAtom, s => ({ ...s, helperModel: next }))
      try { await $.store.set({ key: 'dock-helper-model', value: next }) } catch { /* ignore */ }
    }

    const infoLine = teamSize === 1
      ? 'Claude decides how many helpers'
      : `Splits each request across ${teamSize} helpers  ·  ${Math.min(teamSize, MAX_CONCURRENT)} at a time  ·  ${helperModel === 'haiku' ? 'Fast & Cheap' : 'Same model as you'}`

    const working = helpers.filter(h => h.status === 'working').length
    const queued = helpers.filter(h => h.status === 'queued').length
    const done = helpers.filter(h => h.status === 'done').length
    const stuck = helpers.filter(h => h.status === 'stuck').length

    const liveLabel = phase === 'live' ? '● LIVE' : phase === 'done' ? 'COMPLETE' : 'STANDING BY'
    const liveColor = phase === 'live' ? 'green' : phase === 'done' ? 'green' : 'gray'

    // ── Card rendering ─────────────────────────────────────────────────────
    const cardWidth = cols > 90 ? 32 : 28
    const cardsPerRow = Math.max(1, Math.floor(cols / (cardWidth + 1)))
    const useSmallCards = helpers.length > 12

    const renderCard = (h: Helper) => {
      const isWorking = h.status === 'working'
      const isDone = h.status === 'done'
      const isStuck = h.status === 'stuck'
      const isQueued = h.status === 'queued'
      const timer = fmtTimer(h.startMs, isDone || isStuck ? (h.endMs ?? nowMs) : nowMs)
      const sweepPct = isWorking && h.pct === 0 ? ((tick % 10) * 10) : h.pct

      if (useSmallCards) {
        // Compact tile for 13+ helpers
        const statusChar = isDone ? '✓' : isStuck ? '✕' : isWorking ? '●' : '○'
        const desc = h.description.length > 14 ? h.description.slice(0, 13) + '…' : h.description
        return (
          <Box key={h.id} flexDirection="row" width={18} borderStyle={isStuck ? 'bold' : 'single'}
            borderColor={isStuck ? 'red' : isDone ? 'green' : isWorking ? undefined : undefined}
            dimColor={isQueued}>
            <Text color={h.color} bold> {h.initials}</Text>
            <Text dimColor={isQueued}> {statusChar} </Text>
            <Text dimColor={isQueued}>{desc}</Text>
          </Box>
        )
      }

      return (
        <Box key={h.id} flexDirection="column" width={cardWidth}
          borderStyle="single"
          borderColor={isStuck ? 'red' : isDone ? 'green' : undefined}
          dimColor={isQueued}>
          <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
            <Box flexDirection="row">
              <Text color={h.color} bold>{h.initials}</Text>
              <Text>  </Text>
              <Text dimColor={isQueued} bold={isWorking}>
                {h.description.length > cardWidth - 8
                  ? h.description.slice(0, cardWidth - 9) + '…'
                  : h.description}
              </Text>
            </Box>
            <Text dimColor>{timer}</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={isDone ? 'green' : isStuck ? 'red' : undefined} dimColor={isQueued}>
              {meterBar(isDone ? 100 : sweepPct, cardWidth - 4)}
            </Text>
            <Text dimColor>  {isDone ? '100%' : isQueued ? '  --' : `${h.pct}%`}</Text>
          </Box>
        </Box>
      )
    }

    // ── Idle state ─────────────────────────────────────────────────────────
    const renderIdle = () => {
      const seats = Math.min(teamSize, 25)
      const seatChars = Array.from({ length: seats }, (_, i) => {
        const c = tick % (seats * 3)
        return c === i ? '◆' : '◇'
      }).join(' ')

      const assignedRoles = roles.filter(r => r.name).map(r => r.name)
      return (
        <Box flexDirection="column" paddingX={1} gap={1}>
          <Text dimColor>{seatChars}</Text>
          <Text>Your team of {teamSize} is standing by</Text>
          {assignedRoles.length > 0
            ? <Text dimColor>Specialists: {assignedRoles.join(' · ')}</Text>
            : <Text dimColor>Send a request and it splits across {teamSize} helpers.</Text>
          }
        </Box>
      )
    }

    // ── Group cards into rows ──────────────────────────────────────────────
    const cardRows: Helper[][] = []
    for (let i = 0; i < helpers.length; i += cardsPerRow) {
      cardRows.push(helpers.slice(i, i + cardsPerRow))
    }

    const missionMs = phase === 'live'
      ? (jobStartMs !== null ? nowMs - jobStartMs : 0)
      : (jobEndMs !== null && jobStartMs !== null ? jobEndMs - jobStartMs : 0)
    const pct = overallPct(helpers)

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Masthead */}
        <Box flexDirection="row" justifyContent="space-between" width={cols - 2}>
          <Text bold color="yellow">◆  A G E N T   D O C K</Text>
          <Text color={liveColor}>{liveLabel}</Text>
        </Box>

        {/* Divider */}
        <Text dimColor>{'─'.repeat(cols - 3)}</Text>

        {/* Team size row */}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>T E A M  S I Z E  </Text>
          {sizeButtons}
        </Box>
        <Text dimColor>{infoLine}</Text>
        <Text dimColor>  No keys? Ctrl+X then Tab to focus · 1 3 5 t w f c for size · m for model</Text>

        {/* Model toggle */}
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Helpers: </Text>
          <Button key="model" hotkey="m" label={helperModel === 'haiku' ? 'Fast & Cheap ✓' : 'Same model as you ✓'} onPress={toggleModel} />
        </Box>

        {/* Role assignment (only when team > 1) */}
        {teamSize > 1 && (
          <Box flexDirection="column">
            <Text dimColor>{'─'.repeat(cols - 3)}</Text>
            <Text dimColor>R O L E S  (optional)</Text>
            <Text dimColor>  Click preset  or  type: /dock role N "your role" ["instructions"]</Text>
            {Array.from({ length: Math.min(teamSize, 10) }, (_, i) => {
              const role = roles[i] ?? { name: '', instructions: '' }
              const cycleRole = async () => {
                const nextName = nextRole(role.name)
                await update($, dockAtom, s => {
                  const r = [...s.roles]
                  while (r.length <= i) r.push({ name: '', instructions: '' })
                  r[i] = { ...r[i]!, name: nextName }
                  return { ...s, roles: r }
                })
                try {
                  const s2 = await read($, dockAtom)
                  await $.store.set({ key: 'dock-roles', value: s2.roles })
                } catch { /* ignore */ }
              }
              const editHint = () => {
                $.ui.toast(`Type: /dock role ${i + 1} "your role name" (optionally add "instructions" at end)`)
              }
              return (
                <Box key={`role-${i}`} flexDirection="row" gap={1}>
                  <Text dimColor>#{i + 1}</Text>
                  <Button key={`r-${i}`} label={role.name ? `← ${role.name} →` : '← preset →'} onPress={cycleRole} />
                  <Button key={`e-${i}`} label="✏" onPress={editHint} />
                  {role.instructions && (
                    <Text dimColor>"{role.instructions.length > 20 ? role.instructions.slice(0, 19) + '…' : role.instructions}"</Text>
                  )}
                </Box>
              )
            })}
            {teamSize > 10 && (
              <Text dimColor>  + {teamSize - 10} more — use /dock role N to assign beyond #10</Text>
            )}
            {roles.some(r => r.name) && (
              <Button key="clear-roles" label="Clear all roles" onPress={async () => {
                await update($, dockAtom, s => ({ ...s, roles: [] }))
                try { await $.store.set({ key: 'dock-roles', value: [] }) } catch { /* ignore */ }
              }} />
            )}
          </Box>
        )}

        <Text dimColor>{'─'.repeat(cols - 3)}</Text>

        {/* Mission bar (when live or done) */}
        {(phase === 'live' || phase === 'done') && helpers.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{job.length > cols - 20 ? job.slice(0, cols - 21) + '…' : job}</Text>
              <Text color={phase === 'done' ? 'green' : undefined}>{pct}%  {fmtTime(missionMs)}</Text>
            </Box>
            <Text color={phase === 'done' ? 'green' : 'cyan'}>{meterBar(pct, cols - 4)}</Text>
            <Box flexDirection="row" gap={3}>
              <Text color="green">● {working} working</Text>
              <Text dimColor>○ {queued} queued</Text>
              <Text color="green">✓ {done} done</Text>
              {stuck > 0 && <Text color="red">✕ {stuck} stuck</Text>}
            </Box>
            <Text dimColor>{'─'.repeat(cols - 3)}</Text>
          </Box>
        )}

        {/* Done summary */}
        {phase === 'done' && helpers.length > 0 && (
          <Box borderStyle="single" borderColor="green" paddingX={1}>
            <Text color="green">{summaryLine(helpers.length, job, missionMs, state.stuckCount)}</Text>
          </Box>
        )}

        {/* Cards / idle */}
        {phase === 'idle' || helpers.length === 0
          ? renderIdle()
          : cardRows.map((row, ri) => (
            <Box key={`row-${ri}`} flexDirection="row" gap={1} flexWrap="wrap">
              {row.map(renderCard)}
            </Box>
          ))
        }
      </Box>
    )
  })

  // Status badge is updated in the clock.every callback (turn.start already starts it)
}
