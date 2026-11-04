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
import { FONT_KEYS, FONT_SIZES, FONT_STACKS, SIZE_LEADING, LOOK_PARTS, parseLook, fontFamily, fontKeyOf, splitFontKey, sizeLine, fontInstalled, fontLines, readPrefs, sendSwitch, typeLine, writePrivateJson } from '../skin-lib.mjs'

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

// ---- The checker and the sheets ----
test('every combination is offered and passes the checker: headers, each font, headers plus each font', () => {
  assert.deepEqual(NAMES, ['inter-tight', 'literata', 'plex', 'noto', 'roboto', 'lato', 'zen-maru'])
  // Each font alone (Claude's size) and with each size, each also with the headers (3 Nov 2026: sizes).
  assert.deepEqual(FONT_KEYS, NAMES.flatMap((n) => [n, ...FONT_SIZES.map((z) => `${n}-${z}`)]))
  // Font picker (4 Nov 2026): the helper gets the header sheet and every look part; today's font keys are compositions.
  assert.deepEqual(Object.keys(ALL), ['headers', ...LOOK_PARTS])
  for (const n of FONT_KEYS) {
    assert.equal(sheetOf(n), skin.fontCss(n))
    assert.equal(sheetOf(`headers+${n}`), TYPE + '\n' + skin.fontCss(n))
    assert.ok(!/["'\\]/.test(sheetOf(n)), 'no quotes in any font sheet')
    assert.ok(skin.checkTypeCss(sheetOf(`headers+${n}`)) >= 1)
  }
  for (const css of Object.values(ALL)) { assert.ok(skin.checkTypeCss(css) >= 1); assert.ok(css.length <= 2048) }
  assert.equal(fontFamily('zen-maru'), 'Zen Maru Gothic')
  assert.throws(() => skin.fontCss('comic'), /Not a Reskin font/)
  assert.throws(() => skin.fontCss('__proto__'), /Not a Reskin font/)
})

test('the font rule: exactly five tokens, each once, one reviewed stack, nothing else', () => {
  const INTER = 'Inter Tight, system-ui, sans-serif'
  const rule = (decls, sel = ':root, .cds-root') => `${sel} { ${decls} }`
  const five = (v = INTER, imp = ' !important') => ['--cds-font-sans', '--font-sans', '--default-font-family', '--font-claude-response', '--font-user-message'].map((p) => `${p}: ${v}${imp}`).join('; ')
  assert.equal(skin.checkTypeCss(rule(five())), 1)
  assert.equal(skin.checkTypeCss(rule(five(INTER, ''))), 1, '!important is optional')
  assert.equal(skin.checkTypeCss(rule(five('Inter Tight ,system-ui,   sans-serif'))), 1, 'spacing around commas is normalised')
  const bad = {
    'an unreviewed font': rule(five('Comic Sans, system-ui, sans-serif')),
    'a quoted name': rule(five('"Inter", system-ui, sans-serif')),
    'a stack in another order': rule(five('system-ui, Inter, sans-serif')),
    'a shorter stack': rule(five('Inter')),
    'a url in the value': rule(five('url(x), Inter')),
    'var() in the value': rule(five('var(--x), system-ui, sans-serif')),
    'two fonts mixed': rule(five().replace('--font-user-message: ' + INTER, '--font-user-message: Lato, system-ui, sans-serif')),
    'a token missing': rule(five().replace('--font-sans: ' + INTER + ' !important; ', '')),
    'a token twice': rule(five() + '; --font-sans: ' + INTER),
    'a mono token': rule(five().replace('--font-sans:', '--font-mono:')),
    'the serif heading token': rule(five() + '; --font-ui-serif: ' + INTER),
    'font-family itself': rule(five() + '; font-family: ' + INTER),
    'a hiding property': rule(five() + '; display: none'),
    'only :root': rule(five(), ':root'),
    'only .cds-root': rule(five(), '.cds-root'),
    'the selector reversed': rule(five(), '.cds-root, :root'),
    'every element': rule(five(), '*'),
    'a data-font attribute': rule(five(), ':root, .cds-root[data-font=system]'),
    'two font rules': rule(five()) + ' ' + rule(five('Lato, system-ui, sans-serif')),
    'a font rule nested in @media': `@media all { ${rule(five())} }`,
    'a comment inside the font rule': rule(five().replace('; ', '; /* x */ ')),
    'uppercase token': rule(five().replace('--font-sans', '--FONT-SANS')),
  }
  for (const [why, css] of Object.entries(bad)) assert.throws(() => skin.checkTypeCss(css), Error, `should refuse: ${why}`)
})

test('the release switch: no font sheets unless fonts are shipped; the font verb is refused in a release copy', () => {
  assert.deepEqual(Object.keys(skin.helperTypeSheets(path.join(tool, 'type'), { fonts: false })), ['headers'])
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-font-release-'))
  try {
    for (const f of readdirSync(tool)) if (/\.(mjs|sh)$/.test(f)) copyFileSync(path.join(tool, f), path.join(d, f))
    cpSync(path.join(tool, 'presets'), path.join(d, 'presets'), { recursive: true })
    const home = path.join(d, 'home'); mkdirSync(home)
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47694', RESKIN_LOG: 'off' }
    const go = (args) => spawnSync(process.execPath, [path.join(d, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 30_000, env })
    for (const [file, shipped] of [['{"oneClick": false}', false], ['{"oneClick": false, "font": true}', true], ['not json', false]]) {
      writeFileSync(path.join(d, 'release.json'), file)
      const r = go(['font', 'list'])
      if (shipped) { assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^\/skin font inter-tight  \(Inter Tight/m) } else { assert.equal(r.status, 2); assert.match(r.stderr, /Fonts are not in this release/) }
    }
    writeFileSync(path.join(d, 'release.json'), '{"oneClick": false}')
    const st = go(['status'])
    assert.doesNotMatch(st.stdout, /^font:/m, 'a release copy says nothing about fonts')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- The helper: state it owns, proven transitions ----
const pairOf = (c) => vmRun(c, 'JSON.stringify(globalThis.__reskin.type.css)').then((s) => JSON.parse(s))
// The exact slot text for 'headers', a font key, or 'headers+<font key>' (font picker: composed from the parts).
const sheetOf = (key) => { const ps = key.split('+'); const f = ps.find((x) => x !== 'headers'); return skin.composeType(ALL, ps.includes('headers'), f ? parseLook(f) : []) }
const sheetIs = async (c, key) => assert.equal(await pairOf(c), key === null ? null : sheetOf(key))

test('session.json lists the font cap and fonts; a helper without font sheets has neither', async () => {
  const a = await started(ALL)
  try {
    const s = JSON.parse(readFileSync(path.join(a.d.dir, 'session.json'), 'utf8'))
    assert.deepEqual(s.caps, ['check', 'type', 'font', 'look'])
    assert.deepEqual(s.parts, LOOK_PARTS)
    assert.equal(s.gen, 8)
  } finally { a.d.done() }
  const b = await started({ headers: TYPE })
  try {
    const s = JSON.parse(readFileSync(path.join(b.d.dir, 'session.json'), 'utf8'))
    assert.deepEqual(s.caps, ['check', 'type']); assert.deepEqual(s.parts, [])
    const { ack } = await ask(b.c, b.d.dir, b.session, 'font-inter-tight')
    assert.equal(ack, null, 'a font the helper was not given is ignored as a bad request')
    assert.equal((await ask(b.c, b.d.dir, b.session, 'check')).ack.ignored, 1)
  } finally { b.d.done() }
})

test('the helper composes from what is really on: headers and a font stay independent', async () => {
  const { c, d, session } = await started(ALL)
  try {
    let { ack } = await ask(c, d.dir, session, 'type-on')
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: true, font: null }); await sheetIs(c, 'headers')
    ;({ ack } = await ask(c, d.dir, session, 'font-inter-tight'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: true, font: 'inter-tight' }); await sheetIs(c, 'headers+inter-tight')
    assert.deepEqual(kinds(c.pages[0]), ['colour', 'type'], 'one sheet in the type slot, beside the colours')
    ;({ ack } = await ask(c, d.dir, session, 'type-off'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: 'inter-tight' }); await sheetIs(c, 'inter-tight')
    ;({ ack } = await ask(c, d.dir, session, 'font-lato'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: 'lato' }); await sheetIs(c, 'lato')
    ;({ ack } = await ask(c, d.dir, session, 'font-off'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: null }); await sheetIs(c, null)
    assert.deepEqual(kinds(c.pages[0]), ['colour'])
    assert.equal(await vmRun(c, 'globalThis.__reskin.typeDirty()'), false)
  } finally { d.done() }
})

test('a change that drops a part clears and proves the slot empty first; a stuck old sheet stops the change', async () => {
  const { c, d, session } = await started(ALL)
  try {
    await ask(c, d.dir, session, 'font-inter-tight')
    // The old sheet will not come off and a reload does not clear it either: the clear is not proven.
    const p = c.pages[0]
    const stuck = [...p.sheets.entries()].find(([, v]) => v.includes('--reskin-type'))
    p.removeInsertedCSS = async () => {}
    p.reload = () => { setTimeout(() => p.emit('did-finish-load'), 2) }
    const { ack } = await ask(c, d.dir, session, 'font-lato')
    assert.equal(ack.ok, false)
    assert.equal(ack.verified, 'unknown')
    assert.match(String(ack.errors), /could not prove the old type sheet is gone, so nothing new was put on/)
    assert.ok(![...p.sheets.values()].some((v) => v.includes('Lato')), 'Lato was never put on')
    assert.ok(p.sheets.has(stuck[0]))
  } finally { d.done() }
})

test('a failed apply is cleaned up, and counts as empty only once that cleanup is proven', async () => {
  const { c, d, session } = await started(ALL)
  try {
    const p2 = c.mkPage(2); c.pages.push(p2)
    const real = p2.insertCSS
    p2.insertCSS = async (css) => (css.includes('--reskin-type') ? 'lost' : real(css)) // the sheet never shows on page 2
    const { ack } = await ask(c, d.dir, session, 'font-inter-tight')
    assert.equal(ack.ok, false)
    assert.equal(ack.partial, true)
    assert.deepEqual(ack.verified, { headers: false, font: null }, 'the cleanup was proven')
    await sheetIs(c, null)
    assert.ok(!kinds(c.pages[0]).includes('type'), 'page 1 no longer has it either')
    // Without a proven cleanup the answer stays unknown.
    c.pages[0].removeInsertedCSS = async () => {}
    c.pages[0].reload = () => { setTimeout(() => c.pages[0].emit('did-finish-load'), 2) }
    const again = (await ask(c, d.dir, session, 'font-inter-tight')).ack
    assert.equal(again.ok, false); assert.equal(again.verified, 'unknown')
  } finally { d.done() }
})

test('the check reports headers and font apart, and an unknown sheet as unknown', async () => {
  const { c, d, session } = await started(ALL)
  try {
    await ask(c, d.dir, session, 'font-roboto')
    let { ack } = await ask(c, d.dir, session, 'check')
    assert.equal(ack.type, 'off'); assert.equal(ack.font, 'roboto')
    assert.equal(typeLine(ack), null, 'a font alone is not a leftover header sheet')
    await ask(c, d.dir, session, 'type-on')
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.type, 'on'); assert.equal(ack.font, 'roboto')
    await vmRun(c, 'globalThis.__reskin.type.css = ".x { }"')
    ;({ ack } = await ask(c, d.dir, session, 'check'))
    assert.equal(ack.type, 'unknown'); assert.equal(ack.font, 'unknown')
    assert.deepEqual(fontLines(ack), ['font: unknown sheet in the type slot: run /skin font off'])
  } finally { d.done() }
})

test('remove takes headers and font together', async () => {
  const { c, d, session } = await started(ALL)
  try {
    await ask(c, d.dir, session, 'type-on')
    await ask(c, d.dir, session, 'font-noto')
    await ask(c, d.dir, session, 'remove')
    for (let i = 0; i < 100 && (await vmRun(c, 'typeof globalThis.__reskin')) !== 'undefined'; i++) await settle()
    assert.deepEqual(kinds(c.pages[0]), [])
  } finally { d.done() }
})

test('a change that times out never applies later, and the next change waits for it to settle', async () => {
  const { c, d, session } = await started(ALL)
  try {
    const p = c.pages[0]
    const real = p.insertCSS
    let release = null
    p.insertCSS = (css) => (css.includes('Literata') ? new Promise((r) => { release = () => r(real(css)) }) : real(css))
    // The helper's own clock is fast (1/100); its 20 s change budget passes in about 200 ms.
    const first = await ask(c, d.dir, session, 'font-literata', 3_000)
    assert.equal(first.ack.ok, false)
    assert.equal(first.ack.verified, 'unknown')
    assert.ok(release, 'the Literata insert is still in flight')
    // A new request now waits for the stuck work; once it lands it is taken out again (the run was cancelled).
    const second = ask(c, d.dir, session, 'font-inter-tight', 5_000)
    await settle()
    release()
    const { ack } = await second
    assert.equal(ack.ok, true)
    assert.deepEqual(ack.verified, { headers: false, font: 'inter-tight' })
    await settle()
    assert.ok(![...p.sheets.values()].some((v) => v.includes('Literata')), 'the late Literata sheet did not stay')
    await sheetIs(c, 'inter-tight')
  } finally { d.done() }
})

// ---- The client's pure helpers ----
test('prefs keep a font only by its table name', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-font-prefs-'))
  try {
    nodeFs.chmodSync(d, 0o700)
    writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: true, font: 'inter-tight' }, randomUUID)
    assert.deepEqual(readPrefs(nodeFs, d), { last: 'nord', type: true, font: 'inter-tight' })
    // Inter was replaced by Inter Tight (3 Nov 2026): a remembered inter comes back as inter-tight; the file is not rewritten.
    writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: false, font: 'inter' }, randomUUID)
    assert.equal(readPrefs(nodeFs, d).font, 'inter-tight')
    assert.match(readFileSync(path.join(d, 'prefs.json'), 'utf8'), /"inter"/)
    for (const bad of ['Inter', 'comic', '__proto__', 'constructor', 7, true]) {
      writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: false, font: bad }, randomUUID)
      assert.equal(readPrefs(nodeFs, d).font, null, String(bad))
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('installed check: only a clean yes or no counts; everything else is failed', () => {
  assert.equal(fontInstalled({ status: 0, stdout: 'yes\n' }), 'yes')
  assert.equal(fontInstalled({ status: 0, stdout: 'no' }), 'no')
  for (const r of [null, { status: 1, stdout: 'yes' }, { status: null, stdout: '' }, { status: 0, stdout: 'yes yes' }, { error: new Error('x'), status: 0, stdout: 'yes' }, { status: 0, stdout: '' }]) assert.equal(fontInstalled(r), 'failed')
})

