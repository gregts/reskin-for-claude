// The troubleshooting log (15 Oct 2026): runs of skin-auto.mjs started directly append one entry to
// ~/Library/Logs/Reskin/skin.log through a background writer; /skin runs are logged by the mod (RESKIN_LOG_BY=skin-mod),
// never twice. The cases here match the mod's tests/log.test.ts, so both sides keep the same rules.
import { test, after } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  END, HEAD, LOG_FILE, ENTRY_MAX_BYTES, appendEntry, appearanceOf, capture, formatEntry, hiddenInfo, loggingOn, macModeOf, outcome, presetMode,
  presetOf, redact, redactArgs, runningVersionOf, stepPath, stripComments, viaOf, finish, milestones, MAX_LINES, handoff,
} from '../skin-log.mjs'
import { checksLine } from '../skin-lib.mjs'

const tool = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// The mod around this folder (the package: skin/skin-tool), or one named by RESKIN_MOD_DIR (a separate checkout).
const MOD_LOG = [path.join(tool, '..', 'hooks', 'log.ts'), ...(process.env.RESKIN_MOD_DIR ? [path.join(process.env.RESKIN_MOD_DIR, 'hooks', 'log.ts')] : [])].find((f) => fs.existsSync(f))
const modSource = MOD_LOG ? fs.readFileSync(MOD_LOG, 'utf8') : null
const HOME = '/Users/someone'
const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reskin-logtest-')); made.push(d); return d }
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const rec = (over = {}) => ({
  at: new Date(2026, 9, 15, 18, 30, 0), command: 'node skin-auto.mjs switch dracula', exact: '["node","x"] in /p', from: 'skin-auto.mjs, run directly (not through /skin)',
  tool: `${HOME}/skin-tool`, via: 'colour helper', preset: { name: 'dracula', mode: 'dark' }, portBefore: 'closed', portAfter: 'closed', result: 'ok', exitCode: 0, ms: 420,
  output: '[+0.010s] Skin dracula applied by the colour helper.\n[+0.020s] helper: active until Claude quits (Claude 2.37337.1)\n[+0.400s] PORT_STATE: closed\n[+0.401s] RESULT: ok',
  claudeVersion: '2.37337.1', appearance: 'dark', mac: 'light', ...over,
})
const written = (chunks) => { const c = capture(); for (const x of chunks) c.add(0, 'stdout', x); return formatEntry(rec({ output: c.finish() }), HOME) }
const pieces = (s, size, offset = 0) => [s.slice(0, offset), ...(s.slice(offset).match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [])].filter((x) => x !== '')
const waitFor = async (f, ms = 8_000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); return f() }

test('logging is off for /skin runs (the mod logs them), on request, and in tests unless a test names its own folder', () => {
  assert.equal(loggingOn({}), true)
  assert.equal(loggingOn({ RESKIN_LOG_BY: 'skin-mod' }), false)
  assert.equal(loggingOn({ RESKIN_LOG: 'off' }), false)
  assert.equal(loggingOn({ NODE_TEST_CONTEXT: 'child-v8' }), false)
  assert.equal(loggingOn({ NODE_TEST_CONTEXT: 'child-v8', RESKIN_LOG_DIR: '/x' }), true)
})

