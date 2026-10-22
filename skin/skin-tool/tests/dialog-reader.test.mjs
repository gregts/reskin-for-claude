// The read-only window reader the no-Chrome path uses (first built for the dialog probe, removed 14 Oct 2026), and
// skin.mjs's shared signal shutdown. The probe mode itself is gone: the last test proves it.
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lib from '../skin-lib.mjs'
import { DIALOG_MESSAGE, DIALOG_TEXT, dialogReadScript, parseDialogRead, provesNoDialog } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const skin = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')

test('the reader only reads: no click, no key press, no frontmost; it compiles', () => {
  const s = dialogReadScript()
  for (const bad of ['click', 'keystroke', 'key code', 'frontmost', 'perform', 'set value', 'set focused', 'activate']) assert.ok(!s.includes(bad), bad)
  assert.match(s, /tell process "Claude"/)
  assert.ok(s.includes(`starts with "${DIALOG_TEXT}"`))
  assert.ok(s.includes('"ERR|"'))
  assert.ok(s.includes('"UNSURE|"') && s.includes('is not "AXStandardWindow"')) // a window it could not fully search says so
  assert.ok(s.includes('groups of w') && s.includes('"NTEXT|"')) // one level down, reported apart
  assert.equal(s.match(/tell application "([^"]+)"/g).length, 1)
  const r = spawnSync('/usr/bin/osacompile', ['-o', '/dev/null', '-e', s], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(r.status, 0, r.stderr)
})

test('parseDialogRead: counts, unreadable windows, exact match; unreadable output is null', () => {
  const r = parseDialogRead(`COUNT|3\nERR|1\nWIN|2|Inspector|AXWindow|AXDialog\nTEXT|${DIALOG_MESSAGE}\nTEXT|a|b\nBUTTON|OK\n`)
  assert.deepEqual(r, { windows: 3, unreadable: 1, unsure: 0, unsureKinds: [], dialogs: [{ index: 2, name: 'Inspector', role: 'AXWindow', subrole: 'AXDialog', texts: [DIALOG_MESSAGE, 'a|b'], nested: [], buttons: ['OK'], exact: true }] })
  const n = parseDialogRead(`COUNT|1\nWIN|1|||\nNTEXT|${DIALOG_MESSAGE}\nBUTTON|OK`).dialogs[0]
  assert.deepEqual([n.nested, n.exact], [[DIALOG_MESSAGE], false]) // nested text is reported, but the clicker needs a direct one
  assert.equal(parseDialogRead('COUNT|1\nWIN|1|||\nTEXT|Inspector session is active.').dialogs[0].exact, false)
  for (const bad of ['', 'NOPROC', 'garbage', 'COUNT|x', null, undefined]) assert.equal(parseDialogRead(bad), null, String(bad))
  assert.equal(provesNoDialog(parseDialogRead('COUNT|2')), true)
  assert.equal(provesNoDialog(parseDialogRead('COUNT|2\nERR|1')), false)
  const u = parseDialogRead('COUNT|2\nUNSURE|2|AXDialog')
  assert.deepEqual([u.unsure, u.unsureKinds], [1, ['AXDialog']])
  assert.equal(provesNoDialog(u), false) // not fully searched is not proof
  assert.equal(provesNoDialog(null), false)
})

test("two signals (Ctrl-C's SIGINT, then skin-auto's SIGTERM): skin.mjs's real handlers finish one shutdown, report whole", async () => {
  const start = skin.indexOf('  let shutdown = null')
  const handlers = skin.slice(start, skin.indexOf('\n', skin.indexOf("for (const sig of ['SIGINT', 'SIGTERM'])", start)))
  assert.ok(start > 0 && handlers.includes('shutdown ??='))
  // The real handler lines, with a slow close (300 ms), a slow report (300 ms) and a slow port close (200 ms).
  const harness = `const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let onBatchSignal = async () => { await wait(300); process.stdout.write('closed\\n'); await wait(300); process.stdout.write('REPORT-WHOLE\\n') }
const stop = async () => { await wait(200); process.stdout.write('port closed\\n') }
${handlers}
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', harness], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d; if (out === 'ready\n') { child.kill('SIGINT'); setTimeout(() => child.kill('SIGTERM'), 100) } })
  const code = await new Promise((r) => child.on('close', (c) => r(c)))
  assert.equal(out, 'ready\nclosed\nREPORT-WHOLE\nport closed\n')
  assert.equal(code, 130)
})

test('the dialog-probe mode is gone from both entry points and from skin-lib', () => {
  for (const name of ['runDialogProbe', 'judgeDialogProbe', 'probeCode', 'PROBE_LIMITS', 'PROBE_PARENT_WAIT_MS']) assert.equal(lib[name], undefined, name)
  for (const file of ['skin.mjs', 'skin-auto.mjs']) {
    const r = spawnSync(process.execPath, [file === 'skin-auto.mjs' ? autoPath() : path.join(tool, file), 'dialog-probe'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 2, file) // usage error before anything is touched
    // skin.mjs no longer offers it; skin-auto reads the word as a stylesheet name that does not exist.
    if (file === 'skin.mjs') assert.doesNotMatch(r.stdout, /dialog-probe/)
    else assert.match(r.stdout + r.stderr, /Not one of Reskin's presets: dialog-probe/)
  }
})
