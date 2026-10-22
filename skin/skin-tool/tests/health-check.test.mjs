// Health check (17 Oct 2026): the read-only `check` through the colour helper.
// The judge is pure; the helper side runs for real (the real CORE and installHelper in a vm with a fake Claude); the page
// side runs against a fake document; the client runs end to end through skin-auto.mjs when Claude is running.
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELPER_GEN, HEALTH_PARTS, expectedHealth, healthReport, judgeHealth, parsePs, sendSwitch, CLAUDE_BINARY } from '../skin-lib.mjs'
import { outcome } from '../skin-log.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const uid = process.getuid()
async function loadSkin() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { helperCode, setCode, HEALTH_PAGE }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-hc-'))
  writeFileSync(path.join(d, 'skin.mjs'), src)
  const m = await import(path.join(d, 'skin.mjs'))
  rmSync(d, { recursive: true, force: true })
  return m
}
const skin = await loadSkin()
const NORD = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
const DRACULA = readFileSync(path.join(tool, 'presets', 'dracula.css'), 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
const cssOf = (n) => (n === 'nord' ? NORD : n === 'dracula' ? DRACULA : null)
const opts = { cssOf, digestOf: sha, tested: ['2.42304.0'] }

// A page that shows exactly what the preset promises for `mode`.
function goodPage(css, mode, over = {}) {
  const want = expectedHealth(css, mode)
  const parts = Object.fromEntries(Object.keys(HEALTH_PARTS).map((k) => [k, k in want ? { on: true, v: want[k] } : { on: false, v: null }]))
  if ('pulseWaiting' in want) parts.pulsePaint = { on: true, v: want.pulseWaiting } // a dot painting one of the four colours
  return { ready: 'complete', marker: true, scheme: mode, anchors: { root: true, sidebar: true, content: true, rows: true }, parts, ...over }
}
const ackOf = (pages, over = {}) => ({ ok: true, action: 'check', current: 'nord', digest: sha(NORD), version: '2.42304.0', sample: { stable: true, pages }, ...over })

test('expectedHealth reads every place from a preset, per mode', () => {
  const d = expectedHealth(NORD, 'dark'), l = expectedHealth(NORD, 'light')
  const declared = Object.keys(HEALTH_PARTS).length - 1 // pulsePaint is judged against the four dot colours, not declared itself
  assert.equal(Object.keys(d).length, declared)
  assert.equal(d.sidebarBg, '#252a33'); assert.equal(d.dfSelected, '#424a5c'); assert.equal(d.pulseWaiting, '#fab219'); assert.equal(d.textClass, '#d8dee9')
  assert.equal(l.pulseWaiting, '#965001'); assert.equal(l.surface2, '#ffffff'); assert.equal(l.contentBg, '#eceff4')
  // Every shipped preset declares every place in both halves (the check covers the whole set).
  for (const f of nodeFs.readdirSync(path.join(tool, 'presets')).filter((x) => x.endsWith('.css') && !x.startsWith('dotcheck-'))) {
    const css = readFileSync(path.join(tool, 'presets', f), 'utf8')
    for (const m of ['dark', 'light']) assert.equal(Object.keys(expectedHealth(css, m)).length, declared, `${f} ${m}`)
  }
})

test('judge: pass, with optional places off screen listed, judged per page scheme', () => {
  const p = goodPage(NORD, 'light')
  p.parts.surface2 = { on: false, v: null }; p.parts.pulseWaiting = { on: false, v: null }
  // Claude reports rgb() for painted colours: the same colour in another form still passes.
  p.parts.bodyBg = { on: true, v: 'rgb(236, 239, 244)' }
  const j = judgeHealth(ackOf([p], { dark: true }), opts) // global dark is only reported; the page says light
  assert.equal(j.verdict, 'pass', j.why); assert.equal(j.mode, 'light')
  assert.deepEqual(j.absent.sort(), ['cards', 'session dot (Claude asked)'])
  const r = healthReport(j, ackOf([p]), opts.tested)
  assert.equal(r.code, 0); assert.match(r.lines[0], /^health: pass/); assert.ok(r.lines.some((l) => /^checked: light mode only/.test(l)))
  assert.ok(!r.lines.some((l) => /^untested|^Repair/.test(l)))
})

test('judge: a fully see-through page background is listed as not checked, never a miss; the chat area still decides', () => {
  const p = goodPage(NORD, 'dark')
  p.parts.bodyBg = { on: true, v: 'rgba(0, 0, 0, 0)' }
  const j = judgeHealth(ackOf([p]), opts)
  assert.equal(j.verdict, 'pass', j.why); assert.deepEqual(j.seeThrough, ['page background'])
  const r = healthReport(j, ackOf([p]), opts.tested)
  assert.ok(r.lines.some((l) => l === 'not checked (see-through on this Claude; the chat area is checked instead): page background'))
  // The chat area showing the wrong colour still fails, and a half see-through page background is still a miss.
  p.parts.contentBg = { on: true, v: 'rgb(255, 255, 255)' }
  assert.equal(judgeHealth(ackOf([p]), opts).verdict, 'fail')
  const q = goodPage(NORD, 'dark'); q.parts.bodyBg = { on: true, v: 'rgba(0, 0, 0, 0.5)' }
  assert.equal(judgeHealth(ackOf([q]), opts).verdict, 'fail')
})

test('judge: a place that differs fails and names it; the report carries the repair path and exit 1', () => {
  const p = goodPage(NORD, 'dark')
  p.parts.sidebarBg = { on: true, v: 'rgb(31, 30, 29)' }
  p.parts.pulseError = { on: true, v: '#123456' }
  const j = judgeHealth(ackOf([p]), opts)
  assert.equal(j.verdict, 'fail')
  assert.ok(j.misses.some((m) => m.startsWith('sidebar is rgb(31, 30, 29), expected #252a33')))
  assert.ok(j.misses.some((m) => m.startsWith('session dot (error)')))
  const r = healthReport(j, ackOf([p]), opts.tested)
  assert.equal(r.code, 1); assert.ok(r.lines.some((l) => l.startsWith('Repair: /skin off')))
})

test('judge: a missing frame is "structure changed", before any colour verdict', () => {
  const p = goodPage(NORD, 'dark', { anchors: { root: true, sidebar: false, content: true, rows: false } })
  p.parts.sidebarBg = { on: false, v: null }
  const j = judgeHealth(ackOf([p]), opts)
  assert.equal(j.verdict, 'structure'); assert.match(j.why, /the sidebar/)
  assert.equal(healthReport(j, ackOf([p])).code, 1)
})

test('judge: unknown, never pass, for every kind of not knowing', () => {
  const p = goodPage(NORD, 'dark')
  const cases = {
    busy: ackOf([p], { busy: true, ok: false }),
    unstable: ackOf([p], { sample: { stable: false, pages: [p] } }),
    noPages: ackOf([]),
    noSample: ackOf([p], { ok: false, sample: null, errors: ['timed out'] }),
    unreadablePart: ackOf([{ ...p, parts: { ...p.parts, accentFill: { on: true, v: null } } }]),
    coreOffScreen: ackOf([{ ...p, parts: { ...p.parts, contentBg: { on: false, v: null } } }]),
    unreadablePage: ackOf([p, { error: 'unreadable' }]),
    badScheme: ackOf([{ ...p, scheme: 'sepia' }]),
    notAPreset: ackOf([p], { current: 'unknown' }),
    changedOnDisk: ackOf([p], { digest: sha(NORD + ' ') }),
    goneFromDisk: ackOf([p], { current: 'gone' }),
    noDigest: ackOf([p], { digest: null }),
  }
  for (const [name, a] of Object.entries(cases)) {
    const j = judgeHealth(a, opts)
    assert.equal(j.verdict, 'unknown', name)
    assert.equal(healthReport(j, a).code, 0, name)
  }
  assert.match(judgeHealth(cases.changedOnDisk, opts).why, /changed since this helper started.*--tick/)
})

test('judge: Off is proven by the marker on at least one read window', () => {
  const off = (pages) => judgeHealth(ackOf(pages, { current: 'off', digest: null }), opts)
  assert.equal(off([{ ...goodPage(NORD, 'dark'), marker: false }]).verdict, 'none')
  assert.equal(off([goodPage(NORD, 'dark')]).verdict, 'fail') // marker still there after Off
  assert.equal(off([]).verdict, 'unknown') // no window: nothing proven
  assert.equal(off([{ error: 'unreadable' }]).verdict, 'unknown')
})

test('judge: a skin missing from a window fails; the untested line shows on a new Claude', () => {
  assert.equal(judgeHealth(ackOf([goodPage(NORD, 'dark'), { ...goodPage(NORD, 'dark'), marker: false }]), opts).verdict, 'fail')
  const a = ackOf([goodPage(NORD, 'dark')], { version: '3.0.0' })
  const j = judgeHealth(a, opts)
  assert.equal(j.verdict, 'pass'); assert.equal(j.untested, true)
  assert.ok(healthReport(j, a, opts.tested).lines.some((l) => /^untested: Claude 3\.0\.0 .*2\.42304\.0/.test(l)))
  // A strange version string is never printed.
  assert.equal(judgeHealth(ackOf([goodPage(NORD, 'dark')], { version: '1; rm -rf' }), opts).version, null)
})

test('judge: a core place the skin does not declare is unknown, never a silent pass', () => {
  const noAccent = NORD.replace(/--cds-role-accent-fill:[^;]+;/g, '')
  const p = goodPage(NORD, 'dark'); p.parts.accentFill = { on: true, v: '#ff0000' }
  const o = { ...opts, cssOf: () => noAccent }
  const j = judgeHealth(ackOf([p], { digest: sha(noAccent) }), o)
  assert.equal(j.verdict, 'unknown'); assert.match(j.why, /does not declare accent colour/)
  // A dark-only skin while Claude shows light: nothing to compare, so unknown, not pass.
  const darkOnly = NORD.slice(0, NORD.search(/@media \(prefers-color-scheme: light\)/))
  const l = judgeHealth(ackOf([goodPage(NORD, 'light')], { digest: sha(darkOnly) }), { ...opts, cssOf: () => darkOnly })
  assert.equal(l.verdict, 'unknown'); assert.match(l.why, /no half for this mode/)
})

test('log: a direct check run is summarised by its verdict, never as a debugger run', () => {
  const rec = (output, exitCode, result) => ({ command: 'node skin-auto.mjs check', steps: [{ via: 'health check (read only)', exitCode, output }], shown: '', result, exitCode, portBefore: 'closed', portAfter: 'closed' })
  assert.match(outcome(rec('health: pass (skin nord shows its own colours in every place checked)\nRESULT: ok', 0, 'ok')), /health check: pass \(skin nord/)
  assert.match(outcome(rec('health: unknown (Claude was busy changing pages while it looked; run the check again)\nRESULT: ok', 0, 'ok')), /health check: unknown/)
  assert.match(outcome(rec('health: FAIL (2 place(s) do not show the skin\'s colour)\n  sidebar is rgb(1, 2, 3), expected #252a33\nRESULT: failed', 1, 'failed')), /health check: FAIL/)
  assert.match(outcome(rec('health: helper not answering (no reply in 10 s; it may be stuck)\nRESULT: failed', 1, 'failed')), /health check: helper not answering/)
  assert.doesNotMatch(outcome(rec('health: pass (x)', 0, 'ok')), /one click|LEFT OPEN/)
})

// ---- The helper side: the real CORE and helper in a vm, with a fake Claude ----
function fakeClaude(pageAnswer) {
  const app = new EventEmitter()
  app.getVersion = () => '2.42304.0'
  const polls = []
  const mkPage = (id) => {
    const p = new EventEmitter()
    Object.assign(p, { id, destroyed: false, sheets: new Map(), next: 1, inserts: 0, url: 'https://claude.ai/chat', loading: false, getURL: () => p.url, isLoading: () => p.loading, getType: () => 'window', isDestroyed: () => p.destroyed,
      insertCSS: async (css) => { p.inserts++; const k = String(p.next++); p.sheets.set(k, css); return k },
      removeInsertedCSS: async (k) => { p.sheets.delete(k) },
      executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => world === 4247 ? pageAnswer(p, code)
        : code.includes('--reskin-active') && !code.includes('surface1') ? ([...p.sheets.values()].some((c) => c.includes('--reskin-active')) ? '1' : '') : {},
      reload: () => { p.sheets.clear(); setTimeout(() => p.emit('did-finish-load'), 2) } })
    return p
  }
  const pages = [mkPage(1)]
  const electron = { app, nativeTheme: { shouldUseDarkColors: true }, webContents: { getAllWebContents: () => pages.filter((p) => !p.destroyed) } }
  const mods = { fs: nodeFs, crypto: { randomUUID, createHash } }
  const fast = (f, ms) => setTimeout(f, Math.max(1, Math.round((ms ?? 0) / 100)))
  const ctx = { process: { execPath: '/x', pid: 77, uptime: () => 5, getuid: () => uid, getBuiltinModule: (n) => (n === 'module' ? { createRequire: () => () => electron } : mods[n]) },
    URL, Promise, setTimeout: fast, clearTimeout, setInterval: (f) => { polls.push(f); return { unref() {} } }, clearInterval: () => {}, Map, Set, String, Error, Date, Math, JSON, Object, Number, Uint8Array, TextDecoder, Array }
  return { pages, ctx, mkPage }
}
async function vmRun(c, code) {
  const { createContext, runInContext } = await import('node:vm')
  c.vm ??= createContext(c.ctx)
  return runInContext(code, c.vm)
}
const tmp = () => { const parent = mkdtempSync(path.join(tmpdir(), 'skin-hc-')); return { dir: path.join(parent, 'claude-skin'), done: () => rmSync(parent, { recursive: true, force: true }) } }
async function ask(c, dir, sessionId, action) {
  const p = sendSwitch(nodeFs, dir, sessionId, action, { randomUUID, waitMs: 3_000, gap: 5 })
  await new Promise((r) => setTimeout(r, 15))
  await vmRun(c, 'globalThis.__reskin.helper.kick()')
  return p
}
const PRESETS = { nord: NORD, dracula: DRACULA }

test('helper: Claude\'s start time comes from Electron\'s process creation time (sleep-proof), else from uptime', async () => {
  for (const [metrics, want] of [[() => [{ type: 'GPU', creationTime: 1 }, { type: 'Browser', creationTime: 1700000000123.4 }], 1700000000123], [undefined, null], [() => { throw new Error('no') }, null]]) {
    const c = fakeClaude(() => goodPage(NORD, 'dark'))
    if (metrics) c.ctx.process.getBuiltinModule('module').createRequire()().app.getAppMetrics = metrics
    const d = tmp()
    try {
      const t0 = Date.now()
      await vmRun(c, skin.helperCode(PRESETS, d.dir))
      const boot = JSON.parse(readFileSync(path.join(d.dir, 'session.json'), 'utf8')).boot
      if (want !== null) assert.equal(boot, want)
      else assert.ok(Math.abs(boot - (t0 - 5_000)) < 2_000, `fallback boot ${boot}`) // the fake Claude's uptime is 5 s
    } finally { d.done() }
  }
})

test('helper: check is read-only, names the preset with its digest, and the session says it can check', async () => {
  const c = fakeClaude((p) => ({ ...goodPage(NORD, 'dark'), marker: [...p.sheets.values()].some((x) => x.includes('--reskin-active')) }))
  const d = tmp()
  try {
    await vmRun(c, skin.setCode(NORD))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    assert.deepEqual(JSON.parse(readFileSync(path.join(d.dir, 'session.json'), 'utf8')).caps, ['check'])
    const before = c.pages[0].inserts
    const { ack } = await ask(c, d.dir, r.session, 'check')
    assert.equal(ack.action, 'check'); assert.equal(ack.current, 'nord'); assert.equal(ack.digest, sha(NORD))
    assert.equal(ack.sample.stable, true); assert.equal(ack.sample.pages.length, 1)
    assert.equal(c.pages[0].inserts, before, 'no stylesheet was inserted by the check')
    assert.equal(judgeHealth(ack, opts).verdict, 'pass')
    // Off: no digest, and the marker gone proves it.
    await ask(c, d.dir, r.session, 'off')
    const off = (await ask(c, d.dir, r.session, 'check')).ack
    assert.deepEqual([off.current, off.digest], ['off', null])
    assert.equal(judgeHealth(off, opts).verdict, 'none')
  } finally { d.done() }
})

test('helper: during a batch a check answers busy at once, a switch waits untouched', async () => {
  const c = fakeClaude(() => goodPage(NORD, 'dark'))
  const d = tmp()
  try {
    await vmRun(c, skin.setCode(NORD))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    await vmRun(c, 'globalThis.__reskin.batchActive = Date.now()')
    const { ack } = await ask(c, d.dir, r.session, 'check')
    assert.equal(ack.busy, true); assert.equal(judgeHealth(ack, opts).verdict, 'unknown')
    const sw = sendSwitch(nodeFs, d.dir, r.session, 'dracula', { randomUUID, waitMs: 200, gap: 5 })
    await new Promise((res) => setTimeout(res, 15))
    await vmRun(c, 'globalThis.__reskin.helper.kick()')
    assert.equal((await sw).ack, null, 'the switch was not answered during the batch')
    assert.ok(existsSync(path.join(d.dir, 'request.json')), 'the switch request still waits')
    assert.equal(await vmRun(c, 'globalThis.__reskin.css === null ? "off" : globalThis.__reskin.css.length'), NORD.length)
  } finally { d.done() }
})

test('helper: a page reload during the look makes the snapshot unstable (unknown)', async () => {
  let reloadOnce = true
  const c = fakeClaude((p) => {
    // A reload finishes, and its stylesheet re-apply completes, while the page is being read: no queue is left at the end,
    // so only the work counter can tell.
    if (reloadOnce) { reloadOnce = false; p.emit('did-finish-load'); return new Promise((r) => setTimeout(() => r(goodPage(NORD, 'dark')), 20)) }
    return goodPage(NORD, 'dark')
  })
  const d = tmp()
  try {
    await vmRun(c, skin.setCode(NORD))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    const { ack } = await ask(c, d.dir, r.session, 'check')
    assert.equal(ack.sample.stable, false)
    assert.equal(judgeHealth(ack, opts).verdict, 'unknown')
    // A page still loading is unstable too.
    const c2 = fakeClaude(() => ({ ...goodPage(NORD, 'dark'), ready: 'loading' }))
    const d2 = tmp()
    try {
      await vmRun(c2, skin.setCode(NORD))
      const r2 = await vmRun(c2, skin.helperCode(PRESETS, d2.dir))
      assert.equal((await ask(c2, d2.dir, r2.session, 'check')).ack.sample.stable, false)
    } finally { d2.done() }
  } finally { d.done() }
})

test('helper: a navigation that starts during the look (still loading, new address after) is unstable', async () => {
  for (const how of ['loading', 'address']) {
    let once = true
    const c = fakeClaude((p) => {
      if (once) { once = false; if (how === 'loading') p.loading = true; else p.url = 'https://claude.ai/chat/other' }
      return goodPage(NORD, 'dark')
    })
    const d = tmp()
    try {
      await vmRun(c, skin.setCode(NORD))
      const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
      assert.equal((await ask(c, d.dir, r.session, 'check')).ack.sample.stable, false, how)
    } finally { d.done() }
  }
})

test('helper presets never include a command word', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-hc-p-'))
  try {
    for (const n of ['check', 'off', 'remove', 'nord']) writeFileSync(path.join(d, `${n}.css`), NORD)
    assert.deepEqual(Object.keys(skin.helperPresets(d).map), ['nord'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- The page side against a fake document: only colours leave, presence is separate from readability ----
test('page: colours only in #rrggbb or rgb() form; anything else is unreadable, never text', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const el = (style, classes = [], kids = {}) => ({ style, classList: classes, querySelector: (s) => kids[s] ?? null, querySelectorAll: (s) => (kids[s] ? [kids[s]] : []), matches: () => false })
  const sidebar = el({ backgroundColor: 'rgb(37, 42, 51)', '--df-hover': '#3b4252', '--df-selected': 'secret words here', '--x': '' }, [], { '[data-row]': {}, '[data-cds=Pulse]': el({ '--cds-fill-accent': 'hsl(210 50% 50%)', '--cds-fill-warning': 'url(https://x)' }) })
  const sel = { '.dframe-sidebar': sidebar, '.dframe-content': el({ backgroundColor: 'rgb(46, 52, 64)' }), '.dframe-root': el({}) }
  const els = [el({ backgroundColor: 'rgb(1, 2, 3)' }, ['bg-surface-2', 'bg-bg-000']), el({ backgroundColor: 'rgb(59, 66, 82)' }, ['bg-surface-2', 'rounded'])]
  const match = (s) => { for (const alt of s.split(', ')) { const [base, ...nots] = alt.split(':not('); const no = nots.map((n) => n.replace(/\)$/, '').slice(1)); const hit = els.find((e) => e.classList.includes(base.slice(1)) && no.every((n) => !e.classList.includes(n))); if (hit) return hit } return null }
  const html = el({ '--reskin-active': '1', '--cds-surface-1': '#2e3440', '--cds-text-primary': ' #d8dee9 ', '--cds-role-accent-fill': 'red' })
  const style = (e) => ({ ...e.style, getPropertyValue: (n) => e.style[n] ?? '' })
  class OffscreenCanvas { getContext() { let f = '#000000'; return { get fillStyle() { return f }, set fillStyle(v) { f = /^hsl/.test(v) ? '#4080bf' : v === 'red' ? '#ff0000' : /^#/.test(v) ? v : f } } } }
  const ctx = createContext({ document: { readyState: 'complete', documentElement: html, body: el({ backgroundColor: 'rgb(46, 52, 64)' }), querySelector: (s) => sel[s] ?? (s.includes(':not(') ? match(s) : null), querySelectorAll: () => { throw new Error('no page-wide lists') } },
    getComputedStyle: style, matchMedia: () => ({ matches: true }), OffscreenCanvas })
  const out = JSON.parse(JSON.stringify(runInContext(skin.HEALTH_PAGE, ctx))) // out of the sandbox, as Electron hands it over
  assert.equal(out.marker, true); assert.equal(out.scheme, 'dark'); assert.deepEqual(out.anchors, { root: true, sidebar: true, content: true, rows: true })
  assert.deepEqual(out.parts.textPrimary, { on: true, v: '#d8dee9' })
  assert.deepEqual(out.parts.accentFill, { on: true, v: '#ff0000' }) // a named colour, through the canvas
  assert.deepEqual(out.parts.dfSelected, { on: true, v: null }) // text never leaves: unreadable
  assert.deepEqual(out.parts.pulseUnread, { on: true, v: '#4080bf' })
  assert.deepEqual(out.parts.pulseWaiting, { on: true, v: null }) // a url never leaves
  assert.deepEqual(out.parts.surface2, { on: true, v: 'rgb(59, 66, 82)' }) // the element with only its own class
  assert.deepEqual(out.parts.bg200, { on: false, v: null }) // not on screen
  assert.ok(!JSON.stringify(out).includes('secret') && !JSON.stringify(out).includes('https'))
})

// ---- The client end to end (skin-auto.mjs check), with a helper running in this test ----
async function claudeProc() {
  const { spawnSync } = await import('node:child_process')
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
  const line = ps.stdout.split('\n').find((l) => l.trim().endsWith(CLAUDE_BINARY))
  if (!line) return null
  const pid = Number(line.trim().split(/\s+/)[0])
  return { pid, startMs: parsePs(spawnSync('/bin/ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).startMs }
}
async function cli(dir, ...args) {
  const { spawn } = await import('node:child_process')
  const p = spawn(process.execPath, [autoPath(), ...args], { env: { ...process.env, RESKIN_STATE_DIR: dir, SKIN_LOCK_PORT: '47693', RESKIN_LOG: 'off' } })
  let out = ''
  p.stdout.on('data', (x) => (out += x)); p.stderr.on('data', (x) => (out += x))
  const code = await new Promise((r) => p.on('close', r))
  return { code, out }
}

test('client: check end to end (pass, old helper, no answer), status remembers it, never a port', async (t) => {
  const claude = await claudeProc()
  if (!claude) return t.skip('Claude is not running on this Mac')
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-hc-cli-'))
  const dir = path.join(parent, 'claude-skin')
  let interval
  const st = { css: NORD, sample: async () => ({ stable: true, pages: [goodPage(NORD, 'dark')] }), apply: async () => { throw new Error('check must not apply') } }
  const o = { fs: { ...nodeFs, watch: () => ({ close() {}, on() {} }) }, dir, presets: Object.freeze(Object.assign(Object.create(null), PRESETS)), uid, gen: HELPER_GEN, pid: claude.pid, boot: claude.startMs, version: '2.42304.0',
    randomUUID, now: Date.now, app: null, dark: () => true, digest: sha, setTimeout, setInterval: (f) => (interval = setInterval(f, 20)), clearInterval: () => clearInterval(interval) }
  try {
    skin.installHelper(st, o)
    const none = await cli(dir, 'status')
    assert.match(none.out, /has not been checked yet: run \/skin check/)
    const ok = await cli(dir, 'check')
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /^health: pass \(skin nord/m)
    assert.match(ok.out, /^debugger: not used \(the check needs no port\)/m)
    assert.match(ok.out, /^PORT_STATE: /m); assert.match(ok.out, /^RESULT: ok/m)
    const s = await cli(dir, 'status')
    assert.match(s.out, /^health: last check pass on Claude 2\.42304\.0/m)
    assert.doesNotMatch(s.out, /has not been checked yet/)
    // A newer unknown replaces the older pass.
    st.sample = async () => ({ stable: false, pages: [goodPage(NORD, 'dark')] })
    const unk = await cli(dir, 'check')
    assert.equal(unk.code, 0); assert.match(unk.out, /^health: unknown \(Claude was busy/m)
    assert.match((await cli(dir, 'status')).out, /^health: last check unknown on Claude 2\.42304\.0/m)
    // An older helper (no caps): nothing is sent, and the guidance names a new tick.
    const sess = path.join(dir, 'session.json')
    const j = JSON.parse(readFileSync(sess, 'utf8')); delete j.caps
    rmSync(sess); writeFileSync(sess, JSON.stringify(j), { mode: 0o600 })
    const old = await cli(dir, 'check')
    assert.match(old.out, /started before the check existed.*--tick/)
    assert.ok(!existsSync(path.join(dir, 'request.json')), 'no request sent to an old helper')
    // A helper that does not answer.
    clearInterval(interval)
    j.caps = ['check']; rmSync(sess); writeFileSync(sess, JSON.stringify(j), { mode: 0o600 })
    const silent = await cli(dir, 'check')
    assert.equal(silent.code, 1); assert.match(silent.out, /^health: helper not answering/m)
    // ...and status no longer shows the earlier result.
    assert.match((await cli(dir, 'status')).out, /^health: last check helper not answering on Claude 2\.42304\.0/m)
  } finally { clearInterval(interval); rmSync(parent, { recursive: true, force: true }) }
})

test('judge: a dot whose colour values are right but which paints something else fails', () => {
  const p = goodPage(NORD, 'dark')
  p.parts.pulsePaint = { on: true, v: 'rgb(255, 0, 0)' } // the four --cds values still match
  const j = judgeHealth(ackOf([p]), opts)
  assert.equal(j.verdict, 'fail')
  assert.ok(j.misses.some((m) => m.startsWith('session dot (as painted) is rgb(255, 0, 0), expected one of')), j.misses.join('|'))
  // Any of the four dot colours passes (each state paints its own).
  for (const k of ['pulseUnread', 'pulseError', 'pulseRunning']) {
    const q = goodPage(NORD, 'dark'); q.parts.pulsePaint = { on: true, v: expectedHealth(NORD, 'dark')[k] }
    assert.equal(judgeHealth(ackOf([q]), opts).verdict, 'pass', k)
  }
  // An older helper sends no answer for this place at all: unknown with the way out, never a pass.
  const o = goodPage(NORD, 'dark'); delete o.parts.pulsePaint
  const jo = judgeHealth(ackOf([o]), opts)
  assert.equal(jo.verdict, 'unknown'); assert.match(jo.why, /older than the check; quit and reopen Claude/)
  // Unreadable paint is never a pass.
  const u = goodPage(NORD, 'dark'); u.parts.pulsePaint = { on: true, v: null }
  assert.equal(judgeHealth(ackOf([u]), opts).verdict, 'unknown')
  // Dots on screen but none in a readable form: not checked, and said so (never "not on screen").
  const s = goodPage(NORD, 'dark'); s.parts.pulsePaint = { on: false, v: null, present: true }
  const js = judgeHealth(ackOf([s]), opts), rs = healthReport(js, ackOf([s]), opts.tested).lines
  assert.equal(js.verdict, 'pass'); assert.deepEqual(js.skipped, ['session dot (as painted)'])
  assert.ok(rs.includes('not checked (dots present, but none could be read safely): session dot (as painted)'), rs.join('\n'))
  assert.ok(!rs.some((l) => /^not on screen now/.test(l) && l.includes('session dot')), rs.join('\n'))
})

test('page: the first readable dot is read as painted, filled or as Claude\'s hollow ring', async () => {
  const { createContext, runInContext } = await import('node:vm')
  // Each dot sits in a row (`row` style, default plain) inside the sidebar.
  const run = (...pulses) => {
    // A browser-like dot: 8px box at (20, 100) unless `box` says otherwise; checkVisibility false when `seen: false`,
    // missing when `noCheck`.
    const el = (style, parentElement = null) => ({ style, parentElement, classList: [], querySelector: () => null, querySelectorAll: () => [], matches: () => false,
      ...(style.noCheck ? {} : { checkVisibility: () => style.seen !== false }), getBoundingClientRect: () => { const b = { left: 20, top: 100, width: 8, height: 8, ...style.box }; return { ...b, right: b.left + b.width, bottom: b.top + b.height } } })
    const html = el({ '--reskin-active': '1' })
    const side = { ...el({ backgroundColor: 'rgb(37, 42, 51)' }, html), querySelector: (s) => (s === '[data-row]' ? {} : s === '[data-cds=Pulse]' ? (dots[0] ?? null) : null), querySelectorAll: (s) => (s === '[data-cds=Pulse]' ? dots : []) }
    const dots = pulses.map(({ row = {}, ...style }) => el(style, el(row, side)))
    class OffscreenCanvas { getContext() { let f = '#000000'; return { get fillStyle() { return f }, set fillStyle(v) { f = v } } } }
    // Computed values as a browser gives them: every property has its initial value unless the style sets it.
    const PLAIN = { opacity: '1', visibility: 'visible', filter: 'none', mask: 'none', clipPath: 'none', mixBlendMode: 'normal', contentVisibility: 'visible' }
    const ctx = createContext({ document: { readyState: 'complete', documentElement: html, body: el({}), querySelector: (s) => (s === '.dframe-sidebar' ? side : null) },
      getComputedStyle: (e) => ({ ...PLAIN, ...e.style, getPropertyValue: (n) => e.style[n] ?? '' }), matchMedia: () => ({ matches: true }), OffscreenCanvas, innerWidth: 1200, innerHeight: 800 })
    return JSON.parse(JSON.stringify(runInContext(skin.HEALTH_PAGE, ctx))).parts.pulsePaint
  }
  const NONE = { on: false, v: null }, PRESENT = { on: false, v: null, present: true } // no dots / dots, none readable
  const ring = 'rgb(161, 161, 161) 0px 0px 0px 1px inset, rgb(46, 52, 64) 0px 0px 0px 0.5px'
  assert.deepEqual(run({ backgroundColor: 'rgb(250, 178, 25)' }), { on: true, v: 'rgb(250, 178, 25)' })
  assert.deepEqual(run({ backgroundColor: 'rgba(0, 0, 0, 0)', boxShadow: ring }), { on: true, v: 'rgb(161, 161, 161)' })
  // An outer glow draws outside the dot and cannot cover its colour.
  assert.deepEqual(run({ backgroundColor: 'rgb(250, 178, 25)', boxShadow: 'rgba(0, 0, 0, 0.2) 0px 0px 0px 2px' }), { on: true, v: 'rgb(250, 178, 25)' })
  // An unreadable first dot is skipped for a readable one further down.
  assert.deepEqual(run({ backgroundColor: 'rgba(0, 0, 0, 0)', boxShadow: 'none' }, { backgroundColor: 'rgb(3, 98, 193)' }), { on: true, v: 'rgb(3, 98, 193)' })
  // Something covering the colour: that dot is never read as the colour underneath.
  assert.deepEqual(run({ backgroundColor: 'rgb(250, 178, 25)', backgroundImage: 'linear-gradient(red, red)' }), PRESENT)
  assert.deepEqual(run({ backgroundColor: 'rgb(250, 178, 25)', boxShadow: 'rgb(255, 0, 0) 0px 0px 0px 9px inset' }), PRESENT)
  assert.deepEqual(run({ backgroundColor: 'rgba(0, 0, 0, 0)', boxShadow: ring + ', rgb(255, 0, 0) 0px 0px 0px 9px inset' }), PRESENT)
  assert.deepEqual(run({ backgroundColor: 'rgba(0, 0, 0, 0)', boxShadow: 'none' }), PRESENT) // another form: not checked
  assert.deepEqual(run(), NONE) // no dots on screen
  // A dot not drawn as styled (hidden, faded, filtered, masked, clipped, blended, not laid out, or under a row doing
  // any of that) is never read; the visible wrong dot behind it is what gets judged.
  const red = { backgroundColor: 'rgb(255, 0, 0)' }, amber = 'rgb(250, 178, 25)'
  for (const hide of [{ visibility: 'hidden' }, { visibility: 'collapse' }, { opacity: '0' }, { opacity: '0.5' }, { filter: 'hue-rotate(90deg)' },
    { mask: 'url(#m)' }, { clipPath: 'inset(50%)' }, { mixBlendMode: 'multiply' }, { seen: false },
    { box: { width: 0, height: 0 } }, { box: { width: 8, height: 1 } }, { box: { left: -50 } }, { box: { top: 5000 } }, { box: { left: 1300 } },
    { transform: 'matrix(0.707107, 0.707107, 0, 0, 0, 0)' }, { transform: 'matrix(0.3, 0, 0, 0.3, 0, 0)' }, { transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' },
    { scale: '0.2' }, { scale: '1 0' }, { clip: 'rect(0px, 0px, 0px, 0px)' }, { row: { transform: 'matrix(1, 0, 0, 0, 0, 0)' } },
    { row: { overflowY: 'hidden', box: { left: 0, top: 0, width: 300, height: 50 } } }, { row: { overflowX: 'auto', box: { left: 27, top: 100, width: 300, height: 50 } } },
    { row: { opacity: '0' } }, { row: { opacity: '0.999' } }, { row: { filter: 'grayscale(1)' } }, { row: { mixBlendMode: 'screen' } }, { row: { contentVisibility: 'hidden' } }]) {
    assert.deepEqual(run({ backgroundColor: amber, ...hide }, red), { on: true, v: 'rgb(255, 0, 0)' }, JSON.stringify(hide))
    assert.deepEqual(run({ backgroundColor: amber, ...hide }), PRESENT, JSON.stringify(hide))
  }
  // Ordinary geometry stays readable: a moved dot, a scroll area it sits inside, a dot partly cut by the window edge.
  assert.deepEqual(run({ backgroundColor: amber, transform: 'matrix(1, 0, 0, 1, 4, 0)' }), { on: true, v: amber })
  assert.deepEqual(run({ backgroundColor: amber, row: { overflowY: 'auto', box: { left: 0, top: 90, width: 300, height: 40 } } }), { on: true, v: amber })
  assert.deepEqual(run({ backgroundColor: amber, box: { left: -4 } }), { on: true, v: amber })
  // A list Claude renders with content-visibility auto, on screen: still readable.
  assert.deepEqual(run({ backgroundColor: amber, row: { contentVisibility: 'auto' } }), { on: true, v: amber })
  // A browser without the visibility test: unreadable, never a pass.
  assert.deepEqual(run({ backgroundColor: amber, noCheck: true }), PRESENT)
})
