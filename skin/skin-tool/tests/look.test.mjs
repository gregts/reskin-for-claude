// Fonts (3 Nov 2026): the font rule in the type slot, its exact checker, the combined sheets, the helper's own state and
// its proven transitions, the release switch, and the client's pure helpers. Run in a
// vm with a fake Claude, like type-slot.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync, copyFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_KEYS, FONT_STACKS, FONT_WEIGHTS, LOOK_ORDER, LOOK_PARTS, SECTIONS, describeLook, fontLabel, fontLines, lookKey, lookSetWants, lookOffered, lookWhy, mergeSection, parseLook, readPrefs, sendSwitch, slotOf, slotPairOk, writePrivateJson } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const uid = process.getuid()
async function loadSkin() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { helperCode, setCode }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-font-'))
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
const ALL = skin.helperTypeSheets(path.join(tool, 'type'), { fonts: true })
const NAMES = Object.keys(FONT_STACKS)

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


const sheetOf = (key) => { const ps = key.split('+'); const f = ps.find((x) => x !== 'headers'); return skin.composeType(ALL, ps.includes('headers'), f ? parseLook(f) : []) }
const slotText = (c) => vmRun(c, 'JSON.stringify(globalThis.__reskin.type.css)').then((s) => JSON.parse(s))

// ---- Looks: keys, merging, words ----
test('look keys: today\'s font keys stay as they are, every other look is ids joined by ~ in LOOK_ORDER, exactly', () => {
  assert.deepEqual(parseLook('plex'), ['ui.font.plex'])
  assert.deepEqual(parseLook('plex-16'), ['ui.font.plex', 'chat.size.16'])
  assert.equal(lookKey(['chat.size.16', 'ui.font.plex']), 'plex-16')
  assert.equal(lookKey([]), null)
  const k = 'ui.font.plex~chat.font.literata~chat.size.16~chat.weight.300~rows.font.roboto~rows.size.13~rows.weight.400~headers.font.lato~headers.size.16~headers.weight.600'
  assert.deepEqual(parseLook(k), k.split('~'))
  assert.equal(lookKey([...k.split('~')].reverse()), k)
  for (const bad of ['ui.font.plex', 'ui.font.plex~chat.size.16', 'chat.size.16~ui.font.plex', 'chat.size.16~chat.size.15', 'chat.size.17', 'chat.weight.700', 'rows.size.16', 'ui.size.14',
    'headers.weight.300', 'chat.font.comic', 'chat.font.literata~', '~chat.font.literata', 'chat.font.literata~~rows.size.13', 'headers', 'plex-17', '__proto__', 'chat.font.__proto__', 'x'.repeat(601), '', 7, null]) {
    assert.equal(parseLook(bad), null, String(bad).slice(0, 40))
  }
  assert.throws(() => lookKey(['chat.size.16', 'chat.size.15']), /one part per/)
  assert.throws(() => lookKey(['chat.size.99']), /Not a look part/)
  // Every part id is one of the tables, and no font name ends in a size.
  assert.equal(LOOK_PARTS.length, 7 + 7 + 5 + 3 + 7 + 4 + 3 + 7 + 5 + 3)
  for (const id of LOOK_PARTS) assert.ok(LOOK_ORDER.includes(slotOf(id)), id)
})

