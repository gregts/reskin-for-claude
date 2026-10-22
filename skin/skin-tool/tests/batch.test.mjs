// Batch mode tests. Run with: node --test 'tests/*.test.mjs'   (no Claude debugger, no Chrome: every run here is refused before
// the lock is passed, or drives the real code strings against a fake Electron.)
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'
import { acquireLock, EXIT } from '../skin-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.resolve(here, '..')
const node = process.execPath
const presets = path.join(tool, 'presets')
const preset = (n) => path.join(presets, `${n}.css`)

// skin.mjs without its main(), so its pieces can be tested without ever connecting.
async function load() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) +
    '\nexport { setCode, SHOT, BATCH_STATE, runBatch, checkCss, BUDGET_MS, FALLBACK_CLOSE_MS, onBatchSignal }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-batch-'))
  writeFileSync(path.join(dir, 'm.mjs'), src)
  const m = await import(path.join(dir, 'm.mjs'))
  rmSync(dir, { recursive: true, force: true })
  return m
}
const m = await load()

// ---- fake Electron: pages remember sheets; the screenshot page script really runs against a fake DOM ----
function fakeApp({ dark = false, pages = [{ id: 1, url: 'https://claude.ai/chat' }], dom = {}, image = {} } = {}) {
  const calls = []
  const make = ({ id, url }) => {
    const page = { id, url, sheets: new Map(), next: 1, handlers: new Map() }
    return Object.assign(page, {
      getURL: () => page.url, isDestroyed: () => false, getType: () => 'window', getZoomFactor: () => dom.zoom ?? 1,
      insertCSS: async (css, opts) => { calls.push('insertCSS'); const k = String(page.next++); page.sheets.set(k, { css, origin: opts.cssOrigin }); return k },
      removeInsertedCSS: async (k) => { calls.push('removeInsertedCSS'); page.sheets.delete(k) },
      reload: () => { calls.push('reload'); page.sheets.clear(); setTimeout(() => page.handlers.get('did-finish-load')?.forEach((f) => f()), 5) },
      executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => {
        const on = [...page.sheets.values()].some((s) => s.css.includes('--reskin-active'))
        if (world !== 4245 && world !== 4246) return on ? '1' : ''
        return runPageScript(code, on, dom)
      },
      capturePage: async () => { calls.push('capturePage'); return fakeImage(image, calls) },
      on: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
      once: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
      removeListener: (e, f) => { page.handlers.set(e, (page.handlers.get(e) ?? []).filter((x) => x !== f)) },
    })
  }
  const list = pages.map(make)
  const electron = {
    app: { on() {}, removeListener() {} },
    nativeTheme: { shouldUseDarkColors: dark, themeSource: dark ? 'dark' : 'light' },
    webContents: { getAllWebContents: () => list },
    BrowserWindow: { fromWebContents: () => ({ isVisible: () => true, isMinimized: () => false }) },
  }
  return { list, electron, calls }
}

function fakeImage({ empty = false, width = 3000, height = 2000, jpegBytes = 4 } = {}, calls) {
  const jpg = Buffer.alloc(jpegBytes); jpg[0] = 0xff; jpg[1] = 0xd8; jpg[2] = 0xff
  const img = {
    isEmpty: () => empty, getSize: () => ({ width, height }),
    resize: (o) => { calls.push(`resize:${o.width}`); return img },
    toJPEG: () => jpg,
    crop: (r) => { calls.push(`crop:${r.x},${r.y},${r.width},${r.height}`); return { toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) } },
  }
  return img
}

