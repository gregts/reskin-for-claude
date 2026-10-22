// The tick card above the prompt while a tick run waits for the user's click (null when no run waits).
// where: what Claude shows after the click (a tab in the running Chrome, Chrome starting, or its "Inspector session is
// active" message).
// helper: the run leaves the colour helper inside Claude. nudged: the tool's 10 s "No debugger yet" hint came.
export type TickCard = {
  skin: string
  left: number
  phase: 'wait' | 'applying'
  where: 'chrome-running' | 'chrome-starts' | 'message'
  helper: boolean
  nudged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    skin: { card: TickCard | null }
  }
}
