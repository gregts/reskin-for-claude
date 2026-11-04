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
  // The no-skin tick (4 Nov 2026): this run starts the colour helper with no skin; plan: the parts it also sets, in plain
  // words from the tool's PLAN line ('' when none).
  start?: boolean
  plan?: string
}

// The /skin fonts card (4 Nov 2026): null when closed. look: the part ids the helper proved when last read (null =
// not proven); picks: the dropdown choices per section (not yet applied); status: the last one-line answer.
export type FontPicks = { font: string; size: string; weight: string }
export type FontsCard = {
  helper: string
  look: string[] | null
  section: 'all' | 'chat' | 'rows' | 'headers' | 'ui'
  picks: { all: FontPicks; chat: FontPicks; rows: FontPicks; headers: FontPicks; ui: FontPicks }
  status: string
  busy: boolean
  // true when a band "Fonts" opener opened it: that opener also closes it, so the card draws no ✕ of its own.
  fromButton?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    skin: { card: TickCard | null; fontsCard: FontsCard | null }
  }
}