test('font lines: per kind of text, quotes stripped, not checked when absent or unstable, never a pass', () => {
  const page = (fonts) => ({ ready: 'complete', fonts })
  const ack = (pages, stable = true, font = 'plex') => ({ font, sample: { stable, pages } })
  const all = { paragraph: '"IBM Plex Sans", system-ui, sans-serif', list: 'IBM Plex Sans, system-ui', bold: '"IBM Plex Sans"', composer: 'IBM Plex Sans', sidebarRow: 'ui-sans-serif, system-ui' }
  assert.deepEqual(fontLines(ack([page(all)])), ['font: plex set: chat text match, reply lists match, bold match, message box match, sidebar rows DO NOT match (computed font family)'])
  assert.match(fontLines(ack([page({ paragraph: 'IBM Plex Sans', list: null })]))[0], /chat text match, reply lists not checked, bold not checked/)
  assert.deepEqual(fontLines(ack([page(all)], false)), ['font: plex set (not checked on the page)'])
  assert.deepEqual(fontLines(ack([])), ['font: plex set (not checked on the page)'])
  assert.match(fontLines(ack([page(all)]), 'no')[0], /^font: plex set, but not installed now/)
  assert.match(fontLines(ack([page(all)]), 'failed')[0], /could not check that it is installed/)
  assert.deepEqual(fontLines({ font: null }), [])
  assert.deepEqual(fontLines({}), [])
  assert.match(fontLines(ack([page({ paragraph: 'Inter', list: 'IBM Plex Sans' }), page({ paragraph: 'IBM Plex Sans' })]))[0], /chat text DO NOT match/, 'one page off is a mismatch')
  assert.doesNotMatch(JSON.stringify(fontLines(ack([page(all)]))), /render/)
})

