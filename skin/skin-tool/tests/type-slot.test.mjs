// Type slot (2 Nov 2026): the separate sidebar header type sheet, its strict checker, and how it lives beside the colours
// in the real CORE and helper (run in a vm with a fake Claude, like health-check.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendSwitch, typeLine } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const uid = process.getuid()
async function loadSkin() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { helperCode, setCode }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-type-'))
  writeFileSync(path.join(d, 'skin.mjs'), src)
  const m = await import(path.join(d, 'skin.mjs'))
  rmSync(d, { recursive: true, force: true })
  return m
}
const skin = await loadSkin()
const NORD = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
const DRACULA = readFileSync(path.join(tool, 'presets', 'dracula.css'), 'utf8')
const TYPE = readFileSync(path.join(tool, 'type', 'sidebar-headers.css'), 'utf8')
const PRESETS = { nord: NORD, dracula: DRACULA }
const SEL = '.dframe-sidebar .df-label-inset h3 span.inline-block.whitespace-nowrap'
const CUR = '.dframe-sidebar div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset h3 span.inline-block.whitespace-nowrap'
const OPEN = '.dframe-sidebar .df-label-inset h3 button[aria-expanded=true] span.inline-block.whitespace-nowrap'
const ACT = '.dframe-sidebar div.isolate.rounded-lg:has([data-cds=Pulse]) > div > div > .df-label-inset h3 span.inline-block.whitespace-nowrap'
const ROW = '.dframe-sidebar div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset'
const STRIPE = 'box-shadow: inset 3px 0 0 0 var(--cds-text-accent)'

// ---- The checker ----
test('checkTypeCss: the shipped sheet passes, and helperTypeSheets offers it as "headers" (fonts only where shipped)', () => {
  assert.equal(skin.checkTypeCss(TYPE), 5)
  // The current-project rule shares the active rule's specificity, so it must come after it to win.
  assert.ok(TYPE.indexOf(':has([data-cds=Pulse])') < TYPE.indexOf(':has([aria-current=page])'))
  assert.deepEqual({ ...skin.helperTypeSheets(path.join(tool, 'type'), { fonts: false }) }, { headers: TYPE })
})

