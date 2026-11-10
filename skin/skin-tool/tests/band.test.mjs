// Appearance band (5 Nov 2026): the claims the band may show (pure), the queued-command lock wait and the read's own
// deadline (real processes: a real lock holder, the real skin-auto.mjs, the real port freed by the operating system).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEALTH_PARTS, acquireLock, acquireLockWaiting, bandClaims, expectedHealth, parseLockWait } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const NORD = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
const cssOf = (n) => (n === 'nord' ? NORD : null)
const opts = { cssOf, digestOf: sha }

function goodPage(mode, over = {}) {
  const want = expectedHealth(NORD, mode)
  const parts = Object.fromEntries(Object.keys(HEALTH_PARTS).map((k) => [k, k in want ? { on: true, v: want[k] } : { on: false, v: null }]))
  if ('pulseWaiting' in want) parts.pulsePaint = { on: true, v: want.pulseWaiting }
  const head = { family: 'x', size: 14, line: 20, weight: 400 }
  return { ready: 'complete', marker: true, typeMarker: true, scheme: mode, anchors: { root: true, sidebar: true, content: true, rows: true }, parts, look: { header: head, headerEmph: null }, ...over }
}
const ackOf = (pages, over = {}) => ({ ok: true, action: 'check', current: 'nord', digest: sha(NORD), dark: true, type: 'on', font: null, sample: { stable: true, pages }, ...over })

// ---- Claims ----
test('claims: a health pass names the skin, the mode and the accent of that mode', () => {
  const c = bandClaims(ackOf([goodPage('dark')]), opts)
  assert.deepEqual(c, { skin: 'nord', sidebar: 'on', mode: 'dark', accent: '#8dc3d2' })
  const l = bandClaims(ackOf([goodPage('light')], { dark: false }), opts)
  assert.equal(l.mode, 'light'); assert.equal(l.accent, '#455f7f')
})

test('claims: anything short of a pass is unknown, and no accent without a proven skin and mode', () => {
  assert.equal(bandClaims(ackOf([goodPage('dark')], { digest: 'f'.repeat(64) }), opts).skin, 'unknown', 'preset file changed since the helper started')
  const miss = goodPage('dark'); miss.parts.sidebarBg = { on: true, v: '#ff0000' }
  assert.equal(bandClaims(ackOf([miss]), opts).skin, 'unknown', 'a fail is not a pass')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { sample: { stable: false, pages: [goodPage('dark')] } }), opts).skin, 'unknown')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { ok: false }), opts).skin, 'unknown')
  const unk = bandClaims(ackOf([goodPage('dark')], { current: 'unknown' }), opts)
  assert.equal(unk.skin, 'unknown'); assert.equal(unk.accent, null)
  const off = bandClaims(ackOf([goodPage('dark', { marker: false })], { current: 'off', digest: null }), opts)
  assert.equal(off.skin, 'off'); assert.equal(off.accent, null)
  assert.equal(bandClaims(ackOf([goodPage('dark')], { current: 'off', digest: null }), opts).skin, 'unknown', 'off, yet colours still showing')
  for (const bad of [null, undefined, 'x', {}]) assert.deepEqual(bandClaims(bad, opts), { skin: 'unknown', sidebar: 'unknown', mode: 'unknown', accent: null })
})

test('claims: mode only when every page and the helper agree', () => {
  assert.equal(bandClaims(ackOf([goodPage('dark')], { dark: false }), opts).mode, 'unknown')
  assert.equal(bandClaims(ackOf([goodPage('dark'), goodPage('light')]), opts).mode, 'unknown')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { dark: null }), opts).mode, 'unknown')
  assert.equal(bandClaims(ackOf([goodPage('dark', { scheme: 'blue' })]), opts).mode, 'unknown')
})

