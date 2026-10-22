import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { APPEND_SH, BoundedText, Capture, END, MAX_LINES, Milestones, marksOf, ENTRY_MAX_BYTES, HEAD, LOG_MAX_BYTES, appearanceOf, formatEntry, hiddenInfo, logView, macModeOf, outcome, parseLog, portOf, redact, redactArgs, runningVersionOf, stepPath } from '../hooks/log'
import type { LogRecord, Step } from '../hooks/log'
import { modeOf, stripComments, summary } from '../hooks/logic'

const EM = String.fromCharCode(8212)
const HOME = '/Users/someone'
const HIDDEN_OUT = 'Skin tokyo-night-day applied by the colour helper.\nsampled colour checks: none (this skin has no dark version, so it is not showing now; to see it, set Claude\'s Appearance to Light in its Settings)\ndebugger: not used (switching needs no port)\nhelper: active until Claude quits (Claude 2.37337.1)\nPORT_STATE: closed\nRESULT: ok'
const SWITCH: Step = { argv: ['/opt/homebrew/bin/node', `${HOME}/skin-tool/skin-auto.mjs`, 'switch', 'dracula'], via: 'colour helper', exitCode: 0, ms: 420, output: '[+0.100s] Skin dracula applied by the colour helper.\n[+0.110s] helper: active until Claude quits (Claude 2.37337.1)\n[+0.140s] PORT_STATE: closed\n[+0.140s] RESULT: ok' }

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  when: '2026-10-15 18:30:00 +0200', command: '/skin dracula', from: '/skin mod 0.6.0', tool: `${HOME}/skin-tool`, claudeVersion: '2.37337.1',
  appearance: 'dark', mac: 'dark', preset: { name: 'dracula', mode: 'dark' }, portBefore: 'closed', portAfter: 'closed',
  steps: [SWITCH], shown: 'Skin dracula applied by the colour helper.', result: 'ok', exitCode: 0, ms: 610, ...over,
})
// What a captured output looks like once written: captured, then cleaned with the rest of the entry.
const written = (chunks: string[], stream: 'stdout' | 'stderr' = 'stdout') => {
  const c = new Capture()
  for (const x of chunks) c.add(0, stream, x)
  return formatEntry(rec({ steps: [{ ...SWITCH, output: c.finish() }] }), HOME)
}
const pieces = (s: string, size: number, offset = 0) => [s.slice(0, offset), ...(s.slice(offset).match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [])].filter(x => x !== '')

describe('redaction', () => {
  test('ids, debugger links, named secrets, long keys and the home folder go; paths and ordinary commands stay', () => {
    const t = redact(`session 3f2b1c4d-1111-4222-8333-444455556666 at ws://127.0.0.1:9229/abc-def\ntoken=abc123 password: "x y" ${'a1'.repeat(30)}\nsk-ant-api03-ABCDEFGHIJKLMNOP\n${HOME}/Projects/My Skins /skin-tool/presets/tokyo-night-day.css`, HOME)
    for (const bad of ['3f2b1c4d', '9229/abc', 'abc123', '"x y"', 'a1a1a1a1a1', 'ABCDEFGHIJ', HOME]) expect(t).not.toContain(bad)
    expect(t).toContain('~/Projects/My Skins /skin-tool/presets/tokyo-night-day.css')
    expect(redact('/skin tokyo-night-day --tick', HOME)).toBe('/skin tokyo-night-day --tick')
    expect(redact('node skin-auto.mjs tick nord --dry-run', HOME)).toBe('node skin-auto.mjs tick nord --dry-run')
  })
  test('every known format is caught', () => {
    const cases: [string, string][] = [
      ['{"password":"swordfish"}', 'swordfish'], ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'], ["password='two words'", 'words'],
      ['access_token=shortsecret', 'shortsecret'], ['https://x.test/cb?code=zzz&state=yyy', 'zzz'], ['Cookie: sid=qqq', 'qqq'],
      ['key=shortsecret', 'shortsecret'], ['Cookie: sid=first; other=secondsecret', 'secondsecret'], ['{"password":"first\\"secondsecret"}', 'secondsecret'],
      ['Authorization: bearer abc.def.ghi', 'abc.def.ghi'], ['error: password=shortsecret', 'shortsecret'], ['--password shortsecret --tick', 'shortsecret'],
      ['https://alice:shortsecret@example.test/file', 'shortsecret'], ['{"e":"token=abc"}', 'abc'], ['password="first\nsecond"', 'second'],
      [`password="${'x'.repeat(5000)}tail-secret"`, 'tail-secret'], ['password="never closed and secret', 'secret'],
      ['--dry-run --password shortsecret --tick nord', 'shortsecret'], ['error: password="shortsecret"', 'shortsecret'],
      ['message: "password=\'first\nsecondsecret\'"', 'secondsecret'], ['-p=x --token="a b" --key v', 'a b'],
    ]
    for (const [input, secret] of cases) expect(redact(input, HOME)).not.toContain(secret)
    expect(redact('--dry-run --password shortsecret --tick nord', HOME)).toBe('--dry-run --password <redacted> --tick nord')
    expect(redact('https://alice:shortsecret@example.test/file', HOME)).toBe('https://<redacted>@example.test/file')
    expect(redactArgs(['node', 'x', '--password', 'shortsecret', '--tick'], HOME)).toEqual(['node', 'x', '--password', '<redacted>', '--tick'])
  })
  test('cleaning stays linear on huge or hostile texts', () => {
    for (const big of ['a'.repeat(200_000), 'a='.repeat(100_000), '"'.repeat(200_000), 'a="'.repeat(70_000), '--password '.repeat(20_000), 'a:b@'.repeat(50_000), `--${'token'.repeat(16_000)}`]) {
      const t = Date.now()
      redact(big, HOME)
      expect(Date.now() - t).toBeLessThan(500)
    }
  })
})

