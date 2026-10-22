// Pure helpers for /skin: no engine calls, so they can be tested alone.

import { hiddenInfo } from './log'

// Letters, digits and single hyphens only: no slash, no dots, no spaces.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MIN_NODE_MAJOR = 22

// How a skin is applied: `auto` switches through the colour helper when one is running in this Claude, and otherwise asks
// for one tick ("I tick it"); `tick` always asks for a new tick; `one-click` lets the run tick the menu itself.
export type Via = 'auto' | 'tick' | 'one-click'
export type Parsed =
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'check' }
  | { kind: 'about' }
  | { kind: 'log' }
  | { kind: 'off'; via: Via }
  | { kind: 'remove'; via: Via }
  | { kind: 'apply'; name: string; via: Via }
  | { kind: 'bad'; why: string }

// `oneClick` false (a tick-only release): the error texts offer --tick only.
export function parse(args: string, oneClick = true): Parsed {
  const words = args.trim().toLowerCase().split(/\s+/).filter(w => w !== '')
  const flags = words.filter(w => w.startsWith('--'))
  const rest = words.filter(w => !w.startsWith('--'))
  const unknown = flags.find(f => f !== '--tick' && f !== '--one-click')
  if (unknown) return { kind: 'bad', why: `Unknown option ${unknown}. Use --tick${oneClick ? ' or --one-click' : ''}.` }
  if (flags.includes('--tick') && flags.includes('--one-click')) return { kind: 'bad', why: oneClick ? 'Choose one: --tick or --one-click.' : '--one-click is not in this release. Use --tick.' }
  const via: Via = flags.includes('--tick') ? 'tick' : flags.includes('--one-click') ? 'one-click' : 'auto'
  if (rest.length > 1) return { kind: 'bad', why: 'One skin name at a time, for example /skin dracula.' }
  const word = rest[0] ?? ''
  if (word === '' || word === 'list') return flags.length ? { kind: 'bad', why: 'Options go with a skin name, off or remove.' } : { kind: 'list' }
  if (word === 'status') return flags.length ? { kind: 'bad', why: 'status takes no options.' } : { kind: 'status' }
  if (word === 'check') return flags.length ? { kind: 'bad', why: 'check takes no options.' } : { kind: 'check' }
  if (word === 'about') return flags.length ? { kind: 'bad', why: 'about takes no options.' } : { kind: 'about' }
  if (word === 'log') return flags.length ? { kind: 'bad', why: 'log takes no options.' } : { kind: 'log' }
  if (word === 'off') return { kind: 'off', via }
  if (word === 'remove') return { kind: 'remove', via }
  if (!NAME.test(word)) return { kind: 'bad', why: 'A skin name has only letters, digits and hyphens, for example dracula or catppuccin-latte.' }
  return { kind: 'apply', name: word, via }
}

// The tool folder: the `toolDir` option first, then beside the mod (the one-repo layout), then one level up.
export function toolDirCandidates(option: string | undefined, root: string): string[] {
  const up = root.replace(/\/[^/]+\/?$/, '')
  return [...(option ? [option.replace(/\/+$/, '')] : []), `${root}/skin-tool`, `${up}/skin-tool`]
}
// Node: the `node` option first, then the usual install places, then whatever PATH finds.
export function nodeCandidates(option: string | undefined): string[][] {
  return [...(option ? [[option]] : []), ['/opt/homebrew/bin/node'], ['/usr/local/bin/node'], ['/usr/bin/env', 'node']]
}
export function nodeMajorOk(versionText: string): boolean {
  const m = /^v(\d+)\./.exec(versionText.trim())
  return m !== null && Number(m[1]) >= MIN_NODE_MAJOR
}

export type Preset = { name: string; mode: 'auto' | 'dark' | 'light' | 'unknown' }

// CSS comments removed in one linear pass (an unclosed "/*" ends the text).
export function stripComments(css: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const s = css.indexOf('/*', i)
    if (s === -1) return out + css.slice(i)
    out += `${css.slice(i, s)} `
    const e = css.indexOf('*/', s + 2)
    if (e === -1) return out
    i = e + 2
  }
}

// A pair holds one dark and one light block: Claude shows whichever matches its own Appearance.
// The tool refuses colour-scheme queries inside a block, so counting them (outside comments) gives the mode.
export function modeOf(css: string): Preset['mode'] {
  const found = [...stripComments(css).matchAll(/prefers-color-scheme\s*:\s*(dark|light)/gi)].map(m => m[1]!.toLowerCase())
  if (found.length === 2 && found[0] !== found[1]) return 'auto'
  if (found.length === 1) return found[0] as 'dark' | 'light'
  return 'unknown'
}

