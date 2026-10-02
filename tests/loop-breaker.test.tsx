import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { normalizeError, safeLabel } from '../hooks/register'

const fail = (text = 'exit 1') => ({ isError: true as const, result: text, text })
const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

// A disk the fake tools edit, so whole-file versions are real.
function disk(on: On, files: Record<string, string>, counter = { runs: 0 }) {
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', (_$, e) => {
    counter.runs += 1
    if (e.tool === 'Write') {
      const originalFile = files[e.file_path] ?? null
      files[e.file_path] = e.content
      return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile } }
    }
    if (e.tool === 'Edit') {
      const originalFile = files[e.file_path] ?? ''
      files[e.file_path] = originalFile.replace(e.old_string, () => e.new_string)
      return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile, structuredPatch: [], userModified: false, replaceAll: false } }
    }
    return fail()
  })
  return counter
}

test('the third identical failure with the same error is refused', async ($, on) => {
  on('tool.call', () => fail())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const third = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(third.deny).toMatch(/Loop Breaker/)
})

test('a successful edit between failures is progress, not a loop', async ($, on) => {
  let runs = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') return { result: { staged: false } }
    runs += 1
    return fail()
  })
  for (let i = 0; i < 4; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: `v${i}`, new_string: `v${i + 1}` })
  }
  expect(runs).toBe(4)
})

test('a different error each time is not the same failure', async ($, on) => {
  let runs = 0
  on('tool.call', () => fail(`error ${(runs += 1)}`))
  for (let i = 0; i < 4; i += 1) await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect(runs).toBe(4)
})

test('whitespace inside a command is significant', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: "echo 'a  b'" })
  await $.tool.call({ tool: 'Bash', command: "echo 'a  b'" })
  await $.tool.call({ tool: 'Bash', command: "echo 'a b'" })
  expect(runs).toBe(3)
})

test('a person prompt resets the count, a notification does not', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return fail()
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runs).toBe(2)
  await $.prompt.submit(person('try again'))
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runs).toBe(3)
})

test('successful repeats are never blocked', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: 'ok' }
  })
  for (let i = 0; i < 5; i += 1) await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(runs).toBe(5)
})

test('two identical failing calls in parallel both count', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return fail()
  })
  await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'npm test' }),
    $.tool.call({ tool: 'Bash', command: 'npm test' }),
  ])
  const third = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(runs).toBe(2)
  expect(third.deny).toMatch(/Loop Breaker/)
})

test('a failure finishing after a reset is not recorded', async ($, on) => {
  let runs = 0
  let release: () => void = () => {}
  let started: () => void = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const running = new Promise<void>(resolve => (started = resolve))
  on('tool.call', async () => {
    runs += 1
    if (runs === 2) {
      started()
      await held
    }
    return fail()
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Bash', command: 'make' })
  const pending = $.tool.call({ tool: 'Bash', command: 'make' })
  await running
  await $.prompt.submit(person('start over'))
  release()
  await pending
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runs).toBe(4)
})

test('timings in the error do not make it a different failure', async ($, on) => {
  let runs = 0
  on('tool.call', () => fail(`1 failed\nTime: ${(runs += 1) * 1.3}s`))
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'npx jest' })
  expect(runs).toBe(2)
})

test('structured errors without text are compared by content', async ($, on) => {
  let runs = 0
  on('tool.call', () => ({ isError: true as const, result: { code: (runs += 1) } }))
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'thing' })
  expect(runs).toBe(3)
})

test('interrupted calls and backgrounded commands are not counted', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return runs % 2 === 0 ? fail('partial output\n<error>Command was aborted before completion</error>') : { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }
  })
  for (let i = 0; i < 4; i += 1) await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(runs).toBe(4)
})

test('a shell edit counts as a code change', async ($, on) => {
  let runs = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('sed')) {
      return { result: { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: '/x.ts', hunks: [] }], moreFiles: 0 } } }
    }
    runs += 1
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: "sed -i '' s/a/b/ /x.ts" })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(runs).toBe(3)
})

test('a subagent edit clears the main thread streak', async ($, on) => {
  let runs = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') return { result: { staged: false } }
    runs += 1
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b', agentId: 'sub1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(runs).toBe(3)
})

test('the band shows the streak and keeps what the plugins beneath draw', async ($, on) => {
  on('tool.call', () => fail())
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="beneath">another mod</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const ui = await $.ui.mount({
      plugin: 'loop-breaker',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /stuck/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.press({ key: 'unstick' })
    expect(await ui.find({ type: 'Text', text: /stuck/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test('a file flipped between two versions is refused on the fourth flip', async ($, on) => {
  const c = disk(on, { '/x.ts': 'let a = 1' })
  const ab = { tool: 'Edit' as const, file_path: '/x.ts', old_string: 'a = 1', new_string: 'a = 2' }
  const ba = { tool: 'Edit' as const, file_path: '/x.ts', old_string: 'a = 2', new_string: 'a = 1' }
  await $.tool.call(ab)
  await $.tool.call(ba)
  await $.tool.call(ab)
  const flip = await $.tool.call(ba)
  expect(c.runs).toBe(3)
  expect(flip.deny).toMatch(/oscillating/)
})

test('the same short swap at different places is not oscillation', async ($, on) => {
  const c = disk(on, { '/x.ts': "s1 = 'a'; s2 = 'b'; s3 = 'a'; s4 = 'b'" })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: "s1 = 'a'", new_string: "s1 = 'b'" })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: "s2 = 'b'", new_string: "s2 = 'a'" })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: "s3 = 'a'", new_string: "s3 = 'b'" })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: "s4 = 'b'", new_string: "s4 = 'a'" })
  expect(c.runs).toBe(4)
})

