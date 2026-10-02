import { expect, test } from 'claude-code/testing'

const fail = (text = 'exit 1') => ({ isError: true as const, result: text, text })
const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

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

test('an edit flipped back and forth is refused on the fourth flip, repeats are not', async ($, on) => {
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: { staged: false } }
  })
  const a = { tool: 'Edit' as const, file_path: '/x.ts', old_string: 'a', new_string: 'b' }
  const b = { tool: 'Edit' as const, file_path: '/x.ts', old_string: 'b', new_string: 'a' }
  await $.tool.call(a)
  await $.tool.call(a)
  await $.tool.call(b)
  await $.tool.call(a)
  const flip = await $.tool.call(b)
  expect(runs).toBe(4)
  expect(flip.deny).toMatch(/oscillating/)
})
