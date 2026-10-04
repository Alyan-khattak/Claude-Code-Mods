/** The pet itself: saved across sessions in the plugin store. */
export type PetProfile = {
  name: string
  species: string
  xp: number
  /** When the pet hatched, ms since the epoch. */
  born: number
  /** Green test runs in a row, and the best run ever. */
  streak: number
  best: number
  /** Tests passed today, by local date. */
  today: { date: string; tests: number }
  pets: number
}

/** A mood that lasts a few seconds (tests passed, a failure, a pat), then the pet goes back to its base mood. */
export type PetFlash = { mood: string; say: string; until: number }

declare module 'claude-code' {
  interface PluginState {
    'code-pet': {
      profile: PetProfile | null
      flash: PetFlash | null
      /** Ticks every second: animation frame and idle checks. */
      now: number
      lastActivity: number
      isWorking: boolean
      /** What the pet says while Claude works: "reading app.js", "running npm test". */
      doing: string
      /** The mood that goes with it: reading, building, running, working. */
      doingMood: string
      failStreak: number
      /** Context window and plan-limit fill, from the latest response. */
      contextPercent: number
      limitPercent: number
    }
  }
}
