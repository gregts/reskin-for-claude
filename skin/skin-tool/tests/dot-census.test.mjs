// Dot census tests (17 Oct 2026). Run with: node --test 'tests/*.test.mjs'
// No Claude, no debugger, no Chrome: the real page script runs against a small fake sidebar, and the batch loop against a
// fake Electron, as in batch.test.mjs.
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'
import * as nodeFs from 'node:fs'
import { acquireLock, EXIT, ownTestSheets } from '../skin-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.resolve(here, '..')
const node = process.execPath
const presets = path.join(tool, 'presets')

async function load() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) +
    '\nexport { dotPage, dotCensus, runBatch, checkCss, setCode, BATCH_STATE }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-dots-'))
  writeFileSync(path.join(dir, 'm.mjs'), src)
  const m = await import(path.join(dir, 'm.mjs'))
  rmSync(dir, { recursive: true, force: true })
  return m
}
const m = await load()

const SEEN = { verdict: 'seen' }
// ---- a tiny DOM: enough selectors for the census (class, [attr], [attr=v], tag, :hover, comma lists) ----
const CLEAR = 'rgba(0, 0, 0, 0)'
function h(tag, { cls = '', attrs = {}, style = {}, hover = false } = {}, ...children) {
  const n = { tag, cls: cls.split(/\s+/).filter(Boolean), attrs, style, hover, children: [], parent: null }
  for (const c of children) { c.parent = n; n.children.push(c) }
  return n
}
const simple = (n, sel) => {
  if (sel === ':hover') return n.hover
  if (sel.startsWith('.')) return n.cls.includes(sel.slice(1))
  const a = /^\[([a-z-]+)(?:=([A-Za-z0-9_-]+))?\]$/.exec(sel)
  if (a) return a[2] === undefined ? a[1] in n.attrs : n.attrs[a[1]] === a[2]
  return n.tag === sel
}
// Compound selectors too (a[href], [data-row-main-button][aria-current]): every part must match.
const one = (n, sel) => (sel.trim().match(/\[[^\]]+\]|\.[A-Za-z0-9_-]+|:hover|^[a-z]+/g) ?? []).every((p) => simple(n, p))
const matches = (n, sel) => sel.split(',').some((s) => one(n, s))
const all = (n) => n.children.flatMap((c) => [c, ...all(c)])
const wrap = (n) => {
  if (!n) return null
  if (n.w) return n.w
  n.w = {
    _n: n, tagName: n.tag.toUpperCase(), className: n.cls.join(' '),
    get parentElement() { return wrap(n.parent) }, get firstElementChild() { return wrap(n.children[0]) },
    getAttribute: (k) => (k === 'class' ? n.cls.join(' ') : k in n.attrs ? String(n.attrs[k]) : null),
    matches: (s) => matches(n, s),
    closest: (s) => { for (let x = n; x; x = x.parent) if (matches(x, s)) return wrap(x); return null },
    querySelector: (s) => wrap(all(n).find((x) => matches(x, s)) ?? null),
    querySelectorAll: (s) => all(n).filter((x) => matches(x, s)).map(wrap),
  }
  return n.w
}
const styleOf = (w) => {
  const n = w._n
  const s = n.style
  const inherited = (k) => { for (let x = n; x; x = x.parent) if (x.style[k] !== undefined) return x.style[k]; return '' }
  return {
    backgroundColor: s.bg ?? CLEAR, borderTopColor: s.border ?? 'rgb(0, 0, 0)', opacity: s.opacity ?? '1',
    fill: s.fill ?? inherited('fill') ?? 'none', stroke: s.stroke ?? 'none', fillOpacity: s.fillOpacity ?? '1', strokeOpacity: '1',
    animationName: s.anim ?? 'none', boxShadow: s.shadow ?? 'none', backgroundImage: s.image ?? 'none', mask: 'none', filter: s.filter ?? 'none', clipPath: 'none', display: s.display ?? 'inline', visibility: 'visible',
    getPropertyValue: (k) => inherited(k),
  }
}
// Like Chromium's canvas: numeric colours are kept (serialised), named ones converted, anything else ignored.
class Canvas2D { #v = '#000000'; get fillStyle() { return this.#v } set fillStyle(v) { if (/^#[0-9a-f]{6}$/i.test(v)) this.#v = v.toLowerCase(); else if (/^rgba?\([0-9., ]*\)$/.test(v)) this.#v = v; else if (v === 'white') this.#v = '#ffffff' } }
function runDots(doc, { salt = 'aa', dark = false, reduce = false, clock = performance } = {}) {
  const ctx = createContext({
    performance: clock, Number, String, Object, Math,
    OffscreenCanvas: class { getContext() { return new Canvas2D() } },
    matchMedia: (q) => ({ matches: q.includes('dark') ? dark : q.includes('reduced-motion') ? reduce : false }),
    getComputedStyle: styleOf,
    document: { documentElement: wrap(doc), querySelector: (s) => wrap(doc).querySelector(s) },
  })
  return JSON.parse(JSON.stringify(runInContext(m.dotPage(salt), ctx)))
}

// A sidebar like Claude's: session rows ([data-row] links) carry an icon in .df-leading-slot and
// their status mark at the row's end, in .df-tail-mark.
const SIDE = 'rgb(255, 255, 255)'
const row = (href, mark, { selected = false, hover = false, own, title = 'Private chat title' } = {}) =>
  h('a', { attrs: { 'data-row': '', href, ...(selected ? { 'data-selected': 'focused' } : {}) }, style: own ? { bg: own } : {}, hover },
    h('span', { cls: 'df-leading-slot text-secondary' }, h('svg', { attrs: { 'data-icon': 'code' }, style: { fill: 'rgb(0, 0, 0)' } }, h('path', {}))),
    h('span', { attrs: { 'data-row-label': '' } }, h('span', { cls: title.replace(/\s/g, '-') })),
    h('span', { cls: 'df-tail-mark flex shrink-0' }, mark))
const dot = (kind, extra = {}) => h('span', { cls: 'status-dot', attrs: { 'data-kind': kind }, style: extra })
function sidebar({ tokens = {}, rows } = {}) {
  return h('html', { style: { bg: 'rgb(250, 250, 250)', '--reskin-active': '' } },
    h('body', {},
      h('div', { cls: 'dframe-sidebar', style: { bg: SIDE, '--df-hover': 'rgba(0, 0, 0, 0.06)', '--df-selected': 'rgba(0, 0, 0, 0.1)', ...tokens } },
        h('div', { cls: 'df-placeholder-rows' }, row('/x/placeholder', dot('ready'))),
        h('nav', {}, h('button', { attrs: { 'data-row': '' } }, h('span', { cls: 'df-leading-slot' }, h('svg', { attrs: { 'data-icon': 'gear' }, style: { fill: 'rgb(0, 0, 0)' } })))),
        h('div', { cls: 'df-session-list' }, ...(rows ?? [
          row('/code/session_UNREAD', dot('ready', { bg: 'rgb(42, 120, 214)' }), { hover: true, title: 'Awaiting answer' }),
          row('/code/session_WAIT', dot('awaiting', { bg: 'rgb(250, 178, 25)' })),
          row('/code/session_RUN', dot('running', { bg: 'rgb(137, 135, 129)', anim: 'dframe-dot-blink' })),
          row('/code/session_DONE', h('span', { cls: 'size-[6px] rounded-full border border-current text-muted opacity-50', style: { border: 'rgb(137, 135, 129)', opacity: '0.5' } })),
          row('/code/session_HAND', h('span', { cls: 'wrapper' }, h('svg', { cls: 'icon-hand', style: { fill: 'rgb(115, 69, 0)' } }, h('path', {})))),
          row('/code/session_SEL', dot('ready', { bg: 'rgb(42, 120, 214)' }), { selected: true, own: 'rgba(0, 0, 0, 0.1)' }),
          row('/code/session_CLAY', h('span', { cls: 'status-dot', attrs: { 'data-kind': 'clay' }, style: { image: 'url(x)' } })),
        ])))))
}

test('the dot census page script is valid JavaScript and its main-process wrapper too', () => {
  assert.doesNotThrow(() => new Script(m.dotPage('00')))
  assert.doesNotThrow(() => new Script(m.dotCensus('00', 500)))
})

test('discovery: every session row with a mark, kinds from fixed words, placeholder skipped, nav row kept apart', () => {
  const c = runDots(sidebar())
  assert.equal(c.error, undefined)
  const s = c.rows.filter((r) => r.inSessions)
  assert.deepEqual(s.map((r) => r.kind), ['dot-ready', 'dot-awaiting', 'dot-running', 'ring', 'icon', 'dot-ready', 'dot-clay'])
  assert.equal(s[4].icon, 'hand') // a wrapped svg is found inside the slot
  assert.equal(c.rows.filter((r) => !r.inSessions).length, 1) // the nav row is listed but never counts
  assert.equal(c.rows.some((r) => r.n === 1 && r.inSessions), false) // placeholder rows are skipped
  assert.equal(s[2].anim, 'running')
  assert.equal(s[3].opacity, 0.5)
  assert.equal(s[6].paints, null) // the clay picture's paint is unknown, never guessed
  assert.equal(s[0].hovered, true)
  assert.deepEqual([s[5].selected, s[5].selectedAs, s[5].own], [true, 'focused', 'rgba(0, 0, 0, 0.1)'])
  assert.equal(c.dfHover, 'rgba(0, 0, 0, 0.06)')
  // Session rows: the leading icon is never taken for the status; a row with no tail mark is left out; a Pulse counts.
  const noTail = h('a', { attrs: { 'data-row': '', href: '/n' } }, h('span', { cls: 'df-leading-slot' }, h('svg', { attrs: { 'data-icon': 'code' } }, h('path', {}))))
  const pulse = row('/p', h('span', { attrs: { 'data-cds': 'Pulse' }, style: { bg: 'rgb(137, 135, 129)' } }))
  const only = runDots(sidebar({ rows: [noTail, pulse] })).rows.filter((x) => x.inSessions)
  assert.deepEqual(only.map((x) => x.kind), ['pulse'])
  // data-selected="false" is not a selection (as SHOT's own rule).
  const f = h('a', { attrs: { 'data-row': '', href: '/f', 'data-selected': 'false' } }, h('span', { cls: 'df-tail-mark' }, dot('ready')))
  const r = runDots(sidebar({ rows: [f] })).rows.find((x) => x.inSessions)
  assert.deepEqual([r.selected, r.selectedAs], [false, 'false'])
})

test('privacy: no title or address leaves the page, only salted hashes', () => {
  const c = runDots(sidebar(), { salt: 'salt1' })
  const text = JSON.stringify(c)
  for (const secret of ['Private', 'Awaiting-answer', 'session_', '/code/']) assert.ok(!text.includes(secret), secret)
  // A token value shaped like a colour but carrying text is refused, not passed through.
  const sneaky = JSON.stringify(runDots(sidebar({ tokens: { '--cds-fill-warning': 'rgb(PRIVATE_CHAT_TITLE)', '--cds-text-muted': 'white' } })))
  assert.ok(!sneaky.includes('PRIVATE'))
  assert.match(sneaky, /"--cds-fill-warning":"other"/)
  assert.match(sneaky, /"--cds-text-muted":"#ffffff"/) // a named colour, serialised by the canvas
  // An svg paint that is not a plain colour (a gradient by id) is unknown, and its text never leaves the page.
  const grad = runDots(sidebar({ rows: [row('/g', h('svg', { cls: 'icon-hand' }, h('path', { style: { fill: 'url(#PRIVATE-grad)' } })))] }))
  assert.equal(grad.rows.find((r) => r.inSessions).paints, null)
  assert.ok(!JSON.stringify(grad).includes('PRIVATE'))
  const ids = c.rows.filter((r) => r.inSessions).map((r) => r.id)
  assert.ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id)))
  assert.equal(new Set(ids).size, ids.length)
  const again = runDots(sidebar(), { salt: 'salt1' }).rows.filter((r) => r.inSessions).map((r) => r.id)
  const other = runDots(sidebar(), { salt: 'salt2' }).rows.filter((r) => r.inSessions).map((r) => r.id)
  assert.deepEqual(again, ids)
  assert.ok(other.every((id, i) => id !== ids[i]))
  // Two identical-looking rows that swap places keep their own ids.
  const twin = (href) => row(href, dot('ready', { bg: 'rgb(42, 120, 214)' }))
  const a = runDots(sidebar({ rows: [twin('/a'), twin('/b')] })).rows.filter((r) => r.inSessions)
  const b = runDots(sidebar({ rows: [twin('/b'), twin('/a')] })).rows.filter((r) => r.inSessions)
  assert.equal(a[0].id, b[1].id)
  assert.equal(a[1].id, b[0].id)
  assert.equal(m.removalProof({ rows: a }, { rows: b }, SEEN).verdict, 'proved') // matched by id, not by position
})