test('redaction: every known format is caught, ordinary text stays, and it is the same rule as the mod', () => {
  const cases = [
    ['{"password":"swordfish"}', 'swordfish'], ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'], ["password='two words'", 'words'],
    ['access_token=shortsecret', 'shortsecret'], ['https://x.test/cb?code=zzz&state=yyy', 'zzz'], ['Cookie: sid=qqq', 'qqq'],
    ['key=shortsecret', 'shortsecret'], ['Cookie: sid=first; other=secondsecret', 'secondsecret'], ['{"password":"first\\"secondsecret"}', 'secondsecret'],
    ['Authorization: bearer abc.def.ghi', 'abc.def.ghi'], ['error: password=shortsecret', 'shortsecret'], ['--password shortsecret --tick', 'shortsecret'],
    ['https://alice:shortsecret@example.test/file', 'shortsecret'], ['{"e":"token=abc"}', 'abc'], ['password="first\nsecond"', 'second'],
    [`password="${'x'.repeat(5000)}tail-secret"`, 'tail-secret'], ['password="never closed and secret', 'secret'],
    ['--dry-run --password shortsecret --tick nord', 'shortsecret'], ['error: password="shortsecret"', 'shortsecret'],
    ["message: \"password='first\nsecondsecret'\"", 'secondsecret'], ['-p=x --token="a b" --key v', 'a b'],
    [`3f2b1c4d-1111-4222-8333-444455556666 ws://127.0.0.1:9229/abc ${'a1'.repeat(30)} sk-ant-api03-ABCDEFGHIJKLMNOP`, '3f2b1c4d'],
  ]
  for (const [input, secret] of cases) assert.ok(!redact(input, HOME).includes(secret), input)
  assert.equal(redact('--dry-run --password shortsecret --tick nord', HOME), '--dry-run --password <redacted> --tick nord')
  assert.equal(redact('node skin-auto.mjs tick nord --dry-run', HOME), 'node skin-auto.mjs tick nord --dry-run')
  assert.equal(redact(`${HOME}/Projects/My Skins /skin-tool/presets/tokyo-night-day.css`, HOME), '~/Projects/My Skins /skin-tool/presets/tokyo-night-day.css')
  assert.deepEqual(redactArgs(['node', 'x', '--password', 'shortsecret', '--tick'], HOME), ['node', 'x', '--password', '<redacted>', '--tick'])
  for (const big of ['a'.repeat(200_000), 'a='.repeat(100_000), '"'.repeat(200_000), 'a="'.repeat(70_000), '--password '.repeat(20_000), 'a:b@'.repeat(50_000), `--${'token'.repeat(16_000)}`]) {
    const t = Date.now()
    redact(big, HOME)
    assert.ok(Date.now() - t < 500, `${JSON.stringify(big.slice(0, 8))}: ${Date.now() - t} ms`)
  }
  if (modSource) {
    const rule = (src, name) => new RegExp(`const ${name} = (.*)\\n`).exec(src)?.[1]
    const mine = fs.readFileSync(path.join(tool, 'skin-log.mjs'), 'utf8')
    for (const name of ['SECRET_NAME', 'VALUE', 'PAIR_NAME', 'PAIR_VALUE', 'FLAG_NAME', 'FLAG_VALUE']) {
      assert.ok(rule(mine, name) && rule(mine, name) === rule(modSource, name), `${name} is the same in both writers`)
    }
  }
})

test('facts: only the Appearance word, the Mac mode both wordings, the running version, linear skin modes', () => {
  assert.equal(appearanceOf('{"oauth:tokenCacheV2":"SECRET","userThemeMode":"light"}'), 'light')
  assert.equal(appearanceOf('{"userThemeMode":"secret"}'), 'unknown')
  assert.equal(appearanceOf(undefined), 'unknown')
  assert.equal(macModeOf({ status: 0, stdout: 'Dark\n', stderr: '' }), 'dark')
  assert.equal(macModeOf({ status: 1, stdout: '', stderr: '... does not exist' }), 'light')
  assert.equal(macModeOf({ status: 1, stdout: '', stderr: "Error: Could not find key 'AppleInterfaceStyle' in domain 'kCFPreferencesAnyApplication'." }), 'light')
  assert.equal(macModeOf(null), 'unknown')
  assert.equal(runningVersionOf('helper: active until Claude quits (Claude 2.37337.1)'), '2.37337.1')
  assert.equal(runningVersionOf('helper: active until Claude quits (Claude pid 7305, version 2.37337.1)'), '2.37337.1')
  for (const name of ['tokyo-night', 'dracula']) assert.equal(presetMode(fs.readFileSync(path.join(tool, 'presets', `${name}.css`), 'utf8')), 'auto', name)
  // Every shipped skin has both halves since 17 Oct 2026; one-mode sheets are still read correctly.
  assert.equal(presetMode('@media (prefers-color-scheme: light) { html { color: #000000 } }'), 'light')
  assert.equal(presetMode('@media (prefers-color-scheme: dark) { html { color: #ffffff } }'), 'dark')
  assert.equal(presetMode('/* prefers-color-scheme: dark */ body{}'), 'unknown')
  assert.equal(stripComments('a/*x*/b/*c'), 'a b ')
  const t = Date.now()
  presetMode('/*'.repeat(120_000))
  assert.ok(Date.now() - t < 300, `${Date.now() - t} ms`)
})

