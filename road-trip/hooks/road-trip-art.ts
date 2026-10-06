// Cars, quiz questions, XP levels. No $ references.

export type Perk = 'none' | 'magnet' | 'shield' | 'doublecoin' | 'all'

export interface CarDef {
  id: string
  name: string
  flavor: string
  price: number
  levelReq: number
  perk: Perk
  art: readonly [string, string, string]  // 5-char wide, 3 rows
}

export const CARS: readonly CarDef[] = [
  {
    id: 'hatch', name: 'Starter Hatch',
    flavor: 'Every empire starts somewhere',
    price: 0, levelReq: 1, perk: 'none',
    art: [' ,_, ', '[   ]', "'o o'"],
  },
  {
    id: 'coupe', name: 'Side Hustle Coupe',
    flavor: 'Coin magnet: grabs coins in adjacent lane',
    price: 60, levelReq: 2, perk: 'magnet',
    art: ['▗▄▄▄▖', '▐▀▀▀▌', '▝o o▘'],
  },
  {
    id: 'wagon', name: 'Agency Wagon',
    flavor: 'Shield: survive one hit per run',
    price: 180, levelReq: 3, perk: 'shield',
    art: ['▗▟█▙▖', '▐█▀█▌', '▝▀ ▀▘'],
  },
  {
    id: 'gt', name: 'Founder GT',
    flavor: 'Double coins on everything',
    price: 450, levelReq: 5, perk: 'doublecoin',
    art: ['▗▃▃▃▖', '▐███▌', '▝▀▀▀▘'],
  },
  {
    id: 'hyper', name: 'Unicorn Hyper',
    flavor: 'All perks + nitro start',
    price: 1000, levelReq: 8, perk: 'all',
    art: ['+▀█▀+', '▐███▌', '+▄█▄+'],
  },
]

// Cumulative XP needed to reach each level boundary (index 0 = XP for level 2)
export const LEVEL_XP = [500, 1500, 3000, 5000, 8000, 12000, 18000, 25000, 35000] as const

export function levelFromXp(xp: number): number {
  let lv = 1
  for (const t of LEVEL_XP) { if (xp >= t) lv++; else break }
  return lv
}

export function xpProgress(xp: number): { level: number; frac: number } {
  let level = 1
  let prev = 0
  for (const t of LEVEL_XP) {
    if (xp >= t) { level++; prev = t } else {
      return { level, frac: (xp - prev) / (t - prev) }
    }
  }
  return { level, frac: 1 }
}

export interface QuizQ {
  q: string                             // question, max ~36 chars
  opts: readonly [string, string, string] // A/B/C, each max ~12 chars
  correct: 0 | 1 | 2
}

export const QUIZ: readonly QuizQ[] = [
  { q: 'Stop Claude mid-task?',         opts: ['Esc', 'F5', 'Tab'],                correct: 0 },
  { q: '/compact does what?',           opts: ['Delete files', 'Compress context', 'Exit'], correct: 1 },
  { q: 'That meeting should be...',     opts: ['A slide deck', 'An email', 'A call'],      correct: 1 },
  { q: '/clear resets?',                opts: ['Files', 'Context window', 'Plugins'],      correct: 1 },
  { q: 'MCP stands for?',               opts: ['Multi-Client', 'Model Context', 'Managed'], correct: 1 },
  { q: 'Best deploy day?',              opts: ['Friday 5pm', 'Monday AM', 'Wednesday AM'], correct: 2 },
  { q: 'Haiku vs Sonnet: speed?',       opts: ['Same', 'Haiku faster', 'Sonnet faster'],   correct: 1 },
  { q: 'Debug or rewrite?',             opts: ['Always debug', 'Always rewrite', 'Depends'], correct: 2 },
  { q: 'Biggest startup risk?',         opts: ['Office space', 'Not starting', 'The logo'], correct: 1 },
  { q: 'Spec or code first?',           opts: ['Code', 'Spec', 'Both at once'],            correct: 1 },
  { q: 'Force push main branch?',       opts: ['Sure', 'Never on Friday', 'Ask first'],    correct: 2 },
  { q: 'Fix scope creep how?',          opts: ['Say no', 'Sprint faster', 'Add devs'],     correct: 0 },
  { q: 'Context window full?',          opts: ['/compact', '/clear', 'Restart'],           correct: 0 },
  { q: 'YAGNI stands for?',             opts: ["You Ain't Gonna", 'Yet Another Go', 'Your Agent'], correct: 0 },
  { q: 'Claude API style?',             opts: ['REST only', 'Messages API', 'GraphQL'],    correct: 1 },
  { q: 'Prompt caching saves?',         opts: ['Speed only', 'Cost only', 'Both'],         correct: 2 },
  { q: 'Best code comment?',            opts: ['Why not what', 'What not why', 'No comments'], correct: 0 },
  { q: 'Ship at 80% or wait?',          opts: ['Wait for 100', 'Ship at 80', 'Ship at 60'], correct: 1 },
  { q: 'Cancel running tool?',          opts: ['Esc', 'Ctrl+C', 'q'],                     correct: 0 },
  { q: 'Fastest bug fix?',              opts: ['Add logs', 'Step debugger', 'Ask Claude'], correct: 2 },
  { q: 'Subagents run how?',            opts: ['In parallel', 'In sequence', 'Either'],    correct: 2 },
  { q: 'Daily standup duration?',       opts: ['15 minutes', '1 hour', '30 min'],          correct: 0 },
  { q: 'Tech debt interest rate?',      opts: ['Compound', 'Fixed 5%', 'No interest'],     correct: 0 },
  { q: 'Zero inbox: real or myth?',     opts: ['Real goal', 'Productivity myth', 'App feature'], correct: 1 },
  { q: 'Best first hire?',              opts: ['Generalist', 'Specialist', 'No hire yet'], correct: 0 },
  { q: 'Three similar lines need?',     opts: ['An abstraction', 'A helper', 'Nothing yet'], correct: 2 },
  { q: 'Async/await vs callbacks?',     opts: ['Always async', 'Depends', 'Always callbacks'], correct: 1 },
  { q: 'One-liner or helper?',          opts: ['One-liner always', 'Helper always', 'One-liner first'], correct: 2 },
]
