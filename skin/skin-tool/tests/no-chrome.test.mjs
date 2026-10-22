// No-Chrome path: the Chrome lookup, the dialog clicker and how skin-auto uses them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME_LOOKUP_JXA, DIALOG_MESSAGE, DIALOG_TEXT, NO_CHROME_GUARD_FIRST_S, NO_CHROME_TIMES, chromeLookup, closeMessageThenApply, dialogScript, watchDialog } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ok = (stdout) => ({ status: 0, stdout, stderr: '' })

test('chromeLookup: only a clean "none" with nothing in /Applications is "no"', () => {
  assert.equal(chromeLookup(ok('none\n'), false), 'no')
  assert.equal(chromeLookup(ok('none\n'), true), 'unknown') // the two ways of asking disagree: stop
  assert.equal(chromeLookup(ok('/Applications/Google Chrome.app\n'), true), 'yes')
  assert.equal(chromeLookup(ok('/Users/x/Applications/Google Chrome.app\n'), false), 'yes') // a copy elsewhere still counts
})

test('chromeLookup: errors, timeouts and odd output are "unknown", never "no"', () => {
  assert.equal(chromeLookup({ status: 1, stdout: '', stderr: 'boom' }, false), 'unknown')
  assert.equal(chromeLookup({ status: null, stdout: '', stderr: '' }, false), 'unknown')
  assert.equal(chromeLookup({ error: new Error('x'), status: 0, stdout: 'none', stderr: '' }, false), 'unknown')
  assert.equal(chromeLookup({ status: 0, stdout: 'none', stderr: 'warning' }, false), 'unknown') // "no" must be fully clean
  // "yes" keeps Chrome users on the old path even if an old scripting addition prints warnings.
  assert.equal(chromeLookup({ status: 0, stdout: '/Applications/Google Chrome.app\n', stderr: 'warning' }, true), 'yes')
  assert.equal(chromeLookup(ok(''), false), 'unknown')
  assert.equal(chromeLookup(ok('Nonsense'), false), 'unknown')
  assert.equal(chromeLookup(ok('/a.app\n/b.app'), false), 'unknown')
})

test('the real lookup answers on this Mac, launches nothing, and says "none" for a missing name', () => {
  const real = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CHROME_LOOKUP_JXA], { encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(chromeLookup(real, existsSync('/Applications/Google Chrome.app')), 'unknown')
  const fake = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CHROME_LOOKUP_JXA.replace('"Google Chrome"', '"No Such Browser 47619"')], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(chromeLookup(fake, false), 'no')
})

// The dialog text Reskin waits for is the start of Claude's own message. Optional extra check: RESKIN_DIALOG_SNAPSHOT
// names a saved copy of that message to compare with. Nothing here reads Claude's installed app.
test("DIALOG_TEXT is the start of Claude's dialog message (and matches a saved copy when one is given)", () => {
  assert.ok(DIALOG_MESSAGE.startsWith(DIALOG_TEXT))
  const snap = process.env.RESKIN_DIALOG_SNAPSHOT
  if (snap && existsSync(snap)) assert.ok(readFileSync(snap, 'utf8').includes(`message:"${DIALOG_MESSAGE}"`), 'saved copy differs')
})

