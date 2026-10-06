export type RoadTripSave = {
  bank: number
  ownedCars: string[]
  currentCar: string
  xp: number
  bestDistance: number
  retro: boolean
  disabled: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'road-trip': {
      tick: number
    }
  }
}
