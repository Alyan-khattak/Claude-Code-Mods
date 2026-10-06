import type { On } from 'claude-code'
import {
  createGame, resizeGame, tickGame, renderFrame, handleKey, garageBuy,
  triggerArrived, resumeFromArrived, parseProfile,
  type GameState, type Profile,
} from './road-trip-game'

const PANE = 'road-trip'

// Module-level game state (reset each session start)
let game: GameState | null = null
let rasterCols = 0
let rasterRows = 0
let gameLoopCancel: (() => void) | undefined
let disabled = false
let globalRetro = false

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadProfile($: Parameters<Parameters<On>[2]>[0]): Promise<Profile> {
  try {
    const v = await $.store.get({ key: 'road-trip-profile' })
    return parseProfile(v?.value)
  } catch { return parseProfile(null) }
}

async function saveProfile($: Parameters<Parameters<On>[2]>[0], g: GameState): Promise<void> {
  try {
    await $.store.set({
      key: 'road-trip-profile',
      value: {
        bank: g.profile.bank,
        ownedCars: g.profile.ownedCars,
        currentCar: g.profile.currentCar,
        xp: g.profile.xp,
        bestDistance: g.profile.bestDistance,
      },
    })
  } catch { /* save failure must never stop the game */ }
}

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerRoadTrip(on: On): void {

  // ── Session start ──────────────────────────────────────────────────────────
  on('session.start', async ($, e, next) => {
    game = null
    rasterCols = 0
    rasterRows = 0
    gameLoopCancel?.()
    gameLoopCancel = undefined

    // Restore disabled/retro from store
    try {
      const v = await $.store.get({ key: 'road-trip-meta' })
      if (v?.value && typeof v.value === 'object') {
        const m = v.value as Record<string, unknown>
        if (m['disabled'] === true) disabled = true
        if (m['retro'] === true) globalRetro = true
      }
    } catch {}

    await $.command.register({ name: 'roadtrip', description: 'Open Road Trip game. /roadtrip on|off|retro on|off' })

    return next(e)
  })

  // ── Command ────────────────────────────────────────────────────────────────
  on('command.run', { command: 'roadtrip' }, async ($, e) => {
    const args = (e.args ?? '').trim().toLowerCase()

    if (args === 'off') {
      disabled = true
      try { await $.store.set({ key: 'road-trip-meta', value: { disabled: true, retro: globalRetro } }) } catch {}
      gameLoopCancel?.()
      gameLoopCancel = undefined
      return { text: 'Road Trip hidden. /roadtrip on to re-enable.' }
    }
    if (args === 'on') {
      disabled = false
      try { await $.store.set({ key: 'road-trip-meta', value: { disabled: false, retro: globalRetro } }) } catch {}
      return { text: 'Road Trip enabled. Type /roadtrip to open.' }
    }
    if (args === 'retro on') {
      globalRetro = true
      if (game) { game.retro = true }
      try { await $.store.set({ key: 'road-trip-meta', value: { disabled, retro: true } }) } catch {}
      return { text: 'Retro mode on.' }
    }
    if (args === 'retro off') {
      globalRetro = false
      if (game) { game.retro = false }
      try { await $.store.set({ key: 'road-trip-meta', value: { disabled, retro: false } }) } catch {}
      return { text: 'Retro mode off.' }
    }

    if (disabled) {
      return { text: 'Road Trip is off. Type /roadtrip on to re-enable.' }
    }

    // Open pane (responds instantly — answer before opening)
    const openResult = await $.ui.open({ id: PANE, title: 'Road Trip', focus: true, closeOnEscape: true, rows: 30, columns: 110 })
    if (!openResult.isPlaced) {
      $.ui.toast('Road Trip needs a little more room: widen the window')
      return { text: 'Pane not placed (window too small).' }
    }

    // Start game loop if not running
    if (!gameLoopCancel) {
      gameLoopCancel = $.clock.every(70, () => {
        if (!game || !rasterCols) return
        tickGame(game)
        void $.ui.blit({ requestId: PANE, key: 'game', cells: renderFrame(game) })
      })
    }

    return { text: 'Road Trip opened. Controls: A/D lanes  P pause  G garage' }
  })

  // ── Pane render ────────────────────────────────────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>Road Trip plays in the terminal.</Text>
    }

    const cols = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows

    if (cols < 36 || rows < 5) {
      const { Text } = $.ui.resolve(e)
      return <Text>Drag this pane taller to play  (cols={cols} rows={rows})</Text>
    }

    const newRC = cols
    const newRR = Math.max(4, rows - 1)  // leave 1 row for buttons

    let needInit = !game
    if (newRC !== rasterCols || newRR !== rasterRows) {
      rasterCols = newRC
      rasterRows = newRR
      needInit = needInit || true
    }

    if (needInit && !game) {
      const profile = await loadProfile($)
      game = createGame(rasterCols, rasterRows, profile, globalRetro)
    } else if (game && (newRC !== game.cols || newRR !== game.rows)) {
      game = resizeGame(game, newRC, newRR)
      rasterCols = newRC
      rasterRows = newRR
    }

    if (!game) {
      const { Text } = $.ui.resolve(e)
      return <Text>Loading...</Text>
    }

    const { Box, Button } = $.ui.resolve(e)
    const elements = $.ui.resolve(e) as unknown as { Raster: (p: { key: string; columns: number; rows: number; cells: string }) => unknown }
    const g = game

    const onKeyA = (): void => handleKey(g, 'a')
    const onKeyD = (): void => handleKey(g, 'd')
    const onKeyP = (): void => handleKey(g, 'p')
    const onKeyG = (): void => handleKey(g, 'g')
    const onKeyB = (): void => {
      if (g.phase === 'arrived') void $.ui.close({ id: PANE })
      else garageBuy(g)
    }
    return (
      <Box flexDirection="column">
        {h(elements.Raster, { key: 'game', columns: rasterCols, rows: rasterRows, cells: renderFrame(g) })}
        <Box flexDirection="row" gap={2}>
          <Button key="btn-a" label="A" hotkey="a" onPress={onKeyA} />
          <Button key="btn-d" label="D" hotkey="d" onPress={onKeyD} />
          <Button key="btn-p" label="P" hotkey="p" onPress={onKeyP} />
          <Button key="btn-g" label="G" hotkey="g" onPress={onKeyG} />
          <Button key="btn-b" label="B" hotkey="b" onPress={onKeyB} />
        </Box>
      </Box>
    )
  })

  // ── Pane close ────────────────────────────────────────────────────────────
  on('ui.close', { requestId: PANE }, async ($, e, next) => {
    gameLoopCancel?.()
    gameLoopCancel = undefined
    if (game) await saveProfile($, game)
    return next(e)
  })

  // ── Turn complete: show Arrived card ──────────────────────────────────────
  on('turn.complete', async ($, e, next) => {
    // Only main agent (not subagents)
    if ((e as unknown as Record<string, unknown>)['agentId'] !== undefined) return next(e)
    if (game && (game.phase === 'driving' || game.phase === 'countdown')) {
      triggerArrived(game)
      // Trigger a blit so the Arrived card is shown immediately
      if (rasterCols) void $.ui.blit({ requestId: PANE, key: 'game', cells: renderFrame(game) })
    }
    return next(e)
  })

  // ── Turn start: resume driving ────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    if (game && game.phase === 'arrived') {
      resumeFromArrived(game)
    }
    return next(e)
  })

  // ── Task coins from completed Clean View steps ────────────────────────────
  on('tool.call', { tool: 'mcp__clean-view__report_progress' as 'mcp__clean-view__report_progress' }, async ($, e, next) => {
    const result = await next(e)
    const pct = (e as unknown as Record<string, unknown>)['percent']
    if (pct === 100 && game && game.phase === 'driving') {
      game.taskCoinQueue = Math.min(3, game.taskCoinQueue + 1)
    }
    return result
  })

  // ── Task coins from TodoWrite (fallback when Clean View not installed) ─────
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const todos: unknown[] = (e as unknown as Record<string, unknown[]>)['todos'] ?? []
    const beforeCompleted = game?.seenCompleted ?? 0
    const result = await next(e)
    if (!result.isError && game) {
      const nowCompleted = todos.filter((t: unknown) => {
        const todo = t as Record<string, unknown>
        return todo['status'] === 'completed'
      }).length
      if (nowCompleted > beforeCompleted) {
        const delta = Math.min(3, nowCompleted - beforeCompleted)
        game.taskCoinQueue = Math.min(3, game.taskCoinQueue + delta)
        game.seenCompleted = nowCompleted
      }
    }
    return result
  })

  // ── Task coins from TaskUpdate ────────────────────────────────────────────
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    const status = (e as unknown as Record<string, unknown>)['status']
    if (!result.isError && status === 'completed' && game && game.phase === 'driving') {
      game.taskCoinQueue = Math.min(3, game.taskCoinQueue + 1)
    }
    return result
  })
}
