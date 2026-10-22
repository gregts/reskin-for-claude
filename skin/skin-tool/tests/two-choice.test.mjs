// Two-choice Reskin: the colour helper that stays inside Claude, its file gates, the switch client, the
// sampled colour checks and the tick wait. Behaviour tests: the helper runs for real on a temp folder with a fake `st`.
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TICK, checksLine, expectedColours, judgeChecks, liveSession, nextNonce, parsePs, parseRgb, readPrefs, readPrivateJson,
  sendSwitch, waitForTick, writePrivateJson, CLAUDE_BINARY,
  HELPER_GEN,
} from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const uid = process.getuid()

// skin.mjs runs main() on import, so tests load a copy without that last call.
async function loadSkin() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { helperCode, setCode, STOP_HELPER, STATE, MENU_PROBE }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-2c-'))
  writeFileSync(path.join(d, 'skin.mjs'), src)
  const m = await import(path.join(d, 'skin.mjs'))
  rmSync(d, { recursive: true, force: true })
  return m
}
const skin = await loadSkin()

const PRESETS = { nord: '@media (prefers-color-scheme: dark) { html { color: red } }', dracula: '@media (prefers-color-scheme: dark) { html { color: blue } }' }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (h) => { for (let i = 0; i < 50 && (h.running || h.again); i++) await new Promise((r) => setTimeout(r, 2)) }

// A fresh private folder (inside a temp parent) and a fake `st` whose apply records calls. `fsOver` replaces fs methods.
function setup({ fsOver = {}, apply, o: oOver = {} } = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-helper-'))
  const dir = path.join(parent, 'claude-skin')
  const calls = []
  const st = {
    apply: apply ?? (async (css) => { calls.push(css); return { errors: [], samples: [{ surface1: '#111111' }] } }),
  }
  const fs = { ...nodeFs, watch: () => ({ close() {}, on() {} }), ...fsOver }
  const o = { fs, dir, presets: Object.freeze(Object.assign(Object.create(null), PRESETS)), uid, pid: 4242, boot: 1_000, version: '9.9.9', gen: HELPER_GEN,
    randomUUID, now: Date.now, app: null, dark: () => true, setTimeout, setInterval: () => 0, clearInterval: () => {}, ...oOver }
  const res = skin.installHelper(st, o)
  return { parent, dir, st, calls, res, o, h: st.helper, done: () => rmSync(parent, { recursive: true, force: true }) }
}
const session = (dir) => JSON.parse(readFileSync(path.join(dir, 'session.json'), 'utf8'))
const ack = (dir) => JSON.parse(readFileSync(path.join(dir, 'ack.json'), 'utf8'))
// Writes a request file directly (bypassing the client), with any mode.
const put = (dir, obj, mode = 0o600) => { const f = path.join(dir, 'request.json'); rmSync(f, { force: true }); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode }); chmodSync(f, mode) }
const ask = async (t, obj, mode) => { put(t.dir, obj, mode); t.h.kick(); await settle(t.h) }

test('helper: installs into a private folder, writes a private session file, one helper per Claude', () => {
  const t = setup()
  try {
    assert.equal(t.res.helper, 'active')
    assert.equal(lstatSync(t.dir).mode & 0o777, 0o700)
    assert.equal(lstatSync(path.join(t.dir, 'session.json')).mode & 0o777, 0o600)
    const s = session(t.dir)
    assert.deepEqual([s.v, s.session, s.pid, s.boot, s.version], [1, t.res.session, 4242, 1_000, '9.9.9'])
    // A second install replaces the first: the old one stops and the session id changes.
    const first = t.h
    const again = skin.installHelper(t.st, t.o)
    assert.equal(first.stopped, true)
    assert.notEqual(again.session, t.res.session)
    assert.equal(session(t.dir).session, again.session)
  } finally { t.done() }
})