describe('facts', () => {
  test('Claude\'s Appearance is the one word taken from its config; tokens beside it never come out', () => {
    expect(appearanceOf('{"oauth:tokenCacheV2":"SECRET","userThemeMode":"dark"}')).toBe('dark')
    expect(appearanceOf('{"userThemeMode": "system"}')).toBe('system')
    expect(appearanceOf('{"userThemeMode":"secret"}')).toBe('unknown')
    expect(appearanceOf(undefined)).toBe('unknown')
  })
  test('port and Mac mode read three ways, unknown when unsure', () => {
    expect(portOf({ exitCode: 0, stdout: 'Claude 123 u 40u IPv4 TCP 127.0.0.1:9229 (LISTEN)', stderr: '' })).toBe('open')
    expect(portOf({ exitCode: 1, stdout: '', stderr: '' })).toBe('closed')
    expect(portOf({ exitCode: 1, stdout: '', stderr: 'lsof: WARNING' })).toBe('unknown')
    expect(portOf(undefined)).toBe('unknown')
    expect(macModeOf({ exitCode: 0, stdout: 'Dark\n', stderr: '' })).toBe('dark')
    expect(macModeOf({ exitCode: 1, stdout: '', stderr: 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist' })).toBe('light')
    expect(macModeOf({ exitCode: 1, stdout: '', stderr: "Error: Could not find key 'AppleInterfaceStyle' in domain 'kCFPreferencesAnyApplication'." })).toBe('light')
    expect(macModeOf({ exitCode: 9, stdout: '', stderr: '' })).toBe('unknown')
  })
  test('the running Claude version comes from the tool\'s own lines', () => {
    expect(runningVersionOf('helper: active until Claude quits (Claude 2.37337.1)')).toBe('2.37337.1')
    expect(runningVersionOf('helper: active until Claude quits (Claude pid 7305, version 2.37337.1)')).toBe('2.37337.1')
    expect(runningVersionOf('nothing')).toBe(null)
  })
  test('skin modes: comments are skipped in one pass, even unclosed ones', () => {
    expect(modeOf('/* prefers-color-scheme: dark */ @media (prefers-color-scheme: light) {}')).toBe('light')
    expect(stripComments('a/*x*/b/*c')).toBe('a b ')
    const t = Date.now()
    modeOf('/*'.repeat(120_000))
    expect(Date.now() - t).toBeLessThan(300)
  })
})

describe('capture', () => {
  test('each line gets its time; a split line keeps its first time; stderr is marked', () => {
    const c = new Capture()
    c.add(0, 'stdout', 'one\ntw')
    c.add(1500, 'stdout', 'o\nthree')
    c.add(2000, 'stderr', 'oops\n')
    expect(c.finish().split('\n')).toEqual(['[+0.000s] one', '[+0.000s] two', '[+1.500s] three', '[+2.000s] err| oops']) // back in time order
  })
  test('only the start is kept, with counts of what was not', () => {
    const c = new Capture(400)
    for (let i = 0; i < 1000; i++) c.add(i, 'stdout', `line ${i}\n`)
    const out = c.finish()
    expect(out.length).toBeLessThan(600)
    expect(out).toContain('line 0')
    expect(out).not.toContain('line 999')
    expect(out).toContain('more characters of stdout not kept')
    const l = new Capture()
    l.add(0, 'stdout', `START${'m'.repeat(50_000)}END\n`)
    const line = l.finish()
    expect(line).toContain('START')
    expect(line).not.toContain('END')
    expect(line).toContain('more characters of stdout not kept')
  })
  test('a secret over several lines, in any split of the pieces, never reaches the entry', () => {
    const inputs = [
      'password="first\nsecondsecret" after\nok\n', `${'y'.repeat(7009)}password="first${'z'.repeat(7000)}\nsecondsecret"\nok\n`,
      `${'x'.repeat(13000)} password="first\nsecondsecret"\nok\n`, 'message: "password=\'first\nsecondsecret\'"\nok\n', "--token 'a\nsecondsecret\nc' done\nok\n",
    ]
    for (const input of inputs) {
      for (const size of [1, 7, 37]) {
        for (let offset = 0; offset < 40; offset++) {
          const e = written(pieces(input, size, offset))
          expect(e).not.toContain('secondsecret')
        }
      }
    }
    expect(written(['password="first\nsecondsecret" after\nok\n'])).toContain('ok')
  })
})

describe('log safety, part 1', () => {
  test('capture: no split, cut, budget or other stream can expose a secret, and summaries are built from cleaned text', () => {
    const cases: [string, 'stdout' | 'stderr', string][][] = [
      [['password=\n', 'stdout', ''], ['"secondsecret"\nok\n', 'stdout', '']],
      [[`${'x'.repeat(17_000)} password="first\n`, 'stdout', ''], ['secondsecret"\nok\n', 'stdout', '']],
      [['short\n', 'stdout', ''], [`${'y'.repeat(40_000)}\n`, 'stdout', ''], ['password="a\n', 'stdout', ''], ['secondsecret"\n', 'stdout', '']],
      [['password="first\n', 'stdout', ''], ['x"y\n', 'stderr', ''], ['secondsecret"\nok\n', 'stdout', '']],
      [['Cookie: "first\n', 'stdout', ''], ['secondsecret"\nok\n', 'stdout', '']],
      [['WARNING: password="first\n', 'stdout', ''], ['WARNING: secondsecret"\n', 'stdout', '']],
      [[`${'a'.repeat(10_000)}\n${'b'.repeat(10_000)}\n${'c'.repeat(10_000)}\n`, 'stdout', ''], [`${'p'.repeat(5_000)} password="first\n`, 'stdout', ''], ['secondsecret"\nok\n', 'stdout', '']],
    ]
    for (const parts of cases) {
      const c = new Capture()
      parts.forEach(([text, stream], i) => c.add(i, stream, text))
      const e = formatEntry(rec({ steps: [{ ...SWITCH, output: c.finish(), exitCode: 1 }], result: 'failed', exitCode: 1, shown: 'The skin step failed (exit 1).' }), HOME)
      expect(e).not.toContain('secondsecret')
    }
    const chat = formatEntry(rec({ shown: 'The skin step failed (exit 1).\nerror: password=secondsecret', result: 'failed', exitCode: 1 }), HOME)
    expect(chat).not.toContain('secondsecret')
  })
  test('arguments: a secret flag value with a space is removed whole', () => {
    expect(redactArgs(['--password', 'first secondsecret', '--password=first secondsecret', '--tick'], HOME)).toEqual(['--password', '<redacted>', '--password=<redacted>', '--tick'])
  })
  test('the raw text an answer is read from stays bounded, and markers split over pieces are still seen once', () => {
    const b = new BoundedText(1000)
    b.add('READY_TO')
    expect(b.newly('READY_TO_TICK')).toBe(false)
    b.add('_TICK\n')
    expect(b.newly('READY_TO_TICK')).toBe(true)
    expect(b.newly('READY_TO_TICK')).toBe(false)
    for (let i = 0; i < 10_000; i++) b.add('z'.repeat(100))
    b.add('\nRESULT: ok\n')
    expect(b.text.length).toBeLessThan(3_200)
    expect(b.text).toContain('READY_TO_TICK')
    expect(b.text).toContain('RESULT: ok')
  })
  test('hints are never the reason; the last real warning is', () => {
    const s = outcome(rec({ steps: [{ ...SWITCH, via: 'debugger, one click', exitCode: 1, output: 'DISCLOSED\nWARNING: If a small message "Inspector session is active" appears, click its OK button.\nhelper: unchanged (the apply did not finish)\nWARNING: the skin step took over 8 s; stopping it.' }], result: 'failed', exitCode: 1, shown: 'x' }))
    expect(s).toContain('FAILED (exit 1): the skin step took over 8 s; stopping it')
  })
})

describe('log safety, part 2', () => {
  test('token = and quoted Bearer values over lines are caught', () => {
    expect(redact('token = "first\nsecondsecret"', HOME)).not.toContain('secondsecret')
    expect(redact('Authorization: Bearer "first\nsecondsecret"', HOME)).not.toContain('secondsecret')
    expect(redact('a token = b', HOME)).toBe('a token = <redacted>')
  })
  test('many short lines never push an entry past the writer\'s limit', () => {
    const c = new Capture()
    c.add(0, 'stdout', '\n'.repeat(32_768))
    const e = formatEntry(rec({ steps: [{ ...SWITCH, output: c.finish() }] }), HOME)
    expect(new TextEncoder().encode(e).length).toBeLessThan(ENTRY_MAX_BYTES)
    const big = formatEntry(rec({ steps: Array.from({ length: 3 }, () => ({ ...SWITCH, output: Array.from({ length: 2000 }, (_, i) => `[+0.000s] ${'q'.repeat(60)} ${i}`).join('\n') })) }), HOME)
    expect(new TextEncoder().encode(big).length).toBeLessThan(ENTRY_MAX_BYTES)
    expect(big).toContain(END)
  })
  test('the guardian\'s follow-up note is never the reason; the real warning is', () => {
    const s = outcome(rec({ steps: [{ ...SWITCH, via: 'debugger, one click', exitCode: 6, output: 'DISCLOSED\nWARNING: the throwaway Chrome may still be running; end it with: kill -TERM 4242\nWARNING: the backup guardian stays on duty for about a minute and will try to end the leftover throwaway Chrome' }], result: 'failed', exitCode: 6, shown: 'x' }))
    expect(s).toContain('FAILED (exit 6): the throwaway Chrome may still be running; end it with: kill -TERM 4242')
    expect(outcome(rec({ steps: [{ ...SWITCH, via: 'read only (check)', exitCode: 5, output: 'ok   Node: 22.1.0\nFIX  Port 9229 is closed: open' }], result: 'refused', exitCode: 5, shown: '' }))).toContain('FIX  Port 9229 is closed: open')
  })
  test('a /skin check is summarised by its verdict line, never as an apply or a debugger run', () => {
    const chk = (output: string, exitCode: number, result: string) => outcome(rec({ steps: [{ ...SWITCH, argv: [...SWITCH.argv.slice(0, 2), 'check'], via: 'health check', exitCode, output }], result, exitCode, shown: output }))
    expect(chk('health: pass (skin nord shows its own colours in every place checked)', 0, 'ok')).toContain('health check: pass (skin nord')
    expect(chk('health: FAIL (1 place(s) do not show the skin\'s colour)\n  sidebar is rgb(1, 2, 3), expected #252a33', 1, 'failed')).toContain('health check: FAIL')
    expect(chk('health: unknown (no colour helper in this Claude: no helper session)', 0, 'ok')).toContain('health check: unknown')
    expect(chk('', 1, 'failed')).toContain('health check did not finish (exit 1)')
    expect(chk('health: pass (x)', 0, 'ok')).not.toMatch(/worked|one click/)
  })
  test('milestones are only fixed marker words, never whole lines; each stream keeps at most MAX_LINES lines', () => {
    expect(marksOf('READY_TO_TICK\n[3.0s] debugger port seen: stop clicking (secondsecret)\nWARNING: secondsecret\nPORT_STATE: closed')).toEqual(['READY_TO_TICK', 'debugger port seen', 'PORT_STATE: closed'])
    const many = new Capture()
    for (let i = 0; i < 5000; i++) many.add(0, 'stdout', `${i}\n`)
    expect(many.finish().split('\n').filter(l => l.startsWith('[+')).length).toBe(MAX_LINES)
    const c = new Capture()
    c.add(0, 'stdout', 'READY_TO_TICK\n[3.0s] debugger port seen: stop clicking (secondsecret)\nPORT_STATE: closed\n')
    const e = formatEntry(rec({ steps: [{ ...SWITCH, via: 'debugger, you tick', output: '', marks: 'READY_TO_TICK\ndebugger port seen\nPORT_STATE: closed' }] }), HOME)
    expect(e).toContain('milestones: READY_TO_TICK | debugger port seen | PORT_STATE: closed')
  })
})

describe('log safety, part 3', () => {
  test('extra spaces, and a web address inside a quoted password, never let a secret through', () => {
    for (const t of ['token  = "first\nWARNING: secondsecret"', 'token\t\t=\t"first\nsecondsecret"', 'password="https://x.test/?q=\\"secondsecret"', "password='https://a:b@x/\\'secondsecret'"]) {
      expect(redact(t, HOME)).not.toContain('secondsecret')
    }
    expect(redact('Bearer   abc', HOME)).toBe('Bearer   <redacted>')
    expect(redact('token', HOME)).toBe('token')
    expect(redact('token  abc', HOME)).toBe('token  <redacted>') // the whole run of spaces is taken
    expect(redact('a password= }', HOME)).toBe('a password= }') // a name with no value is left as it is
  })
  test('milestones keep only real values, survive any number of repeats, and follow pieces split mid-line', () => {
    expect(marksOf('RESULT: secondsecret\nPORT_STATE: thirdsecret\nended by SIGfourthsecret\nDOOR_MS: 99999999')).toEqual([])
    const m = new Milestones()
    m.feed('stdout', 'READY_TO')
    m.feed('stdout', '_TICK\n')
    for (let i = 0; i < 200; i++) m.feed('stdout', 'DISCLOSED\n')
    m.feed('stdout', 'PORT_STATE: closed\nDOOR_MS: 12\nDOOR_MS: 15\nRESULT: ok')
    expect(m.list()).toEqual(['READY_TO_TICK', 'DISCLOSED', 'DOOR_MS: 15', 'PORT_STATE: closed', 'RESULT: ok'])
    const b = new BoundedText(1000)
    b.add('x\n')
    for (let i = 0; i < 100; i++) b.add('y'.repeat(100))
    b.add('\nRESULT: secondsecret\nPORT_STATE: closed\n')
    expect(b.cleaned()).not.toContain('secondsecret')
    expect(b.cleaned()).toContain('PORT_STATE: closed')
  })
  test('the reason comes from the step that failed, never an earlier step\'s expected refusal', () => {
    const first: Step = { ...SWITCH, exitCode: 5, output: 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nRESULT: refused' }
    const tick: Step = { ...SWITCH, via: 'debugger, you tick', exitCode: 1, output: 'READY_TO_TICK\n[3.0s] debugger port seen: stop clicking\nPort 9229 closed and confirmed.\nRESULT: failed' }
    const s = outcome(rec({ steps: [first, tick], result: 'failed', exitCode: 1, shown: 'The skin step failed (exit 1).\nPort 9229 closed and confirmed.' }))
    expect(s).not.toContain('No colour helper')
    expect(s).toContain('FAILED (exit 1): no reason line was printed; see the entry')
    expect(outcome(rec({ steps: [{ ...tick, output: 'Unexpected error: boom' }], result: 'failed', exitCode: 1, shown: 'x' }))).toContain('Unexpected error: boom')
    expect(outcome(rec({ steps: [{ ...tick, exitCode: null, output: 'ended by SIGTERM' }], result: 'failed', exitCode: null, shown: 'x' }))).toContain('FAILED (no exit code): ended by SIGTERM')
  })
})

describe('log safety, part 4', () => {
  test('an ok run that printed a real warning, or colour checks that did not match, says so', () => {
    const one: Step = { ...SWITCH, via: 'debugger, one click', output: 'DISCLOSED\nsampled colour checks: 3 of 8 passed (0 unknown); 5 did not match: a; b\nWARNING: the inspect tab was not seen; look for a stray Chrome window\nRESULT: ok' }
    const s = outcome(rec({ steps: [one] }))
    expect(s).toContain('worked (debugger, one click), with a warning: the inspect tab was not seen; look for a stray Chrome window; colour checks: 5 did not match')
    expect(outcome(rec({ steps: [{ ...SWITCH, via: 'status', output: 'helper: none (no helper session)\nlast skin: dracula' }] }))).toContain('status shown: helper: none (no helper session)')
    expect(outcome(rec({ steps: [{ ...SWITCH, exitCode: null, output: 'ended without an exit code' }], result: 'failed', exitCode: null, shown: 'The skin step failed (exit 1).' }))).toContain('FAILED (no exit code): ended without an exit code')
  })
})

describe('summary line', () => {
  const tickStep = (output: string, exitCode = 0): Step => ({ argv: ['node', 'skin-auto.mjs', 'tick', 'dracula'], via: 'debugger, you tick', exitCode, ms: 9000, output })
  test('says what happened, for each kind of run', () => {
    expect(outcome(rec())).toBe('/skin dracula: worked (colour helper). Port 9229 closed.')
    expect(outcome(rec({ command: '/skin tokyo-night day', steps: [], result: 'refused', exitCode: null, shown: 'One skin name at a time, for example /skin dracula.' })))
      .toBe('/skin tokyo-night day: refused before anything ran: One skin name at a time, for example /skin dracula. Port 9229 closed.')
    expect(outcome(rec({ steps: [{ ...SWITCH, output: HIDDEN_OUT }] }))).toContain('applied, but not visible: the skin is light only and Claude was showing dark')
    expect(outcome(rec({ steps: [], result: 'failed', exitCode: null, shown: 'No skins found in /tool/presets.' }))).toBe('/skin dracula: FAILED before the tool ran: No skins found in /tool/presets. Port 9229 closed.')
  })
  test('a failure gives its real reason, not just its exit code', () => {
    const shown = 'The skin step failed (exit 3).\nBut the job failed: Claude refused part of it\nWARNING: port 9229 is STILL OPEN. Untick Developer > Enable Main Process Debugger now, or quit Claude.'
    const s = outcome(rec({ steps: [tickStep('[+3.000s] debugger port seen: stop clicking\nWARNING: port 9229 is STILL OPEN.', 3)], result: 'failed', exitCode: 3, shown, portAfter: 'open' }))
    expect(s).toContain('FAILED (exit 3): port 9229 is STILL OPEN') // the last real warning
    expect(s).toContain('Port 9229 LEFT OPEN')
    const up = outcome(rec({ steps: [tickStep('READY_TO_TICK\nWARNING: Time is up (60 s) and nothing was applied.', 4)], result: 'failed', exitCode: 4, shown: 'Time is up and nothing was applied. To try again, run the same command.' }))
    expect(up).toContain('Time is up')
    const slow = outcome(rec({ steps: [tickStep('[0.10s] lock taken\nREADY_TO_TICK\nWARNING: the skin step took over 8 s; stopping it.', 1)], result: 'failed', exitCode: 1, shown: 'The skin step failed (exit 1).\nlock taken' }))
    expect(slow).toContain('FAILED (exit 1): the skin step took over 8 s; stopping it')
  })
  test('a run that never touched an already open port is not blamed for it', () => {
    const s = outcome(rec({ portBefore: 'open', portAfter: 'open' }))
    expect(s).toContain('Port 9229 is open, but this run did not open it (it was already open before)')
    expect(s).not.toContain('LEFT OPEN')
    expect(outcome(rec({ steps: [tickStep('READY_TO_TICK\ndebugger port seen', 3)], result: 'failed', exitCode: 3, portBefore: 'open', portAfter: 'open', shown: 'x' }))).toContain('still OPEN after this run')
    expect(outcome(rec({ portBefore: 'open', portAfter: 'closed' }))).toContain('now closed (it was open before)')
    expect(outcome(rec({ portAfter: 'unknown' }))).toContain('not checked clearly; this run did not open it')
  })
  test('a list whose status check was refused does not read as a clean success', () => {
    const st: Step = { argv: ['node', 'skin-auto.mjs', 'status'], via: 'status', exitCode: 5, ms: 30, output: '[+0.010s] err| Not started: another skin run is in progress.\n[+0.020s] RESULT: refused' }
    expect(outcome(rec({ command: '/skin', steps: [{ ...st, via: 'status check (for the list)' }], result: 'ok', exitCode: 5 }))).toContain('/skin: listed the skins, but the status check ended with exit 5: another skin run is in progress')
    expect(outcome(rec({ command: '/skin status', steps: [st], result: 'refused', exitCode: 5 }))).toContain('status not shown (exit 5): another skin run is in progress')
    expect(outcome(rec({ command: '/skin remove', steps: [{ ...SWITCH, output: 'helper: none (already clean). If Claude still shows a skin, take it off with: /skin remove --tick' }] }))).toContain('nothing to remove: no colour helper was running')
  })
  test('the path says how far each step got', () => {
    expect(stepPath({ via: 'debugger, you tick', exitCode: 5, output: 'Not started: Port 9229 is already open' })).toBe('debugger, you tick (stopped before the debugger was asked for)')
    expect(stepPath({ via: 'debugger, you tick', exitCode: 4, output: 'READY_TO_TICK\nWARNING: Time is up' })).toBe('debugger, you tick (asked for the click; no click came in time)')
    expect(stepPath({ via: 'debugger, you tick', exitCode: 130, output: 'READY_TO_TICK\nPORT_STATE: open' })).toBe('debugger, you tick (asked for the click; the debugger opening was not confirmed)')
    expect(stepPath({ via: 'debugger, you tick', exitCode: 0, output: 'READY_TO_TICK\n[3.0s] debugger port seen: stop clicking' })).toBe('debugger, you tick (the debugger opened)')
    expect(stepPath({ via: 'colour helper', exitCode: 5, output: 'No colour helper is running in this Claude' })).toBe('colour helper (none running)')
  })
})

describe('entries', () => {
  test('an entry holds every fact, its raw output cannot end it early, and it reads back', () => {
    const text = formatEntry(rec({ steps: [{ ...SWITCH, output: `${SWITCH.output}\n[+0.2s] ${END}\n${HEAD}fake` }] }), HOME)
    for (const want of ['summary: /skin dracula: worked (colour helper). Port 9229 closed.', 'command: /skin dracula', 'from: /skin mod 0.6.0', 'tool: ~/skin-tool',
      'claude: running 2.37337.1; installed 2.37337.1; Appearance setting: dark; Mac: dark', 'preset: dracula (dark only)', 'port 9229 before: closed', 'path: colour helper',
      'port 9229 after: closed', 'result: ok', 'exit code: 0', 'duration: 0.61 s', '--- step 1: ["/opt/homebrew/bin/node","~/skin-tool/skin-auto.mjs","switch","dracula"] (exit 0, 0.42 s)',
      '  [+0.100s] Skin dracula applied', '--- shown in chat']) expect(text).toContain(want)
    expect(text.startsWith(`${HEAD}2026-10-15 18:30:00 +0200 (start)\n`)).toBe(true)
    expect(text.endsWith(`${END}\n`)).toBe(true)
    expect(parseLog(text + text)).toEqual([{ when: '2026-10-15 18:30:00 +0200', summary: '/skin dracula: worked (colour helper). Port 9229 closed.' }, { when: '2026-10-15 18:30:00 +0200', summary: '/skin dracula: worked (colour helper). Port 9229 closed.' }])
    expect(text).not.toContain(EM)
  })
  test('pasted line breaks cannot forge entries; huge commands, chat text and preset names are capped or escaped', () => {
    const forged = formatEntry(rec({ command: `/skin dracula\n${HEAD}forged\nsummary: fake\n${END}`, steps: [], result: 'refused', shown: 'One skin name at a time.' }), HOME)
    expect(parseLog(forged)).toHaveLength(1)
    const big = formatEntry(rec({ command: `/skin ${'a'.repeat(200_000)}`, shown: `Unknown option --${'!'.repeat(600_000)}`, steps: [], result: 'refused' }), HOME)
    expect(big.length).toBeLessThan(12_000)
    expect(parseLog(formatEntry(rec({ preset: { name: `x\n${HEAD}forged`, mode: 'dark' } }), HOME))).toHaveLength(1)
    const many = formatEntry(rec({ steps: Array.from({ length: 5 }, () => ({ ...SWITCH, output: 'x'.repeat(64 * 1024) })) }), HOME)
    expect(new TextEncoder().encode(many).length).toBeLessThan(ENTRY_MAX_BYTES)
  })
  test('/skin log shows the newest first across both files, and points to the file', () => {
    const e = (n: number) => formatEntry(rec({ when: `2026-10-15 18:0${n}:00 +0200`, command: `/skin s${n}` }), HOME)
    const v = logView(e(1) + e(2), e(3) + e(4) + e(5) + e(6), 5, '~/Library/Logs/Reskin/skin.log')
    const bullets = v.split('\n').filter(l => l.startsWith('•'))
    expect(bullets).toHaveLength(5)
    expect(bullets[0]).toContain('18:06')
    expect(bullets[4]).toContain('18:02')
    expect(v).toContain('~/Library/Logs/Reskin/skin.log')
    expect(logView('', '', 5, '~/x.log')).toContain('No /skin runs logged yet')
    expect(logView('', `${HEAD}2026-10-15 18:00:00 +0200\nsummary: torn`, 5, '~/x.log')).toContain('torn')
  })
})

describe('the not-visible message', () => {
  test('says plainly how to see the skin, once', () => {
    const s = summary('tokyo-night-day', 0, HIDDEN_OUT, '')
    expect(s.split('\n')[0]).toBe('Skin tokyo-night-day is on, but you cannot see it yet: it only has a light version and Claude is showing dark. To see it, open Claude\'s Settings and set Appearance to Light, or pick a light-and-dark skin (see /skin list), which follows Claude.')
    expect(s).not.toContain('is not showing now') // the checks line that says it again is left out
    const n = summary('dracula', 0, 'NOTE: Claude is showing light right now and this skin has only a dark version, so you will not see it until Claude looks dark (Settings > Appearance). A -auto skin covers both.\nRESULT: ok', '')
    expect(n.split('\n')[0]).toContain('set Appearance to Dark')
    expect(n).not.toContain('NOTE:')
    expect(summary('dracula', 0, 'Skin dracula applied by the colour helper.\nRESULT: ok', '')).toBe('Skin dracula applied by the colour helper.')
  })
})

// ---- end to end: what /skin writes, with a fake world ----
const TOOL = '/tool'
type Seen = { appends: { argv: readonly string[]; stdin: string }[]; toolEnv: (Record<string, string> | undefined)[]; spawned: (readonly string[])[] }
type World = { switchOut?: [number, string]; tickOut?: [number, string]; logText?: string; appendFails?: boolean; lsof?: () => [number, string]; stallLog?: boolean; logUnreadable?: boolean; stallConfig?: boolean; existsFails?: boolean; stallHome?: boolean }
function world(on: On, o: World = {}): Seen {
  mock.store(on)
  if (o.stallHome) on('env.get', async () => { await new Promise(() => {}); return { value: undefined } })
  else mock.env(on, { HOME })
  const seen: Seen = { appends: [], toolEnv: [], spawned: [] }
  const ok = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as RenderElement)
  on('ui.status', () => ({ value: undefined }))
  on('fs.list', ($, e) => {
    if (e.path === TOOL) return { value: [{ name: 'skin-auto.mjs', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'presets', kind: 'dir', size: 1, mtimeMs: 0, isLink: false }] }
    if (e.path === `${TOOL}/presets`) return { value: [{ name: 'dracula.css', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'tokyo-night-day.css', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    throw new Error('no such folder')
  })
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('/Claude/config.json') && o.stallConfig) await new Promise(() => {})
    if (e.path.endsWith('/Claude/config.json')) return { value: '{"oauth:tokenCacheV2":"SECRET-TOKEN-VALUE","userThemeMode":"dark"}' }
    if (e.path.endsWith('plugin.json')) return { value: '{"name":"skin","version":"9.9.9"}' }
    if (e.path === `${HOME}/Library/Logs/Reskin/skin.log`) { if (o.logText === undefined || o.logUnreadable) throw new Error(o.logUnreadable ? 'EACCES' : 'ENOENT'); return { value: o.logText } }
    if (e.path.endsWith('skin.log.1')) throw new Error('ENOENT')
    return { value: e.path.includes('day') ? '@media (prefers-color-scheme: light) {}' : '@media (prefers-color-scheme: dark) {}' }
  })
  on('fs.exists', ($, e) => { if (o.existsFails) throw new Error('EACCES'); return { value: e.path === `${HOME}/Library/Logs/Reskin/skin.log` && (o.logText !== undefined || !!o.stallLog) } })
  on('fs.stat', async ($, e) => {
    if (e.path.endsWith('/Claude/config.json')) return { value: { kind: 'file', size: 60, mtimeMs: 0, isLink: false } }
    if (e.path === `${HOME}/Library/Logs/Reskin/skin.log` && o.stallLog) await new Promise(() => {})
    if (e.path === `${HOME}/Library/Logs/Reskin/skin.log` && o.logText !== undefined) return { value: { kind: 'file', size: o.logText.length, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('process.run', ($, e) => {
    const a = e.argv
    if (a[0] === '/usr/sbin/lsof') return ok(...(o.lsof?.() ?? [1, '']))
    if (a[0] === '/usr/bin/plutil') return ok(0, '2.37337.1\n')
    if (a[0] === '/usr/bin/defaults') return ok(0, 'Dark\n')
    if (a[0] === '/bin/date') return ok(0, '2026-10-15 18:30:00 +0200\n')
    if (a[0] === '/bin/sh') { if (o.appendFails) throw new Error('disk full'); seen.appends.push({ argv: a, stdin: String(e.init?.stdin ?? '') }); return ok(0, '') }
    if (a.at(-1) === '--version') return a[0] === '/opt/homebrew/bin/node' ? ok(0, 'v26.1.0\n') : ok(1, '')
    return ok(9, 'unexpected')
  })
  on('process.spawn', async function* ($, e) {
    seen.spawned.push(e.argv)
    seen.toolEnv.push(e.env)
    const [code, text] = e.argv[2] === 'switch' ? (o.switchOut ?? [0, 'Skin dracula applied by the colour helper.\nPORT_STATE: closed\nRESULT: ok'])
      : e.argv[2] === 'tick' ? (o.tickOut ?? [0, 'READY_TO_TICK\n[3.0s] debugger port seen: stop clicking\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok'])
      : [0, 'helper: none (no helper session)\nPORT_STATE: closed\nRESULT: ok']
    yield { stream: 'stdout' as const, text }
    return { value: { code, signal: null } }
  })
  return seen
}
const cmd = (args: string) => ({ command: 'skin', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const OPTS = { options: { toolDir: TOOL } }
// The entry is written after the answer, in the background: wait for it.
const settle = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 5)) }

test('every /skin run appends one entry with the facts, timed raw output, and no secret; the answer does not wait for it', OPTS, async ($, on) => {
  const w = world(on, { switchOut: [0, HIDDEN_OUT] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('tokyo-night-day'))
  expect(r.text).toContain('you cannot see it yet')
  expect(w.toolEnv[0]).toEqual({ RESKIN_LOG_BY: 'skin-mod' }) // the tool does not log the same step again
  await settle(() => w.appends.length > 0)
  expect(w.appends).toHaveLength(1)
  const a = w.appends[0]!
  expect(a.argv).toEqual(['/bin/sh', '-c', APPEND_SH, 'sh', `${HOME}/Library/Logs/Reskin`, String(LOG_MAX_BYTES), String(ENTRY_MAX_BYTES)]) // the locked writer
  for (const want of ['command: /skin tokyo-night-day', 'from: /skin mod 9.9.9', 'claude: running 2.37337.1; installed 2.37337.1; Appearance setting: dark; Mac: dark',
    'preset: tokyo-night-day (light only)', 'port 9229 before: closed', 'path: colour helper', 'port 9229 after: closed', 'result: ok', 'exit code: 0',
    'summary: /skin tokyo-night-day: applied, but not visible: the skin is light only and Claude was showing dark. Port 9229 closed.',
    '--- step 1: ["/opt/homebrew/bin/node","/tool/skin-auto.mjs","switch","tokyo-night-day"]', '--- shown in chat', '  Skin tokyo-night-day is on, but you cannot see it yet']) expect(a.stdin).toContain(want)
  expect(a.stdin).toMatch(/\n {2}\[\+\d+\.\d{3}s\] Skin tokyo-night-day applied by the colour helper\./) // quick runs are timed too
  expect(a.stdin).not.toContain('SECRET')
  expect(a.stdin).not.toContain(HOME)
})

test('a confusing run with no record now leaves entries that tell the story', OPTS, async ($, on) => {
  const w = world(on, {
    lsof: () => [0, 'Claude 7305 user 40u IPv4 TCP 127.0.0.1:9229 (LISTEN)'],
    switchOut: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: open\nRESULT: refused'],
    tickOut: [5, 'Not started: Port 9229 is already open (a manual tick, or an earlier run). Untick Developer > Enable Main Process Debugger or quit Claude, then try again. Nothing was changed.\nPORT_STATE: open\nRESULT: refused'],
  })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('tokyo-night day'))
  await settle(() => w.appends.length > 0)
  await $.command.run(cmd('tokyo-night-day'))
  await settle(() => w.appends.length > 1)
  const [two, open] = w.appends.map(x => x.stdin)
  expect(two).toContain('summary: /skin tokyo-night day: refused before anything ran: One skin name at a time')
  expect(two).toContain('Port 9229 is open, but this run did not open it (it was already open before)')
  expect(open).toContain('summary: /skin tokyo-night-day: refused, nothing changed: Port 9229 is already open (a manual tick, or an earlier run)')
  expect(open).toContain('path: colour helper (none running), then debugger, you tick (stopped before the debugger was asked for)')
  expect(open).toContain('port 9229 before: open')
  expect(open).not.toContain('LEFT OPEN')
})

test("the after-reading is the tool's own last port check, not a later look", OPTS, async ($, on) => {
  const w = world(on, { lsof: () => [0, 'Claude 1 u 4u IPv4 TCP 127.0.0.1:9229 (LISTEN)'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('dracula'))
  await settle(() => w.appends.length > 0)
  const e = w.appends[0]!.stdin
  expect(e).toContain("port 9229 after: closed (the tool's own last check)")
  expect(e).toContain('Port 9229 is now closed (it was open before)')
})

test('a secret the tool printed never reaches the chat, the saved chat text or the summary', OPTS, async ($, on) => {
  const out = '{"password":"first\nWARNING: secondsecret"}\nline a\nline b\nline c\nline d\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: failed'
  const w = world(on, { switchOut: [1, out] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(r.text).not.toContain('secondsecret')
  await settle(() => w.appends.length > 0)
  expect(w.appends[0]!.stdin).not.toContain('secondsecret')
})

test('a cut in the kept output never loses the tool\'s own port check', OPTS, async ($, on) => {
  const w = world(on, { lsof: () => [0, 'Claude 1 u 4u IPv4 TCP 127.0.0.1:9229 (LISTEN)'], switchOut: [0, `${'z'.repeat(17_000)}\nSkin dracula applied by the colour helper.\nPORT_STATE: closed\nRESULT: ok`] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('dracula'))
  await settle(() => w.appends.length > 0)
  const e = w.appends[0]!.stdin
  expect(e).toContain("port 9229 after: closed (the tool's own last check)")
  expect(e).toContain('milestones: PORT_STATE: closed | RESULT: ok')
})

test('/skin log answers within 3 s even when the file cannot be read', OPTS, async ($, on) => {
  const clock = mock.clock(on)
  world(on, { stallLog: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const pending = $.command.run(cmd('log'))
  await clock.advance(0)
  await clock.advance(3_000)
  expect((await pending).text).toContain('could not be read within 3 s')
})

test('a log that is there but cannot be read says so, not "nothing logged yet"', OPTS, async ($, on) => {
  world(on, { logText: 'x', logUnreadable: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(cmd('log'))).text).toContain('could not be read')
})

test('a lookup that never answers cannot hold the entry back; it is written as unknown', OPTS, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { stallConfig: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('dracula'))
  await clock.advance(0)
  await clock.advance(2_000)
  await settle(() => w.appends.length > 0)
  expect(w.appends[0]!.stdin).toContain('Appearance setting: unknown')
})

test('an existence check that cannot answer is not "nothing logged"', OPTS, async ($, on) => {
  world(on, { existsFails: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(cmd('log'))).text).toContain('could not be read')
})

test('/skin log answers within 3 s even when the home folder lookup never returns', OPTS, async ($, on) => {
  const clock = mock.clock(on)
  world(on, { stallHome: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const pending = $.command.run(cmd('log'))
  await clock.advance(0)
  await clock.advance(3_000)
  expect((await pending).text).toContain('could not be read within 3 s')
})

test('/skin log reads and never writes (rotation and locking: the real writer is run in the tool tests)', OPTS, async ($, on) => {
  const w = world(on, { logText: formatEntry(rec(), HOME) })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('dracula'))
  await settle(() => w.appends.length > 0)
  const v = (await $.command.run(cmd('log'))).text ?? ''
  expect(v).toContain('/skin dracula: worked (colour helper)')
  expect(v).toContain('~/Library/Logs/Reskin/skin.log')
  await settle(() => false)
  expect(w.appends).toHaveLength(1)
})

test('a log that cannot be written never changes the answer', OPTS, async ($, on) => {
  world(on, { appendFails: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(cmd('dracula'))).text).toBe('Skin dracula applied by the colour helper.')
})