test('merging one section: the others stay, Claude\'s choices remove the part, weights only where the font has them', () => {
  let m = mergeSection([], 'chat', { font: 'literata', size: '16', weight: '300' })
  assert.deepEqual(m.ids, ['chat.font.literata', 'chat.size.16', 'chat.weight.300'])
  m = mergeSection(m.ids, 'headers', { font: 'same', size: '16', weight: '600' })
  assert.deepEqual(m.ids, ['chat.font.literata', 'chat.size.16', 'chat.weight.300', 'headers.size.16', 'headers.weight.600'])
  m = mergeSection(m.ids, 'chat', { font: 'same', size: 'claude', weight: 'claude' })
  assert.deepEqual(m.ids, ['headers.size.16', 'headers.weight.600'])
  assert.deepEqual(mergeSection(['ui.font.plex'], 'ui', { font: 'claude' }).ids, [])
  assert.match(mergeSection([], 'chat', { font: 'lato', weight: '500' }).why, /Lato has no weight 500/)
  assert.match(mergeSection(['chat.weight.500'], 'ui', { font: 'lato' }).why, /Lato has no weight 500/, 'a font for everything else that a section weight does not fit')
  assert.match(mergeSection([], 'rows', { font: 'same', size: '16' }).why, /sizes are 12, 13, 14, 15/)
  assert.match(mergeSection([], 'ui', { font: 'plex', size: '14' }).why, /keeps Claude's sizes/)
  assert.match(mergeSection([], 'chat', { font: 'comic' }).why, /No font called comic/)
  assert.match(mergeSection([], 'menus', { font: 'plex' }).why, /No section called menus/)
  assert.equal(lookWhy(['headers.font.zen-maru', 'headers.weight.600']), 'Zen Maru Gothic has no weight 600 (it has 300, 400, 500).')
  for (const [f, ws] of Object.entries(FONT_WEIGHTS)) assert.ok(Object.hasOwn(FONT_STACKS, f) && ws.every((w) => [300, 400, 500, 600].includes(w)), f)
  assert.deepEqual(describeLook(['ui.font.plex', 'chat.size.16', 'rows.weight.300']), ['Everything else: IBM Plex Sans', 'Chat text: the same font as everything else, 16px', 'Sidebar rows: the same font as everything else, light 300'])
  assert.equal(fontLabel('chat.font.literata~rows.font.roboto~headers.font.literata'), 'Literata and Roboto')
  assert.equal(fontLabel('rows.size.13'), "Claude's own font")
  assert.ok(lookOffered('plex-16', ['ui.font.plex', 'chat.size.16']))
  assert.ok(!lookOffered('plex-16', ['ui.font.plex']))
  assert.ok(slotPairOk({ headers: false, font: 'chat.font.literata~rows.size.13' }))
  assert.ok(!slotPairOk({ headers: false, font: 'rows.size.13~chat.font.literata' }))
})

test('prefs keep a look only when it is exactly canonical', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-look-prefs-'))
  try {
    nodeFs.chmodSync(d, 0o700)
    for (const [font, want] of [['chat.font.literata~rows.size.13', 'chat.font.literata~rows.size.13'], ['plex-16', 'plex-16'], ['rows.size.13~chat.font.literata', null], ['ui.font.plex', null], ['chat.size.17', null]]) {
      writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: false, font }, randomUUID)
      assert.equal(readPrefs(nodeFs, d).font, want, font)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- The parts and the checker ----
test('parts: each one exact rule set, the checker takes each alone, after the header sheet and in the largest composition', () => {
  assert.deepEqual(Object.keys(ALL), ['headers', ...LOOK_PARTS])
  for (const id of LOOK_PARTS) {
    assert.equal(ALL[id], skin.lookPartCss(id))
    assert.ok(skin.checkTypeCss(ALL[id], { headers: false }) >= 1, id)
    assert.ok(!/["'\\]/.test(ALL[id]), id)
  }
  assert.match(skin.lookPartCss('chat.font.literata'), /^\.prose, \.prose :is\(h1, h2, h3, h4, h5, h6\), \.ProseMirror\[contenteditable=true\] \{\n(  --[a-z-]+: Literata, system-ui, sans-serif !important;\n){5}  font-family: Literata, system-ui, sans-serif !important;\n\}\n$/)
  assert.equal(skin.lookPartCss('chat.weight.300'), '.prose, .ProseMirror[contenteditable=true] { font-weight: 300 !important; }\n')
  assert.equal(skin.lookPartCss('rows.size.13'), 'aside.dframe-sidebar { --df-row-font: 13px !important; }\n')
  assert.equal(skin.lookPartCss('rows.weight.300'), '.dframe-sidebar [data-row] button, .dframe-sidebar button[data-row] { font-weight: 300 !important; }\n')
  assert.match(skin.lookPartCss('headers.weight.400'), /^\.dframe-sidebar \.df-label-inset h3 span\.whitespace-nowrap\.inline-block \{ font-weight: 400 !important; \}\n$/)
  assert.equal(skin.lookPartCss('headers.weight.600').split(', ').length, 3, 'at 500 or more the active and current headers follow')
  assert.equal(skin.lookPartCss('headers.weight.500').split(', ').length, 3)
  assert.throws(() => skin.lookPartCss('chat.size.99'), /Not a look part/)
  // The largest composition fits the cap, and the cap is no more than 512 bytes above it.
  const longest = LOOK_ORDER.map((slot) => LOOK_PARTS.filter((id) => slotOf(id) === slot).reduce((a, b) => (ALL[b].length > ALL[a].length ? b : a)))
  const big = skin.composeType(ALL, true, longest)
  assert.equal(skin.checkTypeCss(big), 5 + longest.length + 1)
  assert.ok(big.length <= skin.TYPE_MAX && skin.TYPE_MAX - big.length <= 512, `${big.length} vs ${skin.TYPE_MAX}`)
  // Today's font keys keep exactly their old text.
  assert.equal(skin.fontCss('plex-16'), ALL['ui.font.plex'] + ALL['chat.size.16'])
})

test('checker: near misses of the parts are refused, and parts come once each, in order, after the header sheet', () => {
  const W = (sel, body) => `${sel} { ${body} }\n`
  const bad = {
    'another weight': W(skin.LOOK_SEL.chatWeight, 'font-weight: 450 !important;'),
    'bolder': W(skin.LOOK_SEL.chatWeight, 'font-weight: bolder !important;'),
    'chat weight 600 (not offered)': W(skin.LOOK_SEL.chatWeight, 'font-weight: 600 !important;'),
    'not important': W(skin.LOOK_SEL.chatWeight, 'font-weight: 300;'),
    'any editable box': W('.prose, [contenteditable=true]', 'font-weight: 300 !important;'),
    'every row element': W('.dframe-sidebar [data-row] *', 'font-weight: 300 !important;'),
    'rows size 16': W(skin.LOOK_SEL.rowsSize, '--df-row-font: 16px !important;'),
    'rows size by font-size': W(skin.LOOK_SEL.rowsSize, 'font-size: 13px !important;'),
    'header size 17': W(skin.LOOK_SEL.header, 'font-size: 17px !important;'),
    'header weight 600 without the emphasis selectors': W(skin.LOOK_SEL.header, 'font-weight: 600 !important;'),
    'a family on the rows without the tokens': W(skin.LOOK_SEL.rows, 'font-family: Roboto, system-ui, sans-serif !important;'),
    'a hiding property': W(skin.LOOK_SEL.rows, 'display: none !important;'),
    'a part twice': ALL['chat.weight.300'] + ALL['chat.weight.300'],
    'two weights for one section': ALL['chat.weight.300'] + ALL['chat.weight.400'],
    'out of order': ALL['rows.size.13'] + ALL['chat.weight.300'],
    'header sheet after a part': ALL['chat.weight.300'] + TYPE,
    'the size pair the wrong way round': ALL['chat.size.16'].split('\n').reverse().join('\n'),
  }
  for (const [why, css] of Object.entries(bad)) assert.throws(() => skin.checkTypeCss(css), Error, `should refuse: ${why}`)
  assert.throws(() => skin.checkTypeCss(TYPE + '\n' + ALL['chat.weight.300'], { font: false }), /may not hold a font, size or weight part/)
  assert.equal(skin.checkTypeCss(sheetOf('headers+chat.font.literata~rows.size.13~headers.weight.600')), 8)
})

// ---- The helper: composition and proof ----
test('the helper composes looks from parts, changes one part with a clear first, keeps type apart, and proves only what it put', async () => {
  const { c, d, session } = await started(ALL)
  try {
    const a = 'chat.font.literata~chat.size.16~chat.weight.300'
    let { ack } = await ask(c, d.dir, session, `font-${a}`)
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: a })
    assert.equal(await slotText(c), sheetOf(a))
    ;({ ack } = await ask(c, d.dir, session, 'type-on'))
    assert.deepEqual(ack.verified, { headers: true, font: a }); assert.equal(await slotText(c), sheetOf(`headers+${a}`))
    const b = 'chat.font.literata~chat.size.16~chat.weight.300~headers.size.16~headers.weight.600'
    ;({ ack } = await ask(c, d.dir, session, `font-${b}`))
    assert.deepEqual(ack.verified, { headers: true, font: b }); assert.equal(await slotText(c), sheetOf(`headers+${b}`))
    assert.deepEqual(kinds(c.pages[0]), ['colour', 'type'], 'still one sheet in the slot')
    // The check reports the look by its key.
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.font, b); assert.equal(ack.type, 'on')
    // A slot text that is not what the helper proved (tampered) is unknown, and the next change clears first.
    await vmRun(c, 'globalThis.__reskin.type.want = { headers: true, font: "plex" }')
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.font, 'unknown')
    ;({ ack } = await ask(c, d.dir, session, 'font-plex-16'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: 'plex-16' }, 'from unknown the whole slot is rebuilt: type is not assumed')
    assert.equal(await slotText(c), sheetOf('plex-16'))
    ;({ ack } = await ask(c, d.dir, session, 'font-off'))
    assert.deepEqual(ack.verified, { headers: false, font: null }); assert.equal(await slotText(c), null)
    // Not canonical, not offered or not a part: a bad request, never a guess.
    for (const bad of ['font-ui.font.plex', 'font-chat.size.16~ui.font.plex', 'font-chat.weight.700', 'font-rows.size.13~rows.size.14', 'font-headers', 'font-chat.font.literata~']) {
      assert.equal((await ask(c, d.dir, session, bad, 400)).ack, null, bad)
    }
  } finally { d.done() }
})

