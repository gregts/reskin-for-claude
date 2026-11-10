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
  // The tick run that drew this card: an older run's late write never lands on it.
  run?: number
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
  // true when an opener (the band's, or another band mod's) opened it: with the band off it then draws in the hosted
  // layout (actions in the bar's narrow columns, ✕ last); typed /skin fonts keeps the 1.7.2 look.
  fromButton?: boolean
  // The opening number this row was installed with (band, 5 Nov 2026): every later write checks it, so a late write
  // never lands on a newer fonts row.
  openId?: number
}

// The appearance band's state (5 Nov 2026), kept here so this contract is self-contained.
export type Claim = 'on' | 'off' | 'unknown'
export type Proof = { helper: string; skin: string; sidebar: Claim; mode: 'dark' | 'light' | 'unknown'; accent: string | null }
export type BandRow = 'skins' | 'sidebar'
export type Band = {
  on: boolean
  row: BandRow | null
  rowId: number
  helper: string
  drafts: { skin: string; sidebar: 'on' | 'off' }
  touched: boolean
  busy: boolean
  // The proof read the open row waits for (0: none): the row says "Checking…" until a read at least this new answers.
  checking: number
  status: string
  proof: Proof | null
  proofId: number
  gen: number
  // Option C (the owner's pick, 5 Nov 2026): after an Apply on the Skins row that the next read proves, the row
  // says "✓ Now on: <skin>" with six colour chips, so a switch between two near-white skins still shows what changed.
  // Cleared by any new pick, opening or action.
  now: NowOn | null
}
export type NowOn = { skin: string; light: readonly string[]; dark: readonly string[] } // three #rrggbb each, from chipsOf

declare module 'claude-code' {
  interface PluginState {
    skin: { card: TickCard | null; fontsCard: FontsCard | null; band: Band }
  }
}