test('helper: refuses a folder that is a link or not private-able; repairs the mode of its own real folder', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-helper-'))
  try {
    const real = path.join(parent, 'real'); mkdirSync(real, { mode: 0o700 })
    const link = path.join(parent, 'link'); symlinkSync(real, link)
    const o = (dir) => ({ fs: { ...nodeFs, watch: () => ({ close() {} }) }, dir, presets: PRESETS, uid, pid: 1, boot: 1, version: 'x', gen: HELPER_GEN, randomUUID, now: Date.now, setTimeout, setInterval: () => 0, clearInterval: () => {} })
    assert.equal(skin.installHelper({}, o(link)).helper, 'none')
    assert.ok(!existsSync(path.join(real, 'session.json')), 'nothing written through the link')
    const loose = path.join(parent, 'loose'); mkdirSync(loose, { mode: 0o755 }); chmodSync(loose, 0o755)
    assert.equal(skin.installHelper({}, o(loose)).helper, 'active')
    assert.equal(lstatSync(loose).mode & 0o777, 0o700)
    assert.equal(skin.installHelper({}, { ...o(loose), uid: uid + 1 }).helper, 'none') // not ours
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('helper: a valid preset request applies that preset and acks with the session, number, pid, version, samples', async () => {
  const t = setup()
  try {
    await ask(t, { v: 1, session: t.res.session, nonce: 1, action: 'nord' })
    assert.deepEqual(t.calls, [PRESETS.nord])
    const a = ack(t.dir)
    assert.deepEqual([a.session, a.nonce, a.action, a.ok, a.pid, a.version, a.dark, a.requests, a.phase], [t.res.session, 1, 'nord', true, 4242, '9.9.9', true, 1, 'done'])
    assert.deepEqual(a.samples, [{ surface1: '#111111' }])
    assert.equal(lstatSync(path.join(t.dir, 'ack.json')).mode & 0o777, 0o600)
    // The same number again is already handled: no second apply, not counted as ignored.
    t.h.kick(); await settle(t.h)
    assert.equal(t.calls.length, 1)
    assert.equal(t.h.ignored, 0)
    // "off" removes the colours and keeps the helper.
    await ask(t, { v: 1, session: t.res.session, nonce: 2, action: 'off' })
    assert.deepEqual(t.calls, [PRESETS.nord, null])
    assert.equal(t.h.stopped, false)
    assert.equal(ack(t.dir).action, 'off')
  } finally { t.done() }
})

test('helper: every gate refuses before any change, and a bad file is counted once', async () => {
  const t = setup()
  const sid = t.res.session
  const good = { v: 1, session: sid, nonce: 5, action: 'nord' }
  try {
    const cases = [
      ['mode 644', good, 0o644],
      ['mode 640', good, 0o640],
      ['not JSON', '{nope', 0o600],
      ['array', '[1]', 0o600],
      ['extra field', { ...good, css: 'x' }, 0o600],
      ['missing field', { v: 1, session: sid, nonce: 5 }, 0o600],
      ['version', { ...good, v: 2 }, 0o600],
      ['other session', { ...good, session: randomUUID() }, 0o600],
      ['nonce 0', { ...good, nonce: 0 }, 0o600],
      ['nonce fraction', { ...good, nonce: 1.5 }, 0o600],
      ['nonce text', { ...good, nonce: '5' }, 0o600],
      ['unsafe nonce', { ...good, nonce: 2 ** 60 }, 0o600],
      ['unknown preset', { ...good, action: 'no-such' }, 0o600],
      ['proto name', { ...good, action: '__proto__' }, 0o600],
      ['constructor', { ...good, action: 'constructor' }, 0o600],
      ['css as action', { ...good, action: PRESETS.nord }, 0o600],
      ['over 4 KB', JSON.stringify({ ...good, action: 'nord' }).replace('}', `,"pad":"${'x'.repeat(4100)}"}`), 0o600],
    ]
    for (const [name, body, mode] of cases) {
      const before = t.h.ignored
      await ask(t, body, mode)
      assert.deepEqual(t.calls, [], name)
      assert.equal(t.h.ignored, before + 1, `${name}: counted once`)
      t.h.kick(); await settle(t.h)
      assert.equal(t.h.ignored, before + 1, `${name}: the same bad file is not counted again`)
    }
    // A link to a good file is not a regular file.
    const real = path.join(t.parent, 'good.json'); writeFileSync(real, JSON.stringify(good), { mode: 0o600 })
    rmSync(path.join(t.dir, 'request.json'), { force: true }); symlinkSync(real, path.join(t.dir, 'request.json'))
    t.h.kick(); await settle(t.h)
    assert.deepEqual(t.calls, [], 'symlink')
    // A folder, not a file.
    rmSync(path.join(t.dir, 'request.json'), { force: true }); mkdirSync(path.join(t.dir, 'request.json'))
    t.h.kick(); await settle(t.h)
    assert.deepEqual(t.calls, [], 'directory')
    rmSync(path.join(t.dir, 'request.json'), { recursive: true, force: true })
    // An older number after a newer one is refused.
    await ask(t, { ...good, nonce: 9 })
    assert.equal(t.calls.length, 1)
    await ask(t, { ...good, nonce: 8, action: 'dracula' })
    assert.equal(t.calls.length, 1, 'old nonce')
    // Exactly 4096 bytes is fine.
    const base = JSON.stringify({ v: 1, session: sid, nonce: 10, action: 'dracula' })
    await ask(t, base + ' '.repeat(4096 - base.length))
    assert.equal(t.calls.length, 2, '4096 bytes accepted')
  } finally { t.done() }
})

test('helper: a file swapped or grown between the checks and the read is refused', async () => {
  // Swapped: the open finds a different file than the one checked.
  const swapped = setup({ fsOver: { fstatSync: (fd) => ({ ...nodeFs.fstatSync(fd), isFile: () => true, ino: -1, dev: nodeFs.fstatSync(fd).dev, uid, mode: 0o100600, size: nodeFs.fstatSync(fd).size }) } })
  try {
    await ask(swapped, { v: 1, session: swapped.res.session, nonce: 1, action: 'nord' })
    assert.deepEqual(swapped.calls, [])
    assert.equal(swapped.h.ignored, 1)
  } finally { swapped.done() }
  // Grown: more bytes than fstat promised.
  const grown = setup({ fsOver: { readSync: (fd, buf, off, len, pos) => nodeFs.readSync(fd, buf, off, len, pos) + 1 } })
  try {
    await ask(grown, { v: 1, session: grown.res.session, nonce: 1, action: 'nord' })
    assert.deepEqual(grown.calls, [])
  } finally { grown.done() }
})

test('helper: each file check works on its own (the check before opening and the one after are both needed)', async () => {
  const realLstat = nodeFs.lstatSync
  const realFstat = nodeFs.fstatSync
  const isReq = (f) => String(f).endsWith('request.json')
  // A stat that says "a private regular file of yours", keeping the real identity and size unless told otherwise.
  const fine = (st, over = {}) => ({ ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, size: st.size, uid, mode: 0o100600, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ...over })
  // One layer lies ("all fine", or a given flaw), so only the other layer can catch the bad file.
  const before = (over) => ({ lstatSync: (f, ...r) => (isReq(f) ? fine(realLstat(f, ...r), over) : realLstat(f, ...r)) })
  const after = (over) => ({ fstatSync: (fd) => fine(realFstat(fd), over) })
  const good = (t) => put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'nord' })
  const cases = [
    // [name, fs overrides, how to write the request]
    ['mode 644, caught before opening', after(), (t) => put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'nord' }, 0o644)],
    ['mode 644, caught after opening', before(), (t) => put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'nord' }, 0o644)],
    ['over 4 KB, caught before opening', after({ size: 100 }), (t) => put(t.dir, JSON.stringify({ v: 1, session: t.res.session, nonce: 1, action: 'nord' }) + ' '.repeat(4200))],
    ['over 4 KB, caught after opening', before({ size: 100 }), (t) => put(t.dir, JSON.stringify({ v: 1, session: t.res.session, nonce: 1, action: 'nord' }) + ' '.repeat(4200))],
    ['other owner, caught before opening', { ...before({ uid: 777 }), ...after() }, good],
    ['other owner, caught after opening', after({ uid: 777 }), good],
    ['a folder, caught before opening', after(), (t) => mkdirSync(path.join(t.dir, 'request.json'))],
    ['not a file, caught after opening', { ...before(), ...after({ isFile: () => false }) }, good],
    // lstat lies with the TARGET's identity, so the identity check after opening cannot catch it: only the open can.
    ['a link, refused by the open itself (O_NOFOLLOW)', { lstatSync: (f, ...r) => (isReq(f) ? fine(nodeFs.statSync(f)) : realLstat(f, ...r)) }, (t) => {
      const real = path.join(t.parent, 'good.json'); writeFileSync(real, JSON.stringify({ v: 1, session: t.res.session, nonce: 1, action: 'nord' }), { mode: 0o600 })
      symlinkSync(real, path.join(t.dir, 'request.json'))
    }],
    // Grown after fstat: the read returns one more (valid, blank) byte than fstat promised.
    ['grown after fstat', { readSync: (fd, buf, off, len, pos) => { const n = nodeFs.readSync(fd, buf, off, len, pos); buf[off + n] = 0x20; return n + 1 } }, good],
  ]
  for (const [name, fsOver, write] of cases) {
    const t = setup({ fsOver })
    try {
      write(t)
      t.h.kick(); await settle(t.h)
      assert.deepEqual(t.calls, [], name)
    } finally { t.done() }
  }
  // The same overrides with an honest file do apply: the lies alone do not block a good request.
  const ok = setup({ fsOver: { ...before(), ...after() } })
  try { good(ok); ok.h.kick(); await settle(ok.h); assert.deepEqual(ok.calls, [PRESETS.nord]) } finally { ok.done() }
})

test('helper: one request at a time, events while busy collapse into one more look, and a hung apply is fenced', async () => {
  let release
  const calls = []
  const t = setup({ apply: (css) => { calls.push(css); return new Promise((r) => { release = () => r({ errors: [], samples: [] }) }) } })
  try {
    put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'nord' })
    t.h.kick(); await tick()
    put(t.dir, { v: 1, session: t.res.session, nonce: 2, action: 'dracula' })
    for (let i = 0; i < 20; i++) t.h.kick()
    await tick()
    assert.equal(calls.length, 1, 'serial: the second waits for the first')
    release(); await tick(); await tick()
    for (let i = 0; i < 50 && calls.length < 2; i++) await tick()
    assert.deepEqual(calls, [PRESETS.nord, PRESETS.dracula])
    release(); await settle(t.h)
    assert.equal(ack(t.dir).nonce, 2)
  } finally { t.done() }
  // An apply that never ends: the ack says it timed out, and the helper keeps working.
  const hung = setup({ apply: () => new Promise(() => {}), o: { setTimeout: (f) => setTimeout(f, 5) } })
  try {
    await ask(hung, { v: 1, session: hung.res.session, nonce: 1, action: 'nord' })
    const a = ack(hung.dir)
    assert.equal(a.ok, false)
    assert.match(a.errors[0], /timed out/)
    assert.equal(hung.h.running, false)
  } finally { hung.done() }
})

test('helper: waits while a batch owns the colours', async () => {
  const t = setup()
  try {
    t.st.batchActive = Date.now()
    await ask(t, { v: 1, session: t.res.session, nonce: 1, action: 'nord' })
    assert.deepEqual(t.calls, [])
    t.st.batchActive = Date.now() - 31_000 // a batch that ended (or died) long ago no longer blocks
    t.h.kick(); await settle(t.h)
    assert.deepEqual(t.calls, [PRESETS.nord])
  } finally { t.done() }
})