test('checkTypeCss: refuses every shape outside its narrow rules', () => {
  const ok = (body, sel = SEL) => `${sel} { ${body} }`
  const bad = {
    'another selector': ok('font-weight: 600', '.dframe-sidebar span'),
    'every element': ok('font-weight: 600', '*'),
    'icons': ok('font-weight: 600', '[data-cds=Icon]'),
    'a second selector in a list': ok('font-weight: 600', `${SEL}, body`),
    'font-family': ok('font-family: Inter'),
    'line-height': ok('line-height: 2'),
    'a colour': ok('color: #ff0000'),
    'display': ok('display: none'),
    'var()': ok('font-size: var(--df-row-font)'),
    'calc()': ok('font-size: calc(14px)'),
    'em units': ok('font-size: 1em'),
    'too small': ok('font-size: 10px'),
    'too big': ok('font-size: 17px'),
    'a fraction': ok('font-size: 14.5px'),
    'weight 900': ok('font-weight: 900'),
    'weight bolder': ok('font-weight: bolder'),
    'a custom property': ok('--df-group-font: 14px'),
    'the marker': ok('--reskin-type: 1'),
    '@media': `@media (prefers-color-scheme: dark) { ${ok('font-weight: 600')} }`,
    'nested rule': `${SEL} { ${SEL} { font-weight: 600 } }`,
    'quotes': ok('font-weight: 600') + ' /* "x" */',
    'backslash': ok('font-weight: 6\\30 0'),
    'url': ok('font-weight: 600') + ' .a { background: url(x) }',
    'unclosed rule': `${SEL} { font-weight: 600`,
    'trailing junk': ok('font-weight: 600') + ' html',
    'stray brace': `} ${ok('font-weight: 600')}`,
    'unclosed comment': ok('font-weight: 600') + ' /* x',
    'non-ASCII space': ok('font-weight: 600'),
    'empty': '  /* nothing */  ',
    'empty rule': ok(''),
    'too large': ok('font-weight: 600;'.repeat(300)),
    'a token on the header': ok('--df-row-font: 13px'),
    'the row size too big': ok('--df-row-font: 20px', '.dframe-sidebar'),
    'another token on the sidebar': ok('--df-group-font: 13px', '.dframe-sidebar'),
    'font-size on the sidebar': ok('font-size: 13px', '.dframe-sidebar'),
    'colour on the sidebar': ok('color: var(--cds-text-accent)', '.dframe-sidebar'),
    'another colour token': ok('color: var(--cds-text-secondary)'),
    'size on the open rule': ok('font-size: 14px', OPEN),
    'weight on the open rule': ok('font-weight: 700', OPEN),
    'another attribute': ok('color: var(--cds-text-accent)', OPEN.replace('aria-expanded=true', 'aria-expanded=false')),
    'the open attribute elsewhere': ok('color: var(--cds-text-accent)', '.dframe-sidebar [aria-expanded=true]'),
    'the open attribute on its own': ok('font-weight: 600', '[aria-expanded=true]'),
    'size on the current rule': ok('font-size: 14px', CUR),
    'another :has': ok('color: var(--cds-text-accent)', CUR.replace('aria-current=page', 'aria-current=true')),
    'the :has elsewhere': ok('color: var(--cds-text-accent)', '.dframe-sidebar div:has([aria-current=page]) span'),
    'a looser current rule': ok('color: var(--cds-text-accent)', CUR.replace(' > div > div > ', ' ')),
    'the accent with a fallback': ok('color: var(--cds-text-accent, red)'),
    'the accent as a size': ok('font-size: var(--cds-text-accent)'),
    'the accent nested': ok('color: var(var(--cds-text-accent))'),
    'both selectors in one rule': ok('font-weight: 600', `.dframe-sidebar, ${SEL}`),
    'a bare hex colour': ok('color: #bd93f9'),
    'a named colour': ok('color: red'),
    'a comment inside the selector': `.dframe-sidebar/**/.df-label-inset h3 span.inline-block.whitespace-nowrap { color: var(--cds-text-accent) }`,
    'a comment inside a rule': ok('font-weight: /* x */ 600'),
    'a comment between selector and brace': `${SEL} /* x */ { font-weight: 600 }`,
    'a stray comment end': ok('font-weight: 600') + ' */',
    'transparent text': ok('color: transparent'),
    'size on the active rule': ok('font-size: 15px', ACT),
    'italic on the active rule': ok('font-style: italic', ACT),
    'a looser active rule': ok('color: var(--cds-text-accent)', ACT.replace(' > div > div > ', ' ')),
    'the active mark by its inline colour': ok('color: var(--cds-text-accent)', ACT.replace('[data-cds=Pulse]', '[data-cds=Pulse][style*=fill-accent]')),
    'another mark kind': ok('color: var(--cds-text-accent)', ACT.replace('Pulse', 'Icon')),
    'the active :has elsewhere': ok('color: var(--cds-text-accent)', '.dframe-sidebar div:has([data-cds=Pulse]) span'),
    'italic on the current rule (dropped 3 Nov)': ok('font-style: italic', CUR),
    'italic on every header': ok('font-style: italic'),
    'italic on the open rule': ok('font-style: italic', OPEN),
    'italic on the sidebar': ok('font-style: italic', '.dframe-sidebar'),
    'oblique': ok('font-style: oblique', CUR),
    'a slanted oblique': ok('font-style: oblique 10deg', CUR),
    'font-style normal': ok('font-style: normal', CUR),
    'the font shorthand': ok('font: italic 14px x', CUR),
    'an underline (dropped 3 Nov)': ok('text-decoration-line: underline', CUR),
    'a dotted style (dropped 3 Nov)': ok('text-decoration-style: dotted', CUR),
    'an underline colour (dropped 3 Nov)': ok('text-decoration-color: var(--cds-text-accent)', CUR),
    'an underline thickness (dropped 3 Nov)': ok('text-decoration-thickness: 1px', CUR),
    'an underline offset (dropped 3 Nov)': ok('text-underline-offset: 1px', CUR),
    'the text-decoration shorthand': ok('text-decoration: underline', CUR),
    'padding on the current rule': ok('padding-bottom: 4px', CUR),
    'the stripe on the name': ok(STRIPE, CUR),
    'the stripe on every header': ok(STRIPE),
    'the stripe on the active rule': ok(STRIPE, ACT),
    'the stripe on the sidebar': ok(STRIPE, '.dframe-sidebar'),
    'the stripe on every header row': ok(STRIPE, '.dframe-sidebar .df-label-inset'),
    'the stripe on the active row': ok(STRIPE, ACT.replace(' h3 span.inline-block.whitespace-nowrap', '')),
    'a looser current row': ok(STRIPE, ROW.replace(' > div > div > ', ' ')),
    'the row with its h3': ok(STRIPE, ROW + ' h3'),
    'a wider stripe': ok('box-shadow: inset 30px 0 0 0 var(--cds-text-accent)', ROW),
    'a stripe outside the row': ok('box-shadow: -3px 0 0 0 var(--cds-text-accent)', ROW),
    'a blurred stripe': ok('box-shadow: inset 3px 0 8px 0 var(--cds-text-accent)', ROW),
    'a spread shadow': ok('box-shadow: inset 0 0 0 99px var(--cds-text-accent)', ROW),
    'a stripe in its own colour': ok('box-shadow: inset 3px 0 0 0 red', ROW),
    'a stripe in the text colour': ok('box-shadow: inset 3px 0 0 0 var(--cds-text-primary)', ROW),
    'two shadows': ok('box-shadow: inset 3px 0 0 0 var(--cds-text-accent), inset -3px 0 0 0 var(--cds-text-accent)', ROW),
    'the stripe with extra spaces': ok('box-shadow: inset  3px 0 0 0 var(--cds-text-accent)', ROW),
    'the stripe set twice with junk': ok(STRIPE + ' x', ROW),
    'no shadow': ok('box-shadow: none', ROW),
    'a colour on the row': ok('color: var(--cds-text-accent)', ROW),
    'a weight on the row': ok('font-weight: 500', ROW),
    'a background on the row': ok('background-color: var(--cds-text-accent)', ROW),
    'an outline on the row (looks like focus)': ok('outline: 1px dashed var(--cds-text-accent)', ROW),
    'a border on the row': ok('border-left: 3px solid var(--cds-text-accent)', ROW),
    'the box-shadow word inside another property': ok('--box-shadow: inset 3px 0 0 0 var(--cds-text-accent)', ROW),
  }
  for (const [why, css] of Object.entries(bad)) assert.throws(() => skin.checkTypeCss(css), Error, `should refuse: ${why}`)
  // Allowed variants still pass.
  assert.equal(skin.checkTypeCss(ok('font-size: 13px; font-weight: 700 !important;')), 1)
  assert.equal(skin.checkTypeCss(ok('color: var(--cds-text-accent)') + ' .dframe-sidebar { --df-row-font: 12px }'), 2)
  assert.equal(skin.checkTypeCss(ok('color: var(--cds-text-primary)') + ' ' + ok('color: var(--cds-text-accent)', OPEN)), 2)
  assert.equal(skin.checkTypeCss(ok('color: var(--cds-text-accent)', CUR)), 1)
  assert.equal(skin.checkTypeCss(ok('color: var(--cds-text-accent); font-weight: 500', ACT)), 1)
  assert.equal(skin.checkTypeCss(ok('color: var(--cds-text-accent); font-weight: 500 !important', CUR)), 1)
  assert.equal(skin.checkTypeCss(ok(STRIPE + ' !important', ROW)), 1)
  assert.equal(skin.checkTypeCss(ok(STRIPE + ';', ROW)), 1)
  assert.equal(skin.checkTypeCss(ok('box-shadow:inset 3px 0 0 0 var(--cds-text-accent)', ROW)), 1, 'no space after the colon is fine')
  assert.equal(skin.checkTypeCss('/* a */ ' + ok('font-weight: 600') + ' /* b */ ' + ok('font-size: 12px') + ' /* c */'), 2, 'comments between rules are fine')
})