test('a helper given no parts offers none: no font or look cap, every look refused', async () => {
  const { c, d, session } = await started({ headers: TYPE })
  try {
    const s = JSON.parse(readFileSync(path.join(d.dir, 'session.json'), 'utf8'))
    assert.deepEqual(s.caps, ['check', 'type']); assert.deepEqual(s.parts, [])
    assert.equal((await ask(c, d.dir, session, 'font-chat.size.16', 400)).ack, null)
  } finally { d.done() }
})

// ---- The check ----
test('check lines for a look: per section, family, size and weight; emphasised headers expect 500 under 500 with type on', () => {
  const look = 'chat.font.literata~chat.size.16~chat.weight.300~rows.size.13~headers.weight.400'
  const page = (o) => ({ look: { paragraph: { family: 'Literata, system-ui', size: 16, line: 22, weight: 300 }, composer: { family: 'Literata', size: 16, line: 22, weight: 300 }, row: { family: 'x', size: 13, weight: 400 }, header: { family: 'x', size: 12, weight: 400 }, headerEmph: { family: 'x', size: 12, weight: 500 }, ui: { family: 'x', size: 14, weight: 400 }, ...o } })
  const ack = (pages, type = 'on') => ({ font: look, type, sample: { stable: true, pages } })
  let out = fontLines(ack([page({})]))
  assert.match(out[0], /^fonts: Chat text: Literata, 16px, light 300; Sidebar rows: .*13px; Project headers: .*regular 400/)
  assert.match(out.join('\n'), /chat text font match, size match, weight match; message box font match, size match, weight match/)
  assert.match(out.join('\n'), /session names size match/)
  assert.match(out.join('\n'), /headers weight match; active headers weight match/)
  out = fontLines(ack([page({})], 'off')).join('\n')
  assert.match(out, /active headers weight DO NOT match/, 'type off: emphasis is Claude\'s own, so 500 is not the 400 asked for')
  out = fontLines(ack([page({ composer: null })])).join('\n')
  assert.match(out, /message box font not checked, size not checked, weight not checked/, 'none shown is never a pass')
  out = fontLines(ack([page({}), page({ paragraph: { family: 'Anthropic Sans', size: 16, line: 22, weight: 300 } })])).join('\n')
  assert.match(out, /chat text font DO NOT match/)
  out = fontLines(ack([page({}), { error: 'x' }])).join('\n')
  assert.match(out, /chat text font match on 1 of 2 windows/)
  assert.match(fontLines({ font: look, sample: { stable: false, pages: [page({})] } })[0], /not checked on the page/)
})