// The real page script from SHOT, run in a fake page. `raf: false` means frames never fire (a covered window).
function runPageScript(code, on, { raf = true, innerWidth = 1500, sidebar = true, row = true, rect = { x: 0, y: 0, width: 300, height: 1000 }, blueDot = false, brokenCensus = false } = {}) {
  const el = (bg, color = 'rgb(0, 0, 0)', className = '') => ({ bg, color, className, tagName: 'SPAN', getBoundingClientRect: () => rect, getAttribute: () => null })
  const side = sidebar ? el('rgb(240, 240, 240)') : null
  const selected = row ? el('color(srgb 0 0 0 / 0.15)', 'rgb(20, 20, 20)') : null
  const dot = el(blueDot ? 'rgb(42, 120, 214)' : 'rgb(122, 162, 247)', 'rgb(0, 0, 0)', 'status-dot')
  const ctx = createContext({
    Promise, setTimeout, performance,
    window: { innerWidth },
    requestAnimationFrame: (f) => { if (raf) setTimeout(f, 1) },
    document: {
      documentElement: { marker: on ? '1' : '' }, body: el('rgb(255, 255, 255)'),
      querySelector: (s) => (s === '.dframe-sidebar' ? side : s.startsWith('.dframe-sidebar [data-selected]') ? selected : null),
      querySelectorAll: (s) => { if (brokenCensus) throw new Error('census broke'); return s === '.status-dot' ? [dot] : s === 'body *' ? [side, selected, dot].filter(Boolean) : [] },
    },
    getComputedStyle: (e) => ({ backgroundColor: e.bg, color: e.color, borderTopColor: 'rgb(0, 0, 0)', outlineColor: 'rgb(0, 0, 0)', fill: 'rgb(0, 0, 0)', getPropertyValue: () => e.marker ?? '' }),
  })
  return runInContext(code, ctx)
}