test('the shared deadline: a slow page is reported as stopped early and never counts as complete', () => {
  let t = 0
  const slow = { now: () => (t += 7) } // every clock look costs 7 ms: the 300 ms cap is hit part-way through the rows
  const c = runDots(sidebar(), { clock: slow })
  assert.equal(c.truncated, true)
  assert.ok(c.rows.length < 8, `rows kept: ${c.rows.length}`)
  assert.equal(m.needsYou([c, c, c]).answer, 'unverified')
  assert.equal(m.overrideSeen(c, m.declaredDotTokens(dotcheckCss(), 'light')).verdict, 'unknown')
})

test('judging: observed and predicted cells, under 3:1 flagged, opacity counted, unknown never passes', () => {
  const j = m.judgeDots(runDots(sidebar()))
  const by = (k) => j.marks.find((x) => x.kind === k)
  const unread = by('dot-ready'), wait = by('dot-awaiting'), ring = by('ring'), clay = by('dot-clay')
  assert.equal(unread.state, 'hovered')
  assert.equal(unread.hovered.source, 'observed')
  assert.equal(unread.plain.source, 'predicted')
  assert.ok(unread.plain.contrast > 4 && unread.plain.contrast < 5) // #2a78d6 on white is about 4.6
  assert.ok(wait.plain.contrast < 2) // Claude's own amber on white: the known near-invisible dot
  assert.deepEqual(wait.low, ['plain', 'hovered', 'selected'])
  assert.ok(ring.plain.contrast < 2) // half-opacity grey ring
  assert.deepEqual(clay.unknown, ['plain', 'hovered', 'selected'])
  assert.deepEqual(clay.low, [])
  const sel = j.marks.find((x) => x.state === 'selected')
  assert.equal(sel.selected.source, 'observed')
  assert.ok(sel.selected.contrast < unread.plain.contrast) // the selected wash lowers it
  // Only drawn shapes count, and a group's opacity counts too.
  const svgRow = (svg) => m.judgeDots(runDots(sidebar({ rows: [row('/s', svg)] }))).marks[0]
  const pale = svgRow(h('svg', { cls: 'icon-hand', style: { fill: 'rgb(0, 0, 0)' } }, h('path', { style: { fill: 'rgb(245, 245, 245)' } })))
  assert.ok(pale.plain.contrast < 1.2, `pale path under a black container fill: ${pale.plain.contrast}`)
  const faint = svgRow(h('svg', { cls: 'icon-hand' }, h('g', { style: { opacity: '0.1' } }, h('path', { style: { fill: 'rgb(0, 0, 0)' } }))))
  assert.ok(faint.plain.contrast < 1.5, `black path in a 10% group: ${faint.plain.contrast}`)
  assert.deepEqual(svgRow(h('svg', { cls: 'icon-hand' }, h('g', { style: { filter: 'blur(1px)' } }, h('path', { style: { fill: 'rgb(0, 0, 0)' } })))).unknown, ['plain', 'hovered', 'selected'])
  // Shapes that are never drawn (inside defs, under display:none) do not count; use/text = unknown.
  const pathPale = () => h('path', { style: { fill: 'rgb(245, 245, 245)' } })
  const inDefs = svgRow(h('svg', { cls: 'icon-hand' }, h('defs', {}, h('rect', { style: { fill: 'rgb(0, 0, 0)' } })), pathPale()))
  assert.ok(inDefs.plain.contrast < 1.2, `a black rect in defs must not count: ${inDefs.plain.contrast}`)
  const offGroup = svgRow(h('svg', { cls: 'icon-hand' }, h('g', { style: { display: 'none' } }, h('rect', { style: { fill: 'rgb(0, 0, 0)' } })), pathPale()))
  assert.ok(offGroup.plain.contrast < 1.2, `a hidden group must not count: ${offGroup.plain.contrast}`)
  assert.deepEqual(svgRow(h('svg', { cls: 'icon-hand' }, h('use', {}), pathPale())).unknown, ['plain', 'hovered', 'selected'])
  // A mark hidden as a whole, or inside a hidden wrapper, has no paint: unknown, never a pass.
  const ink = () => h('path', { style: { fill: 'rgb(0, 0, 0)' } })
  const all3 = ['plain', 'hovered', 'selected']
  assert.deepEqual(svgRow(h('svg', { cls: 'icon-hand', style: { display: 'none' } }, ink())).unknown, all3)
  assert.deepEqual(svgRow(h('span', { cls: 'wrap', style: { display: 'none' } }, h('svg', { cls: 'icon-hand' }, ink()))).unknown, all3)
  assert.deepEqual(svgRow(dot('ready', { bg: 'rgb(42, 120, 214)', display: 'none' })).unknown, all3)
  // A hidden container above the row hides the mark too.
  const above = runDots(sidebar({ rows: [h('div', { cls: 'wrap', style: { display: 'none' } }, row('/h', h('svg', { cls: 'icon-hand' }, ink())))] }))
  assert.deepEqual(m.judgeDots(above).marks[0].unknown, all3)
  // An invisible or faded container above the row, or a filter there: the census cannot model it, so unknown (never 21:1).
  const fade = (style) => m.judgeDots(runDots(sidebar({ rows: [h('div', { cls: 'wrap', style }, row('/o', dot('ready', { bg: 'rgb(0, 0, 0)' })))] }))).marks[0].unknown
  assert.deepEqual(fade({ opacity: '0' }), all3)
  assert.deepEqual(fade({ opacity: '0.5' }), all3)
  assert.deepEqual(fade({ filter: 'blur(2px)' }), all3)
  assert.deepEqual(fade({}), []) // a plain container changes nothing
  // A plain row with its own background: other states are unknown, not worked out from the sidebar.
  const black = m.judgeDots(runDots(sidebar({ rows: [row('/k', dot('ready', { bg: 'rgb(0, 0, 0)' }), { own: 'rgb(0, 0, 0)' })] }))).marks[0]
  assert.equal(black.plain.contrast, 1)
  assert.deepEqual([black.hovered.contrast, black.selected.contrast], [null, null])
  // A row colour the page could not parse makes the cell unknown, not a pass.
  const c = runDots(sidebar())
  c.rows.find((r) => r.inSessions).bgs = ['color(display-p3 1 1 1)']
  assert.equal(m.judgeDots(c).marks[0].plain.contrast, null)
})

