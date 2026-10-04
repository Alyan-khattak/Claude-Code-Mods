export type TokenWeatherReading = {
  tokens: number
  window: number
  percent: number
  /** Session cost in US dollars when the host keeps a ledger. */
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-weather': { readings: TokenWeatherReading[] }
  }
}
