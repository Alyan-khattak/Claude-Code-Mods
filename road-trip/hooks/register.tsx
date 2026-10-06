import type { Register } from 'claude-code'
import { registerRoadTrip } from './road-trip'

export const register: Register = on => {
  registerRoadTrip(on)
}