test('helperPresets never offers a preset named like a type action', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-type-p-'))
  try {
    mkdirSync(path.join(parent, 'p'))
    writeFileSync(path.join(parent, 'p', 'nord.css'), NORD)
    writeFileSync(path.join(parent, 'p', 'type-on.css'), NORD)
    writeFileSync(path.join(parent, 'p', 'type-off.css'), NORD)
    assert.deepEqual(Object.keys(skin.helperPresets(path.join(parent, 'p')).map), ['nord'])
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

// ---- The real CORE and helper, with a fake Claude that knows both markers ----
function fakeClaude() {
  const app = new EventEmitter()
  app.getVersion = () => '4.4212.0'
  const mkPage = (id) => {
    const p = new EventEmitter()
    const has = (m) => ([...p.sheets.values()].some((c) => c.includes(m)) ? '1' : '')
    Object.assign(p, { id, destroyed: false, sheets: new Map(), next: 1, url: 'https://claude.ai/chat', loading: false, getURL: () => p.url, isLoading: () => p.loading, getType: () => 'window', isDestroyed: () => p.destroyed,
      insertCSS: async (css) => { const k = String(p.next++); p.sheets.set(k, css); return k },
      removeInsertedCSS: async (k) => { p.sheets.delete(k) },
      executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => code.includes('--reskin-type') && !code.includes('surface1') ? has('--reskin-type')
        : code.includes('--reskin-active') && !code.includes('surface1') ? has('--reskin-active') : {},
      reload: () => { p.sheets.clear(); setTimeout(() => p.emit('did-finish-load'), 2) } })
    return p
  }
  const pages = [mkPage(1)]
  const electron = { app, nativeTheme: { shouldUseDarkColors: true }, webContents: { getAllWebContents: () => pages.filter((p) => !p.destroyed) } }
  const mods = { fs: nodeFs, crypto: { randomUUID, createHash } }
  const fast = (f, ms) => setTimeout(f, Math.max(1, Math.round((ms ?? 0) / 100)))
  const ctx = { process: { execPath: '/x', pid: 77, uptime: () => 5, getuid: () => uid, getBuiltinModule: (n) => (n === 'module' ? { createRequire: () => () => electron } : mods[n]) },
    URL, Promise, setTimeout: fast, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {}, Map, Set, String, Error, Date, Math, JSON, Object, Number, Uint8Array, TextDecoder, Array }
  return { app, pages, ctx, mkPage }
}
async function vmRun(c, code) {
  const { createContext, runInContext } = await import('node:vm')
  c.vm ??= createContext(c.ctx)
  return runInContext(code, c.vm)
}
const tmp = () => { const parent = mkdtempSync(path.join(tmpdir(), 'skin-type-')); return { dir: path.join(parent, 'claude-skin'), done: () => rmSync(parent, { recursive: true, force: true }) } }
async function ask(c, dir, sessionId, action, waitMs = 3_000) {
  const p = sendSwitch(nodeFs, dir, sessionId, action, { randomUUID, waitMs, gap: 5 })
  await new Promise((r) => setTimeout(r, 15))
  await vmRun(c, 'globalThis.__reskin?.helper?.kick()') // a removal may already have finished (the folder watch saw it)
  return p
}
const put = (c, dir, sessionId, action) => { void sendSwitch(nodeFs, dir, sessionId, action, { randomUUID, waitMs: 1_000, gap: 5 }) }
const kinds = (p) => [...p.sheets.values()].map((c) => (c.includes('--reskin-type') ? 'type' : c.includes('--reskin-active') ? 'colour' : 'other')).sort()
const settle = () => new Promise((r) => setTimeout(r, 40))

async function started(typeSheets = { headers: TYPE }) {
  const c = fakeClaude()
  const d = tmp()
  await vmRun(c, skin.setCode(NORD))
  const r = await vmRun(c, skin.helperCode(PRESETS, d.dir, typeSheets))
  return { c, d, session: r.session }
}

test('type on: its own sheet beside the colours, with its own marker; check reports it', async () => {
  const { c, d, session } = await started()
  try {
    const { ack } = await ask(c, d.dir, session, 'type-on')
    assert.equal(ack.ok, true, JSON.stringify(ack))
    assert.equal(ack.applied, 1)
    assert.deepEqual(kinds(c.pages[0]), ['colour', 'type'])
    const typeSheet = [...c.pages[0].sheets.values()].find((s) => s.includes('--reskin-type'))
    assert.ok(typeSheet.startsWith(TYPE) && !typeSheet.includes('--reskin-active'))
    const chk = (await ask(c, d.dir, session, 'check')).ack
    assert.equal(chk.type, 'on')
    assert.equal(chk.current, 'nord')
  } finally { d.done() }
})

test('colour switch and colour Off leave the type sheet; a reload puts it back while the colours are off', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    assert.equal((await ask(c, d.dir, session, 'dracula')).ack.ok, true)
    assert.deepEqual(kinds(c.pages[0]), ['colour', 'type'])
    assert.equal((await ask(c, d.dir, session, 'off')).ack.ok, true)
    assert.deepEqual(kinds(c.pages[0]), ['type'])
    assert.notEqual(await vmRun(c, 'globalThis.__reskin.hooks'), null, 'hooks stay while the type sheet is on')
    c.pages[0].reload()
    await settle()
    assert.deepEqual(kinds(c.pages[0]), ['type'], 'the reload hook put the type sheet back, and no colours')
    // A new window gets it too.
    const w = c.mkPage(2)
    c.pages.push(w)
    c.app.emit('web-contents-created', {}, w)
    w.emit('did-finish-load')
    await settle()
    assert.deepEqual(kinds(w), ['type'])
  } finally { d.done() }
})

