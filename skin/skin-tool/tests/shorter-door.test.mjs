// Shrink the time the debugger is open. P1 fast TCP probe, P2 the skin step starts before the
// prompt and waits for the port itself, P3 colour checks after the close (through the helper), P4 a 5 s in-Claude timer for
// a tick-mode apply and an early guardian look when the main run is gone, P5 the measured time in the report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { TICK, claudePidOf, debuggerClosedLine, guardScript, parseListener, tcpProbe } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const skinSrc = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')
const autoSrc = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')

async function load() {
  const src = skinSrc.replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { arm, ARM, FALLBACK_CLOSE_MS }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-door-'))
  const file = path.join(dir, 'skin-copy.mjs')
  writeFileSync(file, src)
  const m = await import(file)
  rmSync(dir, { recursive: true, force: true })
  return m
}
const listen = () => new Promise((res) => { const s = createServer(); const seen = []; s.on('connection', (c) => { seen.push(c); c.on('data', () => {}) }); s.listen(0, '127.0.0.1', () => res({ s, seen, port: s.address().port })) })

test('P1 probe: open, refused and silent ports, and the socket is always destroyed', async () => {
  const { s, seen, port } = await listen()
  try {
    assert.deepEqual(await tcpProbe({ port }), { state: 'open' })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(seen.length, 1)
    assert.ok(seen[0].destroyed || seen[0].readableEnded || await new Promise((r) => { seen[0].once('close', () => r(true)); setTimeout(() => r(false), 500) }), 'our end closed the connection')
  } finally { for (const c of seen) c.destroy(); s.close() } // never hang the run, even if the probe failed to
  // The same port, now closed: refused.
  assert.deepEqual(await tcpProbe({ port }), { state: 'closed' })
  // A connect that never answers: unknown after the time limit, and destroyed.
  const fake = new EventEmitter()
  let destroyed = false
  fake.destroy = () => { destroyed = true }
  const t = Date.now()
  assert.deepEqual(await tcpProbe({ port: 1, ms: 80, connect: () => fake }), { state: 'unknown' })
  assert.ok(Date.now() - t < 1_000)
  assert.equal(destroyed, true)
  // Other errors are unknown, never "closed".
  const odd = new EventEmitter()
  odd.destroy = () => {}
  const p = tcpProbe({ connect: () => odd })
  odd.emit('error', Object.assign(new Error('x'), { code: 'EPERM' }))
  assert.deepEqual(await p, { state: 'unknown' })
  assert.deepEqual(await tcpProbe({ connect: () => { throw new Error('no') } }), { state: 'unknown' })
})

test('P1 numbers: 50 ms probes, the window unchanged', () => {
  assert.equal(TICK.probeMs, 50)
  assert.equal(TICK.windowMs, 60_000)
  assert.match(skinSrc, /pollMs: TICK\.probeMs/)
  assert.match(skinSrc, /portNow: \(\) => tcpProbe\(\{ port: PORT, host: HOST \}\)/)
})

test('listener and Claude pid parsing: only clean answers count', () => {
  assert.equal(parseListener({ status: 1, out: '', err: '' }), 'none')
  assert.deepEqual(parseListener({ status: 0, out: 'p42\nn127.0.0.1:9229\n', err: '' }), { pid: 42, names: ['127.0.0.1:9229'] })
  assert.throws(() => parseListener({ status: 0, out: 'p1\nn127.0.0.1:9229\np2\nn127.0.0.1:9229\n', err: '' }), /2 owners/)
  assert.throws(() => parseListener({ status: 1, out: '', err: 'boom' }), /lsof failed/)
  assert.throws(() => parseListener({ failed: true }), /unknown/)
  const B = '/Applications/Claude.app/Contents/MacOS/Claude'
  assert.equal(claudePidOf({ status: 0, out: `  1 /sbin/launchd\n 812 ${B}\n 813 ${B} Helper\n 900 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n` }), 812)
  assert.throws(() => claudePidOf({ status: 0, out: '1 /sbin/launchd\n' }), /not running/)
  assert.throws(() => claudePidOf({ status: 0, out: `1 ${B}\n2 ${B}\n` }), /2 Claude processes/)
  assert.throws(() => claudePidOf({ status: 1, out: '' }), /Could not list/)
})