// ---- Each sheet holds only its parts, deadlines, restore and release copies ----
test('each sheet holds only what its key says: a font rule in the header file is refused, a font sheet holds nothing else', () => {
  assert.throws(() => skin.checkTypeCss(skin.fontCss('inter-tight'), { font: false }), /may not hold a font rule/)
  assert.throws(() => skin.checkTypeCss(TYPE, { headers: false }), /font and size rules only/)
  assert.equal(skin.checkTypeCss(TYPE + '\n' + skin.fontCss('inter-tight')), 6) // five type rules (3 Nov 2026: the stripe row added) and the font rule
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-font-loader-'))
  try {
    writeFileSync(path.join(parent, 'sidebar-headers.css'), TYPE + '\n' + skin.fontCss('inter-tight'))
    const off = skin.typeSheetsWhy(parent, { fonts: false })
    assert.deepEqual(Object.keys(off.sheets), [], 'a header file carrying a font is not offered, so fonts stay off')
    assert.match(off.why, /did not pass its check/)
    const on = skin.typeSheetsWhy(parent, { fonts: true })
    assert.deepEqual(Object.keys(on.sheets), LOOK_PARTS, 'the parts alone are still offered, never the bad header file')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('font lines: a window that could not be read is not checked there, never folded into a match', () => {
  const ok = { paragraph: 'Inter Tight, system-ui', list: 'Inter Tight', bold: 'Inter Tight', composer: 'Inter Tight', sidebarRow: 'Inter Tight' }
  const line = fontLines({ font: 'inter-tight', sample: { stable: true, pages: [{ fonts: ok }, { error: 'unreadable' }] } })[0]
  assert.match(line, /chat text match on 1 of 2 windows \(not checked on the rest\)/)
  assert.doesNotMatch(line, /chat text match,/)
  const bad = fontLines({ font: 'inter-tight', sample: { stable: true, pages: [{ fonts: ok }, { error: 'unreadable' }, { fonts: { ...ok, bold: 'Lato' } }] } })[0]
  assert.match(bad, /bold DO NOT match/)
})

test('a failed apply with no time left for a proven cleanup still stops the sheet: a late insert takes itself out', async () => {
  const { c, d, session } = await started(ALL)
  try {
    // The helper's clock jumps 20 s ahead once the Inter insert starts, so no cleanup can fit before the 26 s deadline.
    let shift = 0
    const RealDate = Date
    c.ctx.Date = class extends RealDate { static now() { return RealDate.now() + shift } }
    await vmRun(c, 'globalThis.__reskin.helper.stop(true)')
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir, ALL)) // a helper that reads the shifted clock
    const p = c.pages[0]
    const real = p.insertCSS
    let release = null
    p.insertCSS = (css) => (css.includes('Inter') ? new Promise((res) => { shift = 20_000; release = () => res(real(css)) }) : real(css))
    const { ack } = await ask(c, d.dir, r.session, 'font-inter-tight', 3_000)
    assert.equal(ack.ok, false)
    assert.equal(ack.verified, 'unknown')
    assert.equal(await vmRun(c, 'globalThis.__reskin.type.css'), null, 'the failed sheet is no longer the slot sheet')
    assert.equal(await vmRun(c, 'globalThis.__reskin.typeDirty()'), true, 'the slot stays marked until a proof')
    release()
    await settle()
    assert.ok(![...p.sheets.values()].some((v) => v.includes('Inter')), 'the late Inter insert took itself out')
  } finally { d.done() }
})

test('fontName takes the short name or the full family name, in any case and spelling of spaces', async () => {
  const { fontName } = await import('../skin-lib.mjs')
  for (const [typed, name] of [['plex', 'plex'], ['IBM Plex Sans', 'plex'], ['ibm+plex+sans', 'plex'], ['ibm-plex-sans', 'plex'], ['Zen Maru Gothic', 'zen-maru'], ['zen-maru', 'zen-maru'], ['NOTO sans', 'noto'], ['Inter', 'inter-tight'], ['inter', 'inter-tight'], ['Inter Tight', 'inter-tight'], ['inter+tight', 'inter-tight']]) assert.equal(fontName(typed), name, typed)
  for (const bad of ['comic sans', '', 'sans', '__proto__', 'constructor', 'ibm']) assert.equal(fontName(bad), null, bad)
})

// ---- Sizes (3 Nov 2026): a size is part of the font key (plex-16), one exact rule beside the font rule ----
test('size keys: exact round trip, no font name looks like a sized key, no key collides with a helper word', () => {
  for (const k of FONT_KEYS) {
    const s = splitFontKey(k)
    assert.ok(s !== null, k)
    assert.equal(s.size === null ? s.name : `${s.name}-${s.size}`, k)
  }
  for (const n of [...NAMES, 'inter']) assert.doesNotMatch(n, /-\d+$/, 'no font name or alias ends in a dash and digits')
  for (const k of FONT_KEYS) assert.ok(!['headers', 'on', 'off', 'list', 'check', 'remove'].includes(k) && !k.includes('+'))
  for (const bad of ['plex-11', 'plex-17', 'plex-18', 'plex-014', 'plex-16px', 'plex-', 'plex-1e1', 'inter', 'inter-16', 'comic-16', '__proto__', 'plex--16', 'PLEX-16', '16', null, 16]) assert.equal(splitFontKey(bad), null, String(bad))
  assert.deepEqual(fontKeyOf('ibm plex sans 16'), { key: 'plex-16' })
  assert.deepEqual(fontKeyOf('inter-13'), { key: 'inter-tight-13' })
  assert.deepEqual(fontKeyOf('zen-maru-gothic-16'), { key: 'zen-maru-16' })
  assert.match(fontKeyOf('plex-17').why, /Sizes are 12 to 16/)
  assert.match(fontKeyOf('off-14').why, /No font called off/)
  assert.deepEqual(SIZE_LEADING, { 12: 18, 13: 19, 14: 20, 15: 21, 16: 22 })
})

test('size rules: * and .prose together, exactly their properties, one table row, important, beside a font rule only', () => {
  const font = skin.fontCss('plex')
  const star = (body) => `* { ${body} }\n`
  const prose = (body) => `.prose { ${body} }\n`
  const S16 = '--chat-body: 16px !important; --chat-leading: 22px !important; --cmp-font-size: 16px !important; --cmp-leading: 22px !important;'
  const P16 = 'font-size: 16px !important; line-height: 22px !important;'
  assert.equal(skin.sizeCss(16), star(S16) + prose(P16))
  assert.equal(skin.checkTypeCss(skin.fontCss('plex-16'), { headers: false }), 3)
  assert.equal(skin.checkTypeCss(TYPE + '\n' + skin.fontCss('plex-13')), 8)
  // Font picker (4 Nov 2026): the parts come in the composition order only (the font rule first, * then .prose).
  assert.throws(() => skin.checkTypeCss(prose(P16) + star(S16) + font, { headers: false }), /must follow|out of order/)
  assert.throws(() => skin.checkTypeCss(star(S16) + prose(P16) + font, { headers: false }), /out of order/)
  const refused = [
    [font + star(S16), /go together/],
    [font + prose(P16), /go together/],
    [font + star(S16) + prose('font-size: 15px !important; line-height: 21px !important;'), /same size/],
    [font + star(S16.replace('--chat-leading: 22px', '--chat-leading: 21px')) + prose(P16), /Not one of the reviewed sizes/],
    [font + star(S16.replace('--cmp-font-size: 16px', '--cmp-font-size: 15px')) + prose(P16), /Not one of the reviewed sizes/],
    [font + star(S16) + prose('font-size: 19px !important; line-height: 25px !important;'), /Not one of the reviewed sizes/],
    [font + star(S16.replace('--chat-body: 16px !important', '--chat-body: 16px')) + prose(P16), /a whole px number, important/],
    [font + star(S16) + prose('font-size: 16.0px !important; line-height: 22px !important;'), /a whole px number, important/],
    [font + star(S16) + prose('font-size: 016px !important; line-height: 22px !important;'), /a whole px number, important/],
    [font + star(S16) + prose('font-size: 1rem !important; line-height: 22px !important;'), /a whole px number, important/],
    [font + star(S16.replace(' --cmp-leading: 22px !important;', '')) + prose(P16), /must set/],
    [font + star(S16) + prose('font-size: 16px !important;'), /must set/],
    [font + star(S16 + ' --chat-body: 16px !important;') + prose(P16), /set twice/],
    [font + star(S16 + ' font-size: 16px !important;') + prose(P16), /may not be set on \*/],
    [font + star(S16) + prose(P16 + ' --chat-body: 16px !important;'), /may not be set on \.prose/],
    [font + star(S16.replace('--chat-body', '--cds-font-size-body')) + prose(P16), /may not be set on \*/],
    [font + star(S16) + star(S16) + prose(P16), /one \* size rule only/],
    [font + star(S16) + prose(P16) + prose(P16), /one \.prose size rule only/],
    [font + `:root * { ${S16} }\n` + prose(P16), /font and size rules only/],
    [font + star(S16) + `.dframe-content .prose { ${P16} }\n`, /font and size rules only/],
  ]
  // A size without a font is allowed now (Claude's font at a Reskin size).
  assert.equal(skin.checkTypeCss(star(S16) + prose(P16), { headers: false }), 2)
  for (const [css, re] of refused) assert.throws(() => skin.checkTypeCss(css, { headers: false }), re, css.slice(-120))
  assert.throws(() => skin.checkTypeCss(TYPE + '\n' + skin.sizeCss(16), { font: false }), /may not hold a size rule/)
  assert.equal(skin.checkTypeCss(TYPE + '\n' + skin.sizeCss(16)), 7)
  assert.throws(() => skin.checkTypeCss(TYPE + '\n' + font + `:root * { ${S16} }\n` + prose(P16)), /Not one of the allowed type selectors/)
  // Every generated sheet carries the size of its own key.
  for (const k of FONT_KEYS) {
    const z = splitFontKey(k).size
    const css = sheetOf(k)
    if (z === null) assert.doesNotMatch(css, /--chat-body|\.prose/)
    else { assert.ok(css.includes(`--chat-body: ${z}px`) && css.includes(`.prose { font-size: ${z}px !important; line-height: ${SIZE_LEADING[z]}px`), k) }
  }
})

test('sheets: one bad font combination means no fonts at all, never a silent gap', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-size-loader-'))
  try {
    // A header sheet that passes alone but pushes every combined sheet over the 2 KB cap.
    writeFileSync(path.join(parent, 'sidebar-headers.css'), TYPE + '\n' + `/*${'x'.repeat(2048 - TYPE.length - 200)}*/\n`)
    const w = skin.typeSheetsWhy(parent, { fonts: true })
    assert.deepEqual(Object.keys(w.sheets), ['headers'])
    assert.match(w.fontWhy, /no fonts are offered/)
  } finally { rmSync(parent, { recursive: true, force: true }) }
  const real = skin.typeSheetsWhy(path.join(tool, 'type'), { fonts: true })
  assert.equal(real.fontWhy, null)
  assert.ok(Math.max(...Object.values(real.sheets).map((x) => x.length)) <= 2048)
})