test('the skin and path a command names, read as the batch parser reads them', () => {
  assert.deepEqual(presetOf(fs, tool, ['switch', 'tokyo-night']), { name: 'tokyo-night', mode: 'auto' })
  assert.deepEqual(presetOf(fs, tool, ['one-click', 'batch', 'dracula,nord', '--dry-run']), { name: 'batch dracula, nord', mode: 'dracula: auto, nord: auto' })
  assert.deepEqual(presetOf(fs, tool, ['batch', '--final', 'off', 'dracula']), { name: 'batch dracula', mode: 'dracula: auto' })
  assert.equal(presetOf(fs, tool, ['status']), null)
  assert.deepEqual(presetOf(fs, tool, ['presets/dracula.css'], tool), { name: 'dracula', mode: 'auto' })
  // A full path, as Raycast passes it, arrives cleaned (home as ~) and is still found (seen in a real run, 15 Oct).
  assert.deepEqual(presetOf(fs, tool, ['~/presets/tokyo-night.css'], '/', () => false, tool), { name: 'tokyo-night', mode: 'auto' })
  assert.equal(viaOf(['switch', 'x']), 'colour helper')
  assert.equal(viaOf(['tick', 'x']), 'debugger, you tick')
  assert.equal(viaOf(['one-click', 'batch', 'a']), 'debugger, batch')
  assert.equal(viaOf(['nord', '--dry-run']), 'dry run (no tick, nothing applied)')
  assert.equal(viaOf(['tick', 'nord', '--dry-run']), 'dry run (no tick, nothing applied)')
})

test('capture: timed lines, only the start kept, and a secret over several lines never reaches the entry in any split', () => {
  const c = capture()
  c.add(0, 'stdout', 'one\ntw')
  c.add(1500, 'stdout', 'o\nthree')
  c.add(2000, 'stderr', 'oops\n')
  assert.deepEqual(c.finish().split('\n'), ['[+0.000s] one', '[+0.000s] two', '[+1.500s] three', '[+2.000s] err| oops'])
  const seen = []
  const big = capture(400, (s, l) => seen.push(l))
  for (let i = 0; i < 1000; i++) big.add(i, 'stdout', `line ${i}\n`)
  big.add(1000, 'stdout', 'RESULT: ok\n')
  const out = big.finish()
  assert.ok(out.length < 600 && out.includes('line 0') && !out.includes('line 999') && out.includes('more characters of stdout not kept'))
  assert.ok(seen.includes('RESULT: ok'))
  const long = capture()
  long.add(0, 'stdout', `START${'m'.repeat(50_000)}END\n`)
  const line = long.finish()
  assert.ok(line.includes('START') && !line.includes('END') && line.includes('more characters of stdout not kept'))
  const inputs = [
    'password="first\nsecondsecret" after\nok\n', `${'y'.repeat(7009)}password="first${'z'.repeat(7000)}\nsecondsecret"\nok\n`,
    `${'x'.repeat(13000)} password="first\nsecondsecret"\nok\n`, "message: \"password='first\nsecondsecret'\"\nok\n", "--token 'a\nsecondsecret\nc' done\nok\n",
  ]
  for (const input of inputs) for (const size of [1, 7, 37]) for (let offset = 0; offset < 40; offset++) {
    assert.ok(!written(pieces(input, size, offset)).includes('secondsecret'), `${JSON.stringify(input.slice(0, 20))} size ${size} offset ${offset}`)
  }
})

test('No split, cut, budget or other stream exposes a secret; arguments with spaces; old records cleared', () => {
  const cases = [
    [['password=\n', 'stdout'], ['"secondsecret"\nok\n', 'stdout']],
    [[`${'x'.repeat(17_000)} password="first\n`, 'stdout'], ['secondsecret"\nok\n', 'stdout']],
    [['short\n', 'stdout'], [`${'y'.repeat(40_000)}\n`, 'stdout'], ['password="a\n', 'stdout'], ['secondsecret"\n', 'stdout']],
    [['password="first\n', 'stdout'], ['x"y\n', 'stderr'], ['secondsecret"\nok\n', 'stdout']],
    [['Cookie: "first\n', 'stdout'], ['secondsecret"\nok\n', 'stdout']],
    [['WARNING: password="first\n', 'stdout'], ['WARNING: secondsecret"\nRESULT: failed\n', 'stdout']],
    [[`${'a'.repeat(10_000)}\n${'b'.repeat(10_000)}\n${'c'.repeat(10_000)}\n`, 'stdout'], [`${'p'.repeat(5_000)} password="first\n`, 'stdout'], ['secondsecret"\nok\n', 'stdout']],
  ]
  for (const parts of cases) {
    const c = capture()
    parts.forEach(([text, stream], i) => c.add(i, stream, text))
    const e = formatEntry(rec({ output: c.finish(), result: 'failed', exitCode: 1 }), HOME)
    assert.ok(!e.includes('secondsecret'), JSON.stringify(parts).slice(0, 80))
  }
  assert.deepEqual(redactArgs(['--password', 'first secondsecret', '--password=first secondsecret', '--tick'], HOME), ['--password', '<redacted>', '--password=<redacted>', '--tick'])
  const hint = outcome({ command: 'x', steps: [{ via: 'debugger, one click', exitCode: 1, output: 'DISCLOSED\nWARNING: If a small message appears, click its OK button.\nhelper: unchanged (the apply did not finish)\nWARNING: the skin step took over 8 s; stopping it.' }], shown: '', result: 'failed', exitCode: 1, portBefore: 'closed', portAfter: 'closed' })
  assert.match(hint, /FAILED \(exit 1\): the skin step took over 8 s; stopping it/)
})

