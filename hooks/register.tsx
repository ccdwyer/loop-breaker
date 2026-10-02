import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Stuck } from '../types'

const stuckRef = { plugin: 'loop-breaker', key: 'stuck' } as const
const blockedRef = { plugin: 'loop-breaker', key: 'blocked' } as const
const stuck = atom(stuckRef, null)

// Identical failures (same call, same error) allowed before the next try is refused.
const MAX_FAILS = 2
// Changes in a row that each swap a file back to its version before the last; the next is refused.
const MAX_CHAIN = 3
// Prompts that are a person's own words, so new direction.
const PERSON = new Set(['composer', 'bridge', 'sdk', 'channel', 'slack-ping'])
// Arguments that describe a call without changing what it does.
const COSMETIC = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'description'])

// A run of identical failures of one call: same arguments, same (normalized) error.
type Streak = { label: string; count: number; error: string }
// The latest run of whole-file swaps on one file: `from` and `to` hash its full text.
type Chain = { from: string; to: string; length: number }
type Loop = { streaks: Map<string, Streak>; chains: Map<string, Chain> }
type Call = { tool: string; [k: string]: unknown }

// The history is the module's own: every hook of this plugin runs in one
// environment, one at a time between awaits, so parallel tool calls update it
// without racing on a per-dispatch state snapshot. A hot reload starts it over.
const loops = new Map<string, Loop>()
// Bumped by a reset: results of calls started before it are dropped.
let gen = 0
// Bumped by every real change on disk: failures of calls started before it ran old code.
let codeGen = 0
let shown: Stuck | null = null
let blockedCount = 0

const loopOf = (agent: string): Loop => {
  let loop = loops.get(agent)
  if (loop === undefined) {
    loop = { streaks: new Map(), chains: new Map() }
    loops.set(agent, loop)
  }
  return loop
}

async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Deterministic JSON: object keys sorted at every depth.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

// Every argument that changes behaviour. Bash commands are kept exactly:
// whitespace inside quotes and heredocs matters.
function identity(e: Call): string {
  const args: Record<string, unknown> = {}
  for (const k of Object.keys(e)) if (!COSMETIC.has(k)) args[k] = e[k]
  return `${e.tool}:${stable(args)}`
}

