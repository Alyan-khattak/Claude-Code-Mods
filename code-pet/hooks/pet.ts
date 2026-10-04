// Code Pet's personality as plain functions: species, moods, levels, and
// how to tell a test run from any other command. Nothing here touches $.
//
// Two looks: "ascii" (the default: plain ASCII, lines up in every terminal
// and font) and "emoji" (CODE_PET_STYLE=emoji).

import type { PetFlash, PetProfile } from '../types'

export type Style = 'ascii' | 'emoji'

export const SPECIES: Record<string, string> = {
  cat: '🐱',
  dog: '🐶',
  bunny: '🐰',
  bear: '🐻',
  fox: '🦊',
  panda: '🐼',
  frog: '🐸',
  chick: '🐥',
}

/** ASCII bodies: what goes left and right of the face. `=^.^=` is a cat, `U^.^U` a dog. */
const ASCII_BODY: Record<string, [string, string]> = {
  cat: ['=', '='],
  dog: ['U', 'U'],
  bunny: ['(\\', '/)'],
  bear: ['(', ')'],
  fox: ['<', '>'],
  panda: ['[', ']'],
  frog: ['@', '@'],
  chick: ['{', '}'],
}

export const DEFAULT_PROFILE = (now: number): PetProfile => ({
  name: 'Mochi',
  species: 'cat',
  xp: 0,
  born: now,
  streak: 0,
  best: 0,
  today: { date: day(now), tests: 0 },
  pets: 0,
})

/** Per mood: the ASCII face (eyes and mouth), the icon beside it in each style, and the line's color. */
export const MOODS: Record<string, { eyes: string; ascii: string; emoji: string; color: string }> = {
  watching: { eyes: '^.^', ascii: '', emoji: '👀', color: 'white' },
  working: { eyes: 'o_o', ascii: '...', emoji: '💻', color: 'cyan' },
  building: { eyes: '>_<', ascii: '[#]', emoji: '🔨', color: 'cyan' },
  reading: { eyes: 'o.o', ascii: '[=]', emoji: '📖', color: 'cyan' },
  running: { eyes: '*_*', ascii: '[>]', emoji: '⚙️', color: 'cyan' },
  happy: { eyes: '^o^', ascii: '\\o/', emoji: '🎉', color: 'green' },
  done: { eyes: '^-^', ascii: '*', emoji: '✨', color: 'green' },
  worried: { eyes: 'O.O', ascii: '!', emoji: '😰', color: 'yellow' },
  sad: { eyes: 'T_T', ascii: ';(', emoji: '😢', color: 'red' },
  crowded: { eyes: '@_@', ascii: '!!', emoji: '😵', color: 'magenta' },
  tired: { eyes: '=_=', ascii: 'zz', emoji: '🥱', color: 'magenta' },
  idle: { eyes: '-_-', ascii: '...', emoji: '💭', color: 'gray' },
  sleeping: { eyes: '-.-', ascii: 'zZ', emoji: '💤', color: 'gray' },
  late: { eyes: 'u_u', ascii: 'C', emoji: '🌙', color: 'blue' },
  petted: { eyes: '^w^', ascii: '<3', emoji: '💕', color: 'magenta' },
  levelup: { eyes: '*o*', ascii: '**', emoji: '⭐', color: 'yellow' },
}

// ---------- levels ----------

/** Level from XP: 25 XP to level 2, then each level costs a little more. */
export function level(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1
}

/** XP where the current level starts and where the next one begins. */
export function levelRange(xp: number): { from: number; to: number } {
  const l = level(xp)
  return { from: 25 * (l - 1) ** 2, to: 25 * l ** 2 }
}

/**
 * The pet as it looks at its level, in its mood: an egg first, then the
 * species, then a legend. ASCII: `(^)` egg, `=^o^=` cat, `*=^o^=*` legend.
 */
export function face(profile: PetProfile, style: Style = 'ascii', mood = 'watching'): string {
  const l = level(profile.xp)
  if (style === 'emoji') {
    const animal = SPECIES[profile.species] ?? SPECIES.cat!
    if (l <= 1) return '🥚'
    return l >= 10 ? `${animal}👑` : animal
  }
  const eyes = MOODS[mood]?.eyes ?? '^.^'
  if (l <= 1) return `(${eyes.charAt(0)})`
  const [left, right] = ASCII_BODY[profile.species] ?? ASCII_BODY.cat!
  const body = `${left}${eyes}${right}`
  return l >= 10 ? `*${body}*` : body
}

export function stage(xp: number): string {
  const l = level(xp)
  return l <= 1 ? 'egg' : l <= 4 ? 'baby' : l <= 9 ? 'grown' : 'legendary'
}

export function xpBar(xp: number, style: Style = 'ascii', cells = 5): string {
  const { from, to } = levelRange(xp)
  const filled = Math.round(((xp - from) / Math.max(1, to - from)) * cells)
  return style === 'emoji' ? '█'.repeat(filled) + '░'.repeat(cells - filled) : `[${'#'.repeat(filled)}${'.'.repeat(cells - filled)}]`
}