test('P2 order inside the skin step: slow checks, then ready, then the wait, then the owner check before any code', () => {
  const fn = skinSrc.slice(skinSrc.indexOf('async function main()'))
  const at = (s) => { const i = fn.indexOf(s); assert.ok(i > 0, s); return i }
  assert.ok(at("claudePidOf(run('/bin/ps'") < at("console.log('CHILD_READY')"))
  assert.ok(at("'--verify', `-R=${REQUIREMENT}`, String(claudePid)") < at("console.log('CHILD_READY')"), 'running Claude signature checked before ready')
  assert.ok(at("console.log('CHILD_READY')") < at('await waitForTick('))
  assert.ok(at('await waitForTick(') < at("console.log('PORT_SEEN')"))
  assert.ok(at('const owner = checkOwnerFast(claudePid)') < at('const connecting = connect(() => deadline)'), 'owner check runs alongside the connect')
  assert.ok(at('[first, conn] = await Promise.all([owner, connecting])') < at('conn.evaluate(IDENTIFY)'), 'nothing is evaluated before the owner check passed')
  assert.ok(at("process.stdin.on('end', () => { parentGone = true })") < at("console.log('CHILD_READY')"), 'bound to the run that started it')
})

test('P2 in skin-auto: the prompt waits for the ready line; a child that fails first means no prompt', () => {
  const fn = autoSrc.slice(autoSrc.indexOf('async function tickRun()'), autoSrc.indexOf('function startTickChild()'))
  const ready = fn.indexOf("await child.until(['CHILD_READY'], TICK.readyMs)")
  assert.ok(ready > 0 && ready < fn.indexOf("console.log('READY_TO_TICK')"))
  assert.ok(fn.indexOf("refuse(`The skin step could not get ready") > ready && fn.indexOf("refuse(`The skin step could not get ready") < fn.indexOf('ticked = true'))
  assert.match(autoSrc, /skinArgs\.push\('--patient', '--wait-open'\)/)
  assert.match(autoSrc, /stdio: \['pipe', 'pipe', 'pipe'\] \}\) \/\/ stdin stays open/)
})

test('P3: a tick-mode preset apply samples nothing and reads no mode while the debugger is open', () => {
  const fn = skinSrc.slice(skinSrc.indexOf('async function main()'))
  assert.match(fn, /setCode\(css, false, false, quick\)/)
  assert.match(fn, /if \(mode === 'apply' && !quick\) try \{ claudeMode/)
  assert.match(fn, /if \(mode === 'apply' && !quick\) try \{ claudeVersion/)
  assert.match(skinSrc, /const samples = offRun \|\| quick \? \[\] :/)
  assert.match(skinSrc, /\} else if \(!quick\) \{\n      \/\/ Apply must be proven too/) // proof moves after the close too
  assert.match(autoSrc, /const quickChecks = tickMode && appliedPreset !== null/)
  assert.match(autoSrc, /if \(skinOk && report\.deferred && \(await deferredChecks\(\)\) === 'failed'\) skinOk = false/)
  // The deferred check reuses the helper's existing command (the same preset); it adds nothing to its command list.
  assert.match(autoSrc, /sendSwitch\(nodeFs, STATE, report\.session, appliedPreset,/)
})

test('P4: 8 s in-Claude timer for a tick-mode apply, 22 s for everything else, and both clear the tick', async () => {
  const m = await load()
  const delays = (code) => {
    const got = []
    const ctx = createContext({ process: { execPath: '/x', getBuiltinModule: (n) => n === 'inspector' ? { close: () => {} } : { createRequire: () => () => ({ Menu: { getApplicationMenu: () => null } }) } }, setTimeout: (fn, ms) => { got.push(ms); return 1 }, clearTimeout: () => {} })
    ctx.globalThis = ctx
    assert.equal(new Script(code).runInContext(ctx), true)
    return got
  }
  assert.equal(TICK.armMs, 8_000)
  assert.ok(TICK.armMs >= 3_000 + 3_000 + 2_000, 'the slowest permitted quick apply (3 s change, 3 s helper) plus 2 s fits')
  assert.match(skinSrc, /'changing the stylesheets'\)/)
  assert.match(skinSrc, /helperCode\(presets\.map, STATE_DIR\), 3_000\)/)
  assert.match(skinSrc, /within\(Promise\.all\(webContents\.getAllWebContents\(\)\.map\(put\)\), 3000,/)
  assert.deepEqual(delays(m.arm(TICK.armMs)), [8_000])
  assert.deepEqual(delays(m.ARM), [m.FALLBACK_CLOSE_MS])
  assert.match(m.arm(5_000), /Enable Main Process Debugger/)
  assert.match(skinSrc, /await conn\.evaluate\(arm\(quick \? TICK\.armMs : FALLBACK_CLOSE_MS\)\)/)
})

// Fake lsof says 9229 is open; the fake close counts calls. `main` is the pid the guardian watches.
function guardRun({ main, early, first, tries = 0 }) {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-early-'))
  try {
    const lsof = path.join(d, 'lsof')
    writeFileSync(lsof, '#!/bin/sh\necho open; exit 0\n', { mode: 0o755 })
    const close = path.join(d, 'close')
    writeFileSync(close, `#!/bin/sh\necho c >> "${d}/closes"\n`, { mode: 0o755 })
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, first, gap: 0, tries, limit: 3, early }), close, 'x', '', String(main)], { encoding: 'utf8', timeout: 20_000 })
    return existsSync(path.join(d, 'closes')) ? readFileSync(path.join(d, 'closes'), 'utf8').trim().split('\n').length : 0
  } finally { rmSync(d, { recursive: true, force: true }) }
}