test('Filter order, entry size, guardian note, milestone words, torn entries', () => {
  assert.ok(!redact('token = "first\nsecondsecret"', HOME).includes('secondsecret'))
  assert.ok(!redact('Authorization: Bearer "first\nsecondsecret"', HOME).includes('secondsecret'))
  assert.equal(redact('a token = b', HOME), 'a token = <redacted>')
  const c = capture()
  c.add(0, 'stdout', '\n'.repeat(32_768))
  assert.ok(Buffer.byteLength(formatEntry(rec({ output: c.finish() }), HOME)) < ENTRY_MAX_BYTES)
  const huge = formatEntry(rec({ output: Array.from({ length: 30_000 }, (_, i) => `[+0.000s] ${'q'.repeat(10)} ${i}`).join('\n') }), HOME)
  assert.ok(Buffer.byteLength(huge) < ENTRY_MAX_BYTES && huge.includes(END) && huge.includes('shortened to fit the entry limit'))
  const s = outcome({ command: 'x', steps: [{ via: 'debugger, one click', exitCode: 6, output: 'DISCLOSED\nWARNING: the throwaway Chrome may still be running; end it with: kill -TERM 4242\nWARNING: the backup guardian stays on duty for about a minute and will try to end the leftover throwaway Chrome' }], shown: '', result: 'failed', exitCode: 6, portBefore: 'closed', portAfter: 'closed' })
  assert.match(s, /FAILED \(exit 6\): the throwaway Chrome may still be running; end it with: kill -TERM 4242/)
  const many = capture()
  for (let i = 0; i < 5000; i++) many.add(0, 'stdout', `${i}\n`)
  assert.equal(many.finish().split('\n').filter((l) => l.startsWith('[+')).length, MAX_LINES)
  const marks = milestones()
  for (const l of ['READY_TO_TICK', '[3.0s] debugger port seen: stop clicking (secondsecret)', 'WARNING: secondsecret', 'PORT_STATE: closed', 'stopped by SIGINT']) marks.add(l)
  assert.deepEqual(marks.list(), ['READY_TO_TICK', 'debugger port seen', 'stopped by SIGINT', 'PORT_STATE: closed'])
  const dir = tmp()
  fs.writeFileSync(path.join(dir, LOG_FILE), `${HEAD}torn`, { mode: 0o600 })
  fs.chmodSync(dir, 0o700)
  assert.equal(appendEntry(fs, dir, formatEntry(rec(), HOME)), true)
  assert.equal(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').split('\n').filter((l) => l.startsWith(HEAD) && l !== END).length, 2)
})

test('Spaces, web addresses in passwords, strict milestones, handoff size, the reason from the failed step', () => {
  for (const t of ['token  = "first\nWARNING: secondsecret"', 'token\t\t=\t"first\nsecondsecret"', 'password="https://x.test/?q=\\"secondsecret"', "password='https://a:b@x/\\'secondsecret'"]) {
    assert.ok(!redact(t, HOME).includes('secondsecret'), t)
  }
  assert.equal(redact('Bearer   abc', HOME), 'Bearer   <redacted>')
  assert.equal(redact('token', HOME), 'token')
  assert.equal(redact('token  abc', HOME), 'token  <redacted>') // the whole run of spaces is taken
  assert.equal(redact('a password= }', HOME), 'a password= }') // a name with no value is left as it is
  const lone = milestones()
  for (const l of ['RESULT: secondsecret', 'PORT_STATE: thirdsecret']) lone.add(l)
  assert.deepEqual(lone.list(), [])
  const m = milestones()
  for (const l of ['RESULT: secondsecret', 'PORT_STATE: thirdsecret', 'ended by SIGfourthsecret', 'READY_TO_TICK', ...Array(200).fill('DISCLOSED'), 'PORT_STATE: closed', 'DOOR_MS: 12', 'DOOR_MS: 15', 'RESULT: ok']) m.add(l)
  assert.deepEqual(m.list(), ['READY_TO_TICK', 'DISCLOSED', 'DOOR_MS: 15', 'PORT_STATE: closed', 'RESULT: ok'])
  for (const rec2 of [{ argv: ['x'.repeat(400_000)], execArgs: ['x'.repeat(400_000)], command: 'c', output: 'o'.repeat(100_000) },
    { argv: ['中'.repeat(120_000)], execArgs: ['中'.repeat(120_000)], command: '中'.repeat(120_000), output: '' }]) {
    const j = handoff(rec2)
    assert.ok(Buffer.byteLength(j) <= 256 * 1024 && JSON.parse(j).command.startsWith('node skin-auto.mjs'))
  }
  assert.ok(Buffer.byteLength(handoff({ argv: ['a'], execArgs: [], command: 'c', output: 'o' }, { BIG: 'x'.repeat(880 * 1024) })) <= 20 * 1024) // a full environment leaves little room
  const s = outcome({ command: 'x', steps: [{ via: 'colour helper', exitCode: 5, output: 'No colour helper is running in this Claude.' }, { via: 'debugger, you tick', exitCode: 1, output: 'READY_TO_TICK\ndebugger port seen\nRESULT: failed' }], shown: '', result: 'failed', exitCode: 1, portBefore: 'closed', portAfter: 'closed' })
  assert.ok(!s.includes('No colour helper') && s.includes('no reason line was printed'))
  assert.match(outcome({ command: 'x', steps: [{ via: 'debugger, one click', exitCode: 1, output: 'Unexpected error: boom' }], shown: '', result: 'failed', exitCode: 1, portBefore: 'closed', portAfter: 'closed' }), /Unexpected error: boom/)
  assert.ok(fs.readFileSync(path.join(tool, 'skin-log.mjs'), 'utf8').includes("'/bin/sleep 30 && kill -9"), 'the watchdog names /bin/sleep')
})

test('Only exact report lines set the result; ok runs with warnings and status runs say what they showed', async () => {
  const dir = tmp()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startRunLog } from ${JSON.stringify(path.join(tool, 'skin-log.mjs'))}
    startRunLog({ argv: ['switch', 'nord'], tool: ${JSON.stringify(tool)}, portBefore: 'closed', env: { RESKIN_LOG_DIR: ${JSON.stringify(dir)} } })
    console.log('password="first')
    console.log('RESULT: secondsecret')
    console.log('PORT_STATE: thirdsecret')
    console.log('end"')
    process.exit(0)`], { stdio: 'ignore' })
  await new Promise((r) => child.on('close', r))
  const file = path.join(dir, LOG_FILE)
  assert.ok(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(END)))
  const log = fs.readFileSync(file, 'utf8')
  assert.ok(!log.includes('secondsecret') && !log.includes('thirdsecret'), log)
  assert.ok(log.includes('result: ok') && log.includes('port 9229 after: unknown'))
  const s = outcome({ command: 'x', steps: [{ via: 'debugger, one click', exitCode: 0, output: 'DISCLOSED\nsampled colour checks: 3 of 8 passed (0 unknown); 5 did not match: a\nWARNING: the inspect tab was not seen; look for a stray Chrome window\nRESULT: ok' }], shown: '', result: 'ok', exitCode: 0, portBefore: 'closed', portAfter: 'closed' })
  assert.match(s, /with a warning: the inspect tab was not seen; look for a stray Chrome window; colour checks: 5 did not match/)
  assert.match(outcome({ command: 'x', steps: [{ via: 'status (read only)', exitCode: 0, output: 'helper: none (no helper session)' }], shown: '', result: 'ok', exitCode: 0, portBefore: 'closed', portAfter: 'closed' }), /status shown: helper: none \(no helper session\)/)
})

test('the hidden-skin line says how to see it, and the log recognises it', () => {
  const line = checksLine({ total: 0, passed: 0, failed: 0, unknown: 0, misses: [] }, 'dark')
  assert.equal(line, "sampled colour checks: none (this skin has no dark version, so it is not showing now; to see it, set Claude's Appearance to Light in its Settings)")
  assert.deepEqual(hiddenInfo(line), { claude: 'dark', needs: 'light' })
  assert.match(checksLine({ total: 0 }, 'light'), /set Claude's Appearance to Dark/)
  assert.doesNotMatch(checksLine({ total: 0 }, null), /to see it/)
})

test('summaries: real reasons, ports not blamed on runs that never touched them, paths that say how far a step got', () => {
  const step = (via, output, exitCode = 0) => ({ via, exitCode, output })
  assert.equal(outcome({ command: 'x', steps: [step('colour helper', 'ok')], shown: '', result: 'ok', exitCode: 0, portBefore: 'closed', portAfter: 'closed' }), 'x: worked (colour helper). Port 9229 closed.')
  assert.match(outcome({ command: 'x', steps: [step('debugger, you tick', 'Not started: Port 9229 is already open (a manual tick, or an earlier run).\nRESULT: refused', 5)], shown: '', result: 'refused', exitCode: 5, portBefore: 'open', portAfter: 'open' }),
    /refused, nothing changed: Port 9229 is already open \(a manual tick, or an earlier run\)\. Port 9229 is open, but this run did not open it \(it was already open before\)\./)
  assert.match(outcome({ command: 'x', steps: [step('debugger, one click', 'DISCLOSED\nWARNING: port 9229 is STILL OPEN.\nRESULT: failed', 3)], shown: '', result: 'failed', exitCode: 3, portBefore: 'closed', portAfter: 'open' }),
    /FAILED \(exit 3\): port 9229 is STILL OPEN\. Port 9229 LEFT OPEN\./)
  assert.match(outcome({ command: 'x', steps: [step('debugger, one click', '[0.10s] lock taken\nDISCLOSED\nWARNING: the skin step took over 8 s; stopping it.\nRESULT: failed', 1)], shown: '', result: 'failed', exitCode: 1, portBefore: 'closed', portAfter: 'closed' }),
    /FAILED \(exit 1\): the skin step took over 8 s; stopping it\. Port 9229 closed\./)
  assert.equal(stepPath(step('debugger, you tick', 'READY_TO_TICK\nWARNING: Time is up')), 'debugger, you tick (asked for the click; no click came in time)')
  assert.equal(stepPath(step('debugger, you tick', 'READY_TO_TICK\nPORT_STATE: open')), 'debugger, you tick (asked for the click; the debugger opening was not confirmed)')
  assert.equal(stepPath(step('debugger, you tick', 'READY_TO_TICK\n[3.0s] debugger port seen')), 'debugger, you tick (the debugger opened)')
})

test('an entry has every fact, cannot be forged or end early, and stays under the size limit', () => {
  const text = formatEntry(rec({ output: `[+0.1s] ${END}\n${HEAD}x\nRESULT: ok`, exact: '["node","x","--password","<redacted>"] in /p' }), HOME)
  for (const want of ['summary: node skin-auto.mjs switch dracula: worked (colour helper). Port 9229 closed.', 'from: skin-auto.mjs, run directly', 'tool: ~/skin-tool',
    'claude: running not reported by this run; installed 2.37337.1; Appearance setting: dark; Mac: light', 'preset: dracula (dark only)', 'port 9229 before: closed (checked as the run started', 'path: colour helper',
    'port 9229 after: closed', 'result: ok', 'exit code: 0', 'duration: 0.42 s', `  [+0.1s] ${END}`]) assert.ok(text.includes(want), want)
  assert.ok(text.includes('Mac: light (installed version, Appearance and Mac read just after the run)'))
  assert.match(text, /^==================== 2026-10-15 18:30:00 [+-]\d{4} \(start\)\n/)
  assert.equal(text.split('\n').filter((l) => l === END).length, 1)
  const forged = formatEntry(rec({ command: `node skin-auto.mjs x\n${HEAD}forged\nsummary: fake`, preset: { name: `y\n${HEAD}z`, mode: 'dark' } }), HOME)
  assert.equal(forged.split('\n').filter((l) => l.startsWith(HEAD) && l !== END).length, 1)
  assert.ok(Buffer.byteLength(formatEntry(rec({ output: capture().finish() + 'x'.repeat(64 * 1024) }), HOME)) < ENTRY_MAX_BYTES)
  assert.ok(!text.includes(String.fromCharCode(8212)))
})

test('the writer: private, rotates under the limit, refuses links, hard links, foreign files and oversized entries', () => {
  const dir = path.join(tmp(), 'Reskin')
  assert.equal(appendEntry(fs, dir, 'one\n', 10), true)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, LOG_FILE)).mode & 0o777, 0o600)
  appendEntry(fs, dir, 'two\n', 10)
  appendEntry(fs, dir, 'three\n', 10) // 8 + 6 bytes > 10: the file moves to .1 first
  assert.equal(fs.readFileSync(path.join(dir, `${LOG_FILE}.1`), 'utf8'), 'one\ntwo\n')
  assert.equal(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8'), 'three\n')
  appendEntry(fs, dir, 'four\n', 10)
  assert.equal(fs.readFileSync(path.join(dir, `${LOG_FILE}.1`), 'utf8'), 'three\n') // never more than two files
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.') && n !== '.skin.log.lock'), []) // no temp file left
  fs.chmodSync(path.join(dir, LOG_FILE), 0o644)
  fs.chmodSync(dir, 0o755)
  appendEntry(fs, dir, 'five\n')
  assert.equal(fs.statSync(path.join(dir, LOG_FILE)).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const other = path.join(tmp(), 'target')
  fs.writeFileSync(other, 'keep')
  fs.chmodSync(other, 0o644)
  for (const kind of ['symlink', 'hardlink']) {
    const d = tmp()
    if (kind === 'symlink') fs.symlinkSync(other, path.join(d, LOG_FILE)); else fs.linkSync(other, path.join(d, LOG_FILE))
    assert.equal(appendEntry(fs, d, 'x\n'), false, kind)
    assert.equal(fs.readFileSync(other, 'utf8'), 'keep', kind)
    assert.equal(fs.statSync(other).mode & 0o777, 0o644, kind)
  }
  const real = tmp()
  const linkDir = path.join(tmp(), 'linkdir')
  fs.symlinkSync(real, linkDir)
  assert.equal(appendEntry(fs, linkDir, 'x\n'), false)
  assert.deepEqual(fs.readdirSync(real), [])
  const stuck = tmp()
  fs.mkdirSync(path.join(stuck, `${LOG_FILE}.1`, 'x'), { recursive: true })
  fs.writeFileSync(path.join(stuck, LOG_FILE), 'full\n')
  assert.equal(appendEntry(fs, stuck, 'more\n', 6), false) // rotation impossible: nothing is written
  assert.equal(fs.readFileSync(path.join(stuck, LOG_FILE), 'utf8'), 'full\n')
  assert.equal(appendEntry(fs, tmp(), 'x'.repeat(ENTRY_MAX_BYTES + 1)), false)
  const orphanDir = tmp()
  const orphan = path.join(orphanDir, '.entry.ABCDEF')
  fs.writeFileSync(orphan, 'left by a killed writer')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(orphan, old, old)
  appendEntry(fs, orphanDir, 'y\n')
  assert.equal(fs.existsSync(orphan), false)
})

test('the lock: a live writer (or any part of a killed one) holds it; once all are gone it is free at once', async () => {
  const dir = tmp()
  fs.chmodSync(dir, 0o700)
  const lock = path.join(dir, '.skin.log.lock')
  // A writer killed while its child still runs: the lock stays with the child.
  const holder = spawn('/bin/sh', ['-c', `exec 9>>"${lock}"; /usr/bin/lockf -s -t 3 9 || exit 4; /bin/sleep 4 & echo ready; /bin/sleep 60 9>&-`], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((r) => holder.stdout.once('data', r))
  holder.kill('SIGKILL')
  spawnSync('/usr/bin/pkill', ['-f', '^/bin/sleep 60$'])
  const t = Date.now()
  assert.equal(appendEntry(fs, dir, 'x\n'), false) // still held by the killed writer's child: waits about 3 s, then skips
  assert.ok(Date.now() - t >= 2_500 && Date.now() - t < 6_500, `${Date.now() - t} ms`)
  assert.ok(await waitFor(() => appendEntry(fs, dir, 'y\n'), 6_000)) // the child ends, the lock is free
})

test('two writers at once (the mod and the tool, several each) never rotate over each other or lose an entry', async () => {
  const dir = path.join(tmp(), 'Reskin')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, LOG_FILE), 'O'.repeat(600) + '\n', { mode: 0o600 })
  const APPEND_SH = fs.readFileSync(path.join(tool, 'skin-log-append.sh'), 'utf8')
  const sh = Array.from({ length: 4 }, (_, i) => new Promise((res) => {
    const p = spawn('/bin/sh', ['-c', APPEND_SH, 'sh', dir, '605', String(ENTRY_MAX_BYTES)], { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('close', res)
    p.stdin.end(`sh-${i}\n`)
  }))
  const code = `import * as fs from 'node:fs'; import { appendEntry } from ${JSON.stringify(path.join(tool, 'skin-log.mjs'))}; process.exit(appendEntry(fs, ${JSON.stringify(dir)}, 'node-' + process.argv[1] + '\\n', 605) ? 0 : 1)`
  const nodes = Array.from({ length: 4 }, (_, i) => new Promise((res) => spawn(process.execPath, ['--input-type=module', '-e', code, String(i)], { stdio: 'ignore' }).on('close', res)))
  await Promise.all([...sh, ...nodes])
  assert.equal(fs.readFileSync(path.join(dir, `${LOG_FILE}.1`), 'utf8'), 'O'.repeat(600) + '\n')
  assert.deepEqual(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').split('\n').filter(Boolean).sort(), ['node-0', 'node-1', 'node-2', 'node-3', 'sh-0', 'sh-1', 'sh-2', 'sh-3'])
})

test('the mod carries exactly the same writer as the tool', { skip: modSource === null && 'the mod is not beside this folder' }, () => {
  const embedded = /export const APPEND_SH = String\.raw`([\s\S]*?)`\n/.exec(modSource)?.[1]
  assert.equal(embedded, fs.readFileSync(path.join(tool, 'skin-log-append.sh'), 'utf8').replace(/\n$/, ''))
})

test('the background writer cleans the handed-over record again and writes the entry', () => {
  const dir = tmp()
  assert.equal(finish(fs, { at: Date.now(), argv: ['switch', 'dracula', '--password', 'hunter2'], command: 'x', execArgs: ['/n', `${HOME}/t/skin-auto.mjs`, 'switch', 'dracula', '--password', 'hunter2'],
    from: 'f', tool, via: 'colour helper', cwd: `${HOME}/password=hunter3`, portBefore: 'closed', portAfter: 'closed', marks: ['PORT_STATE: closed'],
    result: 'ok', exitCode: 0, ms: 5, output: '[+0.001s] token=abc\n[+0.002s] RESULT: ok', logDir: dir }, HOME), true)
  const log = fs.readFileSync(path.join(dir, LOG_FILE), 'utf8')
  assert.ok(!log.includes('hunter2') && !log.includes('hunter3') && !log.includes('abc'), log)
  assert.ok(log.includes('preset: dracula (light and dark)') && log.includes('exact: ["/n","~/t/skin-auto.mjs","switch","dracula","--password","<redacted>"]') && log.includes('milestones: PORT_STATE: closed'))
})

test('a real run started directly (a refusal) leaves one entry after it ends; a run started by /skin leaves none', async () => {
  const dir = tmp()
  const run = (env) => spawnSync(process.execPath, [autoPath(), 'switch', 'no-such-skin'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: '', RESKIN_STATE_DIR: tmp(), RESKIN_LOG_DIR: dir, SKIN_LOCK_PORT: String(41000 + Math.floor(Math.random() * 10000)), ...env } }) // RESKIN_LOG cleared: a suite run with RESKIN_LOG=off must still test the writer
  const r = run({})
  assert.match(r.stdout, /RESULT: refused/)
  const file = path.join(dir, LOG_FILE)
  assert.ok(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(END)), 'the background writer wrote the entry')
  const log = fs.readFileSync(file, 'utf8')
  assert.equal(log.split('\n').filter((l) => l.startsWith(HEAD) && l !== END).length, 1)
  for (const want of ['command: node skin-auto.mjs switch no-such-skin', 'exact: [', 'path: colour helper', 'result: refused', 'exit code: 2', 'No preset called no-such-skin', 'port 9229 before: ', 'claude: running ']) {
    assert.ok(log.includes(want), want)
  }
  assert.match(log, /\n {2}\[\+\d+\.\d{3}s\] /)
  run({ RESKIN_LOG_BY: 'skin-mod' })
  await new Promise((res) => setTimeout(res, 1_000))
  assert.equal(fs.readFileSync(file, 'utf8'), log)
})

test('a run stopped by a signal leaves its entry and notes the signal; the tool\'s own handlers still decide the exit', async () => {
  const dir = tmp()
  const child = (extra) => spawn(process.execPath, ['--input-type=module', '-e', `
    import { startRunLog } from ${JSON.stringify(path.join(tool, 'skin-log.mjs'))}
    startRunLog({ argv: ['switch', 'nord'], tool: ${JSON.stringify(tool)}, portBefore: 'closed', env: { RESKIN_LOG_DIR: ${JSON.stringify(dir)} } })
    ${extra}
    console.log('waiting')
    setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
  const stop = (p) => new Promise((res) => { p.stdout.once('data', () => p.kill('SIGTERM')); p.on('close', (c) => res(c)) })
  const file = path.join(dir, LOG_FILE)
  assert.equal(await stop(child('')), 143)
  assert.ok(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('exit code: 143')))
  assert.ok(fs.readFileSync(file, 'utf8').includes('stopped by SIGTERM'))
  const before = fs.readFileSync(file, 'utf8').length
  assert.equal(await stop(child(`process.on('SIGTERM', () => { console.log('cleanup done'); process.exit(130) })`)), 130)
  assert.ok(await waitFor(() => fs.readFileSync(file, 'utf8').slice(before).includes('exit code: 130')))
  const second = fs.readFileSync(file, 'utf8').slice(before)
  assert.ok(second.includes('cleanup done') && second.includes('stopped by SIGTERM')) // noted, while the tool's own handler did the exit
})