test('helper: remove acks first (accepted), then takes down colours, watcher, poll, session file and the state', async () => {
  const events = []
  let closed = false
  let cleared = false
  const t = setup({
    fsOver: { watch: () => ({ close() { closed = true }, on() {} }), renameSync: (a, b) => { if (b.endsWith('ack.json')) events.push('ack'); return nodeFs.renameSync(a, b) } },
    apply: async (css) => { events.push(css === null ? 'off' : 'on'); t.st.gen = (t.st.gen ?? 0) + 1; return { errors: [], samples: [] } },
    o: { clearInterval: () => { cleared = true } },
  })
  try {
    globalThis.__reskin = t.st
    globalThis.__reskinFallback = setTimeout(() => {}, 1)
    await ask(t, { v: 1, session: t.res.session, nonce: 1, action: 'remove' })
    assert.deepEqual(events, ['ack', 'off', 'ack'], 'accepted before teardown, done after it')
    const a = ack(t.dir)
    assert.deepEqual([a.action, a.phase, a.ok], ['remove', 'done', true])
    assert.ok(!existsSync(path.join(t.dir, 'session.json')))
    assert.ok(closed && cleared, 'watcher closed and poll cleared')
    assert.equal(t.st.helper, null)
    assert.equal(globalThis.__reskin, undefined)
    assert.notEqual(globalThis.__reskinFallback, undefined, "the debugger's own close timer is not the helper's to touch")
    // Gone means gone: a later request does nothing.
    put(t.dir, { v: 1, session: t.res.session, nonce: 2, action: 'nord' })
    t.h.kick(); await settle(t.h)
    assert.deepEqual(events, ['ack', 'off', 'ack'])
  } finally { delete globalThis.__reskin; t.done() }
})

test('helper: a request left from an older session is cleared at install and never applied', async () => {
  const t = setup()
  try {
    const old = t.res.session
    put(t.dir, { v: 1, session: old, nonce: 1, action: 'nord' })
    const again = skin.installHelper(t.st, t.o)
    assert.ok(!existsSync(path.join(t.dir, 'request.json')))
    t.st.helper.kick(); await settle(t.st.helper)
    assert.deepEqual(t.calls, [])
    assert.notEqual(again.session, old)
  } finally { t.done() }
})

