#!/usr/bin/env node
// Draws one small picture per skin, `swatches/<skin>.svg`, straight from `presets/<skin>.css`: a mock Claude window
// (sidebar with rows and status dots, page, card, text in three strengths, an accent button), dark half on the left,
// light half on the right. Drawn from code only, never from a screenshot, so no chat title can leak into it.
//   node make-swatches.mjs           write the pictures
//   node make-swatches.mjs --check   exit 1 when a picture differs from what the presets give (a test runs this)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PRESETS = path.join(here, 'presets')
const OUT = path.join(here, 'swatches')
const HALVES = ['dark', 'light']

// The colours one half sets, read rule by rule from its @media block (comments removed first). Tokens come from the
// token rule, row colours from the sidebar rule, dots from the status-dot rule; each must be set exactly once there.
// Then the rules that really paint the page, sidebar, card and text must use those same colours, so a picture can never
// show a colour the skin does not paint. Anything missing or different stops the run: a picture must never guess.
const HEX = /^#[0-9a-f]{6}$/
// Every half has exactly these rules, in this order (make-presets.mjs writes them). Any other rule could paint over a
// colour the picture shows, so a half with a missing, extra or reordered rule is refused rather than drawn wrong.
const RULES = ['*, *::before, *::after', '.dframe-sidebar, .dframe-sidebar *', '.status-dot, [data-cds=Pulse]',
  'html, body, .dframe-content', '.dframe-sidebar, .dframe-sidebar-body', '.bg-surface-1, .bg-bg-100', '.bg-surface-2',
  '.bg-surface-3, .bg-bg-000', '.bg-bg-200, .bg-bg-300', '.text-primary, .text-text-100', '.text-secondary, .text-text-300',
  '.text-text-400, .text-text-500']
const PAINTED = [
  ['html, body, .dframe-content', 'background-color', 'page'],
  ['.bg-surface-1, .bg-bg-100', 'background-color', 'page'],
  ['.bg-bg-200, .bg-bg-300', 'background-color', 'sidebar'],
  ['.dframe-sidebar, .dframe-sidebar-body', 'background-color', 'sidebar'],
  ['.bg-surface-2', 'background-color', 'card'],
  ['.text-primary, .text-text-100', 'color', 'text'],
  ['.text-secondary, .text-text-300', 'color', 'secondary'],
  ['.text-text-400, .text-text-500', 'color', 'muted'],
]
export function halfColours(css, mode) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const head = `@media (prefers-color-scheme: ${mode}) {`
  const start = text.indexOf(head)
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw new Error(`no ${mode} half, or more than one`)
  const next = text.indexOf('@media', start + 1)
  const block = text.slice(start + head.length, next < 0 ? undefined : next)
  const rules = new Map()
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim()
    if (rules.has(sel)) throw new Error(`${mode} half has the rule "${sel}" twice`)
    const decls = new Map()
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i < 0) continue
      const k = d.slice(0, i).trim()
      if (decls.has(k)) throw new Error(`${mode} half sets ${k} twice in "${sel}"`)
      // Every declaration a preset writes is !important; one without it would lose to the token rule and paint another colour.
      const v = d.slice(i + 1).trim().toLowerCase()
      if (!/\s*!important$/.test(v)) throw new Error(`${mode} half: ${k} in "${sel}" is not !important`)
      decls.set(k, v.replace(/\s*!important$/, '').trim())
    }
    rules.set(sel, decls)
  }
  const order = [...rules.keys()]
  if (order.join('\n') !== RULES.join('\n')) throw new Error(`${mode} half has other rules than a preset writes: ${order.join(' | ')}`)
  // The three token rules may set only their own tokens: an extra painting property there would colour over the picture.
  const TOKENS_ONLY = { [RULES[1]]: ['--df-hover', '--df-selected'], [RULES[2]]: ['--cds-fill-accent', '--cds-fill-warning', '--cds-fill-danger', '--cds-text-muted'] }
  for (const k of rules.get(RULES[0]).keys()) if (!k.startsWith('--')) throw new Error(`${mode} half: the token rule sets ${k}`)
  for (const [sel, want] of Object.entries(TOKENS_ONLY)) {
    const have = [...rules.get(sel).keys()]
    if (have.length !== want.length || !want.every((k) => have.includes(k))) throw new Error(`${mode} half: "${sel}" sets ${have.join(', ')}`)
  }
  for (const sel of RULES.slice(3)) {
    const props = [...rules.get(sel).keys()]
    if (props.length !== 1 || !/^(?:background-)?color$/.test(props[0])) throw new Error(`${mode} half: "${sel}" sets ${props.join(', ')}`)
  }
  const get = (sel, prop) => {
    const v = rules.get(sel)?.get(prop)
    if (!v || !HEX.test(v)) throw new Error(`${mode} half has no ${prop} colour in "${sel}"`)
    return v
  }
  const tok = (name) => get('*, *::before, *::after', `--${name}`)
  const side = (name) => get('.dframe-sidebar, .dframe-sidebar *', `--${name}`)
  const dot = (name) => get('.status-dot, [data-cds=Pulse]', `--${name}`)
  const c = {
    sidebar: tok('cds-surface-0'), page: tok('cds-surface-1'), card: tok('cds-surface-2'),
    text: tok('cds-text-primary'), secondary: tok('cds-text-secondary'), muted: tok('cds-text-muted'),
    accent: tok('cds-fill-accent'), onAccent: tok('cds-on-accent'), selected: side('df-selected'), hover: side('df-hover'),
    dots: { unread: dot('cds-fill-accent'), waiting: dot('cds-fill-warning'), error: dot('cds-fill-danger'), running: dot('cds-text-muted') },
  }
  for (const [sel, prop, key] of PAINTED) {
    if (get(sel, prop) !== c[key]) throw new Error(`${mode} half paints ${key} ${get(sel, prop)} but its token says ${c[key]}`)
  }
  return c
}

