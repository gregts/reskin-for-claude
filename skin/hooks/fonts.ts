// The /skin fonts card (font picker, 4 Nov 2026): pure helpers, no engine calls. The tool (skin-tool/skin-lib.mjs
// SECTIONS, FONT_WEIGHTS, describeLook) decides and checks everything; these tables only build the dropdowns, so a
// value missing here is merely not offered, and a value the tool would refuse is refused there.

export const FONT_LABELS: Readonly<Record<string, string>> = {
  'inter-tight': 'Inter Tight', literata: 'Literata', plex: 'IBM Plex Sans', noto: 'Noto Sans', roboto: 'Roboto', lato: 'Lato', 'zen-maru': 'Zen Maru Gothic',
  commissioner: 'Commissioner', jetbrains: 'JetBrains Mono',
}
// Only the weights each family really has (the tool's FONT_WEIGHTS).
export const FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  'inter-tight': [300, 400, 500, 600], literata: [300, 400, 500, 600], plex: [300, 400, 500, 600], noto: [300, 400, 500, 600],
  roboto: [300, 400, 500, 600], lato: [300, 400], 'zen-maru': [300, 400, 500],
  commissioner: [300, 400, 500, 600], jetbrains: [300, 400, 500, 600],
}
export type SectionId = 'all' | 'chat' | 'rows' | 'headers' | 'ui'
export type Section = { id: SectionId; label: string; help: string; sizes: readonly number[]; weights: readonly number[] }
export const SECTIONS: readonly Section[] = [
  // All parts (4 Nov 2026): one font for the whole app at once; every part keeps its size and weight.
  { id: 'all', label: 'All parts', help: 'One font for the whole app. Every part keeps its own size and weight.', sizes: [], weights: [] },
  { id: 'chat', label: 'Chat text', help: 'Replies, your questions and the message box.', sizes: [12, 13, 14, 15, 16], weights: [300, 400, 500] },
  { id: 'rows', label: 'Sidebar rows', help: 'Session names and the other sidebar row text.', sizes: [12, 13, 14, 15], weights: [300, 400, 500] },
  { id: 'headers', label: 'Project headers', help: 'The project names in the sidebar.', sizes: [12, 13, 14, 15, 16], weights: [400, 500, 600] },
  { id: 'ui', label: 'Everything else', help: 'Menus, buttons, settings and the rest (font only).', sizes: [], weights: [] },
]
export const sectionOf = (id: string): Section => SECTIONS.find(s => s.id === id) ?? SECTIONS[0]!
export const WEIGHT_HELP = 'Weight changes the normal text of the section; code and some icons in it may follow. Bold stays bold.'
const WEIGHT_WORDS: Readonly<Record<number, string>> = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold' }

// A section's choices: font is a name, 'same' (as everything else) or 'claude' (ui: Claude's own); size and weight a
// number as text or 'claude'.
export type Picks = { font: string; size: string; weight: string }
export const defaultPicks = (id: SectionId): Picks => ({ font: id === 'ui' || id === 'all' ? 'claude' : 'same', size: 'claude', weight: 'claude' })