// First-time step (A1): the Developer menu only exists once Developer Mode is on. Same words everywhere.
export const DEV_MODE = 'First time only: in Claude choose Help › Troubleshooting › Enable Developer Mode (Claude restarts); the Developer menu then appears.'

export function listText(presets: readonly Preset[], macMode: 'dark' | 'light' | 'unknown'): string {
  const names = (mode: Preset['mode']) => presets.filter(p => p.mode === mode).map(p => p.name).join(', ') || 'none'
  // Since 17 Oct 2026 every shipped skin has both halves; the one-mode lines show only when such a file is present.
  const some = (mode: Preset['mode']) => presets.some(p => p.mode === mode)
  return [
    `Light and dark (follow Claude's Appearance): ${names('auto')}`,
    ...(some('dark') ? [`Dark only: ${names('dark')}`] : []),
    ...(some('light') ? [`Light only: ${names('light')}`] : []),
    ...(some('unknown') ? [`Other (mode not recognised): ${names('unknown')}`] : []),
    `${macMode === 'unknown' ? 'I could not read your Mac\'s appearance' : `Your Mac is in ${macMode} mode`}. Claude follows the Mac only when Settings > Appearance is System${some('dark') || some('light') ? '; a dark-only or light-only skin shows only while Claude looks that way' : ''}.`,
    '/skin <name> applies one: the first needs one tick of Developer > Enable Main Process Debugger, later switches need none until Claude quits. /skin off, /skin remove, /skin status, /skin check.',
    DEV_MODE,
  ].join('\n')
}

// The report lines every run prints (sampled colour checks, debugger, helper), and the few other lines worth showing.
const KEEP = [/^sampled colour checks:/, /^debugger:/, /^helper:/, /^switch unconfirmed/, /^If the colours did not change/, /^Reapply /, /^requests:/, /^last skin:/, /^To apply /]
const keep = (lines: string[]) => lines.filter(l => KEEP.some(re => re.test(l)))

// Turns the script's output into a short plain answer. The script ends with two machine-readable lines
// (PORT_STATE and RESULT); WARNING and NOTE lines are never hidden, whatever the exit code.
export function summary(name: string, exitCode: number, stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split('\n').map(l => l.trim().replace(/^\[\d+(?:\.\d+)?s\] /, '')).filter(l => l !== '')
  const find = (prefix: string) => lines.find(l => l.startsWith(prefix))
  const warnings = lines.filter(l => l.includes('WARNING:'))
  const note = find('NOTE:')
  const portState = find('PORT_STATE:')?.slice('PORT_STATE:'.length).trim()
  const result = find('RESULT:')?.slice('RESULT:'.length).trim()
  const portLine = portState !== undefined && portState !== 'closed' && result !== 'refused'
    ? `PORT 9229 IS NOT CONFIRMED CLOSED (${portState}). Quit and reopen Claude, or untick Developer > Enable Main Process Debugger.`
    : undefined
  const report = keep(lines)
  // The helper's own answers (switch, status) carry their headline as the first plain line.
  const headline = lines.find(l => /^(Skin |helper: none \(already clean\)|No colour helper|The helper could not|Removal not confirmed)/.test(l))
  if (exitCode === 0 && result !== 'failed') {
    // A skin with no half for the mode Claude is showing is applied but invisible: say so first, and how to see it.
    const hidden = name === 'off' ? null : hiddenInfo(lines.join('\n'))
    const head = hidden ? hiddenHead(name, hidden) : headline ?? (name === 'off' ? 'Skin removed.' : `Skin ${name} applied.`)
    // The head already says how to see it: the note and the checks line that say it again are left out.
    const shownNote = hidden && note !== undefined && /will not see it/.test(note) ? undefined : note
    const shownReport = hidden ? report.filter(l => !/is not showing now/.test(l)) : report
    return [head, shownNote, ...shownReport.filter(l => l !== head), ...warnings, portLine].filter(Boolean).join('\n')
  }
  // The click wait ran out with nothing applied: one short line. A port not confirmed closed still shows.
  if (lines.some(l => /^WARNING: Time is up\b/.test(l)) && lines.some(l => /^helper: unchanged/.test(l))) {
    return [TIME_UP, portLine].filter(Boolean).join('\n')
  }
  const noise = (l: string) => l.startsWith('RESULT:') || l.startsWith('PORT_STATE:') || l.startsWith('[') || l.startsWith('{') || l.startsWith('}') || l.startsWith('"') ||
    l.startsWith('SAMPLES:') || l.startsWith('HELPER:') || l === 'READY_TO_TICK' || l === 'DISCLOSED' || KEEP.some(re => re.test(l))
  const detail = lines.filter(l => !noise(l) && !l.includes('WARNING:')).slice(-4).join('\n')
  const head = result === 'refused' || exitCode === 5 ? 'Not started.' : `The skin step failed (exit ${exitCode}).`
  return [head, detail, ...report, ...warnings, portLine].filter(Boolean).join('\n')
}