async function runInFake(code, electron) {
  electron.ctx ??= createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, URL, Promise, setTimeout, clearTimeout, Map, Set, String, Error })
  return runInContext(code, electron.ctx)
}
// A connection whose evaluate obeys its cap, like the real one.
const fakeConn = (electron, hook = () => {}) => ({
  evaluate: (code, ms) => {
    hook(code)
    return Promise.race([runInFake(code, electron), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out: waiting for Claude.')), ms))])
  },
})
const quiet = async (fn) => {
  const lines = []
  const real = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try { return { value: await fn(), lines } } finally { console.log = real }
}
const item = (n) => { const css = readFileSync(preset(n), 'utf8'); return { name: n, file: preset(n), css, modes: m.checkCss(css) } }
// Every shipped skin has both halves since 17 Oct 2026; one-mode sheets (still accepted by the tool) are cut from them.
const halfCss = (n, mode) => readFileSync(preset(n), 'utf8').split(/(?=@media \(prefers-color-scheme: )/).find((b) => b.includes(`prefers-color-scheme: ${mode}`))
const half = (n, mode) => { const css = halfCss(n, mode); return { name: `${n}-${mode}`, file: preset(n), css, modes: m.checkCss(css) } }
const LIGHT = '@media (prefers-color-scheme: light) { html { color: #0000ff } }'

test('time plan: the loop, the final step and the close all end before Claude\'s own fallback close and the 25 s killer', () => {
  const { BATCH, BUDGET_MS, FALLBACK_CLOSE_MS } = m
  const stateRead = 1_500
  // Before "opened": codesign, lsof, ps and codesign again in skin.mjs, and in skin-auto the guardian, hide and click
  // after the 25 s watchdog starts. Generous allowance; the killer and the watchdog both start no later than this.
  const beforeOpened = 4_500
  assert.ok(BATCH.loopEnd + BATCH.finalCap + BATCH.closeCap < FALLBACK_CLOSE_MS - 1_000, 'restore must never be cut off by the fallback close')
  assert.ok(BATCH.loopEnd + BATCH.finalCap <= BUDGET_MS)
  assert.ok(beforeOpened + BATCH.loopEnd + BATCH.finalCap + BATCH.closeCap < 25_000, 'the final step and the close end before the 25 s killer and watchdog')
  assert.ok(BATCH.armLimit + stateRead + BATCH.applyCap + BATCH.shotCap <= BATCH.loopEnd, 'at least one preset fits after the slowest accepted start')
  assert.equal(m.roomForItem(0), true)
  assert.equal(m.roomForItem(BATCH.loopEnd - BATCH.applyCap - BATCH.shotCap), true)
  assert.equal(m.roomForItem(BATCH.loopEnd - BATCH.applyCap - BATCH.shotCap + 1), false)
  assert.equal(BATCH.maxItems, 6)
})

test('prepareBatch: only real presets, listed once, 1 to 6, passing the stylesheet check, final previous or off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-presets-'))
  try {
    for (const n of ['nord', 'dracula', 'github']) copyFileSync(preset(n), path.join(dir, `${n}.css`))
    writeFileSync(path.join(dir, 'nord-dark.css'), halfCss('nord', 'dark'))
    const p = (n) => path.join(dir, `${n}.css`)
    const ok = m.prepareBatch(['previous', p('nord-dark'), p('github')], dir)
    assert.deepEqual(ok.items.map((i) => [i.name, i.modes]), [['nord-dark', ['dark']], ['github', ['dark', 'light']]])
    assert.throws(() => m.prepareBatch(['keep', p('nord')], dir), /previous or off/)
    assert.throws(() => m.prepareBatch(['off'], dir), /1 to 6/)
    assert.throws(() => m.prepareBatch(['off', ...Array(7).fill(p('nord'))], dir), /1 to 6/)
    assert.throws(() => m.prepareBatch(['off', p('nord'), p('nord')], dir), /twice/)
    assert.throws(() => m.prepareBatch(['off', preset('nord')], dir), /Not a preset/) // a real file, but outside this folder
    assert.throws(() => m.prepareBatch(['off', path.join(dir, '..', path.basename(dir), '..', 'x.css')], dir), /ENOENT|Not a preset/)
    writeFileSync(path.join(dir, 'Bad_Name.css'), readFileSync(preset('nord')))
    assert.throws(() => m.prepareBatch(['off', p('Bad_Name')], dir), /Not a preset/)
    writeFileSync(path.join(dir, 'loads.css'), '@media (prefers-color-scheme: dark) { html { background: url(x) } }')
    assert.throws(() => m.prepareBatch(['off', p('loads')], dir), /may not load/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('skin-auto batch: bad lists are refused before the lock, Chrome or the menu; --final works in any position', async () => {
  const run = (args, env = {}) => spawnSync(node, [autoPath(), ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } })
  const refused = (r, re) => { assert.ok([EXIT.usage, EXIT.refused].includes(r.status), r.stdout + r.stderr); assert.match(r.stdout + r.stderr, re); assert.match(r.stdout, /PORT_STATE: unknown/) }
  refused(run(['batch', 'Nord', '--dry-run']), /lowercase letters/)
  refused(run(['batch', '../presets/nord', '--dry-run']), /lowercase letters/)
  refused(run(['batch', 'nord,not-a-skin', '--dry-run']), /No such preset: not-a-skin/)
  refused(run(['batch', 'nord,nord', '--dry-run']), /twice/)
  refused(run(['batch', 'nord,dracula,tokyo-night,one,github,gruvbox,rose-pine', '--dry-run']), /1 to 6/)
  refused(run(['batch', 'nord', '--final', 'keep', '--dry-run']), /previous or off/)
  refused(run(['batch', '--dry-run']), /Usage/)
  refused(run(['batch', 'nord', 'dracula', '--dry-run']), /Usage/)
  // An accepted list gets as far as the lock (held here), so nothing at all is started.
  const port = 41000 + Math.floor(Math.random() * 10000)
  const held = await acquireLock(port)
  try {
    for (const a of [['batch', '--final', 'off', 'nord,github', '--dry-run'], ['batch', 'nord,github', '--dry-run', '--final', 'off']]) {
      const r = run(a, { SKIN_LOCK_PORT: String(port) })
      assert.equal(r.status, EXIT.refused, r.stdout + r.stderr)
      assert.match(r.stdout + r.stderr, /another skin change is running/)
    }
  } finally { await held.release() }
})

test('the new code strings are valid JavaScript', () => {
  for (const [name, code] of Object.entries({ shot: m.SHOT, state: m.BATCH_STATE, batchApply: m.setCode(LIGHT, false, true), batchFinal: m.setCode(null, false, false) })) {
    assert.doesNotThrow(() => new Script(code), name)
  }
})

test('batch: wrong-mode presets are skipped, the rest applied and shot, and the previous skin is restored exactly', async () => {
  const f = fakeApp({ dark: false })
  await runInFake(m.setCode(LIGHT), f.electron) // the user's own skin before the batch
  const b = { final: 'previous', items: [half('catppuccin', 'light'), half('tokyo-night', 'dark'), item('github')] }
  const { value: r, lines } = await quiet(() => m.runBatch(fakeConn(f.electron), Date.now(), b))
  assert.deepEqual(r.items.map((i) => i.status), ['applied', 'skipped: needs Claude in dark', 'applied'])
  assert.deepEqual(lines.filter((l) => l.startsWith('LAST_APPLIED')), ['LAST_APPLIED: catppuccin-light', 'LAST_APPLIED: github'])
  assert.ok(lines.includes('FINAL: ok'))
  assert.equal(r.finalOk, true)
  assert.equal(r.final, 'previous skin re-applied')
  assert.equal(r.claudeMode, 'light')
  assert.equal(r.items[0].mode, 'light')
  assert.ok(r.items[0].shot.window && r.items[0].shot.sidebar)
  assert.equal(r.items[0].row.verdict, 'ok')
  const sheets = [...f.list[0].sheets.values()]
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].css, LIGHT + ' html { --reskin-active: 1 !important; }')
  assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), false)
})

