// The appearance band: pure helpers, no engine calls. Layout C (the owner's pick, 5 Nov 2026; replaces
// the earlier design 2): three plain openers (Skins, Fonts, Sidebar) on Reskin's own quiet line; pressing one opens its
// row underneath, one row at a time, with the dropdown(s), Apply and Reset together at the left, the ✕ at the far
// right and any message right after Reset (on its own wrapping line only when it does not fit). The proof (look show)
// is still read strictly: it sets the open opener's accent, the row's helper state and the dropdown's starting value;
// it is no longer shown in the opener labels.
import { displayName } from './logic'
import type { Band, BandRow, Claim, NowOn, Proof } from '../types'
// The band's state types live in the plugin's types contract (it must be self-contained); re-exported here.
export type { Band, BandRow, Claim, NowOn, Proof }

export const SKINS_OPENER = 'skin-skins-open'
export const FONTS_OPENER = 'skin-fonts-open'
export const SIDEBAR_OPENER = 'skin-sidebar-open'
export const OPENERS = [SKINS_OPENER, FONTS_OPENER, SIDEBAR_OPENER] as const

// Every helper-verb run the mod starts waits up to this long for the tool's run lock (the tool's --lock-wait), so a
// command arriving while an earlier Reskin step is still finishing runs after it instead of being refused at once.
// Above the longest a read can hold the lock (its 13 s deadline plus at most one 4 s check).
export const LOCK_WAIT_MS = 20_000
export const LOCK_WAIT_ARG = `--lock-wait=${LOCK_WAIT_MS}`
// Proof is shown for this long after it was read, then the openers go back to plain words until the next read.
export const PROOF_TTL_MS = 150_000
// Before a tick, the mod waits this long for its own earlier work (a read, a change still finishing) to end.
export const OWN_WORK_WAIT_MS = 25_000
export const STILL_FINISHING = 'The previous Reskin step is still finishing; try again in a moment.'

export const NO_PROOF: Proof = { helper: 'unread', skin: 'unknown', sidebar: 'unknown', mode: 'unknown', accent: null }

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// The band's claims from the tool's last `LOOK: {json}` line. Anything not exactly in the expected form claims nothing.
export function proofOf(stdout: string): Proof {
  const line = stdout.split('\n').filter(l => l.startsWith('LOOK: ')).at(-1)
  if (line === undefined) return NO_PROOF
  let j: unknown
  try { j = JSON.parse(line.slice(6)) } catch { return NO_PROOF }
  if (j === null || typeof j !== 'object') return NO_PROOF
  const o = j as Record<string, unknown>
  const helper = typeof o.helper === 'string' && /^[a-z]{1,12}$/.test(o.helper) ? o.helper : 'unread'
  if (helper !== 'active') return { ...NO_PROOF, helper }
  const skin = typeof o.skin === 'string' && (o.skin === 'off' || (NAME.test(o.skin) && o.skin.length <= 40)) ? o.skin : 'unknown'
  const sidebar: Claim = o.sidebar === 'on' || o.sidebar === 'off' ? o.sidebar : 'unknown'
  const mode = o.mode === 'dark' || o.mode === 'light' ? o.mode : 'unknown'
  // The accent only with a proven skin (not off) and mode, and only as a plain #rrggbb.
  const accent = skin !== 'unknown' && skin !== 'off' && mode !== 'unknown' && typeof o.accent === 'string' && /^#[0-9a-f]{6}$/.test(o.accent) ? o.accent : null
  return { helper, skin, sidebar, mode, accent }
}

export type RowId = 'skins' | 'fonts' | 'sidebar'
// The band's starting state (type Band, in ../types): one row open at most (the fonts row's own data lives in the fonts card atom; `row: 'fonts'` is never
// stored here, the fonts card being open is that). rowId: a new number on every opening, so a late answer for a row
// that was closed or replaced is dropped. gen: a new number whenever the look may change, so a read begun before that
// never shows. touched: the user changed a dropdown in this opening, so a read never overwrites the choice.
export const BAND0: Band = { on: false, row: null, rowId: 0, helper: 'unread', drafts: { skin: 'off', sidebar: 'on' }, touched: false, busy: false, checking: 0, status: '', proof: null, proofId: 0, gen: 0, now: null }

