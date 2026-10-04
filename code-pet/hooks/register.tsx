// Code Pet: a tiny pet above your prompt. It watches you code, cheers
// when tests pass, worries when commands fail, naps when you are idle, and
// earns XP as you work, hatching from an egg and growing over the weeks.
//
// /pet pats it; /pet name <name>, /pet species <cat|dog|bunny|bear|fox|panda|frog|chick>,
// /pet stats. CODE_PET=status shows it in the status line, CODE_PET=off hides it.
// It is plain ASCII by default (=^.^=); CODE_PET_STYLE=emoji uses emoji instead.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PetProfile } from '../types'
import { animate, blink, day, DEFAULT_PROFILE, doingFor, face, isTestCommand, level, MARK, MOODS, passedCount, shown, SPECIES, stage, xpBar } from './pet'
import type { Style } from './pet'

const profile = atom({ plugin: 'code-pet', key: 'profile' } as const, null)
const flash = atom({ plugin: 'code-pet', key: 'flash' } as const, null)
const now = atom({ plugin: 'code-pet', key: 'now' } as const, 0)
const lastActivity = atom({ plugin: 'code-pet', key: 'lastActivity' } as const, 0)
const isWorking = atom({ plugin: 'code-pet', key: 'isWorking' } as const, false)
const doing = atom({ plugin: 'code-pet', key: 'doing' } as const, '')
const doingMood = atom({ plugin: 'code-pet', key: 'doingMood' } as const, 'working')
const failStreak = atom({ plugin: 'code-pet', key: 'failStreak' } as const, 0)
const contextPercent = atom({ plugin: 'code-pet', key: 'contextPercent' } as const, 0)
const limitPercent = atom({ plugin: 'code-pet', key: 'limitPercent' } as const, 0)

const SOUNDS: Record<string, string> = {
  cat: 'purrs happily',
  dog: 'wags its tail',
  bunny: 'does a happy hop',
  bear: 'gives you a hug',
  fox: 'yips with joy',
  panda: 'munches happily',
  frog: 'ribbits',
  chick: 'cheeps',
}

