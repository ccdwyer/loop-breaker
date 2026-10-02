// What the band above the prompt shows. The loop history itself lives in the
// module (one environment, so parallel tool calls never race on a snapshot).
export type Stuck = { agent: string; fp: string; file: string; label: string; count: number; kind: 'repeat' | 'revert' }

declare module 'claude-code' {
  interface PluginState {
    'loop-breaker': {
      stuck: Stuck | null
      blocked: number
    }
  }
}