test('batch: final off leaves no sheet and no hooks; nothing on before also means off', async () => {
  const f = fakeApp({ dark: true })
  const { value: r } = await quiet(() => m.runBatch(fakeConn(f.electron), Date.now(), { final: 'previous', items: [item('nord')] }))
  assert.equal(r.final, 'off')
  assert.equal(r.finalOk, true)
  assert.equal(f.list[0].sheets.size, 0)
  assert.equal(runInContext('globalThis.__reskin.hooks', f.electron.ctx), null)
})

test('batch: a leftover batch test skin, or one that fails the check, is never "restored"', async () => {
  // 1. An earlier batch was cut off: its test skin is still on and marked.
  const a = fakeApp({ dark: true })
  await runInFake(m.setCode(readFileSync(preset('dracula'), 'utf8'), false, true), a.electron)
  const { value: r1 } = await quiet(() => m.runBatch(fakeConn(a.electron), Date.now(), { final: 'previous', items: [item('nord')] }))
  assert.equal(r1.final, 'off')
  assert.ok(r1.notes.some((n) => /leftover batch test skin/.test(n)))
  assert.equal(a.list[0].sheets.size, 0)
  // 2. Whatever is remembered must pass the same stylesheet check as a file.
  const b = fakeApp({ dark: true })
  await runInFake(m.setCode('html { color: #ff0000 }'), b.electron)
  const { value: r2 } = await quiet(() => m.runBatch(fakeConn(b.electron), Date.now(), { final: 'previous', items: [item('nord')] }))
  assert.equal(r2.final, 'off')
  assert.ok(r2.notes.some((n) => /did not pass the stylesheet check/.test(n)))
})

test('batch: a failed apply ends the loop, the final step still runs, later presets are "not reached"', async () => {
  const f = fakeApp({ dark: true })
  let applies = 0
  const conn = fakeConn(f.electron)
  const realEval = conn.evaluate
  // The second batch apply times out.
  conn.evaluate = (code, ms) => (/st\.apply\(.*, false, true, false\)\n\}\)\(\)$/.test(code) && ++applies === 2 ? Promise.reject(new Error('Timed out: waiting for Claude.')) : realEval(code, ms))
  const { value: r, lines } = await quiet(() => m.runBatch(conn, Date.now(), { final: 'off', items: [item('nord'), item('dracula'), item('one')] }))
  assert.deepEqual(r.items.map((i) => i.status), ['applied', 'apply failed', 'not reached (an earlier step failed)'])
  assert.equal(r.finalOk, true)
  assert.ok(lines.includes('FINAL: ok'))
  assert.equal(f.list[0].sheets.size, 0)
})

test('batch: when time runs short nothing more is started, and the final step still runs', async () => {
  const f = fakeApp({ dark: true })
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset // each batch apply "takes" 4 s on this clock
  try {
    const conn = fakeConn(f.electron, (code) => { if (/st\.apply\(.*, false, true, false\)\n\}\)\(\)$/.test(code)) offset += 4_000 })
    const { value: r } = await quiet(() => m.runBatch(conn, Date.now(), { final: 'off', items: [item('nord'), item('dracula'), item('one')] }))
    assert.deepEqual(r.items.map((i) => i.status), ['applied', 'applied', 'not reached (time)'])
    assert.equal(r.finalOk, true)
    assert.equal(f.list[0].sheets.size, 0)
  } finally { Date.now = realNow }
})