test('the injected helper code runs as Claude would run it (fake Electron, real fs) and STATE reports it', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const parent = mkdtempSync(path.join(tmpdir(), 'skin-inject-'))
  const dir = path.join(parent, 'claude-skin')
  try {
    const page = { id: 1, getURL: () => 'https://claude.ai/chat', getType: () => 'window', isDestroyed: () => false, sheets: new Map(), next: 1, on() {}, once() {}, removeListener() {},
      insertCSS: async (css) => { const k = String(page.next++); page.sheets.set(k, css); return k }, removeInsertedCSS: async (k) => { page.sheets.delete(k) },
      executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => (code.includes('surface1') ? { surface1: '#2e3440' } : code.includes('--reskin-active') ? ([...page.sheets.values()].some((c) => c.includes('--reskin-active')) ? '1' : '') : {}) }
    const electron = { app: { on() {}, once() {}, removeListener() {}, getVersion: () => '1.2.3' }, nativeTheme: { shouldUseDarkColors: true }, webContents: { getAllWebContents: () => [page] } }
    const mods = { fs: nodeFs, crypto: { randomUUID } }
    const ctx = createContext({ process: { execPath: '/x', pid: 77, uptime: () => 5, getuid: () => uid, getBuiltinModule: (n) => (n === 'module' ? { createRequire: () => () => electron } : mods[n]) },
      URL, Promise, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {}, Map, Set, String, Error, Date, Math, JSON, Object, Number, Uint8Array, TextDecoder, Array })
    await runInContext(skin.setCode(PRESETS.nord), ctx)
    const r = await runInContext(skin.helperCode(PRESETS, dir), ctx)
    assert.equal(r.helper, 'active')
    const s = session(dir)
    assert.deepEqual([s.pid, s.version], [77, '1.2.3'])
    const state = await runInContext(skin.STATE, ctx)
    assert.equal(state.helper.session, r.session)
    // Through the real client: switch to dracula, the helper (kicked by hand here) applies and acks.
    const pending = sendSwitch(nodeFs, dir, r.session, 'dracula', { randomUUID, waitMs: 1_000, gap: 5 })
    await new Promise((res) => setTimeout(res, 20))
    runInContext('globalThis.__reskin.helper.kick()', ctx)
    const { ack: a } = await pending
    assert.equal(a.action, 'dracula')
    assert.ok([...page.sheets.values()].some((c) => c.includes('blue')))
    assert.ok(!existsSync(path.join(dir, 'request.json')), 'the answered request was tidied away')
    // Off from skin.mjs (remove mode) ends the helper and its session file.
    await runInContext(skin.STOP_HELPER, ctx)
    assert.ok(!existsSync(path.join(dir, 'session.json')))
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('client: a lost ack never makes it reuse a number the helper already took', async () => {
  let failAck = true
  const t = setup({ fsOver: { renameSync: (a, b) => { if (b.endsWith('ack.json') && failAck) throw new Error('disk full'); return nodeFs.renameSync(a, b) } } })
  try {
    const sid = t.res.session
    const first = await sendSwitch(nodeFs, t.dir, sid, 'nord', { randomUUID, waitMs: 60, gap: 5 })
    // Nobody kicked the helper yet: no ack, and the request stays for the next client to see.
    assert.equal(first.ack, null)
    t.h.kick(); await settle(t.h)
    assert.deepEqual(t.calls, [PRESETS.nord]) // taken, but its ack was lost
    failAck = false
    assert.equal(nextNonce(nodeFs, t.dir, sid), 2)
    const p = sendSwitch(nodeFs, t.dir, sid, 'dracula', { randomUUID, waitMs: 500, gap: 5 })
    await new Promise((r) => setTimeout(r, 15)); t.h.kick()
    const second = await p
    assert.equal(second.ack?.nonce, 2)
    assert.deepEqual(t.calls, [PRESETS.nord, PRESETS.dracula])
  } finally { t.done() }
})

test('client: an ack from another session, or for another number, is not ours', async () => {
  const t = setup()
  try {
    writePrivateJson(nodeFs, t.dir, 'ack.json', { session: randomUUID(), nonce: 1, ok: true }, randomUUID)
    const r = await sendSwitch(nodeFs, t.dir, t.res.session, 'nord', { randomUUID, waitMs: 40, gap: 5 })
    assert.equal(r.ack, null)
    assert.equal(r.nonce, 1, 'a foreign ack does not move our numbering')
  } finally { t.done() }
})

test('client: liveSession is active only for the very Claude process that started the helper', () => {
  const t = setup()
  try {
    const proc = (p) => (p === 4242 ? { comm: CLAUDE_BINARY, startMs: 1_500 } : null)
    assert.equal(liveSession(nodeFs, t.dir, proc).state, 'active')
    // A helper started by an older Reskin (no or another generation) is still running old code inside Claude.
    const real = JSON.parse(readFileSync(path.join(t.dir, 'session.json'), 'utf8'))
    assert.equal(real.gen, HELPER_GEN)
    for (const gen of [undefined, HELPER_GEN - 1, String(HELPER_GEN)]) {
      writeFileSync(path.join(t.dir, 'session.json'), JSON.stringify({ ...real, gen }), { mode: 0o600 })
      const old = liveSession(nodeFs, t.dir, proc)
      assert.equal(old.state, 'outdated', String(gen))
      assert.match(old.why, /Quit and reopen Claude once/)
    }
    writeFileSync(path.join(t.dir, 'session.json'), JSON.stringify(real), { mode: 0o600 })
    assert.equal(liveSession(nodeFs, t.dir, () => null).state, 'none') // Claude quit
    assert.equal(liveSession(nodeFs, t.dir, () => ({ comm: '/bin/zsh', startMs: 1_000 })).state, 'none') // pid reused
    assert.equal(liveSession(nodeFs, t.dir, () => ({ comm: CLAUDE_BINARY, startMs: 99_000 })).state, 'none') // restarted
    assert.equal(liveSession(nodeFs, t.dir, () => { throw new Error('ps hung') }).state, 'unknown')
    assert.equal(liveSession(nodeFs, path.join(t.parent, 'nowhere'), proc).state, 'none')
    chmodSync(path.join(t.dir, 'session.json'), 0o644)
    assert.equal(liveSession(nodeFs, t.dir, proc).state, 'unknown') // never trusted, never "none" either
    chmodSync(path.join(t.dir, 'session.json'), 0o600)
    chmodSync(t.dir, 0o755)
    assert.equal(liveSession(nodeFs, t.dir, proc).state, 'unknown')
  } finally { t.done() }
})

test('client: private JSON reads refuse links, loose modes and other shapes; prefs keep a preset name only', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-json-'))
  try {
    writeFileSync(path.join(d, 'a.json'), '{"x":1}', { mode: 0o600 })
    assert.deepEqual(readPrivateJson(nodeFs, path.join(d, 'a.json')).value, { x: 1 })
    symlinkSync(path.join(d, 'a.json'), path.join(d, 'l.json'))
    assert.match(readPrivateJson(nodeFs, path.join(d, 'l.json')).error, /regular/)
    writeFileSync(path.join(d, 'b.json'), '{"x":1}', { mode: 0o644 }); chmodSync(path.join(d, 'b.json'), 0o644)
    assert.match(readPrivateJson(nodeFs, path.join(d, 'b.json')).error, /private/)
    writeFileSync(path.join(d, 'c.json'), '[1]', { mode: 0o600 })
    assert.match(readPrivateJson(nodeFs, path.join(d, 'c.json')).error, /object/)
    assert.equal(readPrivateJson(nodeFs, path.join(d, 'none.json')).missing, true)
    writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: 'nord' }, randomUUID)
    assert.deepEqual(readPrefs(nodeFs, d), { last: 'nord' })
    writePrivateJson(nodeFs, d, 'prefs.json', { v: 1, last: '../etc' }, randomUUID)
    assert.deepEqual(readPrefs(nodeFs, d), { last: null }) // a strange value never becomes a reapply offer
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('ps: start time and binary, gone, and unsure', () => {
  const p = parsePs({ status: 0, stdout: 'Wed Oct 14 02:27:21 2026     /Applications/Claude.app/Contents/MacOS/Claude\n', stderr: '' })
  assert.equal(p.comm, CLAUDE_BINARY)
  assert.ok(Number.isFinite(p.startMs))
  assert.equal(parsePs({ status: 1, stdout: '', stderr: '' }), null)
  assert.throws(() => parsePs({ status: null, stdout: '' }))
  assert.throws(() => parsePs({ status: 0, stdout: 'garbage' }))
})

test('sampled colour checks: real presets, missing and unreadable samples are unknown, never a pass', () => {
  const css = readFileSync(path.join(tool, 'presets', 'tokyo-night.css'), 'utf8')
  const dark = expectedColours(css, 'dark')
  assert.deepEqual(dark, { surface1: '#1a1b26', textPrimary: '#c0caf5', accentFill: '#7aa2f7', bodyBg: '#1a1b26', sidebarBg: '#16161e' })
  assert.notDeepEqual(expectedColours(css, 'light'), dark)
  const good = { surface1: '#1a1b26', textPrimary: '#c0caf5', accentFill: '#7aa2f7', bodyBg: 'rgb(26, 27, 38)', sidebarBg: 'rgb(22, 22, 30)' }
  assert.deepEqual(judgeChecks([good], dark), { passed: 5, failed: 0, unknown: 0, total: 5, misses: [], seeThrough: 0 })
  const partial = judgeChecks([{ ...good, sidebarBg: null, accentFill: 'banana' }], dark)
  assert.deepEqual([partial.passed, partial.unknown, partial.failed], [3, 2, 0])
  assert.equal(checksLine(partial, 'dark'), 'sampled colour checks: 3 of 5 passed (2 unknown)')
  const wrong = judgeChecks([{ ...good, bodyBg: 'rgb(255, 255, 255)' }], dark)
  assert.equal(wrong.failed, 1)
  assert.match(checksLine(wrong, 'dark'), /1 did not match: bodyBg/)
  assert.deepEqual(judgeChecks([], dark), { passed: 0, failed: 0, unknown: 5, total: 5, misses: [], seeThrough: 0 }) // no page at all
  // 22 Oct: a fully see-through page body (Claude 3.6556.1 after a reload) is left out, never a pass or a miss.
  const clear = judgeChecks([{ ...good, bodyBg: 'rgba(0, 0, 0, 0)' }], dark)
  assert.deepEqual([clear.passed, clear.failed, clear.unknown, clear.total, clear.seeThrough], [4, 0, 0, 4, 1])
  assert.equal(checksLine(clear, 'dark'), 'sampled colour checks: 4 of 4 passed (0 unknown); page background see-through on this Claude, not checked (run /skin check to check the chat area)')
  // Only fully see-through: a half see-through body, or another place see-through, is still a miss.
  assert.equal(judgeChecks([{ ...good, bodyBg: 'rgba(0, 0, 0, 0.5)' }], dark).failed, 1)
  assert.equal(judgeChecks([{ ...good, sidebarBg: 'rgba(0, 0, 0, 0)' }], dark).failed, 1)
  assert.equal(judgeChecks([{ error: 'page gone' }], dark).unknown, 5)
  // A dark-only skin while Claude is light: nothing to check, and it says why.
  // (every shipped skin has both halves since 17 Oct 2026, so the dark-only sheet is cut from one)
  const nord = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8').split(/(?=@media \(prefers-color-scheme: )/)[0]
  assert.equal(judgeChecks([good], expectedColours(nord, 'light')).total, 0)
  // The fixed dot colours (on .status-dot) never stand in for the skin's own accent.
  assert.equal(expectedColours(css, 'light').accentFill, /--cds-role-accent-fill:(#[0-9a-f]{6})/.exec(css.split(/(?=@media \(prefers-color-scheme: )/)[1])[1])
  assert.match(checksLine(judgeChecks([good], expectedColours(nord, 'light')), 'light'), /no light version/)
  assert.equal(checksLine(null), 'sampled colour checks: unknown (Claude did not report its colours)')
  assert.deepEqual(parseRgb('#abc'), [170, 187, 204, 1])
  // Every reviewed preset declares all five sampled colours for each mode it has.
  for (const f of nodeFs.readdirSync(path.join(tool, 'presets'))) {
    const c = readFileSync(path.join(tool, 'presets', f), 'utf8')
    for (const m of ['dark', 'light']) {
      const e = expectedColours(c, m)
      if (Object.keys(e).length > 0) assert.equal(Object.keys(e).length, 5, `${f} ${m}`)
    }
  }
})

test('tick wait: the port must open strictly inside the window; hints at 10 s and 30 s; Ctrl-C stops it', async () => {
  const run = async (openAt, { stopAt = Infinity } = {}) => {
    let t = 0
    const hints = []
    const r = await waitForTick({ portNow: () => ({ state: t >= openAt ? 'open' : 'closed' }), now: () => t, sleep: async (ms) => { t += ms }, stopped: () => t >= stopAt, onHint: () => hints.push(t), windowMs: 60_000, pollMs: 250 })
    return { ...r, hints }
  }
  assert.equal((await run(0)).result, 'open')
  assert.equal((await run(59_750)).result, 'open')
  // Polls every 250 ms: a port that opens at 59.999 s would first be seen at 60 s, which is already outside the window.
  assert.equal((await run(59_999)).result, 'timeout')
  const atEdge = await run(60_000)
  assert.equal(atEdge.result, 'timeout', 'a port that opens exactly at 60 s is too late')
  assert.equal((await run(60_001)).result, 'timeout')
  assert.deepEqual((await run(Infinity)).hints, TICK.hintsAtMs)
  assert.equal(TICK.windowMs, 60_000, 'the click wait is 60 s, as the card ring counts')
  assert.deepEqual(TICK.hintsAtMs, [10_000, 30_000])
  assert.ok(TICK.hintsAtMs.every(h => h < TICK.windowMs), 'every hint comes inside the window')
  assert.equal((await run(Infinity, { stopAt: 5_000 })).result, 'stopped')
  assert.equal(TICK.patientMs, 20_000)
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')
  assert.match(src, /export const PATIENT_MS = 20_000/) // skin.mjs's patient wait is what the guardians were sized for
  assert.ok(TICK.guardBFirstS * 1000 >= TICK.patientMs + TICK.jobMs, 'guardian B never closes the port during a patient apply')
  assert.ok(TICK.guardAFirstS * 1000 > TICK.windowMs, 'guardian A waits past the window')
  assert.ok(TICK.runLimitMs < 180_000, 'fits inside the mod allowance')
})

test('tick mode: safety nets before the prompt, no AppleScript anywhere in it, Chrome left alone', () => {
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const fn = auto.slice(auto.indexOf('async function tickRun()'), auto.indexOf('let exitCode'))
  const prompt = fn.indexOf("console.log('READY_TO_TICK')")
  assert.ok(prompt > 0)
  assert.ok(fn.indexOf('guardScript({ first: TICK.guardAFirstS, yieldPort: LOCK_PORT })') < prompt, 'guardian A before the prompt')
  assert.ok(fn.indexOf("refuse('Could not start the backup guardian, so I did not ask") < prompt)
  assert.ok(fn.indexOf('ticked = true') < prompt, 'ticked before the prompt')
  assert.ok(fn.indexOf("[SKIN, 'verify']") < prompt, 'signature checked before the prompt')
  assert.ok(fn.indexOf("child.until(['CHILD_READY']") > 0 && fn.indexOf("child.until(['CHILD_READY']") < fn.indexOf('ticked = true'), 'the skin step is ready before the prompt')
  assert.ok(fn.indexOf('guardScript({ first: TICK.guardBFirstS, tries: TICK.guardBTries, early: TICK.guardBEarlyS })') > fn.indexOf("child.until(['PORT_SEEN']"), 'guardian B once the port is seen')
  assert.ok(TICK.guardBTries * 10 >= 240, 'guardian B covers a late OK click for minutes')
  for (const bad of ['osa(', 'osaAsync(', 'osascript', 'System Events', 'chromeInstalled()', 'endSidecar', 'mkdtempSync']) assert.ok(!fn.includes(bad), bad)
  const clean = auto.slice(auto.indexOf('async function doCleanup()'), auto.indexOf('for (const sig of'))
  assert.match(clean, /if \(!tickMode\) attempt\('refocus', refocus\)/)
  assert.match(clean, /if \(!tickMode\) attempt\('final checks'/)
  // Guardian A stays when no port was seen in the window (a late tick); B always goes on a confirmed close.
  assert.match(clean, /if \(!\(tickMode && ticked && !tickPortSeen\)\) attempt\('guardian'/)
  const main = auto.slice(auto.indexOf('async function main()'), auto.indexOf('async function noChromeRun()'))
  assert.ok(main.indexOf('if (tickMode) return tickRun()') < main.indexOf('chromeState()'), 'tick mode skips the "quit your Chrome" refusal')
  assert.ok(main.indexOf('if (tickMode) return tickRun()') > main.indexOf('acquireLock()'), 'but takes the lock first')
})

test('guardian A skips its close while another run holds the lock, and closes the port again once it is free', async () => {
  const { guardScript } = await import('../skin-lib.mjs')
  const { spawnSync } = await import('node:child_process')
  const d = mkdtempSync(path.join(tmpdir(), 'skin-guard-'))
  try {
    // Fake lsof: port 9229 is always "open"; the lock port is held by pid 4242 only when LOCKED exists. The newer run
    // marks itself in the private folder: run-pid holds 4242.
    const state = path.join(d, 'state')
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(path.join(state, 'run-pid'), '4242', { mode: 0o600 })
    const lsof = path.join(d, 'lsof')
    writeFileSync(lsof, `#!/bin/sh\ncase "$*" in *47619*) [ -f "${d}/LOCKED" ] && { echo p4242; exit 0; }; exit 1;; *) echo open; exit 0;; esac\n`, { mode: 0o755 })
    const close = path.join(d, 'close')
    writeFileSync(close, `#!/bin/sh\necho closed >> "${d}/closes"\n`, { mode: 0o755 })
    const run = () => spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 0, gap: 0, tries: 2, limit: 3, yieldPort: 47619 }), close, 'x', '', '', state], { encoding: 'utf8', timeout: 20_000 })
    writeFileSync(path.join(d, 'LOCKED'), '')
    run()
    assert.ok(!existsSync(path.join(d, 'closes')), 'never closed a port while another run held the lock')
    // The lock is freed between two rounds: the next round closes (it did not give up for good).
    const lockFree = path.join(d, 'lsof2')
    writeFileSync(lockFree, `#!/bin/sh\ncase "$*" in *47619*) n=$(cat "${d}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${d}/n"; [ "$n" -lt 1 ] && { echo p4242; exit 0; }; exit 1;; *) echo open; exit 0;; esac\n`, { mode: 0o755 })
    spawnSync('/bin/sh', ['-c', guardScript({ lsof: lockFree, first: 0, gap: 0, tries: 2, limit: 3, yieldPort: 47619 }), close, 'x', '', '', state], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(readFileSync(path.join(d, 'closes'), 'utf8').trim().split('\n').length, 1, 'skipped round 1, closed in round 2')
    rmSync(path.join(d, 'closes'))
    rmSync(path.join(d, 'LOCKED'))
    run()
    assert.equal(readFileSync(path.join(d, 'closes'), 'utf8').trim().split('\n').length, 2, 'no lock: it keeps closing')
    // Without yieldPort (one-click and guardian B) it never looks at the lock.
    writeFileSync(path.join(d, 'LOCKED'), '')
    rmSync(path.join(d, 'closes'))
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 0, gap: 0, tries: 1, limit: 3 }), close, 'x', '', '', state], { encoding: 'utf8', timeout: 20_000 })
    assert.ok(existsSync(path.join(d, 'closes')))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('tick mode dry run: refuses or finishes without leaving any guardian behind', async () => {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [autoPath(), 'tick', 'nord', '--dry-run'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SKIN_LOCK_PORT: '47691' } })
  assert.match(r.stdout, /RESULT: (ok|refused)/) // refused when Claude is not running here (a CI machine)
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
  assert.ok(!ps.stdout.split('\n').some((l) => l.includes('claude-skin-guard') && l.includes('sleep 3600;')), 'no dry-run guardian left sleeping')
})