test('claims: sidebar on needs the marker on every readable page and headers on screen', () => {
  assert.equal(bandClaims(ackOf([goodPage('dark'), goodPage('dark', { typeMarker: false })]), opts).sidebar, 'unknown', 'one good page plus one missing the marker')
  assert.equal(bandClaims(ackOf([goodPage('dark', { look: { header: null, headerEmph: null } })]), opts).sidebar, 'unknown', 'no header on screen')
  assert.equal(bandClaims(ackOf([goodPage('dark', { look: { header: null, headerEmph: { size: 14 } } })]), opts).sidebar, 'on')
  assert.equal(bandClaims(ackOf([goodPage('dark'), { error: 'gone' }]), opts).sidebar, 'unknown', 'an unreadable page')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { type: 'unknown' }), opts).sidebar, 'unknown')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { sample: { stable: false, pages: [goodPage('dark')] } }), opts).sidebar, 'unknown')
  assert.equal(bandClaims(ackOf([]), opts).sidebar, 'unknown', 'no page at all')
})

test('claims: sidebar off needs no marker, unless a font (which shares it) is on', () => {
  assert.equal(bandClaims(ackOf([goodPage('dark', { typeMarker: false })], { type: 'off' }), opts).sidebar, 'off')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { type: 'off' }), opts).sidebar, 'unknown', 'off, yet the marker shows with no font')
  assert.equal(bandClaims(ackOf([goodPage('dark')], { type: 'off', font: 'chat.font.plex' }), opts).sidebar, 'off', 'the marker is the font\'s')
  assert.equal(bandClaims(ackOf([goodPage('dark', { typeMarker: false }), { error: 'x' }], { type: 'off' }), opts).sidebar, 'unknown')
})

// ---- --lock-wait ----
test('lock wait: the option is parsed strictly and taken out of the arguments', () => {
  assert.deepEqual(parseLockWait(['status']), { ms: 0, rest: ['status'] })
  assert.deepEqual(parseLockWait(['switch', '--lock-wait=15000', 'nord']), { ms: 15000, rest: ['switch', 'nord'] })
  for (const bad of ['--lock-wait=0', '--lock-wait=20001', '--lock-wait=abc', '--lock-wait=', '--lock-wait', '--lock-wait=015', '--lock-wait=1.5', '--lock-wait=-3']) assert.ok(parseLockWait(['status', bad]).why, bad)
  assert.match(parseLockWait(['status', '--lock-wait=10', '--lock-wait=20']).why, /twice/)
})

let nextPort = 47_700 + Math.floor(Math.random() * 150)
const freePort = async () => nextPort++
// A real process that binds the lock port, says so, and lets go after `ms` (or never, until killed).
function holder(port, ms) {
  const code = `const s=require('net').createServer(()=>{});s.listen(${port},'127.0.0.1',()=>{console.log('held');${ms === null ? '' : `setTimeout(()=>process.exit(0),${ms})`}})`
  const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve) => p.stdout.once('data', () => resolve(p)))
}
const gone = (p) => new Promise((r) => (p.exitCode !== null ? r() : p.once('exit', r)))
function runTool(args, port, extraEnv = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-band-'))
  const home = path.join(d, 'home'); mkdirSync(home)
  const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: String(port), RESKIN_LOG: 'off', ...extraEnv }
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(tool, 'skin-auto.mjs'), ...args], { env })
    let out = '', err = ''
    p.stdout.on('data', (b) => { out += b }); p.stderr.on('data', (b) => { err += b })
    p.on('exit', (code) => { rmSync(d, { recursive: true, force: true }); resolve({ code, out, err, ms: Date.now() - t0 }) })
  })
}

test('lock wait (real processes): a queued command starts only after the holder is gone', async () => {
  const port = await freePort()
  const h = await holder(port, 1_500)
  let exitedAt = null
  h.once('exit', () => { exitedAt = Date.now() })
  const r = await runTool(['status', '--lock-wait=6000'], port)
  assert.doesNotMatch(r.err, /Not started/, r.err)
  assert.ok(exitedAt !== null, 'the holder had exited before the command finished')
  assert.ok(r.ms >= 1_000, `waited for the holder (${r.ms} ms)`)
  // Without the option: refused at once, as before.
  const h2 = await holder(port, 1_500)
  const now = await runTool(['status'], port)
  assert.match(now.err, /Not started: another skin change is running/)
  await gone(h2)
})

test('lock wait (real processes): a holder that never lets go gives the plain refusal when the wait ends', async () => {
  const port = await freePort()
  const h = await holder(port, null)
  try {
    const r = await runTool(['status', '--lock-wait=800'], port)
    assert.match(r.err, /Not started: the previous Reskin step is still finishing; try again in a moment\./)
    assert.match(r.out, /^RESULT: refused$/m)
    assert.ok(r.ms < 6_000, `${r.ms} ms`)
  } finally { h.kill('SIGKILL'); await gone(h) }
})

