// A run of identical failures of one call: same arguments, same error.
export type Streak = { label: string; count: number; error: string }
// The latest run of edits on one file that keep undoing each other.
export type Chain = { from: string; to: string; length: number }
export type LoopState = { streaks: Record<string, Streak>; chains: Record<string, Chain> }
export type Stuck = { agent: string; fp: string; label: string; count: number; kind: 'repeat' | 'revert' }

declare module 'claude-code' {
  interface PluginState {
    'loop-breaker': {
      loops: Record<string, LoopState>
      stuck: Stuck | null
      gen: number
      blocked: number
    }
  }
}