test('tick wait: a check that starts inside the window but answers after it is a late tick, not a pass', async () => {
  // The window starts at 0; the only check starts at 59.999 s and the port answers "open" at 60.001 s.
  const run = (answerAt) => {
    let t = 0
    let started = false
    return waitForTick({
      portNow: () => { t = answerAt; return { state: 'open' } },
      now: () => { if (!started) { started = true; return 0 } return t === 0 ? (t = 59_999) : t },
      sleep: async () => {}, windowMs: 60_000, pollMs: 250, hintsAtMs: [],
    })
  }
  const late = await run(60_001)
  assert.deepEqual([late.result, late.late], ['timeout', true])
  assert.equal((await run(59_999)).result, 'open')
})

// ---- Lifecycle harness: real event emitters, mutable destruction, scaled timers, the real CORE ----
import { EventEmitter } from 'node:events'
function lifecycleClaude() {
  const app = new EventEmitter()
  app.getVersion = () => '1.2.3'
  // A test may hold a given page's next insertCSS until it says so: gate(pageId) answers { started, release }.
  const gates = new Map()
  const gate = (id) => {
    const g = { started: false }
    g.wait = new Promise((r) => { g.release = r })
    gates.set(id, [...(gates.get(id) ?? []), g])
    return g
  }
  const polls = [] // the helper's 1 s poll callbacks, run by the test
  const mkPage = (id, url = 'https://claude.ai/chat') => {
    const p = new EventEmitter()
    Object.assign(p, { id, url, destroyed: false, sheets: new Map(), next: 1,
      getURL: () => p.url, getType: () => 'window', isDestroyed: () => p.destroyed,
      insertCSS: async (css) => { const g = gates.get(id)?.shift(); if (g) { g.started = true; await g.wait } const k = String(p.next++); p.sheets.set(k, css); return k },
      removeInsertedCSS: async (k) => { p.sheets.delete(k) },
      executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => (code.includes('surface1') ? { surface1: '#000000' } : code.includes('--reskin-active') ? ([...p.sheets.values()].some((c) => c.includes('--reskin-active')) ? '1' : '') : {}),
      reload: () => { p.sheets.clear(); setTimeout(() => p.emit('did-finish-load'), 2) },
    })
    return p
  }
  const pages = [mkPage(1)]
  const electron = { app, nativeTheme: { shouldUseDarkColors: true }, webContents: { getAllWebContents: () => pages.filter((p) => !p.destroyed) } }
  const mods = { fs: nodeFs, crypto: { randomUUID } }
  // Timers run 100 times faster, so the real 3 s and 8 s fences take 30 and 80 ms.
  const fast = (f, ms) => setTimeout(f, Math.max(1, Math.round((ms ?? 0) / 100)))
  const ctx = { process: { execPath: '/x', pid: 77, uptime: () => 5, getuid: () => uid, getBuiltinModule: (n) => (n === 'module' ? { createRequire: () => () => electron } : mods[n]) },
    URL, Promise, setTimeout: fast, clearTimeout, setInterval: (f) => { polls.push(f); return { unref() {} } }, clearInterval: () => {}, Map, Set, String, Error, Date, Math, JSON, Object, Number, Uint8Array, TextDecoder, Array }
  const poll = () => { for (const f of polls) f() }
  return { app, pages, mkPage, electron, gate, poll, ctx }
}
async function vmRun(c, code) {
  const { createContext, runInContext } = await import('node:vm')
  c.vm ??= createContext(c.ctx)
  return runInContext(code, c.vm)
}
const css = (name) => PRESETS[name]
async function switchTo(c, dir, session, action, kick = true) {
  const p = sendSwitch(nodeFs, dir, session, action, { randomUUID, waitMs: 2_000, gap: 5 })
  await new Promise((r) => setTimeout(r, 15))
  if (kick) await vmRun(c, 'globalThis.__reskin.helper.kick()')
  return p
}
const tmpDir = () => { const parent = mkdtempSync(path.join(tmpdir(), 'skin-life-')); return { parent, dir: path.join(parent, 'claude-skin'), done: () => rmSync(parent, { recursive: true, force: true }) } }