test('waiting-for-you colour: only from one selected session, the same in every read', () => {
  const read = (mark) => runDots(sidebar({ rows: [row('/a', dot('ready', { bg: 'rgb(42, 120, 214)' })), row('/w', mark, { selected: true })] }))
  const three = (x) => [x, x, x]
  assert.equal(m.needsYou(three(read(dot('ready', { bg: 'rgb(42, 120, 214)' })))).answer, 'blue')
  assert.equal(m.needsYou(three(read(dot('awaiting', { bg: 'rgb(250, 178, 25)' })))).answer, 'amber')
  assert.equal(m.needsYou(three(read(h('svg', { cls: 'icon-help', style: { fill: 'rgb(1, 2, 3)' } }, h('path', {}))))).answer, 'amber')
  assert.equal(m.needsYou(three(read(dot('running', { bg: 'rgb(1, 1, 1)' })))).answer, 'unknown')
  // Too few reads, a missing final read, or a read that stopped early: unverified.
  const blue = read(dot('ready', { bg: 'rgb(42, 120, 214)' }))
  assert.equal(m.needsYou([blue]).answer, 'unverified')
  assert.equal(m.needsYou([blue, blue, undefined]).answer, 'unverified')
  assert.equal(m.needsYou([blue, blue, { ...blue, truncated: true }]).answer, 'unverified')
  // Changed between reads, none selected, two selected, or a failed read: unverified.
  assert.equal(m.needsYou([blue, blue, read(dot('awaiting', { bg: 'rgb(250, 178, 25)' }))]).answer, 'unverified')
  assert.equal(m.needsYou(three(runDots(sidebar({ rows: [row('/a', dot('ready'))] })))).answer, 'unverified')
  assert.equal(m.needsYou(three(runDots(sidebar({ rows: [row('/a', dot('ready'), { selected: true }), row('/b', dot('ready'), { selected: true })] })))).answer, 'unverified')
  assert.equal(m.needsYou([blue, { error: 'x' }, blue]).answer, 'unverified')
  // Same mark but a different session selected in the second read: unverified.
  const at = (href) => runDots(sidebar({ rows: [row('/a', dot('ready')), row(href, dot('ready', { bg: 'rgb(42, 120, 214)' }), { selected: true })] }))
  assert.equal(m.needsYou([at('/w'), at('/w'), at('/w')]).answer, 'blue')
  assert.equal(m.needsYou([at('/w'), at('/v'), at('/w')]).answer, 'unverified')
})

