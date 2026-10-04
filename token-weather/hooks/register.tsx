// Token Weather: how full the context window is, as a weather forecast,
// one line above the prompt. Updates after every main-loop turn.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenWeatherReading } from '../types'

const KEEP = 12
const BARS = '▁▂▃▄▅▆▇█'

type Sky = { below: number; icon: string; word: string; color: string }

// Single-width symbols only, so the band lines up in every terminal font.
const SKIES: readonly Sky[] = [
  { below: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { below: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { below: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { below: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { below: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
]

const readings = atom({ plugin: 'token-weather', key: 'readings' } as const, [])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await measure($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await measure($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, readings, () => [])
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const history = await read($, readings)
    const below = await next(e)
    if (e.props.hasSurvey || history.length === 0) return below

    const { Box, Text } = $.ui.resolve(e)
    const now = history[history.length - 1]!
    const sky = skyFor(now.percent)
    const width = e.props.bodyColumns

    const line = (
      <Box key="token-weather" flexDirection="row" paddingX={1}>
        <Text color={sky.color} bold>
          {sky.icon} {sky.word}
        </Text>
        <Text> {now.percent}% of context</Text>
        <Text dimColor>
          {'  '}
          {short(now.tokens)} / {short(now.window)}
        </Text>
        {width >= 64 && history.length > 1 && (
          <Text color={sky.color}>{'  ' + sparkline(history)}</Text>
        )}
        {width >= 80 && history.length > 1 && <Text dimColor>{'  ' + trend(history)}</Text>}
        {width >= 96 && now.usd !== undefined && <Text dimColor>{'  $' + now.usd.toFixed(2)}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below}
        {line}
      </Box>
    )
  })
}

async function measure($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const { context } = usage
  if (!context.window) return
  const tokens = context.tokens ?? 0
  const percent = context.percent ?? Math.round((tokens / context.window) * 100)
  const reading: TokenWeatherReading = { tokens, window: context.window, percent }
  if (usage.cost !== undefined) reading.usd = usage.cost.usd
  await update($, readings, list => {
    const last = list[list.length - 1]
    // A session.start after a hot reload reads the same figures again: skip the repeat.
    if (last && last.tokens === reading.tokens && last.window === reading.window) {
      return [...list.slice(0, -1), reading]
    }
    return [...list, reading].slice(-KEEP)
  })
}

export function skyFor(percent: number): Sky {
  return SKIES.find(s => percent < s.below) ?? SKIES[SKIES.length - 1]!
}

function sparkline(history: readonly TokenWeatherReading[]): string {
  const top = Math.max(1, ...history.map(r => r.tokens))
  return history
    .map(r => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))])
    .join('')
}

function trend(history: readonly TokenWeatherReading[]): string {
  const a = history[history.length - 2]!
  const b = history[history.length - 1]!
  const delta = b.tokens - a.tokens
  if (delta === 0) return 'steady'
  return delta > 0 ? `▲ +${short(delta)} last turn` : `▼ ${short(-delta)} last turn`
}

export function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}