type Display = 'band' | 'status' | 'off'
let display: Display = 'band'
let style: Style = 'ascii'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const mode = ((await $.env.get('CODE_PET')) ?? 'band').toLowerCase()
    display = mode === 'status' || mode === 'off' ? mode : 'band'
    style = ((await $.env.get('CODE_PET_STYLE')) ?? '').toLowerCase() === 'emoji' ? 'emoji' : 'ascii'
    const t = await $.clock.now()
    const saved = await $.store.get('profile')
    const loaded: PetProfile = saved && typeof saved === 'object' ? { ...DEFAULT_PROFILE(t), ...(saved as PetProfile) } : DEFAULT_PROFILE(t)
    await update($, profile, () => loaded)
    if (saved === undefined || saved === null) await $.store.set('profile', loaded)
    await update($, now, () => t)
    await update($, lastActivity, () => t)
    try {
      await $.command.register({
        name: 'pet',
        description: 'Pat your Code Pet (or: /pet name <name>, /pet species <kind>, /pet stats)',
        argumentHint: '[name <name> | species <kind> | stats]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`code-pet: could not register /pet (${String(error)})`, { to: 'debug' })
    }
    // One tick a second: the animation frame, idle naps, and the status line.
    $.clock.every(1_000, () => tick($))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, isWorking, () => true)
    await update($, doing, () => 'on it!')
    await update($, doingMood, () => 'working')
    await update($, lastActivity, () => t)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const what = doingFor(tool, input)
    await update($, doing, () => what.say)
    await update($, doingMood, () => what.mood)
    const started = await $.clock.now()
    await update($, lastActivity, () => started)

    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
    const ran = await next(e)
    if (command === undefined || ran.deny !== undefined) return ran

    const ok = ran.isError !== true
    const output = typeof ran.text === 'string' ? ran.text : ''
    const t = await $.clock.now()
    if (isTestCommand(command)) {
      if (ok) {
        const count = passedCount(output)
        await gainXp($, 10, p => ({
          ...p,
          streak: p.streak + 1,
          best: Math.max(p.best, p.streak + 1),
          today: { date: day(t), tests: (p.today.date === day(t) ? p.today.tests : 0) + (count ?? 0) },
        }))
        await update($, failStreak, () => 0)
        const p = await read($, profile)
        const streak = p !== null && p.streak >= 3 ? ` ${MARK.streak![style]}${p.streak} in a row` : ''
        await say($, 'happy', `${count !== undefined ? `${count} tests passed!` : 'tests passed!'} +10 XP${streak}`, 8_000)
      } else {
        await update($, profile, p => (p === null ? p : { ...p, streak: 0 }))
        await saveProfile($)
        const fails = (await read($, failStreak)) + 1
        await update($, failStreak, () => fails)
        await say($, fails >= 3 ? 'sad' : 'worried', fails >= 3 ? 'tests keep failing... we got this' : 'tests failed, let us fix them', 8_000)
      }
    } else if (!ok) {
      const fails = (await read($, failStreak)) + 1
      await update($, failStreak, () => fails)
      const cmd = command.trim().split(/\s+/).slice(0, 3).join(' ')
      await say($, fails >= 3 ? 'sad' : 'worried', `uh oh, \`${cmd.length > 30 ? cmd.slice(0, 27) + '...' : cmd}\` failed`, 8_000)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const t = await $.clock.now()
    await update($, isWorking, () => false)
    await update($, lastActivity, () => t)
    if (!e.isAborted && e.reason === 'answer') {
      await gainXp($, 5, p => p)
      if (e.durationMs >= 60_000) await say($, 'done', `done! that took ${minutes(e.durationMs)}`, 6_000)
    }
    try {
      const usage = await $.session.usage()
      await update($, contextPercent, () => usage.context.percent ?? 0)
      await update($, limitPercent, () => Math.max(0, ...usage.rateLimits.map(r => r.percentUsed)))
    } catch {
      // no readings: keep the old ones
    }
    return result
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const args = e.args.trim()
    const p = await read($, profile)
    if (p === null) return { text: 'Your pet is still waking up.' }

    const named = /^name\s+(.+)$/i.exec(args)
    if (named) {
      const name = named[1]!.trim().slice(0, 20)
      await update($, profile, q => (q === null ? q : { ...q, name }))
      await saveProfile($)
      await say($, 'petted', `my name is ${name}!`, 5_000)
      return { text: `Your pet is now called ${name}.` }
    }

    const kind = /^species\s+(\w+)$/i.exec(args)
    if (kind) {
      const species = kind[1]!.toLowerCase()
      if (!(species in SPECIES)) return { text: `Pick one of: ${Object.keys(SPECIES).join(', ')}` }
      await update($, profile, q => (q === null ? q : { ...q, species }))
      await saveProfile($)
      return { text: `${p.name} is now a ${species} ${face({ ...p, species, xp: Math.max(p.xp, 25) }, style)} (eggs hatch at level 2).` }
    }

    if (/^stats$/i.test(args)) {
      const t = await $.clock.now()
      const tests = p.today.date === day(t) ? p.today.tests : 0
      const days = Math.max(0, Math.floor((t - p.born) / 86_400_000))
      return {
        text: [
          `${face(p, style)} ${p.name} the ${p.species}: level ${level(p.xp)} (${stage(p.xp)}), ${p.xp} XP`,
          `Green test streak: ${p.streak} (best ${p.best}) | tests passed today: ${tests}`,
          `Pats: ${p.pets} | friends for ${days} ${days === 1 ? 'day' : 'days'}`,
        ].join('\n'),
      }
    }

    await update($, profile, q => (q === null ? q : { ...q, pets: q.pets + 1 }))
    await saveProfile($)
    const sound = SOUNDS[p.species] ?? 'is happy'
    await say($, 'petted', `${sound} ${MARK.heart![style]}`, 5_000)
    return { text: `${face(p, style, 'petted')} ${p.name} ${sound}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (display !== 'band' || e.props.hasSurvey) return below
    const line = await current($)
    if (line === null) return below
    const { Box, Text } = $.ui.resolve(e)
    const roomy = e.props.bodyColumns >= 70
    return (
      <Box flexDirection="column">
        {below}
        <Box key="code-pet" flexDirection="row" paddingX={1} justifyContent="space-between" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            {line.face} {line.icon === '' ? '' : `${line.icon} `}
            <Text bold>{line.name}</Text>
            <Text color={line.color}>: {line.say}</Text>
          </Text>
          {roomy && (
            <Text dimColor>
              {' '}
              Lv {line.level} {line.bar}
              {line.streak >= 3 ? ` ${MARK.streak![style]}${line.streak}` : ''}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}

type Line = { face: string; icon: string; name: string; say: string; color: string; level: number; bar: string; streak: number }

/** Everything the pet shows right now, from its state. */
async function current($: EngineInterface): Promise<Line | null> {
  const p = await read($, profile)
  if (p === null) return null
  const t = await read($, now)
  const s = shown({
    flash: await read($, flash),
    now: t,
    lastActivity: await read($, lastActivity),
    isWorking: await read($, isWorking),
    doing: await read($, doing),
    doingMood: await read($, doingMood),
    failStreak: await read($, failStreak),
    contextPercent: await read($, contextPercent),
    limitPercent: await read($, limitPercent),
    hour: new Date(t).getHours(),
    name: p.name,
  })
  const frame = Math.floor(t / 1000)
  return {
    face: face(p, style, blink(s.mood, frame, style)),
    icon: animate(s.mood, frame, style),
    name: p.name,
    say: s.say,
    color: MOODS[s.mood]?.color ?? 'white',
    level: level(p.xp),
    bar: xpBar(p.xp, style),
    streak: p.streak,
  }
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  if (display === 'status') {
    const line = await current($)
    if (line !== null) $.ui.status(`${line.face} ${line.icon === '' ? '' : `${line.icon} `}${line.name}: ${line.say}`)
  }
}

/** A mood for a few seconds. A fresh level-up message is never overwritten. */
async function say($: EngineInterface, mood: string, text: string, ms: number) {
  const t = await $.clock.now()
  const old = await read($, flash)
  if (old !== null && old.mood === 'levelup' && old.until > t) return
  await update($, flash, () => ({ mood, say: text, until: t + ms }))
  await update($, now, () => t)
}

async function gainXp($: EngineInterface, amount: number, change: (p: PetProfile) => PetProfile) {
  const before = await read($, profile)
  if (before === null) return
  const after = change({ ...before, xp: before.xp + amount })
  await update($, profile, () => after)
  await saveProfile($)
  const from = level(before.xp)
  const to = level(after.xp)
  if (to > from) {
    const t = await $.clock.now()
    const hatched = from === 1
    const text = hatched ? `${after.name} hatched!${MARK.hatch![style]} level ${to}` : `${after.name} grew to level ${to}!${to === 10 ? MARK.crown![style] : ''}`
    await update($, flash, () => ({ mood: 'levelup', say: text, until: t + 8_000 }))
    $.ui.toast(`Code Pet: ${text}`)
  }
}

async function saveProfile($: EngineInterface) {
  const p = await read($, profile)
  if (p !== null) await $.store.set('profile', p)
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 1 ? `${Math.round(ms / 1000)}s` : `${m}m`
}
