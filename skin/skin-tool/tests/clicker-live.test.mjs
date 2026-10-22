// The real OK clicker and reader, run against a stand-in alert (never Claude): `osascript -e 'display alert ...'` shows
// a native alert with Claude's exact message, and the scripts are pointed at that osascript process instead of Claude.
// Opt-in (SKIN_UI_TEST=1), because it puts an alert on screen for about a second and needs Accessibility permission.
// Why it exists: the clicker once answered "none" on Claude's real alert, because looping
// directly over `value of every static text` gives references System Events cannot turn into text, and the error was
// swallowed. The offline tests only compiled the script, so they could not see it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { DIALOG_MESSAGE, dialogReadScript, dialogScript, parseDialogRead } from '../skin-lib.mjs'

const live = process.env.SKIN_UI_TEST === '1'
// Pointed at the stand-in alert's own process by its pid: the checking scripts also run as "osascript", so the name
// alone can pick the wrong one (it did once).
const at = (script, pid) => script.replaceAll('process "Claude"', `(first process whose unix id is ${pid})`)
const run = (script) => spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('the clicker reads texts the way the reader does (stored first, never looped over directly)', () => {
  const s = dialogScript()
  assert.ok(!/repeat with s in \(value of/.test(s), 'looping straight over "value of ..." fails at run time')
  assert.equal((s.match(/set vals to value of every static text of/g) ?? []).length, 2)
})

test('live: the real clicker and reader on a stand-in alert with the exact message', { skip: !live && 'set SKIN_UI_TEST=1 to run' }, async () => {
  const alert = spawn('/usr/bin/osascript', ['-e', `display alert "${DIALOG_MESSAGE}" giving up after 20`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  alert.stdout.on('data', (d) => (out += d))
  const closed = new Promise((r) => alert.on('close', r))
  try {
    let read = null
    for (let i = 0; i < 20 && !(read?.dialogs.length > 0); i++) { await sleep(250); read = parseDialogRead(run(at(dialogReadScript(), alert.pid)).stdout) }
    assert.equal(read?.dialogs.length, 1, 'the reader sees the alert')
    assert.equal(read.dialogs[0].exact, true)
    assert.equal(run(at(dialogScript(), alert.pid)).stdout.trim(), 'clicked')
    await closed
    assert.equal(run(at(dialogScript(), alert.pid)).stdout.trim(), 'none') // gone: nothing left to click
    assert.match(out, /button returned:OK, gave up:false/) // OK was pressed by the clicker, not the 20 s give-up
  } finally {
    if (alert.exitCode === null) alert.kill('SIGKILL')
  }
})