// 15 Oct: "not showing now" must say plainly how to see the skin.
export function hiddenHead(name: string, h: { claude: 'dark' | 'light'; needs: 'dark' | 'light' }): string {
  const Needs = h.needs === 'dark' ? 'Dark' : 'Light'
  return `Skin ${name} is on, but you cannot see it yet: it only has a ${h.needs} version and Claude is showing ${h.claude}. ` +
    `To see it, open Claude's Settings and set Appearance to ${Needs}, or pick a light-and-dark skin (see /skin list), which follows Claude.`
}

export const TIME_UP = 'Time is up and nothing was applied. Do not click the menu item now; if you already did, quit and reopen Claude. No Developer menu? Turn on Help › Troubleshooting › Enable Developer Mode first (Claude restarts). To try again, run the same command.'

// Did a switch find no helper (so the skin needs a tick)?
export const noHelper = (stdout: string) => /No colour helper is running/.test(stdout)

// The tick card's facts, read from the tool's own disclosure (the tool knows, before the click, what Claude will show:
// a tab in the running Chrome, Chrome starting, or its "Inspector session is active" message where there is no Chrome).
export type Where = 'chrome-running' | 'chrome-starts' | 'message'
export function cardFacts(disclosure: string): { where: Where; helper: boolean } {
  return {
    where: /Inspector session is active/.test(disclosure) ? 'message'
      : /Chrome will open with|may start your Chrome/.test(disclosure) ? 'chrome-starts' : 'chrome-running',
    helper: /colour helper stays inside Claude/.test(disclosure),
  }
}

// The card's text (15 Oct 2026, v4): one signed-off paragraph that runs the full width of the card (no columns). The
// risk facts live in /skin about. The menu path is the one bold part, in the same grey as the rest.
export const CARD = {
  menu: 'Developer › Enable Main Process Debugger',
  about: 'How it works: /skin about',
  nudge: 'Still waiting for the click.',
  timeUp: 'Ran out? Type /skin again.',
  // A1: shown under the paragraph while waiting for the click.
  devMode: 'No Developer menu? Turn on Help › Troubleshooting › Enable Developer Mode first (Claude restarts).',
  applying: 'Got it. Painting now. Undo any time with /skin off.',
  // After the click, when the colour helper will stay.
  applyingHelper: 'Painting now. Later skins need no click until Claude quits.',
} as const

// The paragraph: [before the menu path, after it]. `skin` is the run's preset, or "remove" for a tick that takes the
// skin away.
export function cardParagraph(card: { skin: string; where: Where }): [string, string] {
  const removing = card.skin === 'remove' || card.skin === 'off'
  const before = removing ? 'To remove the skin, click ' : 'To enable the skin, click '
  const done = removing ? 'the skin will be removed' : 'the skin will be applied automatically'
  const what = card.where === 'message'
    ? ` in the top menu bar. Claude will show a message saying Inspector session is active. Click OK, and ${done} within a second or two. Reskin turns the debugger off again as soon as that message is closed`
    : ` in the top menu bar. ${card.where === 'chrome-starts' ? 'Chrome will start with an inspect tab' : 'A Chrome inspect tab will open'} and ${done} within a second or two. You can then safely close that tab. Reskin turns the debugger off again almost instantly`
  const end = removing ? '.' : ', and skins stay on until Claude quits or you type /skin remove.'
  return [before, `${what}${end}`]
}

