export type SeenFile = {
  /** Path as Claude named it, shown relative to the project when it lies inside. */
  path: string
  reads: number
  edits: number
  /** The main-loop turn that last touched it. */
  lastTurn: string
  /** Order of last touch, so the newest sort first. */
  seq: number
}

declare module 'claude-code' {
  interface PluginState {
    'files-seen': {
      files: SeenFile[]
      turnId: string | null
      cwd: string
    }
  }
}