test('type off: removes only the type sheet; with the colours off too, no hooks are left', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    const off = (await ask(c, d.dir, session, 'type-off')).ack
    assert.equal(off.ok, true, JSON.stringify(off))
    assert.deepEqual(kinds(c.pages[0]), ['colour'])
    assert.equal((await ask(c, d.dir, session, 'check')).ack.type, 'off')
    await ask(c, d.dir, session, 'type-on')
    await ask(c, d.dir, session, 'off')
    await ask(c, d.dir, session, 'type-off')
    assert.deepEqual(kinds(c.pages[0]), [])
    assert.equal(await vmRun(c, 'globalThis.__reskin.hooks'), null)
  } finally { d.done() }
})

test('type off is proven: a sheet that will not come off gets the page reloaded', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    c.pages[0].removeInsertedCSS = async () => {} // Electron accepts the removal and leaves the sheet
    const off = (await ask(c, d.dir, session, 'type-off')).ack
    assert.equal(off.ok, true, JSON.stringify(off))
    assert.equal(off.reloaded, 1)
    await settle()
    assert.deepEqual(kinds(c.pages[0]), ['colour'], 'after the reload only the colours came back')
  } finally { d.done() }
})

test('remove clears both sheets and the state', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    await ask(c, d.dir, session, 'remove')
    for (let i = 0; i < 100 && (await vmRun(c, 'globalThis.__reskin')) !== undefined; i++) await settle()
    assert.deepEqual(kinds(c.pages[0]), [])
    assert.equal(await vmRun(c, 'globalThis.__reskin'), undefined)
  } finally { d.done() }
})