test('removal proof: only after the test colours were seen; proved, differs, or unverified', () => {
  const base = runDots(sidebar())
  assert.equal(m.removalProof(base, runDots(sidebar()), SEEN).verdict, 'proved')
  // Without a diagnostic read that saw the test colours, equal before and after proves nothing.
  assert.equal(m.removalProof(base, runDots(sidebar())).verdict, 'unverified')
  assert.equal(m.removalProof(base, runDots(sidebar()), { verdict: 'not seen' }).verdict, 'unverified')
  const loud = runDots(sidebar({ tokens: { '--cds-fill-accent': '#ff00ff' } }))
  const r = m.removalProof(base, loud, SEEN)
  assert.equal(r.verdict, 'differs')
  assert.ok(r.differ.length > 0)
  assert.equal(m.removalProof({ error: 'x' }, base, SEEN).verdict, 'unverified')
  assert.equal(m.removalProof(base, undefined, SEEN).verdict, 'unverified')
  assert.equal(m.removalProof(base, { ...base, truncated: true }, SEEN).verdict, 'unverified')
  // A diagnostic read that stopped early is never "seen", so it never unlocks the proof.
  const decl = m.declaredDotTokens(dotcheckCss(), 'light')
  const loudAll = Object.fromEntries(decl.slice(-5).map((d) => [d.token, d.value]))
  const part = { ...runDots(sidebar({ tokens: loudAll })), truncated: true }
  const diag = m.overrideSeen(part, decl)
  assert.equal(diag.verdict, 'unknown')
  assert.equal(m.removalProof(base, runDots(sidebar()), diag).verdict, 'unverified')
  // Duplicate ids, unknown paints and unreadable tokens are never compared.
  const dup = runDots(sidebar({ rows: [row('/a', dot('ready')), row('/a', dot('ready'))] }))
  assert.equal(m.removalProof(dup, dup, SEEN).verdict, 'unverified')
  const clay = runDots(sidebar({ rows: [row('/c', h('span', { cls: 'status-dot', attrs: { 'data-kind': 'clay' }, style: { image: 'url(x)' } }))] }))
  assert.equal(m.removalProof(clay, clay, SEEN).verdict, 'unverified')
  const odd = runDots(sidebar({ tokens: { '--cds-fill-accent': 'var(--nope)' }, rows: [row('/o', dot('ready', { bg: 'rgb(1, 2, 3)' }))] }))
  assert.equal(odd.rows.find((x) => x.inSessions).tokens['--cds-fill-accent'], 'other')
  assert.equal(m.removalProof(odd, odd, SEEN).verdict, 'unverified')
})