test('whole-file Write oscillation is refused, and a no-op Write is not a change', async ($, on) => {
  const c = disk(on, { '/x.ts': 'v1' })
  for (const content of ['v2', 'v1', 'v2']) await $.tool.call({ tool: 'Write', file_path: '/x.ts', content })
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'v2' })
  const flip = await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'v1' })
  expect(c.runs).toBe(4)
  expect(flip.deny).toMatch(/oscillating/)
})

test('another agent changing the file breaks the chain', async ($, on) => {
  const c = disk(on, { '/x.ts': 'v1' })
  for (const content of ['v2', 'v1', 'v2']) await $.tool.call({ tool: 'Write', file_path: '/x.ts', content })
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'v3', agentId: 'sub' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'v1' })
  expect(c.runs).toBe(5)
})

test('a failure from a run that started before a code change is not counted', async ($, on) => {
  let runs = 0
  let release: () => void = () => {}
  let started: () => void = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const running = new Promise<void>(resolve => (started = resolve))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Edit') return { result: { staged: false } }
    runs += 1
    if (runs === 2) {
      started()
      await held
    }
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const old = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await running
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b', agentId: 'sub' } as never)
  release()
  await old
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(runs).toBe(4)
})

test('session end clears the history', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return fail()
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.session.end({ reason: 'clear', sessionId: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runs).toBe(3)
})

test('labels never carry argument values, credentials or queries', () => {
  expect(safeLabel({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://x.test' })).toBe('curl …')
  expect(safeLabel({ tool: 'Bash', command: 'curl -u admin:Sup3rSecret https://x' })).toBe('curl …')
  expect(safeLabel({ tool: 'Bash', command: 'npm test -- --watch' })).toBe('npm test …')
  expect(safeLabel({ tool: 'WebFetch', url: 'https://u:pw@api.example/hooks?token=abc', prompt: 'x' })).toBe('WebFetch api.example')
  expect(safeLabel({ tool: 'Read', file_path: '/Users/me/secret-project/.env' })).toBe('Read .env')
  expect(normalizeError('Time: 1.32 s\nat /var/folders/ab/T/x.js')).toBe('Time: <t>\nat <tmp>')
})

test('a failed edit is a failure, not a change', async ($, on) => {
  let tests = 0
  let edits = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') {
      edits += 1
      return fail('String to replace not found in file.')
    }
    tests += 1
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const edit = { tool: 'Edit' as const, file_path: '/x.ts', old_string: 'nope', new_string: 'b' }
  for (let i = 0; i < 3; i += 1) await $.tool.call(edit)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(edits).toBe(2)
  expect(tests).toBe(2)
})

test('a real error that mentions "interrupted" still counts', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return fail('KeyboardInterrupt: connection interrupted')
  })
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'python app.py' })
  expect(runs).toBe(2)
})

test('a command that wrote files resets streaks', async ($, on) => {
  let runs = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command === 'codegen') {
      return { result: { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: '/g.ts', hunks: [] }], moreFiles: 0 } } }
    }
    runs += 1
    return fail()
  })
  await $.tool.call({ tool: 'Bash', command: 'tsc' })
  await $.tool.call({ tool: 'Bash', command: 'tsc' })
  await $.tool.call({ tool: 'Bash', command: 'codegen' })
  await $.tool.call({ tool: 'Bash', command: 'tsc' })
  expect(runs).toBe(3)
})

test('bare arguments never reach the label', () => {
  expect(safeLabel({ tool: 'Bash', command: 'echo supersecret' })).toBe('echo …')
  expect(safeLabel({ tool: 'Bash', command: 'curl secret-token' })).toBe('curl …')
  expect(safeLabel({ tool: 'Bash', command: 'git push origin main' })).toBe('git push …')
})

test('diffless and unproven commands are not changes; targets are values', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { isError: true as const, result: { bashEditDiff: { files: [], moreFiles: 0, unavailable: true } }, text: 'boom' }
  })
  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'ls nope' })
  expect(runs).toBe(2)
  expect(safeLabel({ tool: 'Bash', command: 'make secret-token' })).toBe('make …')
  expect(safeLabel({ tool: 'Bash', command: 'yarn secret-token' })).toBe('yarn …')
})

test('CRLF files still flip-detect', async ($, on) => {
  const files: Record<string, string> = { '/x.ts': 'a\r\nv1\r\n' }
  let runs = 0
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('tool.call', (_$, e) => {
    runs += 1
    if (e.tool !== 'Write') return fail()
    const originalFile = (files[e.file_path] ?? '').replace(/\r\n/g, '\n')
    files[e.file_path] = e.content.replace(/\n/g, '\r\n')
    return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile } }
  })
  for (const content of ['a\nv2\n', 'a\nv1\n', 'a\nv2\n']) await $.tool.call({ tool: 'Write', file_path: '/x.ts', content })
  const flip = await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: 'a\nv1\n' })
  expect(runs).toBe(3)
  expect(flip.deny).toMatch(/oscillating/)
})