test('debugger remove clears the type sheet; a batch final Off (no all) leaves it', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    const batchOff = await vmRun(c, skin.setCode(null))
    assert.equal(batchOff.errors.length, 0)
    assert.deepEqual(kinds(c.pages[0]), ['type'])
    const rem = await vmRun(c, skin.setCode(null, false, false, false, true))
    assert.equal(rem.errors.length, 0, String(rem.errors))
    assert.deepEqual(kinds(c.pages[0]), [])
    assert.equal(await vmRun(c, 'globalThis.__reskin.type.css'), null)
  } finally { d.done() }
})

test('a new tick apply keeps the type sheet on, and replaces hooks made by older code', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    await vmRun(c, 'delete globalThis.__reskin.hooks.v') // as if older code had made them
    await vmRun(c, skin.setCode(DRACULA))
    assert.equal(await vmRun(c, 'globalThis.__reskin.hooks.v'), 3)
    c.pages[0].reload()
    await settle()
    assert.deepEqual(kinds(c.pages[0]), ['colour', 'type'])
  } finally { d.done() }
})

test('a state from older code (no type slot) gets one on the next apply', async () => {
  const c = fakeClaude()
  await vmRun(c, 'globalThis.__reskin = { css: null, keys: new Map(), queues: new Map(), hooks: null, errors: [] }')
  const r = await vmRun(c, skin.setCode(NORD))
  assert.equal(r.errors.length, 0)
  assert.equal(await vmRun(c, 'globalThis.__reskin.type.css'), null)
})

