// Your own colours (/skin custom): three colours per mode (background, text, accent) become a whole official
// theme. Everything else is worked out from those three.
// No engine calls here, so it runs the same in the mod, its tests and plain Node.
import { makeColors } from './make-colors.js'
import { SKINS, type Half } from './skins.js'

import type { Custom, ModeName, Three } from '../types'
export type { Custom, ModeName, Three }
type Def = Parameters<typeof makeColors>[0]

// The starting point called "Claude's own": Reskin's Classic greys (its copy of Claude's look) with a clay
// accent close to Claude's. Approximate: Reset removes the theme altogether, which gives Claude's exact own.
export const CLAUDE: { light: Three; dark: Three } = {
  light: { bg: '#f0eee6', fg: '#141413', accent: '#c96442' },
  dark: { bg: '#1f1e1d', fg: '#faf9f5', accent: '#d97757' },
}

// Starting points that are not Reskin skins. "Soft grey" is for people who find strong contrast tiring
// (asked for on anthropics/claude-code issue 79305, 14 Nov): a light grey page with text about 0.3 above the
// lowest Claude accepts in Light (4.45:1; the limit is about 4.1:1). Dark cannot go as low: Claude needs main
// text about 9:1 there, because of how it draws highlighted rows, so its dark half sits at 9.5:1.
export const EXTRA: Record<string, { label: string; light: Three; dark: Three }> = {
  'soft-grey': {
    label: 'Soft grey (low contrast)',
    light: { bg: '#d9d9d6', fg: '#606060', accent: '#4f6f8f' },
    dark: { bg: '#2b2b2b', fg: '#d4d4d2', accent: '#8fa8c0' },
  },
}

export function startFrom(base: string): Custom {
  const x = Object.hasOwn(EXTRA, base) ? EXTRA[base] : undefined
  if (x !== undefined) return { base, light: { ...x.light }, dark: { ...x.dark }, scheme: 'system' }
  const s = Object.hasOwn(SKINS, base) ? SKINS[base] : undefined
  if (s === undefined) return { base: 'claude', light: { ...CLAUDE.light }, dark: { ...CLAUDE.dark }, scheme: 'system' }
  const pick = (h: Half): Three => ({
    bg: h.anchors['surface-0']!,
    fg: h.anchors['text-primary']!,
    accent: typeof h.roles.accent === 'string' ? h.roles.accent : (h.roles.accent?.seed ?? '#c96442'),
  })
  return { base, light: pick(s.light), dark: pick(s.dark), scheme: 'system' }
}

// ---- colour arithmetic ----------------------------------------------------------------------------

/** "#FFF", "fff", "#ffffff" all become "#ffffff"; anything else is undefined. */
export function hex(typed: string): string | undefined {
  const t = typed.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(t)) return '#' + [...t].map(c => c + c).join('')
  if (/^[0-9a-f]{6}$/.test(t)) return '#' + t
  return undefined
}

