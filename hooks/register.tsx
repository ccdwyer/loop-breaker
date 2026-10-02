import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chain, LoopState, Streak, Stuck } from '../types'

const loops = atom({ plugin: 'loop-breaker', key: 'loops' } as const, {})
const stuck = atom({ plugin: 'loop-breaker', key: 'stuck' } as const, null)
const gen = atom({ plugin: 'loop-breaker', key: 'gen' } as const, 0)
const blocked = atom({ plugin: 'loop-breaker', key: 'blocked' } as const, 0)

// Identical failures (same call, same error) allowed before the next try is refused.
const MAX_FAILS = 2
// Edits in a row on one file that each undo the one before; the next undo is refused.
const MAX_CHAIN = 3
// Prompts that are a person's own words, so new direction.
const PERSON = ['composer', 'bridge', 'sdk', 'channel', 'slack-ping']
// Arguments that describe a call without changing what it does.
const COSMETIC = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'description'])
const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit'])

const EMPTY: LoopState = { streaks: {}, chains: {} }

const short = (text: string, room = 60) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > room ? `${line.slice(0, room - 1)}…` : line
}

async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

type Call = { tool: string; [k: string]: unknown }

// Every argument that changes behaviour, key order fixed. Bash commands are kept
// exactly: whitespace inside quotes and heredocs matters.
function identity(e: Call): string {
  const args = Object.keys(e)
    .filter(k => !COSMETIC.has(k))
    .sort()
    .map(k => [k, e[k]])
  return `${e.tool}:${JSON.stringify(args)}`
}

function label(e: Call): string {
  if (e.tool === 'Bash') return String(e.command ?? '').trim()
  const target = e.file_path ?? e.notebook_path ?? e.pattern ?? e.url ?? e.query ?? e.prompt ?? ''
  return `${e.tool} ${String(target)}`.trim()
}

const isPerson = (kind: string) => PERSON.includes(kind)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    if (isPerson(e.origin.kind)) await reset($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as Call
    const agent = e.agentId ?? 'main'
    const fp = await hash(identity(call))
    const startedIn = await read($, gen)
    const mine = (await read($, loops))[agent] ?? EMPTY

    // Rule 1: the same call keeps failing with the same error.
    const streak = mine.streaks[fp]
    if (streak !== undefined && streak.count >= MAX_FAILS) {
      await update($, blocked, n => n + 1)
      await update($, stuck, (): Stuck => ({ agent, fp, label: streak.label, count: streak.count, kind: 'repeat' }))
      return {
        deny:
          `Loop Breaker: this exact call has failed ${streak.count} times in a row with the same error, ` +
          `and nothing has changed since (${short(streak.label, 120)}). Running it unchanged will fail ` +
          `the same way. Make a change that addresses the error first (edit code, fix config, ` +
          `install what is missing), then rerun it; or ask the user. The user can run /unstick.`,
      }
    }

    // Rule 2: an Edit that undoes the edit just before it on the same file, again.
    let edit: { file: string; from: string; to: string } | null = null
    if (e.tool === 'Edit') {
      const file = String(e.file_path)
      const flag = e.replace_all === true ? 'all' : 'one'
      edit = { file, from: await hash(`${flag}:${e.old_string}`), to: await hash(`${flag}:${e.new_string}`) }
      const chain = mine.chains[file]
      const undoes = chain !== undefined && chain.from === edit.to && chain.to === edit.from
      if (undoes && chain.length >= MAX_CHAIN) {
        await update($, blocked, n => n + 1)
        await update($, stuck, (): Stuck => ({ agent, fp, label: `Edit ${file}`, count: chain.length, kind: 'revert' }))
        return {
          deny:
            `Loop Breaker: this Edit undoes the previous edit to ${file}, which has flipped back and ` +
            `forth ${chain.length} times in a row. You are oscillating between two versions. Decide ` +
            `which is right from evidence (run the test, read the error), say why, then make one ` +
            `different change, or ask the user. The user can run /unstick.`,
        }
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    // A reset landed while the tool ran: this call belongs to the old history.
    if ((await read($, gen)) !== startedIn) return ran

    const failed = ran.isError === true
    const staged = !failed && (ran.result as { staged?: boolean } | undefined)?.staged === true
    const error = failed ? await hash(String(ran.text ?? ran.result ?? '')) : ''
    const changedFiles = MUTATING.has(e.tool) && !failed && !staged

    const after = await update($, loops, all => {
      const prev = all[agent] ?? EMPTY
      // A successful change to the code is progress: every failure streak starts over.
      const streaks: Record<string, Streak> = changedFiles ? {} : { ...prev.streaks }
      if (failed) {
        const was = streaks[fp]
        const count = was !== undefined && was.error === error ? was.count + 1 : 1
        streaks[fp] = { label: short(label(call), 200), count, error }
      } else {
        delete streaks[fp]
      }

      const chains: Record<string, Chain> = { ...prev.chains }
      if (edit !== null && changedFiles) {
        const was = chains[edit.file]
        const undoes = was !== undefined && was.from === edit.to && was.to === edit.from
        chains[edit.file] = { from: edit.from, to: edit.to, length: undoes ? was.length + 1 : 1 }
      } else if (changedFiles) {
        const file = String(call.file_path ?? call.notebook_path ?? '')
        delete chains[file]
      }
      return { ...all, [agent]: { streaks, chains } }
    })

    // The meter: show the streak one failure before anything is refused; clear it once it ends.
    const now = after[agent]?.streaks[fp]
    await update($, stuck, (cur): Stuck | null => {
      if (now !== undefined && now.count >= MAX_FAILS) {
        return { agent, fp, label: now.label, count: now.count, kind: 'repeat' }
      }
      if (cur === null || cur.agent !== agent) return cur
      if (cur.kind === 'repeat' && after[agent]?.streaks[cur.fp] === undefined) return null
      if (cur.kind === 'revert' && edit !== null && cur.label === `Edit ${edit.file}`) {
        const chain = after[agent]?.chains[edit.file]
        if (chain === undefined || chain.length < MAX_CHAIN) return null
      }
      return cur
    })
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, stuck)
    if (now === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const what = now.kind === 'repeat' ? `failed ${now.count}× in a row` : `flipped ${now.count}×`
    const who = now.agent === 'main' ? '' : ' (subagent)'
    const room = Math.max(20, (e.props.bodyColumns ?? 80) - 45)
    return (
      <Box>
        <Text color="yellow">⟳ stuck{who}: </Text>
        <Text>{short(now.label, room)} </Text>
        <Text dimColor>{what} </Text>
        <Button key="unstick" label="unstick" onPress={() => reset($)} />
      </Box>
    )
  })
}

async function reset($: EngineInterface) {
  await update($, gen, n => n + 1)
  await update($, loops, () => ({}))
  await update($, stuck, () => null)
}