test('lock wait: bad values are a usage refusal and nothing is read', async () => {
  const r = await runTool(['status', '--lock-wait=99999'], await freePort())
  assert.equal(r.code, 2); assert.match(r.err, /--lock-wait takes a whole number/)
})

test('lock wait (unit): retries only for a busy lock, and stops at the time given', async () => {
  let n = 0, t = 0
  const busy = { ok: false, reason: 'another skin change is running (or something else is using local port 1)' }
  const r = await acquireLockWaiting(500, { acquire: async () => (++n < 3 ? busy : { ok: true }), now: () => t, sleep: async (ms) => { t += ms } })
  assert.equal(r.ok, true); assert.equal(n, 3)
  n = 0; t = 0
  const never = await acquireLockWaiting(500, { acquire: async () => { n++; return busy }, now: () => t, sleep: async (ms) => { t += ms } })
  assert.equal(never.ok, false); assert.equal(never.busy, true); assert.ok(n >= 5 && n <= 7, String(n))
  n = 0
  const other = await acquireLockWaiting(500, { acquire: async () => { n++; return { ok: false, reason: 'could not take the run lock on local port 1: EACCES' } } })
  assert.equal(n, 1); assert.match(other.reason, /EACCES/)
  n = 0
  assert.equal((await acquireLockWaiting(0, { acquire: async () => { n++; return busy } })).ok, false); assert.equal(n, 1, 'no wait asked: one try, as before')
})

// ---- The read's own deadline ----
test('look show ends itself at its deadline and the lock is free right after (real process)', async () => {
  const port = await freePort()
  const r = await runTool(['look', 'show'], port, { SKIN_LOOK_DEADLINE_MS: '1200', SKIN_TEST_LOOK_STALL: '1' })
  assert.match(r.out, /^LOOK: \{"helper":"noanswer"\}$/m)
  assert.match(r.out, /^RESULT: failed$/m)
  assert.ok(r.ms >= 1_100 && r.ms < 8_000, `${r.ms} ms`)
  const l = await acquireLock(port)
  assert.equal(l.ok, true, 'the operating system freed the lock with the process')
  await l.release()
})

test('look show: the stall stand-in is ignored without a shortened deadline, and the deadline cannot be lengthened', async () => {
  const port = await freePort()
  const r = await runTool(['look', 'show'], port, { SKIN_TEST_LOOK_STALL: '1', SKIN_LOOK_DEADLINE_MS: '60000' })
  assert.match(r.out, /^LOOK: \{"helper":"none"\}$/m, 'ran normally: no helper in a fresh state folder')
  assert.ok(r.ms < 8_000)
})

test('a queued command behind a stalled read starts after the read\'s deadline (real processes)', async () => {
  const port = await freePort()
  const read = runTool(['look', 'show'], port, { SKIN_LOOK_DEADLINE_MS: '1500', SKIN_TEST_LOOK_STALL: '1' })
  await new Promise((r) => setTimeout(r, 400))
  const cmd = await runTool(['status', '--lock-wait=8000'], port)
  const rr = await read
  assert.match(rr.out, /"helper":"noanswer"/)
  assert.doesNotMatch(cmd.err, /Not started/, cmd.err)
})

test('look show: a blocking check across the deadline delays the end by at most its own 4 s (real process)', async () => {
  const port = await freePort()
  const read = runTool(['look', 'show'], port, { SKIN_LOOK_DEADLINE_MS: '1500', SKIN_TEST_LOOK_STALL: 'sync' })
  await new Promise((r) => setTimeout(r, 400))
  const cmd = runTool(['status', '--lock-wait=10000'], port)
  const r = await read
  assert.match(r.out, /^LOOK: \{"helper":"noanswer"\}$/m)
  assert.ok(r.ms >= 1_300 && r.ms < 1_500 + 4_500 + 1_500, `${r.ms} ms`)
  const c = await cmd
  assert.doesNotMatch(c.err, /Not started/, c.err)
  const l = await acquireLock(port)
  assert.equal(l.ok, true); await l.release()
})