test('lifecycle: after a helper switch, a reload and a new window get the NEW skin; a destroyed window keeps no key', async () => {
  const c = lifecycleClaude()
  const d = tmpDir()
  try {
    await vmRun(c, skin.setCode(css('nord')))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    assert.equal((await switchTo(c, d.dir, r.session, 'dracula')).ack.ok, true)
    // Reload: the page drops every sheet and fires did-finish-load; the hook puts the current skin back.
    c.pages[0].reload()
    await new Promise((res) => setTimeout(res, 30))
    assert.deepEqual([...c.pages[0].sheets.values()].map((v) => v.includes('blue')), [true])
    // A new window, announced the way Electron does.
    const w = c.mkPage(2); c.pages.push(w)
    c.app.emit('web-contents-created', {}, w)
    w.emit('did-finish-load')
    await new Promise((res) => setTimeout(res, 30))
    assert.ok([...w.sheets.values()].some((v) => v.includes('blue')))
    // Destroyed while ITS insert is in flight: no key is kept for it.
    const g = c.gate(2)
    const pending = switchTo(c, d.dir, r.session, 'nord')
    for (let i = 0; i < 50 && !g.started; i++) await new Promise((res) => setTimeout(res, 2))
    assert.ok(g.started, "page 2's insert started")
    w.destroyed = true; w.emit('destroyed')
    g.release()
    await pending
    const state = await vmRun(c, skin.STATE)
    assert.ok(!state.keys.some(([id]) => id === 2), 'no key for the destroyed window')
  } finally { d.done() }
})

test('lifecycle: a hung apply times out, a newer switch wins, and the late finish of the old one removes itself', async () => {
  const c = lifecycleClaude()
  const d = tmpDir()
  try {
    await vmRun(c, skin.setCode(css('nord')))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    const g = c.gate(1)
    const first = await switchTo(c, d.dir, r.session, 'dracula')
    assert.equal(first.ack.ok, false) // the in-Claude 3 s cap (30 ms here) ended it
    // The window's changes are queued one at a time, so nord waits behind the stuck insert (and may time out too).
    const second = await switchTo(c, d.dir, r.session, 'nord')
    assert.equal(second.ack.nonce, first.ack.nonce + 1)
    g.release() // the stuck dracula insert finally completes, after nord was asked for
    await new Promise((res) => setTimeout(res, 40))
    const sheets = [...c.pages[0].sheets.values()]
    assert.ok(sheets.length > 0 && sheets.every((v) => v.includes('red')), `only the newer skin stays: ${sheets.map((v) => v.slice(40, 70)).join(' | ')}`)
    // And the helper keeps working afterwards.
    const third = await switchTo(c, d.dir, r.session, 'dracula')
    assert.equal(third.ack.ok, true)
    assert.ok([...c.pages[0].sheets.values()].every((v) => v.includes('blue')))
  } finally { d.done() }
})

test('lifecycle: Claude quitting removes the session file, even mid-switch; a folder replaced is picked up again', async () => {
  const c = lifecycleClaude()
  const d = tmpDir()
  let watches = 0
  try {
    await vmRun(c, skin.setCode(css('nord')))
    // Count watcher creations through the real fs.
    // The watcher delivers nothing (as after a folder swap on macOS): only the poll can notice.
    c.ctx.process.getBuiltinModule = ((orig) => (n) => (n === 'fs' ? { ...nodeFs, watch: () => { watches++; return { close() {}, on() {} } } } : orig(n)))(c.ctx.process.getBuiltinModule)
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    assert.equal(watches, 1)
    // The folder is replaced (deleted and made again): the helper re-creates its watcher and session file.
    rmSync(d.dir, { recursive: true, force: true }); mkdirSync(d.dir, { mode: 0o700 }); chmodSync(d.dir, 0o700)
    c.poll() // no manual kick: the 1 s poll finds the new folder
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(watches, 2)
    assert.equal(JSON.parse(readFileSync(path.join(d.dir, 'session.json'), 'utf8')).session, r.session)
    // Quit while a switch is stuck: the session file goes at once, and the late answer harms nothing.
    const g = c.gate(1)
    const pending = sendSwitch(nodeFs, d.dir, r.session, 'dracula', { randomUUID, waitMs: 2_000, gap: 5 })
    await new Promise((res) => setTimeout(res, 15))
    c.poll() // picked up by the poll, not a manual kick
    for (let i = 0; i < 50 && !g.started; i++) await new Promise((res) => setTimeout(res, 2))
    assert.ok(g.started, 'the switch reached the page')
    c.app.emit('will-quit')
    assert.ok(!existsSync(path.join(d.dir, 'session.json')), 'will-quit removes the session file')
    g.release()
    await pending
    assert.equal(liveSession(nodeFs, d.dir, () => ({ comm: CLAUDE_BINARY, startMs: 0 })).state, 'none')
  } finally { d.done() }
})

test('helper: three requests while busy end with only the newest; a replaced helper never overwrites the new ack', async () => {
  const releases = []
  const calls = []
  const t = setup({ apply: (cssText) => { calls.push(cssText); return new Promise((r) => releases.push(() => r({ errors: [], samples: [] }))) } })
  try {
    put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'nord' }); t.h.kick(); await tick()
    put(t.dir, { v: 1, session: t.res.session, nonce: 2, action: 'dracula' }); t.h.kick()
    put(t.dir, { v: 1, session: t.res.session, nonce: 3, action: 'off' }); t.h.kick()
    releases.shift()(); for (let i = 0; i < 20 && calls.length < 2; i++) await tick()
    assert.deepEqual(calls, [PRESETS.nord, null], 'request 2 was never applied: 3 replaced it')
    releases.shift()(); await settle(t.h)
    assert.equal(ack(t.dir).nonce, 3)
    // Replace the helper while it is applying: the old helper's late answer must not land.
    put(t.dir, { v: 1, session: t.res.session, nonce: 4, action: 'nord' }); t.h.kick(); await tick()
    const fresh = skin.installHelper(t.st, t.o)
    releases.shift()(); await settle(t.h)
    const a = ack(t.dir)
    assert.notEqual(a.nonce, 4, 'the stopped helper did not write its late ack')
    assert.ok(a.session !== fresh.session || a.nonce !== 4)
  } finally { t.done() }
})