const W = 240
const H = 150
function half(c, x, label) {
  const r = (rx, ry, w, h, fill, rad = 0) => `<rect x="${x + rx}" y="${ry}" width="${w}" height="${h}" rx="${rad}" fill="${fill}"/>`
  const dot = (cy, fill) => `<circle cx="${x + 70}" cy="${cy}" r="3" fill="${fill}"/>`
  return [
    r(0, 0, W, H, c.page),
    r(0, 0, 80, H, c.sidebar),
    `<text x="${x + 8}" y="16" font-family="-apple-system, system-ui, sans-serif" font-size="10" fill="${c.secondary}">${label}</text>`,
    r(6, 26, 68, 16, c.selected, 4), r(12, 32, 40, 4, c.text, 2), dot(34, c.dots.unread),
    r(6, 46, 68, 16, c.hover, 4), r(12, 52, 34, 4, c.secondary, 2), dot(54, c.dots.waiting),
    r(12, 72, 44, 4, c.secondary, 2), dot(74, c.dots.error),
    r(12, 92, 30, 4, c.muted, 2), dot(94, c.dots.running),
    r(94, 16, 110, 6, c.text, 3), r(94, 30, 132, 4, c.secondary, 2), r(94, 40, 96, 4, c.muted, 2),
    r(94, 56, 132, 52, c.card, 6), r(102, 66, 104, 4, c.text, 2), r(102, 76, 84, 4, c.secondary, 2),
    r(170, 116, 56, 22, c.accent, 6),
    `<text x="${x + 198}" y="131" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="10" fill="${c.onAccent}">Send</text>`,
  ].join('')
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
export function swatch(name, css) {
  if (!NAME.test(name)) throw new Error(`not a skin name: ${JSON.stringify(name)}`) // the name goes into the picture's text
  const parts = HALVES.map((mode, i) => half(halfColours(css, mode), i * W, `${name} ${mode}`))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * W}" height="${H}" viewBox="0 0 ${2 * W} ${H}" role="img" aria-label="${name}: dark and light halves">${parts.join('')}</svg>\n`
}

export function allSwatches() {
  const out = {}
  for (const f of fs.readdirSync(PRESETS).sort()) {
    if (!f.endsWith('.css') || f.startsWith('dotcheck-')) continue
    const name = f.slice(0, -4)
    out[`${name}.svg`] = swatch(name, fs.readFileSync(path.join(PRESETS, f), 'utf8'))
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = allSwatches()
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.svg')).sort() : []
    const bad = [...new Set([...Object.keys(want), ...have])].filter((f) => !fs.existsSync(path.join(OUT, f)) || want[f] !== fs.readFileSync(path.join(OUT, f), 'utf8'))
    if (bad.length) { console.error(`swatches out of date: ${bad.join(', ')} (run: node make-swatches.mjs)`); process.exit(1) }
    console.log(`swatches up to date (${have.length})`)
  } else {
    fs.mkdirSync(OUT, { recursive: true })
    for (const f of fs.readdirSync(OUT)) if (f.endsWith('.svg') && !want[f]) fs.rmSync(path.join(OUT, f))
    for (const [f, text] of Object.entries(want)) fs.writeFileSync(path.join(OUT, f), text)
    console.log(`wrote ${Object.keys(want).length} swatches to swatches/`)
  }
}