// The real test sheet, built the way make-dotcheck.mjs builds it, into a temporary folder.
const LOUD = `  .status-dot, [data-cds=Pulse] { --cds-fill-accent:#ff00ff !important; --cds-fill-warning:#00ff00 !important; --cds-text-muted:#00ffff !important; --cds-fill-danger:#ff8000 !important; }
  .dframe-sidebar * { --cds-text-warning:#ff0080 !important; }
`
const dotcheckCss = () => { let out = '', d = 0; for (const ch of readFileSync(path.join(presets, 'tokyo-night.css'), 'utf8')) { if (ch === '{') d++; if (ch === '}' && --d === 0) out += LOUD; out += ch } return out }

test('the test sheet passes the stylesheet check and its dot tokens are read back per mode', () => {
  const css = dotcheckCss()
  assert.deepEqual(m.checkCss(css), ['dark', 'light'])
  // The skin's own fixed dot colours come first (17 Oct 2026), then the loud test values, which win (later rule).
  // One rule on .status-dot and [data-cds=Pulse]: read back once per scope.
  const loudDot = [['--cds-fill-accent', '#ff00ff'], ['--cds-fill-warning', '#00ff00'], ['--cds-text-muted', '#00ffff'], ['--cds-fill-danger', '#ff8000']]
  const want = [...loudDot.map(([k, v]) => ['dot', k, v]), ...loudDot.map(([k, v]) => ['pulse', k, v]), ['sidebar', '--cds-text-warning', '#ff0080']]
  for (const mode of ['dark', 'light']) assert.deepEqual(m.declaredDotTokens(css, mode).slice(-9).map((d) => [d.scope, d.token, d.value]), want)
  const own = m.declaredDotTokens(readFileSync(path.join(presets, 'tokyo-night.css'), 'utf8'), 'dark')
  for (const scope of ['dot', 'pulse']) assert.deepEqual(own.filter((d) => d.scope === scope).map((d) => d.token).sort(), ['--cds-fill-accent', '--cds-fill-danger', '--cds-fill-warning', '--cds-text-muted'])
  const decl = m.declaredDotTokens(css, 'light')
  const loud = Object.fromEntries(decl.slice(-9).map((d) => [d.token, d.value.toUpperCase()]))
  assert.equal(m.overrideSeen(runDots(sidebar({ tokens: loud })), decl).verdict, 'seen')
  assert.equal(m.overrideSeen(runDots(sidebar()), decl).verdict, 'not seen')
  assert.equal(m.overrideSeen(runDots(sidebar()), []).verdict, 'none declared')
  // The dot-only tokens reach dots only; a ring or an icon carrying just the sidebar token is still "seen".
  const dotOnly = { '--cds-fill-accent': '#ff00ff', '--cds-fill-warning': '#00ff00', '--cds-text-muted': '#00ffff', '--cds-fill-danger': '#ff8000' }
  const scoped = sidebar({ tokens: { '--cds-text-warning': '#ff0080' }, rows: [
    row('/d', dot('ready', { bg: 'rgb(42, 120, 214)', ...dotOnly })),
    row('/r', h('span', { cls: 'rounded-full border', style: { border: 'rgb(137, 135, 129)' } })),
  ] })
  assert.equal(m.overrideSeen(runDots(scoped), decl).verdict, 'seen')
})