test('helper: lstat over 4 KB is refused even if the file shrinks before opening; a FIFO is never opened', async () => {
  const realLstat = nodeFs.lstatSync
  const shrunk = setup({ fsOver: { lstatSync: (f, ...r) => (String(f).endsWith('request.json') ? { ...realLstat(f, ...r), isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 4097, uid, mode: 0o100600 } : realLstat(f, ...r)) } })
  try {
    put(shrunk.dir, { v: 1, session: shrunk.res.session, nonce: 1, action: 'nord' })
    shrunk.h.kick(); await settle(shrunk.h)
    assert.deepEqual(shrunk.calls, [])
  } finally { shrunk.done() }
  let opened = 0
  const fifo = setup({ fsOver: { openSync: (f, ...r) => { if (String(f).endsWith('request.json')) opened++; return nodeFs.openSync(f, ...r) } } })
  try {
    const { spawnSync } = await import('node:child_process')
    assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', path.join(fifo.dir, 'request.json')]).status, 0)
    fifo.h.kick(); await settle(fifo.h)
    assert.equal(opened, 0, 'a FIFO is refused before any open')
    assert.deepEqual(fifo.calls, [])
  } finally { fifo.done() }
})

test('lifecycle: an older Off that finishes late never reloads away or untracks a newer skin', async () => {
  const c = lifecycleClaude()
  const d = tmpDir()
  try {
    await vmRun(c, skin.setCode(css('nord')))
    // Off whose marker read is slow: a newer apply lands while it waits.
    let release
    const page = c.pages[0]
    const realExec = page.executeJavaScriptInIsolatedWorld
    let slow = true
    page.executeJavaScriptInIsolatedWorld = async (...a) => { if (slow && String(a[1][0].code).includes('--reskin-active')) { slow = false; await new Promise((res) => { release = res }) } return realExec(...a) }
    const off = vmRun(c, skin.setCode(null))
    await new Promise((res) => setTimeout(res, 20))
    await vmRun(c, skin.setCode(css('dracula')))
    const reloadsBefore = page.listenerCount('did-finish-load')
    let reloaded = 0
    const realReload = page.reload
    page.reload = () => { reloaded++; realReload() }
    release()
    await off
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(reloaded, 0, 'the older Off did not reload the page')
    assert.ok([...page.sheets.values()].some((v) => v.includes('blue')), 'the newer skin is still on')
    const state = await vmRun(c, skin.STATE)
    assert.ok(state.keys.some(([id]) => id === 1), 'and still tracked, so a later Off can remove it')
    void reloadsBefore
  } finally { d.done() }
})

test('remove: the client reports success only on the final "done" answer, and reports a failed teardown', async () => {
  for (const failing of [false, true]) {
    const t = setup({ apply: async (cssText) => ({ errors: cssText === null && failing ? ['the skin marker is still on 1 page(s)'] : [], samples: [] }) })
    try {
      const { ack: first } = await (async () => { const p = sendSwitch(nodeFs, t.dir, t.res.session, 'remove', { randomUUID, waitMs: 500, gap: 5 }); await new Promise((r) => setTimeout(r, 15)); t.h.kick(); return p })()
      assert.ok(first.phase === 'accepted' || first.phase === 'done')
      await settle(t.h)
      const a = ack(t.dir)
      assert.deepEqual([a.phase, a.ok], ['done', !failing])
      if (failing) assert.match(a.errors[0], /marker/)
    } finally { t.done() }
  }
})