test('dialogScript touches only Claude, only the one window with the exact message, and never presses keys or clicks blindly', () => {
  const s = dialogScript()
  assert.match(s, /tell process "Claude"/)
  assert.equal(s.split(`is "${DIALOG_MESSAGE}"`).length - 1, 2) // matched, then re-checked right before the click
  assert.ok(!s.includes('starts with')) // the whole message, not a prefix
  const gate = s.indexOf('if not still then return "none"')
  const many = s.indexOf('if (count of found) > 1 then return "ambiguous"')
  assert.ok(many > 0 && gate > many, 'two or more matches are refused before the re-check')
  assert.equal(s.split('click button').length - 1, 2) // exactly the two clicks below, nothing else clicks
  assert.ok(s.indexOf('click button') > gate, 'every click sits after the checks')
  for (const bad of ['keystroke', 'key code', 'frontmost', 'click at', 'window 1', 'entire contents']) assert.ok(!s.includes(bad), `uses ${bad}`)
  assert.match(s, /\(count of buttons of w\) is 1/) // falls back only to a window's single button
  const compiled = spawnSync('/usr/bin/osacompile', ['-o', '/dev/null', '-e', s], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(compiled.status, 0, compiled.stderr) // it is valid AppleScript (compiling runs nothing)
})

test('skin-auto: the no-Chrome branch is decided before any throwaway Chrome starts, and never starts or hides one', () => {
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const branch = auto.indexOf("if (installed === 'no') return noChromeRun()")
  assert.ok(branch > 0 && branch < auto.indexOf('// 4. Start the throwaway Chrome'))
  assert.ok(auto.indexOf("if (installed === 'unknown') refuse(") < branch)
  const fn = auto.slice(auto.indexOf('async function noChromeRun()'), auto.indexOf('async function tickRun()'))
  for (const bad of ['com.google.Chrome', 'hideScript', 'mkdtempSync', 'sidecarPid =']) assert.ok(!fn.includes(bad), `no-Chrome path uses ${bad}`)
  // Safety nets come before the click, the watcher only after it.
  const click = fn.indexOf('ticked = true')
  for (const net of ['watchdog = setTimeout', "chromeInstalled() !== 'no'", "guardScript({ first: NO_CHROME_GUARD_FIRST_S }), NODE, SKIN, ''"]) assert.ok(fn.indexOf(net) > 0 && fn.indexOf(net) < click, `${net} must come before the click`)
  assert.ok(fn.indexOf('dialogScript()') > click)
})

// A fake clock: sleep moves time forward, so the tests run instantly and exactly.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }

test('watchDialog: keeps trying through errors and "none", stops at the first click', async () => {
  const c = clock()
  const answers = ['', 'none', '', 'clicked', 'clicked']
  let calls = 0
  const r = await watchDialog(async () => answers[calls++], { start: 0, ms: 8_000, gap: 250, ...c })
  assert.equal(r, 'clicked')
  assert.equal(calls, 4)
})

test('watchDialog: "ambiguous" stops at once (never clicks a guess); no dialog gives up after the time limit', async () => {
  assert.equal(await watchDialog(async () => 'ambiguous', { start: 0, ...clock() }), 'ambiguous')
  const c = clock()
  let calls = 0
  assert.equal(await watchDialog(async () => { calls++; return 'none' }, { start: 0, ms: 8_000, gap: 250, ...c }), 'none')
  assert.equal(calls, 32) // the full 8 s from the click, not cut short when the skin step ends early
  assert.ok(c.now() >= 8_000 && c.now() < 8_500)
})

test('watchDialog: a stop request ends it; skin-auto waits for the watcher, not a fixed few seconds', async () => {
  let calls = 0
  assert.equal(await watchDialog(async () => { calls++; return 'none' }, { start: 0, ...clock(), stop: () => calls >= 2 }), 'none')
  assert.equal(calls, 2)
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  assert.ok(!auto.includes('Promise.race([watcher'))
  assert.match(auto, /attempt\('dialog watcher'/) // cleanup ends a leftover osascript
})

// Live probe, 12 Oct 2026: Claude is frozen while its message is up, so the message is closed before the skin step.
const noRead = { windows: 1, unreadable: 0, unsure: 0, unsureKinds: [], dialogs: [] }
const fakeStep = (watchResult, readResult, lateResult = 'none') => {
  const order = []
  let watches = 0
  return {
    order,
    deps: {
      watch: async () => { order.push(watches++ === 0 ? 'watch' : 'late watch'); return watches === 1 ? watchResult : lateResult },
      read: async () => { order.push('read'); return readResult },
      runSkin: async () => { order.push('skin'); return 0 },
      sleep: async () => { order.push('pause') },
    },
  }
}

test('closeMessageThenApply: the message is clicked first, a read confirms it gone, then the skin step runs', async () => {
  const f = fakeStep('clicked', noRead)
  assert.deepEqual(await closeMessageThenApply(f.deps), { dialog: 'clicked', ran: true, code: 0 })
  assert.deepEqual(f.order, ['watch', 'pause', 'read', 'skin'])
  // A press that did not register (message still up), or a read that cannot confirm: no skin step.
  for (const [r, up, why] of [[{ ...noRead, dialogs: [{ exact: true }] }, true, /pressed its OK button but it still seems to be up/], [null, false, /could not read/]]) {
    const g = fakeStep('clicked', r)
    const res = await closeMessageThenApply(g.deps)
    assert.deepEqual([res.ran, res.messageUp], [false, up])
    assert.match(res.why, why)
    assert.ok(!g.order.includes('skin'))
  }
})

test('closeMessageThenApply: a message it could not click, more than one button, or an unreadable screen: no skin step', async () => {
  for (const [w, r, why, up] of [['ambiguous', noRead, /more than one button/, true], ['none', null, /could not read Claude's windows \(does this terminal app have Accessibility/, false],
    ['none', { ...noRead, dialogs: [{ exact: true }] }, /could not click/, true], ['none', { ...noRead, unreadable: 1 }, /could not be read, so I could not rule the message out/, false],
    ['none', { ...noRead, unsure: 1, unsureKinds: ['AXDialog'] }, /unexpected kind \(AXDialog\)/, false]]) {
    const f = fakeStep(w, r)
    const res = await closeMessageThenApply(f.deps)
    assert.equal(res.ran, false, JSON.stringify([w, r]))
    assert.equal(res.messageUp, up, JSON.stringify([w, r])) // "click OK" only when a message is really there
    assert.match(res.why, why)
    assert.ok(!f.order.includes('skin'))
  }
})

test('closeMessageThenApply: no message at all, proven by a full read: the skin step runs, watched for a late message', async () => {
  const f = fakeStep('none', noRead)
  const res = await closeMessageThenApply(f.deps)
  assert.equal(res.ran, true)
  assert.equal(res.noMessage, true)
  assert.deepEqual(f.order, ['watch', 'read', 'late watch', 'skin']) // the late watcher is on before the skin step starts
})

test('closeMessageThenApply: a message that comes late (after the empty read) is clicked during the skin step', async () => {
  // Fake clock: the message shows up 1 s into the skin step; the skin step (held by it) finishes only after the click.
  let t = 0
  let up = false
  let clicked = null
  const watch = async ({ ms, stop = () => false }) => {
    const start = t
    while (!stop() && t - start < ms) { if (up) { up = false; clicked = t; return 'clicked' } t += 250; await null }
    return 'none'
  }
  // (Bounded spins, so a missing watcher fails the test instead of hanging it.)
  const runSkin = async () => { let n = 0; const s0 = t; while (t < s0 + 1_000 && n++ < 1e5) await null; up = true; while (up && n++ < 2e5) await null; return up ? 1 : 0 }
  const res = await closeMessageThenApply({ watch, read: async () => noRead, runSkin, now: () => t, sleep: async () => {} })
  assert.deepEqual([res.ran, res.code, res.noMessage, res.lateDialog], [true, 0, true, 'clicked'])
  assert.ok(clicked >= 1_000)
})

test('closeMessageThenApply: with no late message, the late watcher ends 2 s after the skin step, not at its 30 s cap', async () => {
  let t = 0
  let lateEnd = null
  let watches = 0
  const watch = async ({ ms, stop = () => false }) => {
    const first = watches++ === 0
    const start = t
    while (!stop() && t - start < ms) { t += 250; await null }
    if (!first) lateEnd = t
    return 'none'
  }
  const runSkin = async () => { const s0 = t; let n = 0; while (t < s0 + 1_500 && n++ < 1e5) await null; return 0 }
  const res = await closeMessageThenApply({ watch, read: async () => noRead, runSkin, now: () => t, sleep: async () => {} })
  assert.equal(res.lateDialog, 'none')
  const skinEnd = 8_000 + 1_500 // first watch runs to its 8 s limit, then the skin step takes 1.5 s
  assert.ok(lateEnd >= skinEnd + NO_CHROME_TIMES.lateGraceMs && lateEnd <= skinEnd + NO_CHROME_TIMES.lateGraceMs + 500, `late watch ended at ${lateEnd}`)
})

test('skin-auto no-Chrome path: Claude\'s windows are read before the click; anything that could not be ruled out later refuses first', () => {
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const fn = auto.slice(auto.indexOf('async function noChromeRun()'), auto.indexOf('async function tickRun()'))
  const pre = fn.indexOf('const pre = parseDialogRead(osa(dialogReadScript()).stdout)')
  assert.ok(pre > 0 && pre < fn.indexOf('ticked = true') && pre < fn.indexOf("guardian = spawn('/bin/sh', ['-c', guardScript({ first: NO_CHROME_GUARD_FIRST_S })"))
  assert.match(fn, /if \(!provesNoDialog\(pre\)\) \{\n    refuse\(/)
})

test('closeMessageThenApply: once cleanup has begun, nothing new starts (during the watch, the read or the pause)', async () => {
  for (const at of ['watch', 'read', 'pause']) {
    let stop = false
    const order = []
    const res = await closeMessageThenApply({
      watch: async () => { order.push('watch'); if (at === 'watch') stop = true; return at === 'pause' ? 'clicked' : 'none' },
      read: async () => { order.push('read'); if (at === 'read') stop = true; return noRead },
      sleep: async () => { order.push('pause'); if (at === 'pause') stop = true },
      runSkin: async () => { order.push('skin'); return 0 },
      stopped: () => stop,
    })
    assert.equal(res.ran, false, at)
    assert.ok(!order.includes('skin'), at)
  }
})

test('no-Chrome timing: the guardian waits for the longest wait before the skin step, and the watcher never runs over', async () => {
  const T = NO_CHROME_TIMES
  // Elapsed-time check on a fake clock: the slowest permitted run from the guardian's start (both blocking AppleScripts at
  // their limit, the watch at its limit, the pause and confirm read, a skin step stopped only by its kill, and the same
  // with "none" plus a read) must end before the guardian's first check.
  const worst = async (watchResult) => {
    let t = 2 * T.syncOsaMs // bring Claude to the front, then the menu click, each at its limit
    await closeMessageThenApply({
      watch: async ({ ms }) => { t += ms <= T.watchMs ? ms : 0; return ms <= T.watchMs ? watchResult : 'none' },
      read: async () => { t += T.readMs; return noRead },
      sleep: async (ms) => { t += ms },
      runSkin: async () => { t += T.skinKillMs; return 1 },
      now: () => t,
    })
    return t
  }
  for (const w of ['clicked', 'none']) {
    const end = await worst(w)
    assert.ok(end + 500 <= NO_CHROME_GUARD_FIRST_S * 1_000, `${w}: skin step may end at ${end} ms, guardian checks at ${NO_CHROME_GUARD_FIRST_S} s`)
  }
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const fn = auto.slice(auto.indexOf('async function noChromeRun()'), auto.indexOf('async function tickRun()'))
  assert.match(fn, /guardScript\(\{ first: NO_CHROME_GUARD_FIRST_S \}\), NODE, SKIN, '', String\(process\.pid\)\]/)
  assert.match(fn, /osaAsync\(dialogScript\(\), Math\.max\(300, Math\.min\(3_000, start \+ ms - Date\.now\(\)\)\)\)/)
  assert.match(fn, /osaAsync\(dialogReadScript\(\), NO_CHROME_TIMES\.readMs\)/)
  assert.match(fn, /stop: \(\) => stopping \|\| stop\(\)/)
  assert.match(auto, /spawnSync\(cmd, a, \{ encoding: 'utf8', timeout: 4_000,/) // the blocking AppleScript limit (syncOsaMs)
  assert.equal(T.syncOsaMs, 4_000)
  assert.match(fn, /runSkinChild\(NO_CHROME_TIMES\.skinKillMs\)/) // the shared runner kills the child at this limit
  assert.match(fn, /if \(stopping\) return -1/)
  assert.ok(fn.indexOf('if (stopping) return -1') < fn.indexOf('runSkinChild('))
  // The shared runner itself kills the child at the limit it is given.
  const runner = auto.slice(auto.indexOf('async function runSkinChild(killMs)'), auto.indexOf('function absorb('))
  assert.match(runner, /skinProc\.kill\('SIGTERM'\) \}, killMs\)/)
  const clean = auto.slice(auto.indexOf('async function doCleanup()'), auto.indexOf("// 1. Claude's debugger port first."))
  assert.ok(clean.indexOf('stopping = true') >= 0 && clean.indexOf('stopping = true') < clean.indexOf("attempt('skin child'"))
})

test('skin-auto no-Chrome path: skin.mjs starts only inside runSkin (after the message is handled), with a fresh watchdog', () => {
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const fn = auto.slice(auto.indexOf('async function noChromeRun()'), auto.indexOf('async function tickRun()'))
  assert.equal(fn.split('runSkinChild(').length - 1, 1)
  const runSkin = fn.indexOf('runSkin: async () => {')
  assert.ok(runSkin > fn.indexOf('const step = await closeMessageThenApply({'))
  assert.ok(fn.indexOf('runSkinChild(') > runSkin)
  assert.ok(fn.indexOf('clearTimeout(watchdog)') > runSkin && fn.indexOf('clearTimeout(watchdog)') < fn.indexOf('runSkinChild('))
  assert.match(fn, /if \(!step\.ran\) \{\n    if \(step\.messageUp\) warn\(`Claude is showing a small message/)
  assert.match(fn, /Click its OK button now\. Nothing was applied\./)
  assert.match(fn, /else warn\(`Nothing was applied: \$\{step\.why\}/)
})