// The countdown ring beside the title: a circle that empties as the seconds run out, with the seconds inside, drawn
// like usage-line's rings. Colours follow the app's light or dark look; the last 5 s turn the accent colour.
export const RING_SIZE = 26
export function countdownSvg(left: number, total: number): { source: string; alt: string } {
  const r = 10.5
  const c = 2 * Math.PI * r
  const mid = RING_SIZE / 2
  const shown = Math.max(0, Math.min(total, Math.round(left)))
  const filled = total > 0 ? (c * shown) / total : 0
  const late = shown <= 5
  const style = `text{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:11px;font-weight:600}` +
    `.n{fill:${late ? '#d97757' : '#1f2328'}}@media (prefers-color-scheme:dark){.n{fill:${late ? '#d97757' : '#e6e8eb'}}}`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${RING_SIZE}" height="${RING_SIZE}" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}"><style>${style}</style>` +
    `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="#8a8f98" stroke-opacity=".28" stroke-width="2.5"/>` +
    (shown > 0 ? `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="#d97757" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>` : '') +
    `<text class="n" x="${mid}" y="${mid + 4}" text-anchor="middle">${shown}</text></svg>`
  return { source, alt: `${shown} seconds left to click` }
}

// "tokyo-night-auto" -> "Tokyo Night Auto" for the card's title.
export const displayName = (skin: string) => skin.split('-').filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')

// /skin about: how it works, in short lines (the chat shows it as plain text). The risk facts the card leaves out live
// here; the open time quoted after the short-door build is measured.
export const ABOUT = [
  'Reskin: how it works',
  '',
  'Claude has no setting to recolour the whole app, and mods only reach the chat area.',
  'Claude\'s own menu item, Developer › Enable Main Process Debugger, is the one built-in way in.',
  DEV_MODE,
  '',
  'When you click it:',
  '  • Reskin paints the skin and leaves a small colour helper inside Claude.',
  '  • Reskin turns the debugger off by itself, usually within a second.',
  '  • Until then, other apps on this Mac could also reach Claude. Nothing from the internet can.',
  '  • On a Mac without Chrome, Claude shows a message and the debugger stays on until it is closed with OK.',
  '  • If Reskin stops part-way, a timer inside Claude closes it within 22 seconds once that timer is set; before that, backup helpers try to close it for several minutes, but only once Reskin has seen it open. If in doubt, quit and reopen Claude: that always closes it.',
  '',
  'Every run ends with "debugger: confirmed closed", or a clear warning if that could not be confirmed.',
  '',
  'Reskin sends nothing online and changes no Claude files.',
  'Skins switch with no click until Claude quits. Undo with /skin off, or quit Claude.',
  '',
  'Every /skin run is saved for troubleshooting in ~/Library/Logs/Reskin/skin.log (known secret formats removed). /skin log shows the last few.',
  '',
  'Reskin is open source: https://github.com/gregts/reskin-for-claude',
].join('\n')

// Typeahead for /skin. The word at the cursor is completed when it
// is the skin word or a --flag. Names that start with what was typed come first, then names that merely contain it.
// Every row is checked by parse() on the whole draft as it would read after taking it, so nothing refused is offered.
export const VERBS = ['off', 'remove', 'status', 'check', 'list', 'log', 'about'] as const
const FLAGS = ['--tick', '--one-click'] as const
export const MAX_SUGGESTIONS = 12
export type Suggestion = { text: string; description?: string }
export const isSkinName = (name: string) => NAME.test(name)

// The tool's release switch: a release.json present means tick only unless it says "oneClick": true; no file = the
// owner's own copy, which keeps one-click.
export function oneClickOf(releaseJson: string | null): boolean {
  if (releaseJson === null) return true
  try { return JSON.parse(releaseJson)?.oneClick === true } catch { return false }
}
export const argumentHintOf = (oneClick: boolean) => `[name | off | remove | status | check | list | log | about] [--tick${oneClick ? ' | --one-click' : ''}]`

export function skinSuggestions(text: string, start: number, cursor: number, skins: readonly string[], oneClick = true): Suggestion[] {
  const head = /^\s*\/skin\s+/i.exec(text)
  if (head === null || start < head[0].length || cursor < start) return []
  // Mid-word (more letters right after the cursor): taking a row would leave the tail behind, so offer nothing.
  if (/^\S/.test(text.slice(cursor))) return []
  const t = text.slice(start, cursor).toLowerCase()
  if (t === '') return []
  const args = (row: string) => `${text.slice(head[0].length, start)}${row}${text.slice(cursor)}`
  // A flag on its own is fine as long as a name can still follow it.
  const ok = (row: string) => parse(args(row)).kind !== 'bad' || (row.startsWith('--') && parse(`${args(row)} x`).kind !== 'bad')
  const rows: Suggestion[] = t.startsWith('-')
    ? FLAGS.filter(f => oneClick || f !== '--one-click').map(f => ({ text: f }))
    : [...skins.filter(isSkinName).map(s => ({ text: s, description: 'skin' })), ...VERBS.map(v => ({ text: v }))]
  const fits = rows.filter(r => r.text !== t && ok(r.text))
  const starts = fits.filter(r => r.text.startsWith(t))
  const contains = t.startsWith('-') ? [] : fits.filter(r => !r.text.startsWith(t) && r.text.includes(t))
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
}
