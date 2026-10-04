// Replay Theater: records every edit Claude makes during a turn (the file
// before and after), and when the turn ends offers a replay: /replay opens a
// pane that steps through the edits one diff at a time.
// It only observes: no edit is blocked or changed.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplayStep } from '../types'
import { diffLines, fit } from './diff'

const PANE = 'replay-theater'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_STEPS = 200

const pending = atom({ plugin: 'replay-theater', key: 'pending' } as const, [])
const replay = atom({ plugin: 'replay-theater', key: 'replay' } as const, [])
const index = atom({ plugin: 'replay-theater', key: 'index' } as const, 0)
const showHint = atom({ plugin: 'replay-theater', key: 'showHint' } as const, false)
const cwd = atom({ plugin: 'replay-theater', key: 'cwd' } as const, '')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, cwd, () => e.cwd)
    try {
      await $.command.register({ name: 'replay', description: "Step through the last turn's file edits" })
    } catch (error) {
      $.ui.log(`replay-theater: could not register /replay (${String(error)})`, { to: 'debug' })
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, pending, () => [])
    await update($, showHint, () => false)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (path === undefined) return next(e)

    const before = await readText($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    try {
      const step = await stepFor($, tool, path, before, input)
      if (step !== undefined) await update($, pending, list => [...list, step].slice(-MAX_STEPS))
    } catch (error) {
      $.ui.log(`replay-theater: could not record ${path} (${String(error)})`, { to: 'debug' })
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const steps = await read($, pending)
    if (steps.length > 0) {
      await update($, replay, () => steps)
      await update($, index, () => 0)
      await update($, showHint, () => true)
      await update($, pending, () => [])
    }
    return result
  })

  on('command.run', { command: 'replay' }, async $ => {
    const steps = await read($, replay)
    if (steps.length === 0) return { text: 'No edits to replay yet: they are recorded as Claude makes them.' }
    await openReplay($)
    return { text: `Replaying ${summary(steps)}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const steps = await read($, replay)
    if (e.props.hasSurvey || e.props.isWorking || !(await read($, showHint)) || steps.length === 0) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box key="replay-hint" flexDirection="row" paddingX={1} gap={1}>
          <Text color="magenta">↺</Text>
          <Text>Last turn: {summary(steps)}</Text>
          <Button key="open-replay" label="Replay" hotkey="r" onPress={() => openReplay($)} />
          <Button key="hide-replay" label="Hide" plain dimColor onPress={() => update($, showHint, () => false)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const steps = await read($, replay)
    if (steps.length === 0) return <Text dimColor>Nothing to replay.</Text>
    const at = Math.min(await read($, index), steps.length - 1)
    const step = steps[at]!
    const go = (to: number) => update($, index, () => Math.max(0, Math.min(steps.length - 1, to)))

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text>{strip(steps.length, at, e.props.bodyColumns)}</Text>
        <Box flexDirection="row" marginTop={1} justifyContent="space-between">
          <Text bold wrap="truncate-start">
            {step.path}
          </Text>
          <Text dimColor>
            {' '}
            {step.kind} <Text color="green">+{step.added}</Text> <Text color="red">−{step.removed}</Text>
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {step.diff === '' ? (
            <Text dimColor>No line changes to show.</Text>
          ) : (
            <Code key={`diff-${at}`} source={step.diff} format="diff" path={step.path} />
          )}
        </Box>
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button key="prev" label="Prev" hotkey="p" onPress={() => go(at - 1)} />
          <Button key="next" label="Next" hotkey="n" variant="primary" onPress={() => go(at + 1)} />
          <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          <Text dimColor>
            {' '}
            step {at + 1} of {steps.length}
          </Text>
        </Box>
      </Box>
    )
  })
}

async function openReplay($: EngineInterface) {
  await update($, showHint, () => false)
  await $.ui.open({ id: PANE, title: 'Replay', focus: true, closeOnEscape: true, rows: 50 })
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined // missing (a new file) or too large to read
  }
}

async function stepFor(
  $: EngineInterface,
  tool: string,
  path: string,
  before: string | undefined,
  input: Record<string, unknown>,
): Promise<ReplayStep | undefined> {
  const shown = relative(path, await read($, cwd))
  if (tool === 'NotebookEdit') {
    const source = typeof input.new_source === 'string' ? input.new_source : ''
    const d = diffLines('', source)
    return { path: shown, kind: 'notebook', diff: fit(d.hunks), added: d.added, removed: 0 }
  }
  const after = await readText($, path)
  if (after === undefined) return undefined
  const d = diffLines(before ?? '', after)
  const kind = before === undefined ? 'new file' : tool === 'Write' ? 'rewrite' : 'edit'
  return { path: shown, kind, diff: fit(d.hunks), added: d.added, removed: d.removed }
}

function summary(steps: readonly ReplayStep[]): string {
  const files = new Set(steps.map(s => s.path)).size
  return `${steps.length} ${steps.length === 1 ? 'edit' : 'edits'} in ${files} ${files === 1 ? 'file' : 'files'}`
}

/** "‹ 3 4 [5] 6 7 ›": the steps around the current one, as many as fit. */
export function strip(count: number, at: number, columns: number): string {
  const room = Math.max(3, Math.floor((columns - 4) / 5))
  let lo = Math.max(0, at - Math.floor(room / 2))
  const hi = Math.min(count, lo + room)
  lo = Math.max(0, hi - room)
  const cells: string[] = []
  for (let i = lo; i < hi; i++) cells.push(i === at ? `[${i + 1}]` : ` ${i + 1} `)
  return `${lo > 0 ? '‹ ' : '  '}${cells.join(' ')}${hi < count ? ' ›' : ''}`
}

function relative(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return r !== '' && p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p
}
