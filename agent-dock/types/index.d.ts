export type HelperStatus = 'queued' | 'working' | 'done' | 'stuck'
export type DockPhase = 'idle' | 'live' | 'done'

export interface AgentRole {
  name: string
  instructions: string
}

export interface Helper {
  id: string
  description: string
  initials: string
  color: string
  status: HelperStatus
  pct: number
  startMs: number | null
  endMs: number | null
}

export interface DockState {
  teamSize: number
  helperModel: 'haiku' | 'same'
  job: string
  helpers: Helper[]
  phase: DockPhase
  jobStartMs: number | null
  jobEndMs: number | null
  isFolded: boolean
  pendingBigTeam: number | null
  stuckCount: number
  roles: AgentRole[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-dock': {
      dock: DockState
      tick: number
    }
  }
}