test('the helper switches sizes like fonts: unsized to sized and back clear first; type off keeps the size', async () => {
  const { c, d, session } = await started(ALL)
  try {
    let { ack } = await ask(c, d.dir, session, 'font-plex')
    assert.deepEqual(ack.verified, { headers: false, font: 'plex' }); await sheetIs(c, 'plex')
    ;({ ack } = await ask(c, d.dir, session, 'font-plex-16'))
    assert.equal(ack.ok, true); assert.deepEqual(ack.verified, { headers: false, font: 'plex-16' }); await sheetIs(c, 'plex-16')
    ;({ ack } = await ask(c, d.dir, session, 'type-on'))
    assert.deepEqual(ack.verified, { headers: true, font: 'plex-16' }); await sheetIs(c, 'headers+plex-16')
    ;({ ack } = await ask(c, d.dir, session, 'font-roboto-13'))
    assert.deepEqual(ack.verified, { headers: true, font: 'roboto-13' }); await sheetIs(c, 'headers+roboto-13')
    ;({ ack } = await ask(c, d.dir, session, 'type-off'))
    assert.deepEqual(ack.verified, { headers: false, font: 'roboto-13' }); await sheetIs(c, 'roboto-13')
    ;({ ack } = await ask(c, d.dir, session, 'font-roboto'))
    assert.deepEqual(ack.verified, { headers: false, font: 'roboto' }); await sheetIs(c, 'roboto')
    ;({ ack } = await ask(c, d.dir, session, 'font-zen-maru-12'))
    assert.deepEqual(ack.verified, { headers: false, font: 'zen-maru-12' })
    ;({ ack } = await ask(c, d.dir, session, 'font-off'))
    assert.deepEqual(ack.verified, { headers: false, font: null }); await sheetIs(c, null)
    // Keys this helper was not given are bad requests, never a guess.
    for (const bad of ['font-plex-17', 'font-plex-19', 'font-plex-016', 'font-plex-16px', 'font-inter-16']) assert.equal((await ask(c, d.dir, session, bad, 400)).ack, null, bad)
  } finally { d.done() }
})