test('P4 guardian: the early look closes only when the main run is gone; a live run is left alone', () => {
  const gone = spawnSync('/usr/bin/true').pid // a finished process: its pid is no longer alive
  assert.equal(guardRun({ main: gone, early: 1, first: 2 }), 1, 'main run gone: closed at the early look')
  assert.equal(guardRun({ main: process.pid, early: 1, first: 2 }), 0, 'main run alive: no early close')
  assert.equal(guardRun({ main: gone, early: 0, first: 1 }), 0, 'no early look unless asked')
  assert.equal(guardRun({ main: gone, early: 1, first: 1, tries: 1 }), 1, 'early must come before first, or it is ignored')
  assert.equal(TICK.guardBEarlyS, 6)
  assert.ok(TICK.guardBEarlyS < TICK.guardBFirstS)
})

test('P5: the debugger line names the measured time and says what it measures', () => {
  assert.equal(debuggerClosedLine(412), 'debugger: confirmed closed (seen open -> confirmed closed: 0.4 s)')
  assert.equal(debuggerClosedLine(null), 'debugger: confirmed closed')
  assert.equal(debuggerClosedLine(-1), 'debugger: confirmed closed')
  assert.equal(debuggerClosedLine(300, true), 'debugger: confirmed closed (it never opened)')
  assert.match(skinSrc, /console\.log\(`DOOR_MS: \$\{closedAt - seenAt\}`\)/)
  // The time starts when the port was seen, never when the connection was made.
  assert.match(skinSrc, /const opened = seenAt \?\? Date\.now\(\)/)
})

// Live, but safe: needs the real Claude desktop app running here, and port 9229 free. A stand-in program listens on 9229;
// the skin step must refuse it (it is not Claude) and send it no code at all.
test('P2 live: a stand-in on port 9229 gets no code, and the skin step stops', async (ctx) => {
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
  try { claudePidOf({ status: ps.status, out: ps.stdout }) } catch { return ctx.skip('the Claude desktop app is not running here') }
  const child = spawn(process.execPath, [path.join(tool, 'skin.mjs'), 'apply', path.join(tool, 'presets', 'nord.css'), '--patient', '--wait-open', '--quick'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise((r) => child.on('close', (c) => r(c)))
  for (let i = 0; i < 200 && !out.includes('CHILD_READY') && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50))
  if (!out.includes('CHILD_READY')) { child.kill(); return ctx.skip(`the skin step did not get ready here: ${out.trim().slice(0, 200)}`) }
  const s = createServer()
  const got = []
  s.on('connection', (c) => c.on('data', (d) => got.push(String(d))))
  try { await new Promise((res, rej) => { s.once('error', rej); s.listen(9229, '127.0.0.1', res) }) } catch { child.kill(); return ctx.skip('port 9229 is busy for real') }
  try {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 10_000))])
    assert.notEqual(code, 'hung')
    assert.notEqual(code, 0)
    assert.match(out, /PORT_SEEN/)
    assert.match(out, /not the Claude checked before \(\d+\)\. Stopping\. Nothing was sent to that program\./)
    assert.ok(!got.join('').includes('Runtime.evaluate'), 'no code was sent to the stand-in')
  } finally { child.kill(); s.close() }
})