// The six chips: light page, sidebar, accent, then dark page, sidebar, accent, read from the skin's own preset file.
const HEX6 = /^#[0-9a-f]{6}$/
// One half's three colours from its @media block: --cds-surface-1 (page), --cds-surface-0 (sidebar) and
// --cds-role-accent-fill (the accent, as on buttons). Each must be set exactly once in that block as a plain #rrggbb;
// anything else gives null and the line shows no chips (never a guessed colour).
export function chipsOf(css: string): { light: string[]; dark: string[] } | null {
  const half = (mode: 'dark' | 'light'): string[] | null => {
    const at = css.search(new RegExp(`@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*${mode}\\s*\\)`))
    if (at < 0) return null
    const rest = css.slice(at)
    const nextAt = rest.slice(1).search(/@media/)
    const block = nextAt < 0 ? rest : rest.slice(0, nextAt + 1)
    const one = (token: string): string | null => {
      const all = [...block.matchAll(new RegExp(`(?:^|[\\s;{])${token}\\s*:\\s*([^;!}]+?)\\s*(?:!important)?\\s*[;}]`, 'g'))].map(m => m[1]!.trim().toLowerCase())
      return all.length === 1 && HEX6.test(all[0]!) ? all[0]! : null
    }
    const v = [one('--cds-surface-1'), one('--cds-surface-0'), one('--cds-role-accent-fill')]
    return v.every(x => x !== null) ? (v as string[]) : null
  }
  const light = half('light'), dark = half('dark')
  return light && dark ? { light, dark } : null
}

// Opener labels (the owner's pick C, 5 Nov 2026): always the plain words. No state at rest; the open row's
// dropdown shows what is on now.
export const OPENER_LABELS = { skins: 'Skins', fonts: 'Fonts', sidebar: 'Sidebar' } as const
export const skinLabel = (name: string) => (name === 'vs' ? 'VS' : displayName(name))

// Below this many body columns the setup button says "Set up…" instead of "Set up with one tick…".
export const SHORT_SETUP_BELOW = 64

// The skin dropdown: every preset by display name, then Claude's own colours.
export const skinOptions = (names: readonly string[]) => [...names.map(n => ({ value: n, label: skinLabel(n) })), { value: 'off', label: "Claude's own colours" }]
export const SIDEBAR_OPTIONS = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] as const

// What each band button runs: fixed tool arguments, never the /skin command handler (whose auto route can fall back to
// a tick). Apply and Reset go through the colour helper only; the setup button is the only way to a tick, in tick
// mode written out, never one-click.
export type Action = { runner: 'quick'; args: string[] } | { runner: 'tick'; args: string[] } | null
export function actionOf(row: RowId, button: 'apply' | 'reset' | 'setup', drafts: Band['drafts']): Action {
  const skin = NAME.test(drafts.skin) ? drafts.skin : 'off'
  const side = drafts.sidebar === 'off' ? 'off' : 'on'
  if (row === 'skins') {
    if (button === 'apply') return { runner: 'quick', args: ['switch', skin] }
    if (button === 'reset') return { runner: 'quick', args: ['switch', 'off'] }
    return { runner: 'tick', args: ['tick', skin] }
  }
  if (row === 'sidebar') {
    if (button === 'apply') return { runner: 'quick', args: ['type', side] }
    if (button === 'reset') return null
    return { runner: 'tick', args: ['tick', 'off', `--want-type=${side}`] }
  }
  // Fonts: Apply and Reset stay the fonts card's own (look set); setup starts the helper with no skin.
  return button === 'setup' ? { runner: 'tick', args: ['tick', 'off'] } : null
}

// What a row shows for each helper state: only a proven 'none' offers the setup button.
export function rowState(helper: string): { controls: boolean; setup: boolean; text: string } {
  if (helper === 'active') return { controls: true, setup: false, text: '' }
  if (helper === 'none') return { controls: true, setup: true, text: '' }
  if (helper === 'old') return { controls: false, setup: false, text: 'This colour helper is from an older Reskin: quit and reopen Claude, then set up.' }
  if (helper === 'outdated') return { controls: false, setup: false, text: 'Reskin was updated: quit and reopen Claude once.' }
  return { controls: false, setup: false, text: 'Could not reach the colour helper. Try again in a moment.' }
}

// The one-line answer after a band run: the tool's first plain line, cut short (the full answer is in /skin log).
export function bandStatusOf(stdout: string, stderr: string, exitCode: number): string {
  const line = [...stdout.split('\n'), ...stderr.split('\n')].map(l => l.trim()).find(l => l !== '' && !/^(LOOK|PORT_STATE|RESULT|CHILD_READY|PLAN):/.test(l) && !l.startsWith('['))
  const text = line ?? (exitCode === 0 ? 'Done.' : `Did not finish (exit ${exitCode}).`)
  // Shown on its own wrapping line, so only a runaway line is cut.
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}
// The Sidebar row's answer after a good Apply: short, so it stays beside Reset for either choice (the Air look, 6 Nov
// 2026: a long line was cut, and on and off sat in different places). The tool's whole line goes to /skin log.
export const sidebarDone = (side: string): string => `Project headers ${side === 'off' ? 'off' : 'on'}.`
// A band command: on or off.
export function bandWord(args: string): boolean | 'bad' | null {
  const w = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (w[0] !== 'band') return null
  if (w.length === 2 && (w[1] === 'on' || w[1] === 'off')) return w[1] === 'on'
  return 'bad'
}