test('a helper given no type sheet refuses type-on (counted as ignored), and changes nothing', async () => {
  const { c, d, session } = await started({})
  try {
    assert.deepEqual(JSON.parse(readFileSync(path.join(d.dir, 'session.json'), 'utf8')).caps, ['check'])
    const { ack } = await ask(c, d.dir, session, 'type-on', 300)
    assert.equal(ack, null)
    assert.deepEqual(kinds(c.pages[0]), ['colour'])
  } finally { d.done() }
})

test('removal: a newer apply that starts while a removal waits is never undone by it', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    const slow = c.pages[0].removeInsertedCSS
    c.pages[0].removeInsertedCSS = async (k) => { await new Promise((r) => setTimeout(r, 8)); return slow(k) }
    put(c, d.dir, session, 'remove')
    await vmRun(c, 'globalThis.__reskin?.helper?.kick()')
    await new Promise((r) => setTimeout(r, 5))
    await vmRun(c, skin.setCode(DRACULA)) // its own timings are scaled down in this fake; what counts is the end state
    for (let i = 0; i < 40; i++) await settle()
    assert.equal(await vmRun(c, 'globalThis.__reskin?.css'), DRACULA, 'the newer skin stays')
    assert.ok(kinds(c.pages[0]).includes('colour'))
  } finally { d.done() }
})

test('reset: a reset whose reload did not take reports the type sheet still there', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    await ask(c, d.dir, session, 'off')
    c.pages[0].reload = () => { setTimeout(() => c.pages[0].emit('did-finish-load'), 2) } // the old page stays
    c.pages[0].removeInsertedCSS = async () => {}
    const r = await vmRun(c, skin.setCode(null, true, false, false, true))
    assert.match(String(r.errors), /type sheet is gone/)
    assert.equal(await vmRun(c, 'globalThis.__reskin.type.keys.size'), 1, 'the key is kept until absence is proven')
  } finally { d.done() }
})

test('typeLine: the check reports what the pages show, not only what the helper means', () => {
  const page = (t, more = {}) => ({ typeMarker: t, anchors: { sidebar: true }, typeHeaders: 22, typeCurrent: 1, ...more })
  const on = (pages, stable = true) => typeLine({ type: 'on', sample: { stable, pages } })
  assert.equal(on([page(true)]), "type: project headers with activity colours on (22 header(s); the open chat's project header found)")
  assert.match(on([page(true, { typeCurrent: 0 })]), /the open chat's project header not found now: no chat open/)
  // The sheet is in but its rules find nothing: Claude changed its sidebar. Never reported as working.
  assert.match(on([page(true, { typeHeaders: 0, typeCurrent: 0 })]), /found no project header in the sidebar .*run \/skin type off/)
  assert.match(on([page(true, { anchors: { sidebar: false } })]), /no sidebar on screen now/)
  assert.match(on([{ typeMarker: true, anchors: { sidebar: true } }]), /does not count headers yet/, 'a helper from before the header count')
  assert.match(on([page(true), page(false)]), /showing on 1 of 2 .*run \/skin type on again/)
  // An unreadable page is never left out of the count.
  assert.equal(on([page(true), { error: 'unreadable' }]), 'type: sheet on, showing on 1 of 2 Claude page(s) (1 of 2 Claude page(s) could not be read)')
  assert.match(typeLine({ type: 'off', sample: { stable: true, pages: [page(false), { error: 'unreadable' }] } }), /^type: off \(1 of 2 Claude page\(s\) could not be read\)$/)
  assert.equal(typeLine({ type: 'off', sample: { stable: true, pages: [page(false)] } }), null)
  assert.match(typeLine({ type: 'off', sample: { stable: true, pages: [page(true)] } }), /still showing on 1 of 1/)
  assert.match(on([page(true)], false), /not checked on the page/)
  assert.match(typeLine({ type: 'unknown', sample: { stable: true, pages: [page(true)] } }), /unknown sheet/)
  assert.equal(typeLine({ current: 'nord' }), null, 'an older helper with no type field: no line')
})

test('removal after a type off that did not take still cleans up, and does not claim success', async () => {
  const { c, d, session } = await started()
  try {
    await ask(c, d.dir, session, 'type-on')
    const p = c.pages[0]
    p.removeInsertedCSS = async () => {} // removal silently does nothing
    p.reload = () => { setTimeout(() => p.emit('did-finish-load'), 2) } // and a reload does not take
    const off = (await ask(c, d.dir, session, 'type-off')).ack
    assert.equal(off.ok, false)
    assert.equal(await vmRun(c, 'globalThis.__reskin.type.dirty'), true, 'still marked as maybe on')
    const rem = await vmRun(c, skin.setCode(null, false, false, false, true))
    assert.match(String(rem.errors), /type/, 'the debugger removal looked again and reports it')
  } finally { d.done() }
})

test('reset while an older type insert is still in flight: a later removal still cleans up, or says it could not', async () => {
  const { c, d, session } = await started()
  try {
    const p = c.pages[0]
    const realInsert = p.insertCSS
    let release
    p.insertCSS = (css) => (css.includes('--reskin-type') ? new Promise((r) => { release = () => r(realInsert(css)) }) : realInsert(css))
    put(c, d.dir, session, 'type-on')
    await vmRun(c, 'globalThis.__reskin.helper.kick()')
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 2))
    assert.ok(release, 'the type insert is in flight')
    await vmRun(c, skin.setCode(null, true, false, false, true)) // reset reloads the page and proves no marker
    p.removeInsertedCSS = async () => {} // from now on removals silently do nothing
    release()
    await settle()
    assert.ok(kinds(p).includes('type'), 'the late insert landed')
    assert.equal(await vmRun(c, 'globalThis.__reskin.typeDirty()'), true, 'and the slot knows it may be on')
    const rem = await vmRun(c, skin.setCode(null, false, false, false, true))
    assert.ok(!kinds(p).includes('type') || /type/.test(String(rem.errors)), 'gone, or reported')
  } finally { d.done() }
})

