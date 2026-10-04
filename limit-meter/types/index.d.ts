export type LimitReading = {
  /** `five_hour`, `seven_day`, `spend_limit`, or another window Claude Code reports. */
  kind: string
  /** 0 to 100 (past 100 on an exceeded spend limit). */
  percentUsed: number
  /** When the window resets, ms since the epoch. */
  resetsAt?: number
}

/** The weekly reading at the start of the local day, for "used today". */
export type LimitDayStart = { date: string; percent: number; resetsAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'limit-meter': {
      limits: LimitReading[]
      /** Session cost in US dollars, when the host keeps a ledger. */
      usd: number | null
      /** When the readings were last refreshed. */
      updatedAt: number
      /** Ticks every minute so the countdowns move. */
      now: number
      dayStart: LimitDayStart | null
    }
  }
}