// The tool's `LOOK: {json}` line (look show / look set). Only the shape the card needs; anything else is null.
export type LookInfo = { helper: string; look: string[] | null; type: string }
export function lookInfoOf(stdout: string): LookInfo | null {
  const line = stdout.split('\n').filter(l => l.startsWith('LOOK: ')).at(-1)
  if (line === undefined) return null
  let j: unknown
  try { j = JSON.parse(line.slice(6)) } catch { return null }
  if (j === null || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (typeof o.helper !== 'string' || !/^[a-z]{1,12}$/.test(o.helper)) return null
  const look = Array.isArray(o.look) && o.look.length <= 12 && o.look.every(x => typeof x === 'string' && /^(ui|chat|rows|headers)\.(font|size|weight)\.[a-z0-9-]{1,20}$/.test(x)) ? o.look as string[] : null
  return { helper: o.helper, look, type: o.type === 'on' || o.type === 'off' ? o.type : 'unknown' }
}
// The current choices of one section in a look (parts it does not have are Claude's / same).
export function picksOf(look: readonly string[], id: SectionId): Picks {
  // All parts shows the font of everything else (what it sets).
  if (id === 'all') return { ...defaultPicks('all'), font: look.find(p => p.startsWith('ui.font.'))?.split('.')[2] ?? 'claude' }
  const get = (kind: string) => look.find(p => p.startsWith(`${id}.${kind}.`))?.split('.')[2]
  const d = defaultPicks(id)
  return { font: get('font') ?? d.font, size: get('size') ?? d.size, weight: get('weight') ?? d.weight }
}
export const allPicks = (look: readonly string[]): Record<SectionId, Picks> =>
  Object.fromEntries(SECTIONS.map(s => [s.id, picksOf(look, s.id)])) as Record<SectionId, Picks>

export type Option = { value: string; label: string }
export function fontOptions(id: SectionId): Option[] {
  return [id === 'ui' || id === 'all' ? { value: 'claude', label: "Claude's own" } : { value: 'same', label: 'Same as everything else' },
    ...Object.entries(FONT_LABELS).map(([value, label]) => ({ value, label }))]
}
export const sizeOptions = (id: SectionId): Option[] => [{ value: 'claude', label: "Claude's size" }, ...sectionOf(id).sizes.map(z => ({ value: String(z), label: `${z} px` }))]
// The font that section shows with these choices: its own, else everything else's (from the card's ui choice).
export const shownFont = (id: SectionId, font: string, uiFont: string): string | null =>
  font !== 'same' && font !== 'claude' ? font : id !== 'ui' && id !== 'all' && uiFont !== 'claude' ? uiFont : null
export function weightOptions(id: SectionId, font: string, uiFont: string): Option[] {
  const f = shownFont(id, font, uiFont)
  const has = f === null ? null : FONT_WEIGHTS[f] ?? null
  return [{ value: 'claude', label: "Claude's weight" }, ...sectionOf(id).weights.filter(w => has === null || has.includes(w)).map(w => ({ value: String(w), label: `${WEIGHT_WORDS[w] ?? 'Weight'} ${w}` }))]
}
// After a font pick: a weight the new font does not have goes back to Claude's (the card never offers a refused one).
export function withFont(id: SectionId, p: Picks, font: string, uiFont: string): Picks {
  const next = { ...p, font }
  return weightOptions(id, font, uiFont).some(o => o.value === next.weight) ? next : { ...next, weight: 'claude' }
}
// The tool's argv for one section (after `look set`).
export function setArgs(id: SectionId, p: Picks): string[] {
  return ['look', 'set', id, `font=${p.font}`, ...(id === 'ui' || id === 'all' ? [] : [`size=${p.size}`, `weight=${p.weight}`])]
}
// One plain line per section with a Reskin choice (the same words as the tool's describeLook).
export function lookSummary(look: readonly string[]): string[] {
  return SECTIONS.filter(s => s.id !== 'all').flatMap(s => {
    const p = picksOf(look, s.id)
    if (!look.some(x => x.startsWith(`${s.id}.`))) return []
    const font = p.font !== 'same' && p.font !== 'claude' ? FONT_LABELS[p.font] ?? p.font : s.id === 'ui' ? "Claude's font" : 'the same font as everything else'
    return [`${s.label}: ${[font, p.size !== 'claude' ? `${p.size}px` : null, p.weight !== 'claude' ? `${(WEIGHT_WORDS[Number(p.weight)] ?? 'weight').toLowerCase()} ${p.weight}` : null].filter(Boolean).join(', ')}`]
  })
}
// What the card says when it cannot change anything (no helper, an old helper, no answer).
export function noLookText(helper: string): string {
  return helper === 'none' ? 'Fonts need the colour helper inside Claude. Run /skin fonts --tick (one tick, no skin put on), or start with a skin, for example /skin dracula --tick.'
    : helper === 'old' || helper === 'outdated' ? 'The colour helper inside Claude is from an older Reskin. Quit and reopen Claude, apply a skin with one tick (/skin <name> --tick), then open this card again.'
    : helper === 'noanswer' ? 'The colour helper did not answer. Close this card and try /skin fonts again in a moment.'
    : 'Could not read the fonts that are on now. Close this card and try /skin fonts again.'
}
// The tool's answer to an Apply, in one line for the card: the first line that is not machine output or a footnote.
export function resultLineOf(stdout: string, stderr: string, exitCode: number): string {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l && !/^(LOOK|PORT_STATE|RESULT):/.test(l) && !l.startsWith('(as the colour helper') && !l.startsWith('debugger:') && !l.startsWith('helper:'))
  return lines[0] ?? (stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? `The change did not finish (exit ${exitCode}).`)
}

// The chat reply to /skin fonts: everything the slim card leaves out.
export const CARD_HELP = [
  'The fonts card is open above the message box. Pick a part, a font, a size and a weight, then Apply. Reset clears the picker\'s choices for that part (its font then follows Everything else); on All parts it clears every font and keeps sizes and weights. /skin font off clears every picker choice. Neither turns off the project headers (/skin type off does).',
  'All parts sets one font everywhere (each part keeps its size and weight). Chat text is replies, your questions and the message box; sidebar rows are the session names and other row text.',
  WEIGHT_HELP,
  '/skin check shows what is on; /skin fonts off closes the card.',
].join('\n')
// The card's status after an Apply: a word when it worked, the reason (one sentence) when it did not.
// "Applied" only with proof (a look the helper proved); an answer without proof keeps its warning.
export function shortStatus(result: string, line: string, reset: boolean, proven = true): string {
  if (result === 'ok' && proven) return reset ? 'Reset' : 'Applied'
  const first = line.split(/(?<=[.!?])\s/)[0] ?? line
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}