/** Little marks that differ by style. */
export const MARK: Record<string, Record<Style, string>> = {
  heart: { ascii: '<3', emoji: '♥' },
  streak: { ascii: 'x', emoji: '🔥' },
  hatch: { ascii: '', emoji: ' 🐣' },
  crown: { ascii: ' legendary!', emoji: ' 👑 legendary!' },
}

// ---------- reading what happened ----------

const TEST_RUNNER =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpx\s+(jest|vitest|mocha)\b|\b(pytest|vitest|jest|mocha|phpunit|rspec)\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(go|cargo|deno|dart|flutter|mvn|swift)\s+test\b|\bgradlew?\s+test\b|\bdotnet\s+test\b|\bmix\s+test\b/

export function isTestCommand(command: string): boolean {
  return TEST_RUNNER.test(command)
}

/** How many tests passed, when the runner's output says so. */
export function passedCount(output: string): number | undefined {
  const m = /(\d+)\s+(?:tests?\s+)?(?:passed|passing)\b/i.exec(output) ?? /\bTests?:\s+(\d+)\s+passed/i.exec(output) ?? /\bok\s+\((\d+)\s+tests?\)/i.exec(output)
  return m ? Number(m[1]) : undefined
}

/** A short "what I'm doing" line from a tool call. */
export function doingFor(tool: string, input: Record<string, unknown>): { mood: string; say: string } {
  const file = (p: unknown) => (typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop() ?? p : '')
  if (tool === 'Read') return { mood: 'reading', say: `reading ${file(input.file_path)}` }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return { mood: 'building', say: `building ${file(input.file_path ?? input.notebook_path)}` }
  }
  if (tool === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.trim().split(/\s+/).slice(0, 3).join(' ')
    return { mood: 'running', say: `running ${cmd.length > 28 ? cmd.slice(0, 25) + '...' : cmd}` }
  }
  if (tool === 'Grep' || tool === 'Glob') return { mood: 'reading', say: 'searching the code' }
  if (tool === 'WebSearch' || tool === 'WebFetch') return { mood: 'reading', say: 'looking things up' }
  if (tool === 'Agent') return { mood: 'working', say: 'calling a friend' }
  return { mood: 'working', say: 'on it!' }
}

// ---------- what the pet shows right now ----------

export type Shown = { mood: string; say: string }

type Base = {
  flash: PetFlash | null
  now: number
  lastActivity: number
  isWorking: boolean
  doing: string
  doingMood?: string
  failStreak: number
  contextPercent: number
  limitPercent: number
  hour: number
  name: string
}

export function shown(b: Base): Shown {
  if (b.flash && b.flash.until > b.now) return { mood: b.flash.mood, say: b.flash.say }
  if (b.isWorking) return { mood: b.doingMood ?? 'working', say: b.doing || 'on it!' }
  const idleMin = (b.now - b.lastActivity) / 60_000
  if (idleMin >= 15) return { mood: 'sleeping', say: `${b.name} is asleep` }
  if (b.hour >= 1 && b.hour < 5) return { mood: 'late', say: "it's late... go to sleep?" }
  if (b.limitPercent >= 90) return { mood: 'tired', say: "I'm tired... your limit is almost used" }
  if (b.contextPercent >= 75) return { mood: 'crowded', say: "it's crowded in here... /compact?" }
  if (b.failStreak >= 3) return { mood: 'sad', say: 'rough day... want to take a break?' }
  if (idleMin >= 5) return { mood: 'idle', say: '...' }
  return { mood: 'watching', say: `${b.name} is watching you code` }
}

/** A tiny animation: the icon beside the pet changes every second for some moods. */
export function animate(mood: string, frame: number, style: Style = 'ascii'): string {
  if (style === 'emoji') {
    const icon = MOODS[mood]?.emoji ?? '👀'
    if (mood === 'sleeping') return ['💤', '  ', '💤', 'z '][frame % 4]!
    if (mood === 'happy' || mood === 'levelup' || mood === 'petted') return frame % 2 === 0 ? icon : icon === '🎉' ? '🥳' : icon === '💕' ? '💖' : '🌟'
    if (mood === 'watching') return frame % 6 === 5 ? '😑' : icon
    if (mood === 'building' || mood === 'running' || mood === 'working') return frame % 2 === 0 ? icon : '💦'
    return icon
  }
  const icon = MOODS[mood]?.ascii ?? ''
  if (mood === 'sleeping') return ['z', 'zZ', 'zZz', 'zZ'][frame % 4]!
  if (mood === 'working' || mood === 'idle') return ['.', '..', '...'][frame % 3]!
  if (mood === 'happy') return frame % 2 === 0 ? '\\o/' : '_o_'
  if (mood === 'petted') return frame % 2 === 0 ? '<3' : '<3 <3'
  if (mood === 'levelup') return frame % 2 === 0 ? '**' : '*'
  return icon
}

/** In ASCII style the eyes blink now and then while watching. */
export function blink(mood: string, frame: number, style: Style): string {
  return style === 'ascii' && mood === 'watching' && frame % 6 === 5 ? 'idle' : mood
}

// ---------- helpers ----------

const pad = (n: number) => String(n).padStart(2, '0')

export function day(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