// ---- The look verb (offline: no helper) ----
test('look verb: usage and no-helper refusals, with a LOOK line the card reads; nothing is sent', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-look-verb-'))
  try {
    const home = path.join(d, 'home'); mkdirSync(home)
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47695', RESKIN_LOG: 'off' }
    const go = (args) => spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), 'look', ...args], { encoding: 'utf8', timeout: 30_000, env })
    for (const args of [[], ['nope'], ['show', 'extra'], ['set'], ['set', 'menus'], ['set', 'chat', 'colour=red'], ['set', 'chat', 'size=16', 'size=15'], ['set', 'ui', 'font=same']]) {
      const r = go(args)
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
    }
    const r = go(['show'])
    assert.equal(r.status, 5, r.stdout + r.stderr)
    assert.match(r.stdout, /^LOOK: \{"helper":"none"\}$/m)
    assert.match(r.stdout, /No colour helper is running/)
    assert.match(r.stdout, /^RESULT: refused$/m)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- No empty proof from an unproven cleanup, no proof of a superseded state ----
test('an empty slot that is still marked dirty is unknown, never proven empty; font off then proves it', async () => {
  const { c, d, session } = await started(ALL)
  try {
    let { ack } = await ask(c, d.dir, session, 'font-chat.size.16')
    assert.equal(ack.ok, true)
    // As after a cleanup that could not prove itself: no sheet named, but the slot may still hold one.
    await vmRun(c, 'globalThis.__reskin.type.css = null; globalThis.__reskin.type.dirty = true')
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.font, 'unknown'); assert.equal(ack.type, 'unknown')
    ;({ ack } = await ask(c, d.dir, session, 'font-off'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: null })
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.font, null)
  } finally { d.done() }
})