// The parts of an error that differ between runs of the same failure.
export function normalizeError(text: string): string {
  return text
    .split('\n')
    .filter(line => !/saved to:|persisted output|output too large/i.test(line))
    .join('\n')
    .replace(/(\/private)?\/var\/folders\/\S+/g, '<tmp>')
    .replace(/(\/private)?\/tmp\/\S+/g, '<tmp>')
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<ts>')
    .replace(/\b\d{1,2}:\d\d:\d\d(\.\d+)?\b/g, '<ts>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|min|minutes)\b/gi, '<t>')
    .replace(/0x[0-9a-f]{6,}/gi, '<addr>')
    .replace(/\bpid[ =:]?\d+/gi, 'pid <n>')
    .trim()
}

// Public subcommands per program; anything else (make targets, script names) is a value.
const VERBS: Record<string, string[]> = {
  git: ['add', 'commit', 'push', 'pull', 'fetch', 'rebase', 'merge', 'checkout', 'switch', 'status', 'diff', 'log', 'stash', 'reset', 'restore', 'clone', 'tag', 'branch', 'cherry-pick', 'apply'],
  npm: ['install', 'ci', 'test', 'run', 'exec', 'publish', 'audit', 'update', 'uninstall'],
  pnpm: ['install', 'add', 'test', 'run', 'exec', 'update', 'remove'],
  yarn: ['install', 'add', 'test', 'run', 'remove', 'upgrade'],
  bun: ['install', 'add', 'test', 'run', 'x'],
  cargo: ['build', 'test', 'check', 'clippy', 'run', 'fmt', 'add'],
  go: ['build', 'test', 'run', 'vet', 'mod', 'get'],
  docker: ['build', 'run', 'compose', 'push', 'pull', 'exec'],
  gh: ['pr', 'issue', 'api', 'run', 'repo', 'stack'],
  pip: ['install', 'uninstall'],
  pip3: ['install', 'uninstall'],
  uv: ['run', 'add', 'sync', 'pip'],
  poetry: ['install', 'add', 'run'],
  swift: ['build', 'test', 'run'],
  pod: ['install', 'update'],
  expo: ['start', 'run', 'prebuild', 'install'],
}

// How the engine reports a call that was stopped rather than one that failed.
const ABORTED =
  /Command was aborted before completion|\[Request interrupted|Interrupted by user|\[Tool call (did not complete|interrupted|skipped|not completed)/i

// The Edit/Write tools fold CRLF to LF in their records; compare files the same way.
const lf = (text: string) => text.replace(/\r\n/g, '\n')

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// A short, safe description: the program and its subcommand, or the tool and
// a file name or host. Never an argument value, URL path, query or search text.
export function safeLabel(e: Call): string {
  if (e.tool === 'Bash') {
    const words = String(e.command ?? '').trim().split(/\s+/)
    const program = basename(words[0] ?? '')
    const sub = words[1] ?? ''
    const head = /^[A-Za-z0-9._-]{1,30}$/.test(program) ? program : 'command'
    // A subcommand only for tools whose second word is a verb, never a value.
    const showSub = (VERBS[head] ?? []).includes(sub)
    return showSub ? `${head} ${sub}${words.length > 2 ? ' …' : ''}` : `${head}${words.length > 1 ? ' …' : ''}`
  }
  const path = e.file_path ?? e.notebook_path
  if (typeof path === 'string') return `${e.tool} ${basename(path)}`
  if (typeof e.url === 'string') {
    try {
      return `${e.tool} ${new URL(e.url).hostname}`
    } catch {
      return String(e.tool)
    }
  }
  return String(e.tool)
}

const errorText = (ran: { text?: string; result?: unknown }) =>
  typeof ran.text === 'string' && ran.text !== '' ? ran.text : stable(ran.result ?? null)

const isPerson = (origin: { kind: string; asUser?: true }) =>
  PERSON.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

// The file text an Edit produces from `text`, as the Edit tool applies it.
function applyEdit(text: string, e: Call): string | null {
  const from = String(e.old_string)
  const to = String(e.new_string)
  if (from === '' || !text.includes(from)) return null
  return e.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to)
}

// The file's text before and after a successful Edit or Write, when the result says.
function versions(e: Call, result: Record<string, unknown>): { before: string; after: string } | null {
  if (typeof result.originalFile !== 'string') return null
  const before = lf(result.originalFile)
  if (e.tool === 'Write') return { before, after: lf(typeof result.content === 'string' ? result.content : String(e.content)) }
  if (e.tool === 'Edit') {
    // The person changed the proposal: the bytes on disk are not ours to predict.
    if (result.userModified === true) return null
    const after = applyEdit(before, e)
    return after === null ? null : { before, after }
  }
  return null
}

// Paths a call changed on disk; null when it changed nothing or cannot be told.
// An empty list means files changed but the host could not say which.
function changedPaths(e: Call, result: Record<string, unknown>, failed: boolean): string[] | null {
  if (e.tool === 'Bash') {
    const diff = result.bashEditDiff as
      | { files?: { filePath: string }[]; changedFiles?: string[]; unavailable?: true; skipped?: true }
      | undefined
    if (diff === undefined) return null
    const paths = [...(diff.files ?? []).map(f => f.filePath), ...(diff.changedFiles ?? [])]
    if (paths.length > 0) return [...new Set(paths)]
    // Skipped for checkout/stash/reset/restore, which rewrite the tree; "unavailable" proves nothing.
    return diff.skipped === true ? [] : null
  }
  // An errored call's result is its error text: no record says anything changed.
  if (failed) return null
  if (e.tool === 'Edit' || e.tool === 'Write') {
    if (result.staged === true) return null
    const v = versions(e, result)
    if (v !== null && v.before === v.after) return null
    return [String(e.file_path)]
  }
  if (e.tool === 'NotebookEdit') {
    if (typeof result.error === 'string' && result.error !== '') return null
    if (typeof result.original_file === 'string' && result.original_file === result.updated_file) return null
    return [String(e.notebook_path)]
  }
  return null
}

// Writes the meter. A newer show may run while this set is in flight; whichever
// finishes last writes the latest value again, so the band ends on the truth.
async function show($: EngineInterface, next: Stuck | null) {
  shown = next
  await $.state.set(stuckRef, next)
  if (shown !== next) await $.state.set(stuckRef, shown)
}

// Whether the meter's claim still holds against the history.
function stillStuck(cur: Stuck | null): Stuck | null {
  if (cur === null) return null
  const loop = loops.get(cur.agent)
  if (loop === undefined) return null
  if (cur.kind === 'repeat') return (loop.streaks.get(cur.fp)?.count ?? 0) >= MAX_FAILS ? cur : null
  return (loop.chains.get(cur.fp)?.length ?? 0) >= MAX_CHAIN ? cur : null
}

async function reset($: EngineInterface) {
  gen += 1
  loops.clear()
  await show($, null)
}

// Would this call put the file back to its version before the last change, again?
async function undoesAgain($: EngineInterface, e: Call, chain: Chain | undefined): Promise<boolean> {
  if (chain === undefined || chain.length < MAX_CHAIN) return false
  if (e.tool !== 'Edit' && e.tool !== 'Write') return false
  let current: string
  try {
    current = lf(await $.fs.read(String(e.file_path)))
  } catch {
    return false
  }
  // Someone else changed the file since: the chain no longer describes it.
  if ((await hash(current)) !== chain.to) return false
  const after = e.tool === 'Write' ? lf(String(e.content)) : applyEdit(current, e)
  return after !== null && (await hash(after)) === chain.from
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload starts the history over; a meter left in state no longer applies.
    await $.state.set(stuckRef, null)
    await $.command.register({
      name: 'unstick',
      description: 'Loop Breaker: forget recorded failures and let blocked calls run again',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'unstick' }, async $ => {
    await reset($)
    return { text: 'Loop Breaker: history cleared. Blocked calls may run again.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isPerson(e.origin)) await reset($)
    return next(e)
  })

  // /clear and resume end the conversation without reloading the module.
  on('session.end', async ($, e, next) => {
    gen += 1
    loops.clear()
    shown = null
    try {
      await $.state.set(stuckRef, null)
    } catch {
      // The session is going away; the module state above is what matters.
    }
    return next(e)
  })

  // A subagent that finished cannot loop any more: drop its history and meter.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      loops.delete(e.agentId)
      await show($, stillStuck(shown))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as Call
    const agent = e.agentId ?? 'main'
    const fp = await hash(identity(call))
    const startedIn = gen
    const codeAtStart = codeGen
    const mine = loopOf(agent)
    const file = typeof call.file_path === 'string' ? call.file_path : null

    // Rule 1: the same call keeps failing with the same error.
    const streak = mine.streaks.get(fp)
    if (streak !== undefined && streak.count >= MAX_FAILS) {
      blockedCount += 1
      void $.state.set(blockedRef, blockedCount)
      await show($, { agent, fp, file: '', label: streak.label, count: streak.count, kind: 'repeat' })
      return {
        deny:
          `Loop Breaker: this exact call has failed ${streak.count} times in a row with the same error, ` +
          `and nothing has changed since (${streak.label}). Running it unchanged will fail the same way. ` +
          `Make a change that addresses the error first (edit code, fix config, install what is ` +
          `missing), then rerun it; or ask the user. The user can run /unstick.`,
      }
    }

    // Rule 2: a change that puts the whole file back to the version before the last one, again.
    if (file !== null) {
      const chain = mine.chains.get(file)
      const again = await undoesAgain($, call, chain)
      // A reset or another change while the file was read: the chain is not current.
      if (again && gen === startedIn && mine.chains.get(file) === chain) {
        blockedCount += 1
        void $.state.set(blockedRef, blockedCount)
        await show($, { agent, fp: file, file, label: `${call.tool} ${basename(file)}`, count: chain?.length ?? 0, kind: 'revert' })
        return {
          deny:
            `Loop Breaker: this ${call.tool} puts ${file} back to the version it had before the last ` +
            `change, and the file has flipped between those two versions ${chain?.length ?? 0} times in a ` +
            `row. You are oscillating. Decide which is right from evidence (run the test, read the ` +
            `error), say why, then make one different change, or ask the user. The user can run /unstick.`,
        }
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    // A reset landed while the tool ran: this call belongs to the old history.
    if (gen !== startedIn) return ran

    const result = (ran.result !== null && typeof ran.result === 'object' ? ran.result : {}) as Record<string, unknown>
    const failed = ran.isError === true || (call.tool === 'NotebookEdit' && typeof result.error === 'string' && result.error !== '')
    // Interrupted or moved to the background: no verdict on whether it works,
    // though what it already wrote still counts.
    const undecided =
      result.interrupted === true ||
      typeof result.backgroundTaskId === 'string' ||
      (failed && ABORTED.test(errorText(ran)))

    // Changes on disk count whether or not the call then failed (when the record says).
    const changed = changedPaths(call, result, failed)
    const swap = !failed && changed !== null && file !== null ? versions(call, result) : null
    const from = swap !== null ? await hash(swap.before) : ''
    const to = swap !== null ? await hash(swap.after) : ''
    const error = failed ? await hash(normalizeError(errorText(ran))) : ''
    if (gen !== startedIn) return ran

    if (changed !== null) {
      codeGen += 1
      // The code changed: every agent's failures may now go differently, and
      // those files' chains no longer describe them (except the one this call extends).
      for (const loop of loops.values()) {
        loop.streaks.clear()
        for (const key of [...loop.chains.keys()]) {
          const ours = loop === mine && key === file && swap !== null
          if (!ours && (changed.length === 0 || changed.some(p => key === p))) loop.chains.delete(key)
        }
      }
    }

    if (undecided) {
      // No verdict either way.
    } else if (failed) {
      // A failure of code that has since changed says nothing about the code now.
      if (codeGen === codeAtStart || changed !== null) {
        const was = mine.streaks.get(fp)
        const count = was !== undefined && was.error === error ? was.count + 1 : 1
        mine.streaks.set(fp, { label: safeLabel(call), count, error })
      }
    } else {
      mine.streaks.delete(fp)
    }

    if (file !== null && changed !== null) {
      if (swap === null) {
        // The result does not say what the whole file was (too large, or a notebook).
        mine.chains.delete(file)
      } else {
        const was = mine.chains.get(file)
        const undoes = was !== undefined && was.from === to && was.to === from
        mine.chains.set(file, { from, to, length: undoes ? was.length + 1 : 1 })
      }
    }

    // The meter: show the streak one failure before anything is refused; clear it once it ends.
    const now = mine.streaks.get(fp)
    if (now !== undefined && now.count >= MAX_FAILS) {
      await show($, { agent, fp, file: '', label: now.label, count: now.count, kind: 'repeat' })
    } else {
      await show($, stillStuck(shown))
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, stuck)
    // The band is one site: draw ours above whatever the plugins beneath draw.
    const below = await next(e)
    if (now === null || e.props.hasSurvey || stillStuck(now) === null) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const what = now.kind === 'repeat' ? `failed ${now.count}× in a row` : `flipped ${now.count}×`
    const who = now.agent === 'main' ? '' : ' (subagent)'
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">⟳ stuck{who}: </Text>
          <Text wrap="truncate-end">{now.label} </Text>
          <Text dimColor>{what} </Text>
          <Button key="unstick" label="unstick" onPress={() => reset($)} />
        </Box>
        {below}
      </Box>
    )
  })
}