test('batch: a slow connection changes nothing; a batch that applies nothing skips the final step', async () => {
  const f = fakeApp({ dark: true })
  await assert.rejects(quiet(() => m.runBatch(fakeConn(f.electron), Date.now() - m.BATCH.armLimit - 100, { final: 'off', items: [item('nord')] })), /did not start/)
  assert.deepEqual(f.calls, [])
  const { value: r, lines } = await quiet(() => m.runBatch(fakeConn(f.electron), Date.now(), { final: 'off', items: [half('catppuccin', 'light')] }))
  assert.equal(r.items[0].status, 'skipped: needs Claude in light')
  assert.equal(r.final, 'nothing applied, nothing changed')
  assert.equal(r.finalOk, true)
  assert.ok(!lines.some((l) => l.startsWith('LAST_APPLIED')))
  assert.deepEqual(f.calls, [])
})

test('batch: an apply that times out but keeps running inside Claude cannot re-mark the restored skin as a leftover', async () => {
  const f = fakeApp({ dark: true })
  await runInFake(m.setCode(LIGHT.replace('light', 'dark')), f.electron) // the user's own dark skin
  const page = f.list[0]
  // The test apply's two marker reads hang past their 1.5 s limit, so that apply ends inside "Claude" at about 3.3 s,
  // well after the client gave up (2.5 s) and the quick final step finished: the classic late-finish race.
  const realRead = page.executeJavaScriptInIsolatedWorld
  let hangs = 0
  page.executeJavaScriptInIsolatedWorld = (world, args) => (world === 4244 && hangs < 2 && ++hangs ? new Promise(() => {}) : realRead(world, args))
  const { value: r } = await quiet(() => m.runBatch(fakeConn(f.electron), Date.now(), { final: 'previous', items: [item('nord')] }))
  assert.equal(r.items[0].status, 'apply failed')
  assert.equal(r.finalOk, true)
  await new Promise((res) => setTimeout(res, 3_500)) // let the late apply inside "Claude" finish
  assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), false)
  const sheets = [...page.sheets.values()].map((x) => x.css)
  assert.equal(sheets.length, 1)
  assert.ok(sheets[0].startsWith(LIGHT.replace('light', 'dark')), 'the late test sheet cleaned itself up; the restored skin stays')
})

test('batch: after a signal restores, the loop never applies another test skin; FINAL: ok only for a proven restore', async () => {
  const f = fakeApp({ dark: true })
  const conn = fakeConn(f.electron)
  const realEval = conn.evaluate
  let signalAt = null
  // Ctrl-C arrives while the first screenshot is still pending.
  conn.evaluate = async (code, ms) => {
    if (code === m.SHOT && signalAt === null) { signalAt = f.calls.length; await m.onBatchSignal() }
    return realEval(code, ms)
  }
  const { value: r, lines } = await quiet(() => m.runBatch(conn, Date.now(), { final: 'off', items: [item('nord'), item('dracula'), item('one')] }))
  assert.ok(signalAt !== null)
  assert.deepEqual(f.calls.slice(signalAt).filter((c) => c === 'insertCSS'), [], 'no test skin after the restore')
  assert.deepEqual(r.items.map((i) => i.status), ['applied', 'not reached (stopped by a signal)', 'not reached (stopped by a signal)'])
  assert.equal(f.list[0].sheets.size, 0)
  assert.equal(lines.filter((l) => l === 'FINAL: ok').length, 1)
  // A signal restore whose result is not proven must not print FINAL: ok.
  const g = fakeApp({ dark: true })
  const conn2 = fakeConn(g.electron)
  const real2 = conn2.evaluate
  let fired = false
  conn2.evaluate = async (code, ms) => {
    if (code === m.SHOT && !fired) { fired = true; g.list[0].executeJavaScriptInIsolatedWorld = async () => { throw new Error('page gone') }; await m.onBatchSignal() }
    return real2(code, ms)
  }
  const { lines: l2 } = await quiet(() => m.runBatch(conn2, Date.now(), { final: 'off', items: [item('nord')] }))
  assert.ok(!l2.includes('FINAL: ok'))
})

test('batch: a final step that fails is reported, never "ok"', async () => {
  const f = fakeApp({ dark: true })
  const conn = fakeConn(f.electron)
  const realEval = conn.evaluate
  conn.evaluate = (code, ms) => (code.includes('st.apply(null, ') ? Promise.reject(new Error('Timed out: waiting for Claude.')) : realEval(code, ms))
  const { value: r, lines } = await quiet(() => m.runBatch(conn, Date.now(), { final: 'off', items: [item('nord')] }))
  assert.equal(r.finalOk, false)
  assert.ok(!lines.includes('FINAL: ok'))
  assert.ok(r.notes.some((n) => /final step: Timed out/.test(n)))
})