test('a change whose sheet is replaced while it runs (a reset) is not reported as proven', async () => {
  const { c, d, session } = await started(ALL)
  try {
    const p = c.pages[0]
    const real = p.insertCSS
    p.insertCSS = async (css) => { const k = await real(css); if (css.includes('Literata')) c.ctx.__reskin.type.css = null; return k }
    const { ack } = await ask(c, d.dir, session, 'font-chat.font.literata')
    assert.equal(ack.verified, 'unknown', 'the slot text is not the composed sheet any more')
  } finally { d.done() }
})

// ---- All parts (4 Nov 2026): one font for the whole app ----
test('All parts: every part\'s own font goes, everything else takes the font, sizes and weights stay; weights still checked', () => {
  const L = ['ui.font.plex', 'chat.font.literata', 'chat.size.16', 'chat.weight.300', 'rows.font.roboto', 'headers.font.lato', 'headers.weight.400']
  assert.deepEqual(mergeSection(L, 'all', { font: 'noto' }).ids, ['ui.font.noto', 'chat.size.16', 'chat.weight.300', 'headers.weight.400'])
  assert.deepEqual(mergeSection(L, 'all', { font: 'claude' }).ids, ['chat.size.16', 'chat.weight.300', 'headers.weight.400'])
  assert.deepEqual(mergeSection(['rows.font.roboto'], 'all', { font: 'claude' }).ids, [])
  assert.match(mergeSection(['headers.weight.600'], 'all', { font: 'lato' }).why, /Lato has no weight 600/)
  assert.match(mergeSection(L, 'all', { font: 'noto', size: '14' }).why, /font only/)
  assert.match(mergeSection(L, 'all', { font: 'noto', weight: '400' }).why, /font only/)
  assert.match(mergeSection(L, 'all', { font: 'comic' }).why, /No font called comic/)
})

test('look verb: All parts takes a font only', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-look-all-'))
  try {
    const home = path.join(d, 'home'); mkdirSync(home)
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47696', RESKIN_LOG: 'off' }
    const go = (args) => spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), 'look', ...args], { encoding: 'utf8', timeout: 30_000, env })
    for (const args of [['set', 'all', 'font=same'], ['set', 'all', 'font=noto', 'size=14'], ['set', 'all', 'weight=400']]) assert.equal(go(args).status, 2, args.join(' '))
    assert.equal(go(['set', 'all', 'font=noto']).status, 5, 'well formed: refused only for want of a helper')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('look verb: All parts with claude is a real reset (never turned into same)', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-look-all2-'))
  try {
    const home = path.join(d, 'home'); mkdirSync(home)
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47697', RESKIN_LOG: 'off' }
    const r = spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), 'look', 'set', 'all', 'font=claude'], { encoding: 'utf8', timeout: 30_000, env })
    assert.equal(r.status, 5, r.stdout + r.stderr) // well formed: refused only for want of a helper
    assert.doesNotMatch(r.stdout + r.stderr, /No font called same|font name or claude/)
    const r2 = spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), 'look', 'set', 'all'], { encoding: 'utf8', timeout: 30_000, env })
    assert.equal(r2.status, 5, 'no font given means Claude\'s own')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('look set options: All parts with claude stays claude (a real reset); a part\'s claude means same; bad shapes refused', () => {
  assert.deepEqual(lookSetWants('all', ['font=claude']).want, { font: 'claude', size: 'claude', weight: 'claude' })
  assert.deepEqual(lookSetWants('all', []).want.font, 'claude')
  assert.deepEqual(lookSetWants('ui', ['font=claude']).want.font, 'claude')
  assert.deepEqual(lookSetWants('chat', ['font=claude', 'size=16']).want, { font: 'same', size: '16', weight: 'claude' })
  assert.deepEqual(lookSetWants('rows', ['font=IBM-Plex-Sans'.toLowerCase()]).want.font, 'plex')
  assert.deepEqual(mergeSection(['rows.font.roboto', 'chat.size.16'], 'all', lookSetWants('all', ['font=claude']).want).ids, ['chat.size.16'])
  for (const [sec, opts] of [['all', ['font=same']], ['all', ['size=14']], ['ui', ['font=same']], ['chat', ['colour=red']], ['chat', ['size=16', 'size=15']]]) assert.ok(lookSetWants(sec, opts).why, `${sec} ${opts}`)
})