test('P2 live: the waiting skin step stops, touching nothing, when the run that started it goes away', async (ctx) => {
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
  try { claudePidOf({ status: ps.status, out: ps.stdout }) } catch { return ctx.skip('the Claude desktop app is not running here') }
  const child = spawn(process.execPath, [path.join(tool, 'skin.mjs'), 'remove', '--patient', '--wait-open'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  const exited = new Promise((r) => child.on('close', (c) => r(c)))
  for (let i = 0; i < 200 && !out.includes('CHILD_READY') && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50))
  if (!out.includes('CHILD_READY')) { child.kill(); return ctx.skip(`the skin step did not get ready here: ${out.trim().slice(0, 200)}`) }
  child.stdin.end()
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 5_000))])
  if (code === 'hung') child.kill()
  assert.equal(code, 130)
  assert.match(out, /Stopped waiting: the run that started me has ended\. Nothing was touched\./)
  assert.doesNotMatch(out, /PORT_SEEN/)
})

// ---- Edge cases, part 1 ----
import { waitForTick } from '../skin-lib.mjs'

test('A cancel that lands while a probe runs wins over the open port it finds', async () => {
  let stop = false
  const r = await waitForTick({ portNow: async () => { stop = true; return { state: 'open' } }, sleep: async () => {}, stopped: () => stop, windowMs: 60_000, pollMs: 50, hintsAtMs: [] })
  assert.equal(r.result, 'stopped')
  assert.match(skinSrc, /stopped: \(\) => parentGone \|\| claudeGone\(\)/) // a Claude restart while waiting also stops it
  assert.match(skinSrc, /Stopped waiting: Claude quit or restarted\. Nothing was touched\./)
})