function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(c: [number, number, number]): string {
  return '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

/** `t` of the way from a to b. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

function luminance(h: string): number {
  const [r, g, b] = rgb(h).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The usual contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** A background reads as light when it is closer to white than black. */
export function looksLight(bg: string): boolean {
  return contrast(bg, '#000000') >= contrast(bg, '#ffffff')
}

// ---- three colours to makeColors input ------------------------------------------------------------

/** One mode's anchors and roles. Where a colour equals the base skin's, the skin's own shades are kept,
 * so "start from Dracula" with nothing changed is exactly Dracula. */
export function half(mode: ModeName, three: Three, base: string): { gray: { anchors: Record<string, string> }; roles: Record<string, unknown> } {
  // "Claude's own" borrows Classic's shades (not its blue accent or other roles).
  const key = base === 'claude' ? 'classic' : base
  const skin = Object.hasOwn(SKINS, key) ? SKINS[key]![mode] : undefined
  const { bg, fg, accent } = three
  const a: Record<string, string> = { 'surface-0': bg, 'text-primary': fg }
  if (skin !== undefined && skin.anchors['surface-0'] === bg) {
    for (const k of ['surface-1', 'surface-2', 'surface-3']) if (skin.anchors[k]) a[k] = skin.anchors[k]!
  } else if (mode === 'light') {
    // Cards and panels a little lighter than the page, as Claude and every Reskin light skin do.
    a['surface-1'] = mix(bg, '#ffffff', 0.4)
    a['surface-2'] = mix(bg, '#ffffff', 0.75)
    a['surface-3'] = a['surface-2']
  } else {
    // Dark: each later surface a small step toward the text colour. Menus stay close to the page,
    // the usual reason Claude refuses a dark theme (look.md).
    a['surface-1'] = mix(bg, fg, 0.03)
    a['surface-2'] = mix(bg, fg, 0.06)
    a['surface-3'] = mix(bg, fg, 0.08)
  }
  if (skin !== undefined && skin.anchors['text-primary'] === fg && skin.anchors['surface-0'] === bg) {
    for (const k of ['text-secondary', 'text-muted']) if (skin.anchors[k]) a[k] = skin.anchors[k]!
  } else {
    // Muted text: as faint as it can be while still easy to read (4.5:1) on the page and on panels.
    // Secondary text sits between main and muted, so the shades always run the right way round.
    let t = 0.4
    while (t > 0 && (contrast(mix(fg, bg, t), bg) < 4.5 || contrast(mix(fg, bg, t), a['surface-2']!) < 4.5)) {
      t = Math.max(0, t - 0.04)
    }
    a['text-muted'] = mix(fg, bg, t)
    a['text-secondary'] = mix(fg, bg, t * 0.55)
  }
  // Red, green, amber and purple come from the base skin, else Claude's own stay.
  const roles: Record<string, unknown> = base === 'claude' ? {} : { ...(skin?.roles ?? {}) }
  roles.accent = accent
  return { gray: { anchors: a }, roles }
}

export function definition(c: Custom): Def {
  return {
    label: 'Your colours',
    light: half('light', c.light, c.base),
    dark: half('dark', c.dark, c.base),
  } as unknown as Def
}

export type Verdict = {
  ok: boolean
  /** Short plain lines saying why Claude would refuse, at most one per mode. Empty when ok. */
  refusals: string[]
  /** Which modes Claude would refuse. */
  bad: ModeName[]
  /** Text-on-background ratio per mode, for the panel's read-out. */
  ratio: { light: number; dark: number }
}

/** Would Claude paint this? makeColors itself is the judge: any "Desktop won't paint" line means no. */
export function check(c: Custom): Verdict & { theme?: ReturnType<typeof makeColors>['theme'] } {
  const ratio = { light: contrast(c.light.fg, c.light.bg), dark: contrast(c.dark.fg, c.dark.bg) }
  let lines: string[]
  let theme: ReturnType<typeof makeColors>['theme'] | undefined
  try {
    const made = makeColors(definition(c))
    theme = made.theme
    lines = made.problems.filter(p => p.startsWith("Desktop won't paint"))
  } catch (err) {
    lines = [String(err instanceof Error ? err.message : err)]
  }
  const worst: Partial<Record<ModeName, number>> = {}
  const other: string[] = []
  for (const line of lines) {
    const m = /is ([\d.]+):1 in (light|dark) mode/.exec(line)
    const mode = (m?.[2] ?? /in (light|dark) mode/.exec(line)?.[1]) as ModeName | undefined
    if (mode === undefined) other.push(line)
    else worst[mode] = Math.min(worst[mode] ?? 99, m ? Number(m[1]) : 0)
  }
  const bad = (['light', 'dark'] as const).filter(m => worst[m] !== undefined)
  const refusals = [
    ...bad.map(m => {
      const r = worst[m]!
      const name = m === 'light' ? 'Light' : 'Dark'
      return r > 0
        ? `${name}: some text would be too faint (${r.toFixed(1)}:1, Claude needs 3:1). Try a stronger text colour.`
        : `${name}: these colours do not work together. Try a stronger text colour.`
    }),
    ...other,
  ]
  return { ok: lines.length === 0, refusals, bad, ratio, theme }
}

/** Push the text colour further from the background, a step at a time, only in the mode Claude refuses,
 * until it accepts. Background and accent stay as typed. Undefined if even black or white text is refused. */
export function makeReadable(c: Custom): Custom | undefined {
  let next: Custom = structuredClone(c)
  // Small steps, so a person who likes low contrast lands just past Claude's limit, not far beyond it.
  for (let step = 0; step < 50; step++) {
    const v = check(next)
    if (v.ok) return next
    const modes: ModeName[] = v.bad.length > 0 ? v.bad : ['light', 'dark']
    for (const m of modes) {
      const t = next[m]
      const far = contrast('#000000', t.bg) > contrast('#ffffff', t.bg) ? '#000000' : '#ffffff'
      next = { ...next, [m]: { ...t, fg: mix(t.fg, far, step < 40 ? 0.08 : 1) } }
    }
  }
  return check(next).ok ? next : undefined
}

// ---- the text form: one line to copy, paste, or type after the slash command -------------------

/** One line a person can copy and paste: `light bg #faf9f5 fg #141413 accent #c96442; dark bg ... ; from dracula`. */
export function toText(c: Custom): string {
  const one = (m: ModeName) => `${m} bg ${c[m].bg} fg ${c[m].fg} accent ${c[m].accent}`
  // `from` first: reading it back starts from that skin, then the colours go on top.
  const head = c.base !== 'claude' ? `from ${c.base}` : ''
  const tail = c.scheme !== 'system' ? `always ${c.scheme}` : ''
  return [head, one('light'), one('dark'), tail].filter(Boolean).join('; ')
}

const WORDS: Record<string, keyof Three> = {
  bg: 'bg', background: 'bg', back: 'bg',
  fg: 'fg', foreground: 'fg', text: 'fg',
  accent: 'accent', acc: 'accent',
}

/** Reads the text form, forgivingly, onto a starting point. A part with no `light` or `dark` word goes to
 * the mode its background looks like (or, with no background, the light mode). Returns what it could not read. */
export function fromText(typed: string, start: Custom): { custom: Custom; unread: string[] } {
  let c: Custom = structuredClone(start)
  const unread: string[] = []
  // A theme copied from elsewhere may use commas, new lines or "=" and ":"; treat them all as spaces.
  const parts = typed.split(/[;\n]+/).map(p => p.replace(/[=:,]/g, ' ').trim()).filter(Boolean)
  for (const part of parts) {
    const toks = part.split(/\s+/)
    const first = toks[0]!.toLowerCase()
    if (first === 'from' && toks[1]) {
      const name = toks.slice(1).join('-').toLowerCase()
      if (name === 'claude' || Object.hasOwn(SKINS, name) || Object.hasOwn(EXTRA, name)) {
        const fresh = startFrom(name)
        c = { ...fresh, scheme: c.scheme }
      } else unread.push(part)
      continue
    }
    if (first === 'always' || first === 'mode') {
      const m = (toks[1] ?? '').toLowerCase()
      if (m === 'light' || m === 'dark' || m === 'system') c.scheme = m
      else unread.push(part)
      continue
    }
    let mode: ModeName | undefined
    let i = 0
    if (first === 'light' || first === 'dark') {
      mode = first
      i = 1
    }
    const got: Partial<Three> = {}
    for (; i < toks.length; i++) {
      const word = WORDS[toks[i]!.toLowerCase()]
      const value = toks[i + 1] !== undefined ? hex(toks[i + 1]!) : undefined
      if (word && value) {
        got[word] = value
        i++
      } else unread.push(toks[i]!)
    }
    mode ??= got.bg !== undefined ? (looksLight(got.bg) ? 'light' : 'dark') : 'light'
    c = { ...c, [mode]: { ...c[mode], ...got } }
  }
  return { custom: c, unread }
}
