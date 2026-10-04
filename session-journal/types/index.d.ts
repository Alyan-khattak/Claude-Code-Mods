export type JournalFile = { path: string; kind: 'created' | 'edited' }
export type JournalCommand = { command: string; ok: boolean; byAgent: boolean }

export type JournalTurn = {
  prompt: string
  startedAt: number
  files: JournalFile[]
  commands: JournalCommand[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-journal': {
      current: JournalTurn | null
      cwd: string
      dir: string
    }
  }
}
