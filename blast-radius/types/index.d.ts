export type BlastReport = {
  /** The command as Claude wrote it. */
  command: string
  /** What kind of risk, in a few words: "rm -r", "git reset --hard". */
  title: string
  /** One line for the question: "would delete 9 files (1.1 MB)". */
  summary: string
  /** The details: files, commits, changes. */
  lines: string[]
  /** Things worth shouting about: the whole project, the home folder, no preview. */
  warnings: string[]
}

export type BlastHeld = {
  report: BlastReport
  /** Where the report is drawn while the question is up. */
  where: 'pane' | 'band'
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': {
      held: BlastHeld | null
      isInteractive: boolean
    }
  }
}