test('screenshot: read-only, frames that never fire cost at most about 150 ms, zoom-safe sidebar crop', async () => {
  const f = fakeApp({ dom: { raf: false, innerWidth: 1200, zoom: 1.25, rect: { x: 0, y: 40.2, width: 240.4, height: 2000 } }, image: { width: 3000, height: 2000 } })
  const t = Date.now()
  const s = await runInFake(m.SHOT, f.electron)
  assert.ok(Date.now() - t < 900, 'a covered window must not stall the screenshot')
  assert.equal(s.zoom, 1.25)
  assert.ok(s.window && s.sidebar)
  // 3000 image px / 1200 CSS px = 2.5 per CSS px; rounded outward and clamped to the image.
  assert.ok(f.calls.includes('crop:0,100,601,1900'), f.calls.join(' '))
  assert.ok(f.calls.includes('resize:1600'))
  assert.deepEqual(f.calls.filter((c) => /insertCSS|removeInsertedCSS|reload/.test(c)), [])
})

test('screenshot: empty, oversized, ambiguous and unreadable cases are reported, not thrown', async () => {
  const empty = await runInFake(m.SHOT, fakeApp({ image: { empty: true } }).electron)
  assert.match(empty.windowError, /empty screenshot/)
  const big = await runInFake(m.SHOT, fakeApp({ image: { jpegBytes: 2_400_000 } }).electron)
  assert.equal(big.window, undefined)
  assert.match(big.windowError, /too large/)
  const two = fakeApp({ pages: [{ id: 1, url: 'https://claude.ai/a' }, { id: 2, url: 'https://claude.ai/b' }] })
  const amb = await runInFake(m.SHOT, two.electron)
  assert.match(amb.error, /more than one Claude page/)
  assert.ok(!two.calls.includes('capturePage'))
  const f = fakeApp()
  f.list[0].executeJavaScriptInIsolatedWorld = async () => { throw new Error('page gone') }
  const gone = await runInFake(m.SHOT, f.electron)
  assert.match(gone.pageError, /page gone/)
  assert.ok(gone.window, 'the window picture is still taken')
})

test('screenshot: counts Claude blue still painted and reports the unread dots; a broken census loses only itself', async () => {
  const clean = await runInFake(m.SHOT, fakeApp().electron)
  assert.equal(clean.census.blueLeft.n, 0)
  assert.equal(clean.census.blueLeft.truncated, false)
  assert.equal(clean.census.dots[0].bg, 'rgb(122, 162, 247)')
  assert.equal(clean.census.dots[0].cls, 'status-dot')
  const blue = await runInFake(m.SHOT, fakeApp({ dom: { blueDot: true } }).electron)
  assert.equal(blue.census.blueLeft.n, 1)
  assert.match(blue.census.blueLeft.samples[0], /span\.status-dot backgroundColor rgb\(42, 120, 214\)/)
  const broken = await runInFake(m.SHOT, fakeApp({ dom: { brokenCensus: true } }).electron)
  assert.equal(broken.census, undefined)
  assert.match(broken.censusError, /census broke/)
  assert.ok(broken.page.row && broken.window, 'the main read and the picture survive')
  // A census that hangs costs at most its own 400 ms, never the main read.
  const slow = fakeApp()
  const real = slow.list[0].executeJavaScriptInIsolatedWorld
  slow.list[0].executeJavaScriptInIsolatedWorld = (world, a) => (world === 4246 ? new Promise(() => {}) : real(world, a))
  const t = Date.now()
  const hung = await runInFake(m.SHOT, slow.electron)
  assert.ok(Date.now() - t < 1_200)
  assert.match(hung.censusError, /timed out/)
  assert.ok(hung.page.row && hung.window)
})

