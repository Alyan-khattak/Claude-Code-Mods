// Limit Meter: your plan's usage limits, live, like a usage counter for
// Claude Code. One line above the prompt shows the 5-hour and weekly windows
// (percent used, time to reset, how much of the week you used today), toasts
// warn at 75%, 90% and 100%, and /limits opens a pane with the details.
//
// The readings are the ones Claude Code itself gets back with every response,
// so they refresh as you work. With an API key there are no plan limits, and
// only the session cost is shown.
//
// LIMIT_METER=status shows it in the status line instead; LIMIT_METER=off
// hides the line (warnings and /limits keep working).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LimitDayStart, LimitReading } from '../types'
import { ago, bar, color, crossed, day, label, order, pct, shortLabel, untilReset, when } from './format'

const PANE = 'limit-meter'

const limits = atom({ plugin: 'limit-meter', key: 'limits' } as const, [])
const usd = atom({ plugin: 'limit-meter', key: 'usd' } as const, null)
const updatedAt = atom({ plugin: 'limit-meter', key: 'updatedAt' } as const, 0)
const now = atom({ plugin: 'limit-meter', key: 'now' } as const, 0)
const dayStart = atom({ plugin: 'limit-meter', key: 'dayStart' } as const, null)

type Display = 'band' | 'status' | 'off'
// Each Claude Code session loads its own copy of this module, so one variable per module is per session.
// (Keying a map by $ is not allowed: $ may only be used as $.noun.method(...), and the module refuses to load.)
let display: Display = 'band'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const mode = ((await $.env.get('LIMIT_METER')) ?? 'band').toLowerCase()
    display = mode === 'status' || mode === 'off' ? (mode as Display) : 'band'
    const saved = await $.store.get('dayStart')
    if (saved !== undefined && saved !== null) await update($, dayStart, () => saved as LimitDayStart)
    try {
      await $.command.register({ name: 'limits', description: 'Show your 5-hour and weekly usage limits' })
    } catch (error) {
      $.ui.log(`limit-meter: could not register /limits (${String(error)})`, { to: 'debug' })
    }
    await refresh($)
    // Move the countdowns along, and pick up readings from background work.
    $.clock.every(60_000, () => refresh($))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('command.run', { command: 'limits' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Limits', focus: true, closeOnEscape: true })
    const list = order(await read($, limits))
    if (list.length === 0) return { text: 'No plan limits reported yet.' }
    return { text: list.map(l => `${label(l.kind)} ${pct(l.percentUsed)}`).join(' · ') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (display !== 'band' || e.props.hasSurvey) return below
    const list = order(await read($, limits))
    if (list.length === 0) return below
    const t = await read($, now)
    const start = await read($, dayStart)
    const { Box, Text } = $.ui.resolve(e)
    const roomy = e.props.bodyColumns >= 76

    return (
      <Box flexDirection="column">
        {below}
        <Box key="limit-meter" flexDirection="row" paddingX={1} gap={2}>
          {list.map(l => {
            const todayPct = l.kind === 'seven_day' ? today(l, start) : undefined
            return (
              <Box key={`lim-${l.kind}`} flexDirection="row">
                <Text dimColor>{shortLabel(l.kind)} </Text>
                {roomy && <Text color={color(l.percentUsed)}>{bar(l.percentUsed, 8)} </Text>}
                <Text color={color(l.percentUsed)} bold>
                  {pct(l.percentUsed)}
                </Text>
                {l.resetsAt !== undefined && <Text dimColor> · {untilReset(l.resetsAt, t)}</Text>}
                {todayPct !== undefined && todayPct > 0 && (
                  <Text dimColor> · today +{pct(todayPct)}</Text>
                )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = order(await read($, limits))
    const t = await read($, now)
    const start = await read($, dayStart)
    const cost = await read($, usd)
    const at = await read($, updatedAt)
    const cells = Math.max(10, Math.min(40, e.props.bodyColumns - 12))

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {list.length === 0 ? (
          <Box flexDirection="column">
            <Text bold>No plan limits reported yet.</Text>
            <Text dimColor>
              They appear after Claude's first response when you sign in with a Claude subscription (Pro or Max). With an
              API key there are no plan limits, only the cost below.
            </Text>
          </Box>
        ) : (
          list.map(l => {
            const todayPct = l.kind === 'seven_day' ? today(l, start) : undefined
            return (
              <Box key={`pane-${l.kind}`} flexDirection="column" marginBottom={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold>{label(l.kind)} limit</Text>
                  <Text color={color(l.percentUsed)} bold>
                    {pct(l.percentUsed)} used
                  </Text>
                </Box>
                <Text color={color(l.percentUsed)}>{bar(l.percentUsed, cells)}</Text>
                {l.resetsAt !== undefined && (
                  <Text dimColor>
                    Resets in {untilReset(l.resetsAt, t)} · {when(l.resetsAt)}
                  </Text>
                )}
                {todayPct !== undefined && todayPct > 0 && (
                  <Text dimColor>Used today: +{pct(todayPct)} of the week</Text>
                )}
              </Box>
            )
          })
        )}
        {cost !== null && <Text>This session: ${cost.toFixed(2)}</Text>}
        <Text dimColor>
          Updated {at === 0 ? 'never' : ago(at, t)} · from Claude Code's latest response
        </Text>
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => { refresh($).catch(e => $.ui.log(String(e), { to: 'debug' })) }} />
          <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

/** How much of the week was used since the first reading of the local day. */
function today(weekly: LimitReading, start: LimitDayStart | null): number | undefined {
  if (start === null || start.resetsAt !== weekly.resetsAt) return undefined
  return Math.max(0, Math.round((weekly.percentUsed - start.percent) * 10) / 10)
}

async function refresh($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
  let usage
  try {
    usage = await $.session.usage()
  } catch {
    return
  }
  if (usage.cost !== undefined) await update($, usd, () => usage.cost!.usd)

  const fresh: LimitReading[] = usage.rateLimits.map(r => {
    const reading: LimitReading = { kind: r.kind, percentUsed: r.percentUsed }
    const resets = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    if (!Number.isNaN(resets)) reading.resetsAt = resets
    return reading
  })
  // No reading yet this session (or an API key): keep what we had.
  if (fresh.length === 0) return
  await update($, limits, () => fresh)
  await update($, updatedAt, () => t)

  await trackDay($, fresh, t)
  await warn($, fresh, t)
  if (display === 'status') {
    await $.ui.status(order(fresh).map(l => `${shortLabel(l.kind)} ${pct(l.percentUsed)}`).join(' · '))
  }
}

async function trackDay($: EngineInterface, fresh: readonly LimitReading[], t: number) {
  const weekly = fresh.find(l => l.kind === 'seven_day')
  if (weekly === undefined) return
  const current = await read($, dayStart)
  const date = day(t)
  if (current !== null && current.date === date && current.resetsAt === weekly.resetsAt) return
  const start: LimitDayStart = { date, percent: weekly.percentUsed }
  if (weekly.resetsAt !== undefined) start.resetsAt = weekly.resetsAt
  await update($, dayStart, () => start)
  await $.store.set('dayStart', start)
}

async function warn($: EngineInterface, fresh: readonly LimitReading[], t: number) {
  const stored = await $.store.get('warned')
  const warned = new Set(Array.isArray(stored) ? (stored as string[]) : [])
  let changed = false
  for (const l of fresh) {
    const levels = crossed(l.percentUsed)
    const window = `${l.kind}|${l.resetsAt ?? ''}`
    const fresher = levels.filter(level => !warned.has(`${window}|${level}`))
    if (fresher.length === 0) continue
    for (const level of fresher) warned.add(`${window}|${level}`)
    changed = true
    const top = fresher[fresher.length - 1]!
    const reset = l.resetsAt !== undefined ? ` · resets in ${untilReset(l.resetsAt, t)}` : ''
    $.ui.toast(
      top >= 100
        ? `Limit Meter: ${label(l.kind)} limit reached${reset}`
        : `Limit Meter: ${label(l.kind)} limit at ${pct(l.percentUsed)}${reset}`,
    )
  }
  if (changed) await $.store.set('warned', [...warned].slice(-60))
}