test('The early look does not push the regular rounds later (absolute schedule)', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-early2-'))
  try {
    const lsof = path.join(d, 'lsof')
    writeFileSync(lsof, '#!/bin/sh\necho open; exit 0\n', { mode: 0o755 })
    const close = path.join(d, 'close')
    writeFileSync(close, `#!/bin/sh\ndate +%s >> "${d}/closes"\nsleep 2\n`, { mode: 0o755 }) // a slow close (Claude frozen)
    const gone = spawnSync('/usr/bin/true').pid
    const t0 = Math.floor(Date.now() / 1000)
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 4, gap: 0, tries: 1, limit: 5, early: 1 }), close, 'x', '', String(gone)], { encoding: 'utf8', timeout: 20_000 })
    const at = readFileSync(path.join(d, 'closes'), 'utf8').trim().split('\n').map((x) => Number(x) - t0)
    assert.equal(at.length, 2)
    assert.ok(at[1] <= 5, `regular round at ${at[1]} s, scheduled for 4 s (it would be 7 s if the early close delayed it)`)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('Guardian B also starts when this run sees the port itself, not only on the skin step\'s word', () => {
  const fn = autoSrc.slice(autoSrc.indexOf('async function tickRun()'), autoSrc.indexOf('function startTickChild()'))
  assert.match(fn, /if \(\(await tcpProbe\(\)\)\.state === 'open' && !stopping\) \{ portOpenedSeen = true; startGuardianB\(\) \}/)
  assert.ok(fn.indexOf('  parentWatch = setInterval') < fn.indexOf("console.log('READY_TO_TICK')") || fn.indexOf('  parentWatch = setInterval') < fn.indexOf("child.until(['PORT_SEEN']"))
  assert.match(autoSrc, /function startGuardianB\(\) \{\n  if \(guardianB \|\| stopping\) return/)
})

test('An explicit failed re-apply fails the run; the door time is read for removals too', () => {
  assert.match(autoSrc, /if \(skinOk && report\.deferred && \(await deferredChecks\(\)\) === 'failed'\) skinOk = false/)
  assert.match(autoSrc, /if \(ack\.ok !== true\) \{[\s\S]{0,800}return 'failed'/)
  const absorb = autoSrc.slice(autoSrc.indexOf('function absorb('), autoSrc.indexOf("if (skinArgs[0] !== 'apply') return"))
  assert.ok(absorb.indexOf('DOOR_MS') < absorb.indexOf("if (skinArgs[0] === 'remove'"), 'timing is read before the removal branch returns')
})

// ---- Edge cases, part 2 ----
test('The port watch never blocks (async probe, one at a time); an opening it saw is never reported as "never opened"', () => {
  const fn = autoSrc.slice(autoSrc.indexOf('async function tickRun()'), autoSrc.indexOf('function startTickChild()'))
  const watch = fn.slice(fn.indexOf('  parentWatch = setInterval'), fn.indexOf('}, 1_000)'))
  assert.ok(watch.includes('if (watching) return') && watch.includes('await tcpProbe()'), 'single-flight async probe')
  assert.ok(!watch.includes('portNow()'), 'no blocking lsof inside the watch')
  assert.match(autoSrc, /debuggerClosedLine\(report\.doorMs, tickMode && !tickPortSeen && !portOpenedSeen\)/)
})

test('Cleanup closes the port first, then ends a skin child for sure (SIGTERM, then SIGKILL after 3 s), bounded', () => {
  const clean = autoSrc.slice(autoSrc.indexOf('async function doCleanup()'), autoSrc.indexOf('for (const sig of'))
  assert.ok(clean.indexOf("attempt('close port', closeClaudePort)") < clean.indexOf('await endSkinChild()'))
  assert.ok(clean.indexOf('await endSkinChild()') < clean.indexOf('await endSidecar()'))
  const fn = autoSrc.slice(autoSrc.indexOf('async function endSkinChild()'), autoSrc.indexOf('// Guardian B, started once:'))
  assert.match(fn, /if \(await gone\(3_000\)\) return\n  try \{ p\.kill\('SIGKILL'\) \} catch \{\}\n  await gone\(1_000\)/)
})

test('No proof that the skin shows means the run is not ok, and the wait covers the helper\'s own 8 s cap', () => {
  assert.equal(TICK.confirmMs, 12_000)
  assert.ok(TICK.confirmMs >= 8_000 + 1_000 + 2_000)
  assert.match(skinSrc, /within\(st\.apply\(j\.action === 'off' \? null : presets\[j\.action\]\), 8_000\)/)
  const fn = autoSrc.slice(autoSrc.indexOf('async function deferredChecks()'))
  assert.match(fn, /return unconfirmed\('no colour helper to ask'\)/)
  assert.match(fn, /if \(ack === null\) return unconfirmed\('the colour helper did not answer'\)/)
  assert.match(fn, /const unconfirmed = \(why\) => \{[\s\S]{0,400}return 'failed'/)
  assert.match(fn, /waitMs: TICK\.confirmMs/)
})

// ---- Edge cases, part 3 ----
test('After waiting for the skin child, cleanup checks and closes the port once more; the watch stops first', () => {
  const clean = autoSrc.slice(autoSrc.indexOf('async function doCleanup()'), autoSrc.indexOf('for (const sig of'))
  const a = clean.indexOf("attempt('port watch', () => clearInterval(parentWatch))")
  const b = clean.indexOf('await endSkinChild()')
  const c = clean.indexOf("attempt('close port again', closeClaudePort)")
  assert.ok(a > 0 && a < b && b < c && c < clean.indexOf('await endSidecar()'))
})

test('A probe that answers after cleanup began starts no guardian; the time limit includes the proof wait', () => {
  assert.match(autoSrc, /if \(\(await tcpProbe\(\)\)\.state === 'open' && !stopping\)/)
  assert.match(autoSrc, /function startGuardianB\(\) \{\n  if \(guardianB \|\| stopping\) return/)
  assert.equal(TICK.runLimitMs, 15_000 + TICK.windowMs + TICK.applyMs + TICK.confirmMs + 20_000)
  assert.ok(TICK.runLimitMs < 180_000)
})

// ---- Tidy report lines ----
test('the "stopped before the debugger opened" warning shows the reason, not machine lines; a quick apply prints no raw answer', () => {
  assert.match(autoSrc, /filter\(\(l\) => !\['CHILD_READY', 'PORT_SEEN', 'WINDOW_ENDED'\]\.includes\(l\.trim\(\)\)\)/)
  assert.match(skinSrc, /if \(result !== undefined && !quick\) \{\n    await writeAll\(JSON\.stringify\(result, null, 2\)/)
})