test('prefs keep a sized key only when it is exact; proof accepts exact sized keys', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-size-prefs-'))
  try {
    nodeFs.chmodSync(d, 0o700)
    writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: true, font: 'plex-16' }, randomUUID)
    assert.equal(readPrefs(nodeFs, d).font, 'plex-16')
    for (const bad of ['plex-19', 'inter-16', 'plex-016', 'plex-16px']) {
      writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord', type: false, font: bad }, randomUUID)
      assert.equal(readPrefs(nodeFs, d).font, null, bad)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('check: size and line height are judged together, within 0.05 px; missing or partial is not a pass', () => {
  const ok = { paragraph: 'IBM Plex Sans', list: 'IBM Plex Sans', bold: 'IBM Plex Sans', composer: 'IBM Plex Sans', sidebarRow: 'IBM Plex Sans' }
  const page = (sizes) => ({ fonts: ok, sizes })
  const lines = (pages) => fontLines({ font: 'plex-16', sample: { stable: true, pages } })
  assert.equal(lines([page({ paragraph: { size: 16, line: 22.0004 }, composer: { size: 16, line: 22 } })])[1], 'size: 16px with 22px lines: chat text match, message box match (computed size and line height)')
  assert.match(lines([page({ paragraph: { size: 16, line: 21 }, composer: { size: 16, line: 22 } })])[1], /chat text DO NOT match/)
  assert.match(lines([page({ paragraph: { size: 15, line: 22 }, composer: null })])[1], /chat text DO NOT match, message box not checked/)
  assert.match(lines([page({ paragraph: { size: 16, line: 22 }, composer: { size: 16, line: 22 } }), { error: 'unreadable' }])[1], /chat text match on 1 of 2 windows/)
  assert.match(lines([page(undefined)])[1], /chat text not checked, message box not checked/)
  assert.match(lines([page({ paragraph: { size: 'x', line: 22 }, composer: { size: NaN, line: 22 } })])[1], /chat text not checked, message box not checked/)
  assert.equal(fontLines({ font: 'plex-16', sample: { stable: false, pages: [] } }).length, 1, 'an unstable look is not checked at all')
  assert.equal(fontLines({ font: 'plex', sample: { stable: true, pages: [page({ paragraph: { size: 15, line: 21 } })] } }).length, 1, 'no size line without a size')
  assert.match(fontLines({ font: 'plex-16', sample: { stable: true, pages: [] } })[0], /^font: plex-16 set/)
  assert.equal(sizeLine(13, []).startsWith('size: 13px with 19px lines'), true)
})
