import type { Register } from 'claude-code'
import { registerDock } from './dock'

export const register: Register = on => {
  registerDock(on)
}