test('dotcheck sheets are never given to a colour helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-dotcheck-'))
  try {
    copyFileSync(path.join(presets, 'nord.css'), path.join(dir, 'nord.css'))
    writeFileSync(path.join(dir, 'dotcheck-test.css'), dotcheckCss())
    const { map, skipped } = m.helperPresets(dir)
    assert.deepEqual(Object.keys(map), ['nord'])
    assert.deepEqual(skipped, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('skin-auto: dotcheck sheets only in a --dot-census batch; a census batch needs no screenshot OK; the sheet is deleted after', async () => {
  // The sheet goes beside the skin-auto that runs (a copy without release.json in the package), so the checks below look
  // at the very file that run sees.
  const file = path.join(path.dirname(autoPath()), 'presets', 'dotcheck-unit.css')
  writeFileSync(file, dotcheckCss())
  const run = (args, env = {}) => spawnSync(node, [autoPath(), ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', ...env } })
  const refused = (r, re) => { assert.ok([EXIT.usage, EXIT.refused].includes(r.status), r.stdout + r.stderr); assert.match(r.stdout + r.stderr, re) }
  try {
    refused(run(['one-click', 'dotcheck-unit', '--dry-run']), /dot census test sheet/)
    refused(run(['tick', 'dotcheck-unit', '--dry-run']), /dot census test sheet/)
    refused(run(['dotcheck-unit', '--dry-run']), /dot census test sheet/)
    refused(run(['switch', 'dotcheck-unit']), /Usage: node skin-auto.mjs switch/)
    refused(run(['batch', 'dotcheck-unit', '--screenshots-ok', '--dry-run']), /only with --dot-census/)
    assert.ok(existsSync(file), 'a dry or refused run leaves it')
    const port = 41000 + Math.floor(Math.random() * 10000)
    const held = await acquireLock(port)
    try {
      const r = run(['batch', 'dotcheck-unit,tokyo-night', '--dot-census', '--dry-run'], { SKIN_LOCK_PORT: String(port) })
      assert.equal(r.status, EXIT.refused, r.stdout + r.stderr)
      assert.match(r.stdout + r.stderr, /another skin change is running/) // accepted as far as the lock, with no screenshot OK
      assert.ok(existsSync(file), 'a dry run never deletes it')
      const real = run(['batch', 'dotcheck-unit,tokyo-night', '--dot-census'], { SKIN_LOCK_PORT: String(port) })
      assert.equal(real.status, EXIT.refused, real.stdout + real.stderr)
      assert.ok(existsSync(file), 'a run refused by the lock never deletes another run\'s sheet')
    } finally { await held.release() }
  } finally { rmSync(file, { force: true }) }
})

test('skin-auto takes ownership of the test sheets only after it holds the lock, and never in a dry run', () => {
  const src = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const lock = src.indexOf('lock = await acquireLock()\n  if (!lock.ok) refuse(')
  const own = src.indexOf("if (dotSheets.length > 0 && !dryRun) { dropSheets = ownTestSheets(dotSheets, nodeFs); process.on('exit', dropSheetsOnce) }")
  assert.ok(lock > 0 && own > lock && own - lock < 500, 'registered right after the lock check')
  assert.equal(src.split('ownTestSheets(').length - 1, 1, 'and nowhere else')
  // Cleanup deletes the sheets while the lock is still held, before letting it go.
  const drop = src.indexOf("attempt('test sheets', dropSheetsOnce)")
  assert.ok(drop > 0 && drop < src.indexOf("attempt('lock', () => { void lock?.release?.() })"))
})

test('ownTestSheets: deletes the very file it saw, never a replacement', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-own-'))
  try {
    const a = path.join(dir, 'dotcheck-a.css'), b = path.join(dir, 'dotcheck-b.css')
    writeFileSync(a, 'x'); writeFileSync(b, 'y')
    const clean = ownTestSheets([a, b, path.join(dir, 'missing.css')], nodeFs)
    rmSync(b); writeFileSync(b, 'a new sheet for a later run')
    clean()
    assert.equal(existsSync(a), false)
    assert.equal(existsSync(b), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('time plan: baseline plus one census item always fit after the slowest accepted start', () => {
  const { BATCH, DOT } = m
  const stateRead = 1_500
  assert.ok(BATCH.armLimit + stateRead + DOT.baselineCap + BATCH.applyCap + DOT.itemCap <= BATCH.loopEnd)
  assert.equal(m.roomForItem(BATCH.loopEnd - BATCH.applyCap - DOT.itemCap, true), true)
  assert.equal(m.roomForItem(BATCH.loopEnd - BATCH.applyCap - DOT.itemCap + 1, true), false)
  assert.equal(m.roomForItem(BATCH.loopEnd - BATCH.applyCap - BATCH.shotCap + 1), false) // screenshots unchanged
  assert.ok(DOT.itemCap <= BATCH.finalCap) // the final read shares the final step's time
})

// ---- the batch loop with a fake Electron: the census reads a sidebar whose dot tokens follow the inserted sheets ----
function fakeApp({ dark = false } = {}) {
  const calls = []
  const page = { sheets: new Map(), next: 1, handlers: new Map() }
  Object.assign(page, {
    getURL: () => 'https://claude.ai/code', isDestroyed: () => false, getType: () => 'window', getZoomFactor: () => 1,
    insertCSS: async (css, opts) => { const k = String(page.next++); page.sheets.set(k, { css, origin: opts.cssOrigin }); return k },
    removeInsertedCSS: async (k) => { page.sheets.delete(k) },
    reload: () => { page.sheets.clear(); setTimeout(() => page.handlers.get('did-finish-load')?.forEach((f) => f()), 5) },
    executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => {
      const on = [...page.sheets.values()].some((s) => s.css.includes('--reskin-active'))
      if (world !== 4247) return on ? '1' : ''
      calls.push('census')
      const loud = [...page.sheets.values()].some((s) => s.css.includes('#ff00ff'))
      const doc = sidebar({ tokens: loud ? { '--cds-fill-accent': '#ff00ff', '--cds-fill-warning': '#00ff00', '--cds-text-muted': '#00ffff', '--cds-fill-danger': '#ff8000', '--cds-text-warning': '#ff0080' } : {} })
      doc.style['--reskin-active'] = on ? '1' : ''
      const ctx = createContext({ performance, Number, String, Object, Math, OffscreenCanvas: class { getContext() { return new Canvas2D() } },
        matchMedia: (q) => ({ matches: q.includes('dark') ? dark : false }), getComputedStyle: styleOf,
        document: { documentElement: wrap(doc), querySelector: (s) => wrap(doc).querySelector(s) } })
      return JSON.parse(JSON.stringify(runInContext(code, ctx)))
    },
    capturePage: async () => { calls.push('capturePage'); throw new Error('no screenshots in a dot census') },
    on: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
    once: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
    removeListener: (e, f) => { page.handlers.set(e, (page.handlers.get(e) ?? []).filter((x) => x !== f)) },
  })
  const electron = {
    app: { on() {}, removeListener() {} }, nativeTheme: { shouldUseDarkColors: dark, themeSource: 'system' },
    webContents: { getAllWebContents: () => [page] }, BrowserWindow: { fromWebContents: () => ({ isVisible: () => true, isMinimized: () => false }) },
  }
  return { electron, calls, page }
}
const runInFake = (code, electron) => {
  electron.ctx ??= createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, URL, Promise, setTimeout, clearTimeout, Map, Set, String, Error, JSON })
  return runInContext(code, electron.ctx)
}
const fakeConn = (electron) => ({ evaluate: (code, ms) => Promise.race([runInFake(code, electron), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out: waiting for Claude.')), ms))]) })
const quiet = async (fn) => { const real = console.log; console.log = () => {}; try { return await fn() } finally { console.log = real } }

test('batch --dot-census: baseline, each item, the final read; override seen, removal proved, no screenshot taken', async () => {
  const f = fakeApp()
  const css = dotcheckCss()
  const items = [{ name: 'dotcheck-test', css, modes: m.checkCss(css) }, { name: 'tokyo-night', css: readFileSync(path.join(presets, 'tokyo-night.css'), 'utf8'), modes: ['dark', 'light'] }]
  const report = await quiet(() => m.runBatch(fakeConn(f.electron), Date.now(), { final: 'off', items, dots: true, salt: 'ab' }))
  assert.equal(f.calls.includes('capturePage'), false)
  assert.equal(f.calls.filter((c) => c === 'census').length, 4) // before, two items, after
  assert.equal(report.finalOk, true)
  assert.deepEqual(report.items.map((i) => i.status), ['applied', 'applied'])
  assert.equal(report.dots.items[0].override.verdict, 'seen')
  assert.equal(report.dots.items[1].override.verdict, 'not seen') // the fake page shows only the loud test colours, not a skin's own fixed dots
  assert.equal(report.dots.removal.verdict, 'proved')
  assert.equal(report.dots.needsYou.answer, 'blue') // the fake's selected session shows a ready dot
  const lines = m.dotLines(report.dots)
  assert.ok(lines.some((l) => /^DOTS before \(light\): 7 marks/.test(l)), lines.join('\n'))
  assert.ok(lines.some((l) => /^DOTS removal: proved/.test(l)))
  const sheet = m.contactSheet({ ...report, folder: 'x' })
  assert.match(sheet, /Session dots/)
  assert.ok(!sheet.includes('session_') && !sheet.includes('Private'))
})

// Claude's real session row is a div[data-row] whose address and aria-current sit on its main
// link, and whose status mark is a [data-cds=Pulse] span painted with a token (solid) or an inset box-shadow (hollow).
// The tail mark is hidden (opacity 0) while the row is hovered.
const realRow = (href, pulse, { selected = false, hover = false } = {}) =>
  h('div', { attrs: { 'data-row': '', ...(selected ? { 'data-selected': 'focused' } : {}) }, hover },
    h('a', { attrs: { href, 'data-row-main-button': '', ...(selected ? { 'aria-current': 'page' } : {}) } }, h('span', { cls: 'Private-title' })),
    h('span', { cls: 'df-tail-mark flex' }, pulse))
const pulse = (style) => h('span', { attrs: { 'data-cds': 'Pulse' }, style })
const AMBER = 'rgb(250, 178, 25)', BLUE = 'rgb(42, 120, 214)'
const realSidebar = (rows, tokens = {}) => h('html', {}, h('body', {}, h('div', { cls: 'dframe-sidebar', style: { bg: SIDE, '--df-hover': 'rgba(0, 0, 0, 0.06)', '--df-selected': 'rgba(0, 0, 0, 0.1)', '--cds-fill-warning': AMBER, '--cds-fill-accent': BLUE, ...tokens } },
  h('div', { cls: 'df-session-list' }, ...rows))))

test('real rows: address and selection from the main link, Pulse paints, hollow ring, hidden on hover', () => {
  const c = runDots(realSidebar([
    realRow('/code/session_WAIT', pulse({ bg: AMBER }), { selected: true }),
    realRow('/code/session_UNREAD', pulse({ bg: BLUE, opacity: '0' }), { hover: true }),
    realRow('/code/session_DONE', pulse({ shadow: `${BLUE} 0px 0px 0px 1px inset, rgb(255, 255, 255) 0px 0px 0px 0.5px` })),
    realRow('/code/session_ODD', pulse({ shadow: `${BLUE} 0px 0px 0px 3px` })),
  ]))
  const [wait, unread, done, odd] = c.rows
  assert.ok(c.rows.every((r) => r.kind === 'pulse' && typeof r.id === 'string'))
  assert.equal(new Set(c.rows.map((r) => r.id)).size, 4)
  assert.ok(!JSON.stringify(c).includes('session_'))
  assert.deepEqual([wait.selected, unread.selected, done.selected], [true, false, false])
  // Selection read from the main link alone (aria-current=page), with no data-selected on the row.
  const linkOnly = h('div', { attrs: { 'data-row': '' } }, h('a', { attrs: { href: '/x', 'data-row-main-button': '', 'aria-current': 'page' } }), h('span', { cls: 'df-tail-mark' }, pulse({ bg: AMBER })))
  assert.equal(runDots(realSidebar([linkOnly])).rows[0].selected, true)
  assert.deepEqual(wait.paints, [{ c: AMBER, a: 1 }])
  assert.deepEqual(done.paints, [{ c: BLUE, a: 1 }])
  assert.equal(odd.paints, null) // a shadow that is not Claude's ring: unknown, never guessed
  const j = m.judgeDots(c)
  const u = j.marks.find((x) => x.n === unread.n)
  assert.equal(u.hovered.source, 'hidden')
  assert.ok(!u.low.includes('hovered') && !u.unknown.includes('hovered'))
  assert.deepEqual(u.unknown, ['plain', 'selected']) // its opacity when shown is not known: never guessed
  // A row both selected and hovered hides its mark too: observed cell hidden, the others unknown.
  const both = m.judgeDots(runDots(realSidebar([realRow('/s', pulse({ bg: BLUE, opacity: '0' }), { selected: true, hover: true })]))).marks[0]
  assert.deepEqual([both.state, both.selected.source, both.low, both.unknown], ['selected', 'hidden', [], ['plain', 'hovered']])
  // An invisible mark on a row that is NOT hovered still fails.
  const ghost = m.judgeDots(runDots(realSidebar([realRow('/g', pulse({ bg: BLUE, opacity: '0' }))])))
  assert.deepEqual(ghost.marks[0].low, ['plain', 'hovered', 'selected'])
  assert.match(m.dotLines({ baseline: j, items: [], after: j, removal: { verdict: 'unverified' }, needsYou: { answer: 'x', why: 'y' } })[0], /unknown cells: 5; hidden by Claude on hover: 1/) // 2 from the hidden mark, 3 from the odd shadow
  // A shadow list with anything beyond Claude's exact ring form is unknown.
  const extra = runDots(realSidebar([realRow('/e', pulse({ shadow: `${BLUE} 0px 0px 0px 1px inset, rgb(0, 0, 0) 0px 0px 0px 100px inset` }))]))
  assert.equal(extra.rows[0].paints, null)
  // Waiting-for-you from a selected Pulse: painted with the warning token = amber, with the accent token = blue.
  assert.equal(m.needsYou([c, c, c]).answer, 'amber')
  const b = runDots(realSidebar([realRow('/code/session_WAIT', pulse({ bg: BLUE }), { selected: true })]))
  assert.equal(m.needsYou([b, b, b]).answer, 'blue')
  const same = runDots(realSidebar([realRow('/code/session_WAIT', pulse({ bg: BLUE }), { selected: true })], { '--cds-fill-warning': BLUE }))
  assert.equal(m.needsYou([same, same, same]).answer, 'unknown') // both tokens alike: cannot tell
  // The same session turning from amber to blue between reads is never reported as either.
  const amberRead = runDots(realSidebar([realRow('/code/session_WAIT', pulse({ bg: AMBER }), { selected: true })]))
  assert.equal(m.needsYou([amberRead, b, b]).answer, 'unverified')
})

test('Pulse override: the [data-cds=Pulse] rule reaches Pulse marks only, and only that exact selector passes the check', () => {
  const css = '@media (prefers-color-scheme: light) {\n  .status-dot, [data-cds=Pulse] { --cds-fill-warning:#965001 !important; }\n}\n'
  assert.deepEqual(m.checkCss(css), ['light'])
  for (const bad of ['[data-cds=Pulsex]', 'span[data-cds=Pulse]', '[data-cds=Pulse] *', '[data-cds=Icon]', '[style]'])
    assert.throws(() => m.checkCss(`@media (prefers-color-scheme: light) {\n  ${bad} { --cds-fill-warning:#965001; }\n}\n`), /selectors are allowed/)
  const decl = m.declaredDotTokens(css, 'light')
  assert.deepEqual(decl.map((d) => d.scope), ['dot', 'pulse'])
  const reached = runDots(realSidebar([realRow('/a', pulse({ bg: AMBER }))], { '--cds-fill-warning': '#965001' }))
  assert.equal(m.overrideSeen(reached, decl).verdict, 'seen')
  const missed = runDots(realSidebar([realRow('/a', pulse({ bg: AMBER }))]))
  assert.equal(m.overrideSeen(missed, decl).verdict, 'not seen')
  const pulseOnly = m.declaredDotTokens('@media (prefers-color-scheme: light) {\n  .status-dot { --cds-fill-warning:#965001 !important; }\n}\n', 'light')
  assert.equal(m.overrideSeen(missed, pulseOnly).verdict, 'unknown') // a .status-dot rule says nothing about Pulse marks
})