test('reset with two pages: an insert that lands during the proof keeps the slot marked', async () => {
  const { c, d, session } = await started()
  try {
    const p1 = c.pages[0]
    const p2 = c.mkPage(2)
    c.pages.push(p2)
    const realInsert = p1.insertCSS
    let release
    p1.insertCSS = (css) => (css.includes('--reskin-type') ? new Promise((r) => { release = () => r(realInsert(css)) }) : realInsert(css))
    put(c, d.dir, session, 'type-on')
    await vmRun(c, 'globalThis.__reskin.helper.kick()')
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 2))
    assert.ok(release, 'the type insert on page 1 is in flight')
    // Page 2's type marker read, once the reset has reloaded it, lets page 1's insert land first.
    const read2 = p2.executeJavaScriptInIsolatedWorld
    p2.executeJavaScriptInIsolatedWorld = async (world, args) => {
      if (world === 4248 && args[0].code.includes('--reskin-type') && release) { p1.removeInsertedCSS = async () => {}; const r = release; release = null; r(); await new Promise((x) => setTimeout(x, 10)) }
      return read2(world, args)
    }
    await vmRun(c, skin.setCode(null, true, false, false, true))
    await settle()
    // Since fonts (3 Nov 2026) the helper cleans up after a type change that failed (here: undone by the reset), and
    // proves that cleanup too. Either way a sheet still on a page must keep the slot marked.
    assert.ok(!kinds(p1).includes('type') || (await vmRun(c, 'globalThis.__reskin.typeDirty()')) === true, 'a sheet still on page 1 keeps the slot marked')
    const rem = await vmRun(c, skin.setCode(null, false, false, false, true))
    assert.ok(!kinds(p1).includes('type') || /type/.test(String(rem.errors)), 'gone, or reported')
  } finally { d.done() }
})

test('type on with no Claude window open fails and is not left armed for a later window', async () => {
  const { c, d, session } = await started()
  try {
    c.pages[0].url = 'about:blank' // no Claude page now
    const { ack } = await ask(c, d.dir, session, 'type-on')
    assert.equal(ack.ok, false)
    assert.match(String(ack.errors), /no Claude window is open/)
    assert.equal(await vmRun(c, 'globalThis.__reskin.type.css'), null)
  } finally { d.done() }
})

test('type off is always accepted as a cleanup, even by a helper given no type sheet', async () => {
  const { c, d, session } = await started({})
  try {
    const { ack } = await ask(c, d.dir, session, 'type-off')
    assert.equal(ack.action, 'type-off')
    assert.equal(ack.ok, true)
    assert.deepEqual(kinds(c.pages[0]), ['colour'])
  } finally { d.done() }
})
