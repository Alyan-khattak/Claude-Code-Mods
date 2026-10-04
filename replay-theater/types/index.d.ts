export type ReplayStep = {
  /** File path, relative to the project when inside it. */
  path: string
  kind: 'edit' | 'new file' | 'rewrite' | 'notebook'
  /** Unified-diff hunks (no file headers), or '' when there is nothing to show. */
  diff: string
  added: number
  removed: number
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      /** Edits recorded during the running turn. */
      pending: ReplayStep[]
      /** The last finished turn's edits: what /replay steps through. */
      replay: ReplayStep[]
      index: number
      showHint: boolean
      cwd: string
    }
  }
}