test('colours: rgb, rgba, color(srgb), see-through rows laid over the sidebar, unreadable = unknown', () => {
  assert.deepEqual(m.parseColor('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 })
  assert.equal(m.parseColor('rgba(0, 0, 0, 0.5)').a, 0.5)
  assert.deepEqual(m.parseColor('color(srgb 1 1 1 / 0.15)'), { r: 1, g: 1, b: 1, a: 0.15 })
  assert.equal(m.parseColor('oklch(0.5 0.1 200)'), null)
  assert.equal(m.parseColor(null), null)
  assert.ok(Math.abs(m.contrast({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }) - 21) < 0.01)
  const page = (row, color = 'rgb(20, 20, 20)') => ({ bodyBg: 'rgb(255, 255, 255)', sidebarBg: 'rgb(240, 240, 240)', row: { bg: row, color } })
  assert.equal(m.judgeRow(page('color(srgb 0 0 0 / 0.15)')).verdict, 'ok')
  const faint = m.judgeRow(page('rgba(0, 0, 0, 0.01)'))
  assert.equal(faint.verdict, 'check')
  assert.match(faint.why, /barely differs/)
  assert.match(m.judgeRow(page('rgb(0, 0, 0)', 'rgb(30, 30, 30)')).why, /below 4.5:1/)
  assert.equal(m.judgeRow(page('oklch(0.5 0 0)')).verdict, 'unknown')
  assert.equal(m.judgeRow({ ...page('rgb(0,0,0)'), bodyBg: 'rgba(0, 0, 0, 0)' }).verdict, 'unknown')
  assert.match(m.judgeRow({ bodyBg: 'rgb(255, 255, 255)', row: null }).why, /select a chat/)
})

test('saving: own new folder under previews, report first without image data, checked image bytes, escaped contact sheet', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skin-previews-'))
  try {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]).toString('base64')
    const report = () => ({
      claudeMode: 'light', themeSource: 'system', final: 'off', finalOk: true, notes: [],
      items: [
        { n: 1, name: 'one-light', mode: 'light', status: 'applied', notes: ['<script>alert(1)</script>'], shot: { window: jpg, sidebar: png }, row: { verdict: 'ok', dE: 0.05, contrast: 7, why: '' } },
        { n: 2, name: 'nord', status: 'skipped: needs Claude in dark', notes: [] },
        { n: 3, name: 'github-light', mode: 'light', status: 'applied', notes: [], shot: { window: Buffer.from('nope').toString('base64') } },
      ],
    })
    const now = new Date(2026, 9, 12, 9, 5, 7)
    const folder = m.writeBatch(report(), path.join(root, 'previews'), now)
    assert.equal(path.basename(folder), 'batch-20261012-090507')
    assert.deepEqual(readdirSync(folder).sort(), ['01-one-light-light-sidebar.png', '01-one-light-light.jpg', 'index.html', 'report.json'])
    const saved = readFileSync(path.join(folder, 'report.json'), 'utf8')
    assert.ok(!saved.includes(jpg.slice(0, 6)) && !saved.includes('"shot"'))
    assert.match(saved, /not a JPEG/)
    const html = readFileSync(path.join(folder, 'index.html'), 'utf8')
    assert.ok(!/<script/i.test(html) && !/https?:/.test(html))
    assert.match(html, /&lt;script&gt;/)
    assert.ok(html.includes(`src="data:image/jpeg;base64,${jpg}"`) && html.includes(`src="data:image/png;base64,${png}"`), 'pictures embedded, so the page works on its own')
    assert.throws(() => m.writeBatch(report(), path.join(root, 'previews'), now), /EEXIST/) // never reuses a folder
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a successful normal apply, remove or reset clears the batch mark', async () => {
  for (const code of [m.setCode(readFileSync(preset('dracula'), 'utf8')), m.setCode(null), m.setCode(null, true)]) {
    const f = fakeApp({ dark: true })
    await runInFake(m.setCode(readFileSync(preset('nord'), 'utf8'), false, true), f.electron)
    assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), true)
    const r = await runInFake(code, f.electron)
    assert.deepEqual([...r.errors], [])
    assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), false)
  }
})

test('a normal apply or remove clears the batch mark only when it succeeded', async () => {
  const f = fakeApp({ dark: true })
  await runInFake(m.setCode(readFileSync(preset('nord'), 'utf8'), false, true), f.electron)
  assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), true)
  f.list[0].executeJavaScriptInIsolatedWorld = async () => '' // the marker never shows: apply fails
  await runInFake(m.setCode(readFileSync(preset('dracula'), 'utf8')), f.electron)
  assert.equal(runInContext('globalThis.__reskin.batch', f.electron.ctx), true)
})
