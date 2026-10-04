export type WaypointCheckpoint = {
  /** Number shown to the person: #1, #2, ... per project. */
  n: number
  /** prompt: taken before a prompt ran; safety: taken before a restore; manual: /waypoints save. */
  kind: 'prompt' | 'safety' | 'manual'
  /** The prompt's text (prompt), or what the checkpoint is for. */
  label: string
  /** When it was taken, ms since the epoch. */
  at: number
  /** Snapshot commit of the files before the prompt ran (or at the moment taken). */
  before: string
  /** Snapshot commit after the prompt's turn ended; absent while it runs or if it never finished. */
  after?: string
  turnId?: string
  files?: number
  added?: number
  removed?: number
}

export type WaypointFileDiff = { path: string; hunks: string; added: number; removed: number; isBinary: boolean }

export type WaypointDetail = {
  n: number
  files: WaypointFileDiff[]
  /** Files left out of the preview to keep it readable. */
  more: number
}

export type WaypointRepo = { dir: string; work: string }

declare module 'claude-code' {
  interface PluginState {
    waypoint: {
      repo: WaypointRepo | null
      /** Why Waypoint is off, when it is (no git, no project folder). */
      offReason: string | null
      checkpoints: WaypointCheckpoint[]
      selected: number | null
      /** The highlighted row in the list (a checkpoint number); the list keeps it in the middle. */
      cursor: number | null
      /** The highlighted option in a checkpoint's view: 'after', 'before' or 'back'. */
      action: string | null
      detail: WaypointDetail | null
      isWorking: boolean
      /** Told to Claude with the next prompt after a restore. */
      note: string | null
      /** A line for the pane: what just happened. */
      message: string | null
    }
  }
}