// End to end through the real entry script: `skin-auto.mjs switch` talks to a helper running in this test (a temp
// folder via RESKIN_STATE_DIR), whose session names the Claude running on this Mac (read-only: Claude is not touched).
async function claudeProc() {
  const { spawnSync } = await import('node:child_process')
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
  const line = ps.stdout.split('\n').find((l) => l.trim().endsWith(CLAUDE_BINARY))
  if (!line) return null
  const pid = Number(line.trim().split(/\s+/)[0])
  return { pid, startMs: parsePs(spawnSync('/bin/ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })).startMs }
}
async function cli(dir, ...args) {
  const { spawn } = await import('node:child_process')
  const p = spawn(process.execPath, [autoPath(), ...args], { env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: dir, SKIN_LOCK_PORT: '47692' } })
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  const code = await new Promise((r) => p.on('close', r))
  return { code, out }
}

test('switch client end to end: apply, unconfirmed with no answer, remove reports the final answer honestly', async (t) => {
  const claude = await claudeProc()
  if (!claude) return t.skip('Claude is not running on this Mac')
  for (const failing of [false, true]) {
    let interval
    const h = setup({ o: { pid: claude.pid, boot: claude.startMs, setInterval: (f) => (interval = setInterval(f, 20)), clearInterval: (x) => clearInterval(x ?? interval) },
      apply: async (cssText) => ({ errors: cssText === null && failing ? ['the skin marker is still on 1 page(s)'] : [], samples: [{ surface1: '#2e3440', textPrimary: '#d8dee9', accentFill: '#88c0d0', bodyBg: 'rgb(46, 52, 64)', sidebarBg: 'rgb(36, 41, 51)' }] }) })
    try {
      if (!failing) {
        const st = await cli(h.dir, 'status')
        assert.match(st.out, /helper: active until Claude quits/)
        const sw = await cli(h.dir, 'switch', 'nord')
        assert.equal(sw.code, 0, sw.out)
        assert.match(sw.out, /Skin nord applied by the colour helper\./)
        assert.match(sw.out, /sampled colour checks: \d+ of \d+ passed/)
        assert.match(sw.out, /debugger: not used/)
        assert.match(sw.out, /PORT_STATE: \w+\nRESULT: ok/)
        assert.deepEqual(readPrefs(nodeFs, h.dir), { last: 'nord' })
        // The helper stops answering: unconfirmed, failed, and nothing else is tried.
        clearInterval(interval); h.h.stopped = true
        const quiet = await cli(h.dir, 'switch', 'dracula')
        assert.equal(quiet.code, 1)
        assert.match(quiet.out, /switch unconfirmed/)
        assert.doesNotMatch(quiet.out, /READY_TO_TICK|menu ticked/)
        continue
      }
      const rm = await cli(h.dir, 'switch', 'remove')
      assert.equal(rm.code, 1, rm.out)
      assert.match(rm.out, /Removal not complete: the skin marker is still on/)
      assert.match(rm.out, /RESULT: failed/)
    } finally { clearInterval(interval); h.done() }
  }
  // A clean remove succeeds only with the final answer.
  let interval
  const ok = setup({ o: { pid: claude.pid, boot: claude.startMs, setInterval: (f) => (interval = setInterval(f, 20)), clearInterval: () => {} } })
  try {
    const rm = await cli(ok.dir, 'switch', 'remove')
    assert.equal(rm.code, 0, rm.out)
    assert.match(rm.out, /Skin and colour helper removed, as the helper itself reports/)
  } finally { clearInterval(interval); ok.done() }
})

test('lifecycle: a newer skin applied while an older Off waits for its page reload stays tracked', async () => {
  const c = lifecycleClaude()
  const page = c.pages[0]
  await vmRun(c, skin.setCode(css('nord')))
  // Removal that silently does nothing (what Electron once did live), so Off finds the marker and reloads; the reload
  // holds until we let it finish.
  page.removeInsertedCSS = async () => {}
  let finish
  page.reload = () => { page.sheets.clear(); finish = () => page.emit('did-finish-load') }
  const off = vmRun(c, skin.setCode(null))
  for (let i = 0; i < 50 && !finish; i++) await new Promise((r) => setTimeout(r, 2))
  assert.ok(finish, 'the Off reached its reload')
  await vmRun(c, skin.setCode(css('dracula'))) // a newer skin lands while the reload is pending
  finish()
  await off
  const state = await vmRun(c, skin.STATE)
  assert.ok(state.keys.some(([id]) => id === 1), 'the newer skin is still tracked, so a later Off can remove it by key')
  assert.ok([...page.sheets.values()].some((v) => v.includes('blue')))
})

test('helper: an old removal that finishes after a new helper took over never overwrites the new ack', async () => {
  let releaseOff
  const t = setup({ apply: (cssText) => (cssText === null ? new Promise((r) => { releaseOff = () => r({ errors: [], samples: [] }) }) : Promise.resolve({ errors: [], samples: [] })) })
  try {
    put(t.dir, { v: 1, session: t.res.session, nonce: 1, action: 'remove' }); t.h.kick()
    for (let i = 0; i < 50 && !releaseOff; i++) await tick()
    assert.equal(ack(t.dir).phase, 'accepted')
    // A new apply installs a new helper, which handles a request of its own.
    const fresh = skin.installHelper(t.st, t.o)
    put(t.dir, { v: 1, session: fresh.session, nonce: 1, action: 'nord' }); t.st.helper.kick(); await settle(t.st.helper)
    assert.deepEqual([ack(t.dir).session, ack(t.dir).action], [fresh.session, 'nord'])
    releaseOff(); await settle(t.h)
    assert.deepEqual([ack(t.dir).session, ack(t.dir).action], [fresh.session, 'nord'], 'the old removal stayed silent')
  } finally { t.done() }
})

test('lifecycle: an old removal that ends while a newer debugger apply is under way leaves the new state alone', async () => {
  const c = lifecycleClaude()
  const d = tmpDir()
  try {
    await vmRun(c, skin.setCode(css('nord')))
    const r = await vmRun(c, skin.helperCode(PRESETS, d.dir))
    await vmRun(c, 'globalThis.__reskinFallback = setTimeout(() => {}, 99999)') // as a debugger run's ARM leaves it
    // The removal's Off finds a page whose removal silently fails, so it reloads; the reload is held.
    const page = c.pages[0]
    page.removeInsertedCSS = async () => {}
    let finish
    page.reload = () => { page.sheets.clear(); finish = () => page.emit('did-finish-load') }
    put(d.dir, { v: 1, session: r.session, nonce: 1, action: 'remove' })
    c.poll()
    for (let i = 0; i < 50 && !finish; i++) await new Promise((res) => setTimeout(res, 2))
    assert.ok(finish, 'the removal reached its reload')
    // A newer debugger apply starts (its helper not installed yet) and is still inserting when the old reload finishes,
    // so the old Off sees no marker and ends cleanly: only the generation rule can keep it from wiping the new state.
    const g = c.gate(1)
    const newer = vmRun(c, skin.setCode(css('dracula')))
    for (let i = 0; i < 50 && !g.started; i++) await new Promise((res) => setTimeout(res, 2))
    assert.ok(g.started, 'the newer insert is in flight')
    finish()
    await new Promise((res) => setTimeout(res, 20))
    const ackNow = JSON.parse(readFileSync(path.join(d.dir, 'ack.json'), 'utf8'))
    assert.deepEqual([ackNow.phase, ackNow.ok], ['done', true], 'the old removal itself succeeded')
    const left = await vmRun(c, '({ st: globalThis.__reskin !== undefined, fallback: globalThis.__reskinFallback !== undefined, css: globalThis.__reskin?.css ?? null })')
    assert.deepEqual([left.st, left.fallback], [true, true], 'the newer run keeps its state and its close timer')
    assert.ok(String(left.css).includes('blue'))
    g.release()
    await newer
  } finally { d.done() }
})

test('menu probe (P9) reads the debugger item and its handler, and clicks or changes nothing', async () => {
  const { createContext, runInContext } = await import('node:vm')
  let clicked = 0
  const item = { label: 'Enable Main Process Debugger', type: 'checkbox', checked: true, enabled: true, visible: true, click: function handler() { clicked++ } }
  const menu = { items: [{ label: 'File', submenu: { items: [] } }, { label: 'Developer', submenu: { items: [{ label: 'Other' }, item] } }] }
  const electron = { Menu: { getApplicationMenu: () => menu } }
  const ctx = createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, String })
  const r = JSON.parse(JSON.stringify(runInContext(skin.MENU_PROBE, ctx)))
  assert.deepEqual([r.found, r.path, r.type, r.checked], [true, ['Developer', 'Enable Main Process Debugger'], 'checkbox', true])
  assert.match(r.handler, /function handler/)
  assert.equal(clicked, 0)
  assert.equal(item.checked, true)
  assert.ok(!/\.click\(|checked\s*=[^=]/.test(skin.MENU_PROBE), 'no click call and no assignment to checked')
  electron.Menu.getApplicationMenu = () => null
  assert.equal(runInContext(skin.MENU_PROBE, ctx).found, false)
})

// Updating Reskin while a helper from the older code still runs inside Claude: every path refuses and
// says to quit and reopen Claude, so no second skin is put beside the old one and no Off reports a false success.
test('an outdated helper: switch, off, check and a tick all refuse and say to quit and reopen Claude', async (t) => {
  const claude = await claudeProc()
  if (!claude) return t.skip('Claude is not running on this Mac')
  const dir = mkdtempSync(path.join(tmpdir(), 'reskin-outdated-'))
  try {
    chmodSync(dir, 0o700)
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, session: randomUUID(), pid: claude.pid, boot: claude.startMs, version: '9.9.9', caps: ['check'] }), { mode: 0o600 })
    for (const args of [['switch', 'nord'], ['switch', 'off'], ['check'], ['tick', 'nord']]) {
      const r = await cli(dir, ...args)
      assert.notEqual(r.code, 0, args.join(' '))
      assert.match(r.out, /Quit and reopen Claude once/, args.join(' '))
      assert.doesNotMatch(r.out, /READY_TO_TICK/, args.join(' '))
      assert.ok(!existsSync(path.join(dir, 'request.json')), `${args.join(' ')} sent nothing to the old helper`)
    }
    const st = await cli(dir, 'status')
    assert.match(st.out, /helper: outdated/); assert.match(st.out, /Quit and reopen Claude once/); assert.doesNotMatch(st.out, /Reapply/)
    // A session file that cannot be trusted (here: readable by others) may be an old helper too: a tick refuses.
    chmodSync(path.join(dir, 'session.json'), 0o644)
    const tick = await cli(dir, 'tick', 'nord')
    assert.notEqual(tick.code, 0); assert.match(tick.out, /Could not tell whether a colour helper is already running/)
    assert.doesNotMatch(tick.out, /READY_TO_TICK/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// An untrusted helper folder or session file must not block Reskin for good: only a session
// file written while the running Claude was up can belong to a live helper. Deterministic: Claude's start is given.
test('liveSession: an untrusted folder or session file is a leftover once it is older than the running Claude', () => {
  const t = setup()
  try {
    const file = path.join(t.dir, 'session.json')
    const proc = (p) => (p === 4242 ? { comm: CLAUDE_BINARY, startMs: 1_500 } : null)
    const at = (ms) => utimesSync(file, ms / 1000, ms / 1000)
    const state = (claudeStart) => liveSession(nodeFs, t.dir, proc, { claudeStart }).state
    chmodSync(file, 0o644) // a session file that cannot be trusted
    at(1_000_000)
    assert.equal(liveSession(nodeFs, t.dir, proc).state, 'unknown') // without a Claude start time: as before
    assert.equal(state(() => 2_000_000), 'none') // written before this Claude started: a leftover
    assert.equal(state(() => 1_001_000), 'unknown') // within 2 s of the start: not sure
    assert.equal(state(() => 500_000), 'unknown') // written while this Claude runs: may be a live helper
    assert.equal(state(() => null), 'none') // no Claude runs, so no helper does
    assert.equal(state(() => { throw new Error('2 Claude processes are running') }), 'unknown')
    chmodSync(file, 0o600)
    chmodSync(t.dir, 0o755) // a folder that cannot be trusted
    assert.equal(state(() => 2_000_000), 'none')
    assert.equal(state(() => 500_000), 'unknown')
    rmSync(file)
    assert.equal(state(() => 500_000), 'none') // no session at all: the next skin repairs the folder
    assert.equal(liveSession(nodeFs, t.dir, proc).state, 'unknown') // without a Claude start time: as before
    // A folder that cannot even be opened: its own time decides, and no running Claude means no helper.
    writeFileSync(file, '{}', { mode: 0o600 })
    utimesSync(t.dir, 1_000, 1_000)
    chmodSync(t.dir, 0o000)
    assert.equal(state(() => null), 'none')
    assert.equal(state(() => 2_000_000), 'none') // folder unchanged since before this Claude started
    chmodSync(t.dir, 0o700); utimesSync(t.dir, 1_000_000, 1_000_000); chmodSync(t.dir, 0o000)
    assert.equal(state(() => 500_000), 'unknown') // changed while this Claude runs
  } finally { chmodSync(t.dir, 0o700); t.done() }
})
