import { describe, expect, test } from 'claude-code/testing'

import { classify, tokenize } from '../hooks/register'

type Setup = {
  answer?: string | Error
  git?: Record<string, string>
  placed?: boolean
}

function world(on: any, setup: Setup) {
  const ran: string[] = []
  const asked: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: setup.placed === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    const key = e.argv.join(' ')
    const out = setup.git?.[key]
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($: any, e: any) => {
    if (String(e.path).replace(/^\/work\//, '') === 'build') return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('missing ' + e.path)
  })
  on('fs.list', ($: any, e: any) => {
    const path = String(e.path).replace(/^\/work\//, '')
    if (path === 'build') {
      return { value: [
        { name: 'app.js', kind: 'file', size: 1_048_576, mtimeMs: 0, isLink: false },
        { name: 'assets', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      ] }
    }
    if (path === 'build/assets') {
      return { value: [{ name: 'logo.png', kind: 'file', size: 2048, mtimeMs: 0, isLink: false }] }
    }
    return { value: [] }
  })
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      asked.push(q)
      if (setup.answer instanceof Error) return { deny: 'dismissed' }
      return answer(e, setup.answer ?? 'Cancel')
    }
    ran.push(String(e.command))
    return { result: 'ok', text: 'ok' }
  })
  return { ran, asked }
}

// The engine's AskUserQuestion answering: the label picked for the question.
function answer(e: any, label: string) {
  const q = e.questions[0].question
  return { result: { questions: e.questions, answers: { [q]: label } }, text: `User has answered your questions: "${q}"="${label}".` }
}

const bash = (command: string) => ({ tool: 'Bash', command, tool_use_id: 'u1' }) as any

describe('blast-radius', () => {
  test('ordinary commands run untouched', async ($, on) => {
    const w = world(on, {})
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('npm test && git status'))
    expect(w.ran).toEqual(['npm test && git status'])
    expect(w.asked).toHaveLength(0)
  })

  test('Cancel refuses rm -rf and says what it would have deleted', async ($, on) => {
    const w = world(on, { answer: 'Cancel' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const result = await $.tool.call(bash('rm -rf build'))
    expect(w.ran).toHaveLength(0)
    expect(w.asked[0]).toContain('would delete 2 files (1.0 MB)')
    expect(String((result as any).deny ?? (result as any).text)).toContain('the user chose Cancel')
  })

  test('Proceed runs the command as written', async ($, on) => {
    const w = world(on, { answer: 'Proceed' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('rm -rf build'))
    expect(w.ran).toEqual(['rm -rf build'])
  })

  test('dismissing the question counts as Cancel', async ($, on) => {
    const w = world(on, { answer: new Error('dismissed') })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('git clean -fd'))
    expect(w.ran).toHaveLength(0)
  })

  test('git reset --hard lists the uncommitted files it would discard', async ($, on) => {
    const w = world(on, {
      git: {
        'git status --porcelain': ' M src/a.ts\nM  src/b.ts\n?? scratch.txt\n',
        'git diff --shortstat HEAD': ' 2 files changed, 10 insertions(+), 3 deletions(-)\n',
      },
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('git reset --hard'))
    expect(w.asked[0]).toContain('would discard uncommitted changes in 2 files (2 files changed, 10 insertions(+), 3 deletions(-))')
  })

  test('a force push counts the remote commits it would overwrite', async ($, on) => {
    const w = world(on, {
      git: {
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
        'git log --oneline -n 30 HEAD..origin/main': 'abc123 fix login\ndef456 docs\n',
      },
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('git push --force'))
    expect(w.asked[0]).toContain('would overwrite 2 commits on origin/main')
  })

  test('non-interactive runs are left alone', async ($, on) => {
    const w = world(on, {})
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.tool.call(bash('rm -rf build'))
    expect(w.ran).toEqual(['rm -rf build'])
    expect(w.asked).toHaveLength(0)
  })

  test('the pane shows the report while the question is up', async ($, on) => {
    let mounted: unknown
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))
    on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
    on('tool.call', { tool: 'AskUserQuestion' }, async (_: any, e: any) => {
      const ui = await $.ui.mount({
        plugin: 'blast-radius',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'blast-radius',
        props: { title: 'Blast Radius', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { top: 0, bodyRows: 20, totalRows: 20 }, view: {} },
      } as any)
      mounted = await ui.find({ type: 'Text', text: /would delete 1 file/ })
      await ui.unmount()
      return answer(e, 'Cancel')
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok', text: 'ok' }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('rm -f notes.txt'))
    expect(mounted).toBeDefined()
  })
})

describe('classify', () => {
  test('knows the dangerous shapes and leaves the rest', async () => {
    const kinds = (c: string) => classify(c).map(r => r.kind)
    expect(kinds('rm -rf node_modules')).toEqual(['rm'])
    expect(kinds('rm -r -f dist')).toEqual(['rm'])
    expect(kinds('rm notes.txt')).toEqual([])
    expect(kinds('sudo rm -rf /tmp/x')).toEqual(['rm'])
    expect(kinds('Remove-Item -Recurse -Force build')).toEqual(['rm'])
    expect(kinds('rmdir /s /q build')).toEqual(['rm'])
    expect(kinds('git reset --hard HEAD~2')).toEqual(['reset'])
    expect(kinds('git reset --soft HEAD~1')).toEqual([])
    expect(kinds('git clean -fdx')).toEqual(['clean'])
    expect(kinds('git clean -n')).toEqual([])
    expect(kinds('git push -f origin main')).toEqual(['push'])
    expect(kinds('git push origin main')).toEqual([])
    expect(kinds('git checkout -- .')).toEqual(['discard'])
    expect(kinds('git checkout feature')).toEqual([])
    expect(kinds('git restore src/a.ts')).toEqual(['discard'])
    expect(kinds('git restore --staged src/a.ts')).toEqual([])
    expect(kinds('git branch -D old')).toEqual(['branch'])
    expect(kinds('python manage.py migrate')).toEqual(['data'])
    expect(kinds('psql -c "DROP TABLE users"')).toEqual(['data'])
    expect(kinds('docker compose down -v')).toEqual(['data'])
    expect(kinds('npm run build && rm -rf dist')).toEqual(['rm'])
    expect(tokenize(`echo "a b" 'c d' e`)).toEqual(['echo', 'a b', 'c d', 'e'])
  })
})
