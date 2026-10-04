// Files Seen: every file Claude read or edited this session.
// Status line: "◉ 12 read · ✎ 3 edited". /seen opens a pane grouped into
// Edited and Read only, with files from the current turn marked.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SeenFile } from '../types'

const PANE = 'files-seen'
const LIMIT = 500

const files = atom({ plugin: 'files-seen', key: 'files' } as const, [])
const turnId = atom({ plugin: 'files-seen', key: 'turnId' } as const, null)
const cwd = atom({ plugin: 'files-seen', key: 'cwd' } as const, '')

const READ_TOOLS = new Set(['Read'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, cwd, () => e.cwd)
    try {
      await $.command.register({ name: 'seen', description: 'Show every file Claude read or edited this session' })
    } catch (error) {
      $.ui.log(`files-seen: could not register /seen (${String(error)})`, { to: 'debug' })
    }
    await showStatus($)
    return result
  })

  on('session.end', async ($, e, next) => {
    // A /clear starts a fresh conversation: start the list over with it.
    if (e.reason === 'clear') {
      await update($, files, () => [])
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnId, () => e.turnId)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isRead = READ_TOOLS.has(tool)
    const isEdit = EDIT_TOOLS.has(tool)
    const ran = await next(e)
    if (!isRead && !isEdit) return ran
    if (ran.deny !== undefined || ran.isError === true) return ran

    const raw = pathOf(e as unknown as Record<string, unknown>)
    if (raw === undefined) return ran

    const root = await read($, cwd)
    const path = display(raw, root)
    const turn = (await read($, turnId)) ?? ''

    await update($, files, list => {
      const seq = list.reduce((max, f) => Math.max(max, f.seq), 0) + 1
      const found = list.find(f => f.path === path)
      const entry: SeenFile = found
        ? {
            ...found,
            reads: found.reads + (isRead ? 1 : 0),
            edits: found.edits + (isEdit ? 1 : 0),
            lastTurn: turn,
            seq,
          }
        : { path, reads: isRead ? 1 : 0, edits: isEdit ? 1 : 0, lastTurn: turn, seq }
      return [...list.filter(f => f.path !== path), entry].slice(-LIMIT)
    })
    await showStatus($)
    return ran
  })

  on('command.run', { command: 'seen' }, async $ => {
    const list = await read($, files)
    await $.ui.open({ id: PANE, title: 'Files seen', focus: true, closeOnEscape: true, rows: 30 })
    return { text: list.length === 0 ? 'No files read or edited yet.' : `${count(list)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = [...(await read($, files))].sort((a, b) => b.seq - a.seq)
    const turn = await read($, turnId)
    const width = e.props.bodyColumns

    const edited = list.filter(f => f.edits > 0)
    const readOnly = list.filter(f => f.edits === 0)

    const row = (f: SeenFile) => {
      const isNow = turn !== null && f.lastTurn === turn
      const counts =
        f.edits > 0 ? `✎${f.edits}${f.reads > 0 ? ` ◉${f.reads}` : ''}` : `◉${f.reads}`
      return (
        <Box key={`f-${f.path}`} flexDirection="row" justifyContent="space-between">
          <Text bold={isNow} dimColor={!isNow} wrap="truncate-start">
            {isNow ? '● ' : '  '}
            {f.path}
          </Text>
          <Text dimColor>{' ' + counts}</Text>
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nothing read or edited yet this session.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Text bold>{count(list)}</Text>
        <Text dimColor>● touched this turn  ✎ edits  ◉ reads</Text>
        {edited.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow" bold>
              Edited ({edited.length})
            </Text>
            {edited.map(row)}
          </Box>
        )}
        {readOnly.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan" bold>
              Read only ({readOnly.length})
            </Text>
            {readOnly.map(row)}
          </Box>
        )}
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button
            key="reset"
            label="Reset list"
            hotkey="r"
            onPress={async () => {
              await update($, files, () => [])
              await showStatus($)
            }}
          />
          <Button
            key="close"
            label="Close"
            hotkey="c"
            role="dismiss"
            onPress={() => $.ui.close({ id: PANE })}
          />
        </Box>
      </Box>
    )
  })
}

async function showStatus($: EngineInterface) {
  const list = await read($, files)
  $.ui.status(list.length === 0 ? undefined : count(list, true))
}

function count(list: readonly SeenFile[], short = false): string {
  const edited = list.filter(f => f.edits > 0).length
  const readOnly = list.length - edited
  return short
    ? `◉ ${readOnly} read · ✎ ${edited} edited`
    : `${list.length} files: ${edited} edited, ${readOnly} read only`
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

/** Shows a path relative to the project when it lies inside it, with forward slashes. */
function display(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (r.length > 0 && p.toLowerCase().startsWith(r.toLowerCase() + '/')) {
    return p.slice(r.length + 1)
  }
  return p
}
