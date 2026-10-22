import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { ABOUT, CARD, DEV_MODE, TIME_UP, cardFacts, cardParagraph, countdownSvg, displayName, listText, modeOf, nodeCandidates, nodeMajorOk, noHelper, parse, skinSuggestions, oneClickOf, argumentHintOf, summary, toolDirCandidates } from '../hooks/logic'

const EM = String.fromCharCode(8212)

describe('parse', () => {
  test('empty and list show the list; status, off and remove are their own commands', () => {
    expect(parse('')).toEqual({ kind: 'list' })
    expect(parse(' LIST ')).toEqual({ kind: 'list' })
    expect(parse('status')).toEqual({ kind: 'status' })
    expect(parse('check')).toEqual({ kind: 'check' })
    expect(parse('check --tick').kind).toBe('bad')
    expect(parse('about')).toEqual({ kind: 'about' })
    expect(parse('about --tick').kind).toBe('bad')
    expect(parse('off')).toEqual({ kind: 'off', via: 'auto' })
    expect(parse('remove')).toEqual({ kind: 'remove', via: 'auto' })
    expect(parse('remove --tick')).toEqual({ kind: 'remove', via: 'tick' })
  })
  test('a plain preset name applies, through the helper or a tick; flags choose the way', () => {
    expect(parse('Catppuccin-Latte')).toEqual({ kind: 'apply', name: 'catppuccin-latte', via: 'auto' })
    expect(parse('nord --tick')).toEqual({ kind: 'apply', name: 'nord', via: 'tick' })
    expect(parse('--one-click nord')).toEqual({ kind: 'apply', name: 'nord', via: 'one-click' })
  })
  test('anything path-like, odd or doubled is refused', () => {
    for (const bad of ['../x', 'a/b', '..', 'dracula.css', 'a b', '-x', 'x-', 'a--b', '$(rm)', 'a;b', 'nord --force', 'nord --tick --one-click', '--tick', 'status --tick']) {
      expect(parse(bad).kind).toBe('bad')
    }
  })
  test('a tick-only release never suggests --one-click in an error', () => {
    for (const bad of ['nord --force', 'nord --tick --one-click']) {
      const r = parse(bad, false)
      expect(r.kind).toBe('bad')
      expect(r.kind === 'bad' && r.why).toMatch(/--tick/)
      expect(r.kind === 'bad' && /or --one-click|Choose one/.test(r.why)).toBe(false)
      expect(parse(bad).kind === 'bad' && (parse(bad) as { why: string }).why).toMatch(/--one-click/)
    }
  })
})

test('no owner-specific paths: the tool folder and Node are looked up, Node must be 22 or newer', () => {
  expect(toolDirCandidates(undefined, '/x/mods/skin')).toEqual(['/x/mods/skin/skin-tool', '/x/mods/skin-tool'])
  expect(toolDirCandidates('/opt/reskin/', '/x/mods/skin')[0]).toBe('/opt/reskin')
  expect(nodeCandidates(undefined).map(a => a.join(' '))).toEqual(['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/env node'])
  expect(nodeCandidates('/my/node')[0]).toEqual(['/my/node'])
  expect(nodeMajorOk('v22.0.0\n')).toBe(true)
  expect(nodeMajorOk('v26.10.0')).toBe(true)
  expect(nodeMajorOk('v21.9.0')).toBe(false)
  expect(nodeMajorOk('garbage')).toBe(false)
})

test('the list leaves out empty one-mode groups (17 Oct: every shipped skin has both halves)', () => {
  const t = listText([{ name: 'nord', mode: 'auto' }, { name: 'vs', mode: 'auto' }], 'light')
  expect(t).toContain('Light and dark (follow Claude\'s Appearance): nord, vs')
  expect(t).not.toContain('Dark only')
  expect(t).not.toContain('Light only')
  expect(t).not.toContain('dark-only or light-only')
})

test('A1: the Developer Mode first step shows in the list, /skin about, the card and the time-out line', () => {
  const t = listText([{ name: 'nord', mode: 'auto' }], 'dark')
  expect(t).toContain(DEV_MODE)
  expect(ABOUT).toContain(DEV_MODE)
  for (const s of [DEV_MODE, CARD.devMode, TIME_UP]) expect(s).toContain('Help › Troubleshooting › Enable Developer Mode')
  expect(TIME_UP).toContain('Do not click the menu item now; if you already did, quit and reopen Claude.')
  expect(CARD.devMode).toContain('Claude restarts')
})

test('A2: an unread Mac appearance is said plainly, never guessed as light', () => {
  const t = listText([{ name: 'nord', mode: 'auto' }], 'unknown')
  expect(t).toContain('I could not read your Mac\'s appearance')
  expect(t).not.toContain('Your Mac is in')
  expect(listText([{ name: 'nord', mode: 'auto' }], 'light')).toContain('Your Mac is in light mode')
})

test('modeOf reads the colour scheme and nothing else', () => {
  expect(modeOf('@media (prefers-color-scheme: dark) { }')).toBe('dark')
  expect(modeOf('@media (prefers-color-scheme:light){}')).toBe('light')
  expect(modeOf('body {}')).toBe('unknown')
  expect(modeOf('@media (prefers-color-scheme: dark) { } @media (prefers-color-scheme: light) { }')).toBe('auto')
  expect(modeOf('@media (prefers-color-scheme: dark) { } @media (prefers-color-scheme: dark) { }')).toBe('unknown')
})

test('the list names the three groups and how switching works', () => {
  const t = listText([{ name: 'dracula', mode: 'dark' }, { name: 'one-light', mode: 'light' }, { name: 'one-auto', mode: 'auto' }], 'dark')
  expect(t).toContain('Dark only: dracula')
  expect(t).toContain('later switches need none')
  expect(t).not.toContain('Quit Chrome first')
  expect(t).not.toContain(EM)
})

describe('summary', () => {
  test('success shows the three report lines', () => {
    const out = 'sampled colour checks: 5 of 5 passed (0 unknown)\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n'
    expect(summary('dracula', 0, out, '')).toBe('Skin dracula applied.\nsampled colour checks: 5 of 5 passed (0 unknown)\ndebugger: confirmed closed\nhelper: active until Claude quits')
  })
  test('a switch answer keeps its own headline', () => {
    const out = 'Skin nord applied by the colour helper.\nsampled colour checks: 4 of 5 passed (1 unknown)\ndebugger: not used (switching needs no port)\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok'
    const t = summary('nord', 0, out, '')
    expect(t.startsWith('Skin nord applied by the colour helper.')).toBe(true)
    expect(t).toContain('1 unknown')
  })
  test('switch unconfirmed is a failure that says what to do, never a silent tick', () => {
    const out = 'switch unconfirmed: the colour helper did not answer within 2 s. Nothing else was tried (no tick, no port).\nIf the colours did not change, apply with a new tick: /skin nord --tick\nPORT_STATE: closed\nRESULT: failed'
    const t = summary('nord', 1, out, '')
    expect(t).toContain('switch unconfirmed')
    expect(t).toContain('/skin nord --tick')
  })
  test('a refusal says so and shows why', () => {
    const t = summary('dracula', 5, 'PORT_STATE: closed\nRESULT: refused', 'Port 9229 is already open. Nothing was changed.')
    expect(t).toContain('Not started.')
    expect(t).toContain('Port 9229 is already open')
    expect(t).not.toContain('NOT CONFIRMED CLOSED')
  })
  test('an open or unknown port is never hidden, and machine lines never leak', () => {
    const t = summary('nord', 3, 'READY_TO_TICK\nSAMPLES: {}\nHELPER: active x\ndebugger: NOT confirmed closed (unknown). Fix: quit and reopen Claude\nPORT_STATE: unknown\nRESULT: failed', '')
    expect(t).toContain('exit 3')
    expect(t).toContain('PORT 9229 IS NOT CONFIRMED CLOSED (unknown)')
    expect(t).toContain('debugger: NOT confirmed closed')
    expect(t).not.toContain('READY_TO_TICK')
    expect(t).not.toContain('SAMPLES:')
  })
  test('no helper is recognised', () => {
    expect(noHelper('No colour helper is running in this Claude (no helper session), so nothing was changed.')).toBe(true)
    expect(noHelper('Could not tell whether a colour helper is running')).toBe(false)
  })
})

// ---- the command end to end, with a fake file system, fake runs and a fake streamed run ----
const TOOL = '/tool'
type Answers = { registerThrows?: boolean; defaults?: [number, string, string]; switch?: [number, string]; status?: [number, string]; check?: [number, string]; tick?: string[]; tickCode?: number; spawn?: (argv: readonly string[], signal: AbortSignal) => AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { value: { code: number | null; signal: string | null } }> }
function world(on: On, a: Answers = {}) {
  mock.store(on)
  const runs: (readonly string[])[] = []
  const spawns: (readonly string[])[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const lists: string[] = []
  on('command.register', ($, e) => { if (a.registerThrows) throw new Error('command /skin is already registered'); return { value: { command: e.name } } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as RenderElement)
  on('fs.list', ($, e) => {
    lists.push(e.path)
    if (e.path === TOOL) return { value: [{ name: 'skin-auto.mjs', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'presets', kind: 'dir', size: 1, mtimeMs: 0, isLink: false }] }
    if (e.path === `${TOOL}/presets`) return { value: [
      { name: 'dracula.css', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'one-light.css', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ] }
    throw new Error('no such folder')
  })
  on('fs.read', ($, e) => ({ value: e.path.includes('light') ? '@media (prefers-color-scheme: light) {}' : '@media (prefers-color-scheme: dark) {}' }))
  const ok = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ($, e) => {
    runs.push(e.argv)
    if (e.argv[0] === '/usr/bin/defaults') return a.defaults ? { value: { exitCode: a.defaults[0], stdout: a.defaults[1], stderr: a.defaults[2], isStdoutTruncated: false, isStderrTruncated: false } } : ok(0, 'Dark\n')
    if (e.argv.at(-1) === '--version') return e.argv[0] === '/opt/homebrew/bin/node' ? ok(0, 'v26.1.0\n') : ok(1, '')
    if (e.argv[2] === 'switch') return ok(...(a.switch ?? [0, 'Skin x applied by the colour helper.\nPORT_STATE: closed\nRESULT: ok']))
    if (e.argv[2] === 'status') return ok(...(a.status ?? [0, 'helper: none (no helper session)\nlast skin: dracula\nReapply dracula? Run: /skin dracula\nPORT_STATE: closed\nRESULT: ok']))
    return ok(9, 'unexpected')
  })
  on('process.spawn', async function* ($, e, next) {
    // Quick runs (switch, status) are streamed too since 0.6.0; they count as runs here, tick runs as spawns.
    if (e.argv[2] === 'check') {
      runs.push(e.argv)
      const [code, text] = a.check ?? [0, 'health: pass (skin dracula shows its own colours in every place checked)\nchecked: dark mode only (the light half is checked when Claude shows light)\n(as the colour helper reports; no debugger checked it)\ndebugger: not used (the check needs no port)\nhelper: active until Claude quits (Claude 2.42304.0)\nPORT_STATE: closed\nRESULT: ok']
      if (text) yield { stream: 'stdout', text }
      return { value: { code, signal: null } }
    }
    if (e.argv[2] === 'switch' || e.argv[2] === 'status') {
      runs.push(e.argv)
      const [code, text] = e.argv[2] === 'switch' ? (a.switch ?? [0, 'Skin x applied by the colour helper.\nPORT_STATE: closed\nRESULT: ok']) : (a.status ?? [0, 'helper: none (no helper session)\nlast skin: dracula\nReapply dracula? Run: /skin dracula\nPORT_STATE: closed\nRESULT: ok'])
      yield { stream: 'stdout', text }
      return { value: { code, signal: null } }
    }
    spawns.push(e.argv)
    if (a.spawn) return yield* a.spawn(e.argv, next.signal)
    for (const text of a.tick ?? ['[0.10s] lock taken\n', 'Ready. Before you tick, so nothing surprises you:\n- A "chrome://inspect" tab may open in your Chrome. Just close it.\n- After this, a small colour helper stays inside Claude until you quit Claude.\nNOW: in Claude, click Developer > Enable Main Process Debugger once. You have 60 seconds.\n', 'READY_TO_TICK\n', '[3.00s] debugger port seen: stop clicking\n', 'sampled colour checks: 5 of 5 passed (0 unknown)\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n']) {
      yield { stream: 'stdout', text }
    }
    return { value: { code: a.tickCode ?? 0, signal: null } }
  })
  return { runs, spawns, toasts, statuses, lists }
}
const cmd = (args: string) => ({ command: 'skin', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const OPTS = { options: { toolDir: TOOL } }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const
const tool = (runs: (readonly string[])[]) => runs.filter(a => a.includes(`${TOOL}/skin-auto.mjs`))

test('another plugin already owns /skin: the session still starts and a status line says so', OPTS, async ($, on) => {
  const w = world(on, { registerThrows: true })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect(w.statuses).toContain('Reskin: /skin is taken by another plugin. Disable one of them to use Reskin.')
})

test('/skin dracula switches through the helper when one runs: no tick, no streamed run', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(r.text).toBe('Skin x applied by the colour helper.')
  expect(tool(w.runs).map(a => a.slice(2))).toEqual([['switch', 'dracula']])
  expect(w.spawns).toHaveLength(0)
  expect(tool(w.runs)[0]![0]).toBe('/opt/homebrew/bin/node') // the Node that answered 22+
})

test('/skin dracula with no helper asks for one tick, shows the prompt the moment the tool is ready, then clears it', OPTS, async ($, on) => {
  const w = world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(w.spawns.map(a => a.slice(2))).toEqual([['tick', 'dracula']])
  // The card above the prompt replaced the long tick toast.
  expect(w.toasts.some(t => t.includes('Enable Main Process Debugger'))).toBe(false)
  expect(w.statuses.at(-1)).toBe(undefined) // cleared at the end
  expect(r.text).toContain('Skin dracula applied.')
  expect(r.text).toContain('helper: active until Claude quits')
})

test('a switch that could not tell about the helper never falls back to a tick', OPTS, async ($, on) => {
  const w = world(on, { switch: [5, 'Could not tell whether a colour helper is running (session.json not private (mode 600)). Nothing was changed.\nPORT_STATE: closed\nRESULT: refused'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(w.spawns).toHaveLength(0)
  expect(r.text).toContain('Could not tell')
})

test('switch unconfirmed never falls back to a tick', OPTS, async ($, on) => {
  const w = world(on, { switch: [1, 'switch unconfirmed: the colour helper did not answer within 2 s.\nPORT_STATE: closed\nRESULT: failed'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(w.spawns).toHaveLength(0)
  expect(r.text).toContain('switch unconfirmed')
})

test('--tick and --one-click choose the way; off and remove go through the helper unless --tick', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('dracula --tick'))
  await $.command.run(cmd('dracula --one-click'))
  await $.command.run(cmd('off'))
  await $.command.run(cmd('remove'))
  await $.command.run(cmd('remove --tick'))
  expect(w.spawns.map(a => a.slice(2))).toEqual([['tick', 'dracula'], ['one-click', 'dracula'], ['tick', 'remove']])
  expect(tool(w.runs).map(a => a.slice(2))).toEqual([['switch', 'off'], ['switch', 'remove']])
})

test('a bad or unknown name never reaches the tool', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect((await $.command.run(cmd('../../etc/passwd'))).text).toContain('only letters')
  expect((await $.command.run(cmd('notes'))).text).toContain('No skin called notes')
  expect(tool(w.runs)).toHaveLength(0)
  expect(w.spawns).toHaveLength(0)
})

test('/skin lists the groups with the helper line and the reapply offer; /skin status shows the tool answer', OPTS, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const list = (await $.command.run(cmd(''))).text ?? ''
  expect(list).toContain('Dark only: dracula')
  expect(list).toContain('helper: none')
  expect(list).toContain('Reapply dracula?')
  const st = (await $.command.run(cmd('status'))).text ?? ''
  expect(st).toContain('last skin: dracula')
  expect(st).not.toContain('PORT_STATE')
})

test('/skin check shows the tool\'s own report, never an apply headline; a silent tool says the check did not finish', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const ok = (await $.command.run(cmd('check'))).text ?? ''
  expect(tool(w.runs).at(-1)).toEqual([...tool(w.runs).at(-1)!.slice(0, -1), 'check'])
  expect(ok.split('\n')[0]).toBe('health: pass (skin dracula shows its own colours in every place checked)')
  expect(ok).toContain('debugger: not used (the check needs no port)')
  expect(ok).not.toMatch(/applied|removed|PORT_STATE|RESULT/)
  expect(w.spawns).toHaveLength(0)
})

test('/skin check with no output from the tool: a plain "did not finish", not "Skin check applied"', OPTS, async ($, on) => {
  world(on, { check: [1, ''] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const t = (await $.command.run(cmd('check'))).text ?? ''
  expect(t).toMatch(/^The check did not finish \(exit 1\)/)
  expect(t).not.toMatch(/applied/)
})

test('no tool folder found: says how to set it, runs nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('dracula'))
  expect(r.text).toContain('toolDir')
  expect(tool(w.runs)).toHaveLength(0)
})

test('the tick prompt and disclosure show while the run is still waiting, not after it ends', OPTS, async ($, on) => {
  let finish = () => {}
  const held = new Promise<void>(r => { finish = r })
  const w = world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'], spawn: async function* () {
    yield { stream: 'stdout', text: 'Ready. Before you tick, so nothing surprises you:\n- After this, a small colour helper stays inside Claude until you quit Claude.\nNOW: in Claude, click Developer > Enable Main Process Debugger once.\nREADY_TO_TICK\n' }
    await held
    yield { stream: 'stdout', text: 'debugger: confirmed closed\nPORT_STATE: closed\nRESULT: ok\n' }
    return { value: { code: 0, signal: null } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const running = $.command.run(cmd('dracula'))
  await clock.advance(0)
  // Shown mid-run, on both surfaces that draw the band: title, the paragraph with the menu path, the countdown.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'skin', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'Reskin · Dracula' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Developer › Enable Main Process Debugger' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^To enable the skin, click .*A Chrome inspect tab will open .*within a second or two\. You can then safely close that tab\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /skins stay on until Claude quits or you type \/skin remove/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /only apps on this Mac/ })).toBeUndefined() // the risk line lives in /skin about
    expect(await ui.find({ type: 'Text', text: /How it works: \/skin about/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: '60 s' })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(5_000)
  const later = await $.ui.mount({ plugin: 'skin', surface: 'terminal', ...BAND })
  expect(await later.find({ type: 'Text', text: '55 s' })).toBeDefined()
  await later.unmount()
  await clock.advance(2_000)
  // The card was drawn, so the line under the prompt never repeats it.
  expect(w.statuses.some(t => t?.includes('Enable Main Process Debugger'))).toBe(false)
  finish()
  const r = await running
  expect(r.text).toContain('Skin dracula applied.')
  expect(w.statuses.at(-1)).toBe(undefined)
  // Gone when the run ends.
  const after = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await after.find({ type: 'Text', text: /Reskin/ })).toBeUndefined()
  await after.unmount()
})

test('a run that goes silent is ended at exactly 180 s: the child is told to stop once, the command ends, status cleared', OPTS, async ($, on) => {
  let cancels = 0
  const w = world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'], spawn: async function* (_argv, signal) {
    yield { stream: 'stdout', text: 'READY_TO_TICK\n' }
    // Silent until the stream is ended from outside, which is how the child is stopped.
    await new Promise<void>(r => signal.addEventListener('abort', () => { cancels++; r() }))
    return { value: { code: null, signal: 'SIGTERM' } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  let settled = false
  const running = $.command.run(cmd('dracula')).then(r => { settled = true; return r })
  await clock.advance(0)
  const start = clock.now()
  await clock.set(start + 179_999)
  expect(settled).toBe(false)
  expect(cancels).toBe(0)
  await clock.set(start + 180_000)
  const r = await running
  expect(settled).toBe(true)
  expect(cancels).toBe(1)
  expect(r.text).toContain('exit 4')
  expect(r.text).toContain('Stopped by /skin after 180 s')
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('the card follows the run: the no-Chrome message, the 10 s nudge, then "applying" once the port is seen', OPTS, async ($, on) => {
  let step = () => {}
  let gate = new Promise<void>(r => { step = r })
  const wait = async () => { await gate; gate = new Promise<void>(r => { step = r }) }
  world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'], spawn: async function* () {
    yield { stream: 'stdout', text: 'Ready. Before you tick, so nothing surprises you:\n- Claude will probably show a small message, "Inspector session is active": click its OK button.\nNOW: click.\nREADY_TO_TICK\n' }
    await wait()
    yield { stream: 'stdout', text: 'No debugger yet. Developer is in the top menu bar.\n' }
    await wait()
    yield { stream: 'stdout', text: '[12.00s] debugger port seen: stop clicking\n' }
    await wait()
    yield { stream: 'stdout', text: 'debugger: confirmed closed\nPORT_STATE: closed\nRESULT: ok\n' }
    return { value: { code: 0, signal: null } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const running = $.command.run(cmd('dracula'))
  await clock.advance(0)
  const look = async (text: string | RegExp) => { const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND }); const f = await ui.find({ type: 'Text', text }); await ui.unmount(); return f }
  expect(await look(/Inspector session is active. Click OK/)).toBeDefined()
  expect(await look(/chrome:\/\/inspect/)).toBeUndefined()
  expect(await look(/Later skins/)).toBeUndefined() // this run's disclosure named no helper
  expect(await look(/Still waiting/)).toBeUndefined()
  expect(await look(/No Developer menu\? Turn on Help › Troubleshooting › Enable Developer Mode first/)).toBeDefined() // A1, while waiting
  step(); await clock.advance(0)
  expect(await look(/Still waiting/)).toBeDefined()
  step(); await clock.advance(0)
  expect(await look(/Painting now. Undo any time with \/skin off/)).toBeDefined()
  expect(await look(/Click Developer/)).toBeUndefined()
  expect(await look(/No Developer menu/)).toBeUndefined() // gone once the click came
  step()
  await running
  expect(await look(/Reskin/)).toBeUndefined()
})

test('the card is one full-width paragraph under a title row with the ring and /skin about in the corner', OPTS, async ($, on) => {
  let finish = () => {}
  const done = new Promise<void>(r => { finish = r })
  world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'], spawn: async function* () {
    yield { stream: 'stdout', text: 'Ready. Before you tick, so nothing surprises you:\n- A "chrome://inspect" tab will open in Chrome. Close it.\nNOW: click.\nREADY_TO_TICK\n' }
    await done
    yield { stream: 'stdout', text: 'debugger: confirmed closed\nPORT_STATE: closed\nRESULT: ok\n' }
    return { value: { code: 0, signal: null } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const running = $.command.run(cmd('dracula'))
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'skin-card-halves' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^To enable the skin, click Developer › Enable Main Process Debugger in the top menu bar. / }), 'text').toBeDefined()
  const corner = await ui.find({ key: 'skin-card-corner' })
  expect(corner, 'corner').toBeDefined()
  const ring = await ui.find({ type: 'Svg' })
  expect(ring, 'ring').toBeDefined()
  expect(String(ring!.props.source)).toContain('>60</text>')
  await ui.unmount()
  await clock.advance(3_000)
  const later = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(String((await later.find({ type: 'Svg' }))!.props.source)).toContain('>57</text>')
  await later.unmount()
  finish()
  await running
})

test('the countdown ring empties as time runs out and turns the accent colour for the last 5 s', () => {
  const full = countdownSvg(30, 30).source
  const half = countdownSvg(15, 30).source
  expect(full).toContain('>30</text>')
  expect(half).toContain('>15</text>')
  const dash = (src: string) => Number(/stroke-dasharray="([\d.]+) /.exec(src)?.[1] ?? 0)
  expect(Math.abs(dash(half) - dash(full) / 2)).toBeLessThan(0.1)
  expect(countdownSvg(0, 30).source).not.toContain('stroke-dasharray')
  expect(countdownSvg(4, 30).source).toContain('.n{fill:#d97757}')
  expect(countdownSvg(20, 30).source).not.toContain('.n{fill:#d97757}')
  expect(countdownSvg(12, 30).alt).toBe('12 seconds left to click')
})

test('where no card is drawn, the line under the prompt carries the instruction after 1.5 s, and is cleared at the end', OPTS, async ($, on) => {
  let finish = () => {}
  const held = new Promise<void>(r => { finish = r })
  const w = world(on, { switch: [5, 'No colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'], spawn: async function* () {
    yield { stream: 'stdout', text: 'Ready.\nREADY_TO_TICK\n' }
    await held
    yield { stream: 'stdout', text: 'debugger: confirmed closed\nPORT_STATE: closed\nRESULT: ok\n' }
    return { value: { code: 0, signal: null } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const running = $.command.run(cmd('dracula'))
  await clock.advance(1_400)
  expect(w.statuses.some(t => t?.includes('Enable Main Process Debugger'))).toBe(false)
  await clock.advance(200)
  expect(w.statuses.at(-1)).toContain('click Developer > Enable Main Process Debugger once')
  finish()
  await running
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('the card names the right Chrome case, with no "may", from the tool\'s own disclosure', () => {
  expect(cardFacts('- A "chrome://inspect" tab will open in Chrome. Close it.').where).toBe('chrome-running')
  expect(cardFacts('- Chrome will open with a "chrome://inspect" tab. Close it.').where).toBe('chrome-starts')
  expect(cardFacts('- Claude may start your Chrome to show a "chrome://inspect" tab.').where).toBe('chrome-starts') // an older tool
  expect(cardFacts('- Claude will probably show a small message, "Inspector session is active": click its OK button').where).toBe('message')
  for (const where of ['chrome-running', 'chrome-starts', 'message'] as const) {
    for (const skin of ['dracula', 'remove']) {
      const text = cardParagraph({ skin, where }).join(CARD.menu)
      expect(text).not.toMatch(/\bmay\b/)
      expect(text).not.toContain(EM)
    }
  }
  // No Chrome: the debugger stays on until the message is closed, so the card must not say "almost instantly".
  const noChrome = cardParagraph({ skin: 'dracula', where: 'message' }).join('')
  expect(noChrome).toContain('Click OK')
  expect(noChrome).toContain('as soon as that message is closed')
  expect(noChrome).not.toContain('almost instantly')
  expect(cardParagraph({ skin: 'dracula', where: 'chrome-starts' }).join('')).toContain('Chrome will start')
})

test('/skin about explains the click and its one risk, and runs nothing', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('about'))
  expect(r.text).toContain('the one built-in way in')
  expect(r.text).toContain('other apps on this Mac could also reach Claude')
  expect(r.text.split('\n').length).toBeGreaterThan(8) // short lines, not one block
  expect(r.text).toContain('Nothing from the internet can')
  expect(r.text).toContain('within 22 seconds')
  expect(r.text).not.toContain('46 seconds')
  expect(r.text).toContain('or a clear warning')
  expect(r.text).toContain('with no click until Claude quits')
  expect(r.text).toContain('changes no Claude files')
  expect(r.text).not.toContain(EM)
  expect(tool(w.runs)).toHaveLength(0)
  expect(w.spawns).toHaveLength(0)
})

test('the card is the signed-off paragraph: enable, menu path, Chrome tab, a second or two, off, stays until quit', () => {
  const [before, after] = cardParagraph({ skin: 'dracula', where: 'chrome-running' })
  expect(`${before}${CARD.menu}${after}`).toBe('To enable the skin, click Developer › Enable Main Process Debugger in the top menu bar. A Chrome inspect tab will open and the skin will be applied automatically within a second or two. You can then safely close that tab. Reskin turns the debugger off again almost instantly, and skins stay on until Claude quits or you type /skin remove.')
  const removing = cardParagraph({ skin: 'remove', where: 'chrome-running' }).join(CARD.menu)
  expect(removing).toMatch(/^To remove the skin/)
  expect(removing).not.toContain('stay on')
  // The risk facts moved to /skin about.
  expect(ABOUT).toContain('other apps on this Mac could also reach Claude')
  expect(ABOUT).toContain('stays on until it is closed with OK')
  expect(displayName('tokyo-night-auto')).toBe('Tokyo Night Auto')
  expect(displayName('dracula')).toBe('Dracula')
})

test('a click wait that runs out says so in one short line, and never hides an open port', () => {
  const out = `- After this, a small colour helper stays inside Claude until you quit Claude.
NOW: click Developer > Enable Main Process Debugger once. You have 30 seconds.
No debugger yet. Developer is in the top menu bar, next to Window (not under Help).
debugger: confirmed closed (it never opened)
helper: unchanged (nothing was applied)
WARNING: Time is up (30 s) and nothing was applied. Do not tick now. If you already did, the backup guardian closes the debugger within about 30 s. To try again: run the same command.
PORT_STATE: closed
RESULT: failed`
  expect(summary('dracula', 4, out, '')).toBe(TIME_UP)
  const open = summary('dracula', 4, out.replace('PORT_STATE: closed', 'PORT_STATE: open'), '')
  expect(open.split('\n')[0]).toBe(TIME_UP)
  expect(open).toContain('PORT 9229 IS NOT CONFIRMED CLOSED')
})

describe('typeahead for /skin', () => {
  const SKINS = ['catppuccin', 'classic', 'dracula', 'night-owl', 'tokyo-night']
  const at = (text: string, skins = SKINS) => {
    const start = text.search(/\S+$/)
    return skinSuggestions(text, start, text.length, skins).map(s => s.text)
  }
  test('first letters of a skin name complete it; names that start with them come first', () => {
    expect(at('/skin d')).toEqual(['dracula'])
    expect(at('/skin c')).toEqual(['catppuccin', 'classic', 'check', 'dracula'])
    expect(at('/skin cl')).toEqual(['classic'])
    expect(at('/skin night')).toEqual(['night-owl', 'tokyo-night'])
    expect(at('/SKIN DR')).toEqual(['dracula'])
  })
  test('verbs complete too; a finished word or a stranger gets nothing', () => {
    expect(at('/skin re')).toEqual(['remove'])
    expect(at('/skin st')).toEqual(['status', 'list'])
    expect(at('/skin dracula')).toEqual([])
    expect(at('/skin zzz')).toEqual([])
  })
  test('flags complete after a name or on their own; other commands and later words are left alone', () => {
    expect(at('/skin --o')).toEqual(['--one-click'])
    expect(at('/skin nord --t')).toEqual(['--tick'])
    expect(at('/skins d')).toEqual([])
    expect(at('/other d')).toEqual([])
    expect(at('hello /skin d')).toEqual([])
    expect(at('/skin nord d')).toEqual([])
  })
  test('Never mid-word, never a draft parse() refuses, never a bad file name', () => {
    const mid = (text: string, cursor: number) => {
      const start = text.slice(0, cursor).search(/\S+$/)
      return skinSuggestions(text, start, cursor, SKINS).map(s => s.text)
    }
    expect(mid('/skin dracula', 8)).toEqual([])
    expect(mid('/skin st --tick', 8)).toEqual([])
    expect(mid('/skin d --tick', 7)).toEqual(['dracula'])
    expect(mid('/skin --o --tick nord', 9)).toEqual([])
    expect(at('/skin status --t')).toEqual([])
    expect(at('/skin --t')).toEqual(['--tick'])
    expect(at('/skin b', ['bad name', 'bad--name', 'b..', 'blue'])).toEqual(['blue', 'about'])
  })
  test('at most twelve rows', () => {
    const many = Array.from({ length: 30 }, (_, i) => `a${i}`)
    expect(at('/skin a', many)).toHaveLength(12)
  })
})

test('the hook offers the preset names from the tool folder, and nothing outside /skin', OPTS, async ($, on) => {
  const w = world(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const both = await Promise.all([1, 2, 3].map(() => $.prompt.autocomplete({ text: '/skin d', cursor: 7, token: 'd', start: 6 })))
  expect(both.map(x => x.suggestions.map(s => s.text))).toEqual([['dracula'], ['dracula'], ['dracula']])
  expect(w.lists.filter(p => p.endsWith('/presets'))).toHaveLength(1) // three keystrokes at once share one folder read
  const r = await $.prompt.autocomplete({ text: '/skin d', cursor: 7, token: 'd', start: 6 })
  expect(r.suggestions.map(s => s.text)).toEqual(['dracula'])
  const o = await $.prompt.autocomplete({ text: '/skin o', cursor: 7, token: 'o', start: 6 })
  expect(o.suggestions.map(s => s.text)).toEqual(['one-light', 'off', 'remove', 'log', 'about'])
  const none = await $.prompt.autocomplete({ text: 'hi d', cursor: 4, token: 'd', start: 3 })
  expect(none.suggestions).toEqual([])
})

test('A2 end to end: /skin list says light, dark, or that the Mac appearance could not be read (never a guess)', OPTS, async ($, on) => {
  const answers: Answers = {}
  world(on, answers)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const said = async (defaults?: [number, string, string]) => {
    answers.defaults = defaults
    return (await $.command.run(cmd('list'))).text ?? ''
  }
  expect(await said()).toContain('Your Mac is in dark mode')
  expect(await said([1, '', 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist'])).toContain('Your Mac is in light mode')
  const odd = await said([9, '', 'something else went wrong'])
  expect(odd).toContain('I could not read your Mac\'s appearance')
  expect(odd).not.toContain('Your Mac is in')
  expect(odd).toContain(DEV_MODE)
})

describe('release switch (tick-only release)', () => {
  test('release.json decides one-click: absent keeps it, present needs "oneClick": true', () => {
    expect(oneClickOf(null)).toBe(true)
    expect(oneClickOf('{ "oneClick": false }')).toBe(false)
    expect(oneClickOf('{}')).toBe(false)
    expect(oneClickOf('not json')).toBe(false)
    expect(oneClickOf('{ "oneClick": true }')).toBe(true)
  })
  test('a tick-only release never offers --one-click, in the typeahead or the hint', () => {
    const t = '/skin nord --'
    expect(skinSuggestions(t, t.length - 2, t.length, ['nord'], false).map(s => s.text)).toEqual(['--tick'])
    expect(skinSuggestions(t, t.length - 2, t.length, ['nord'], true).map(s => s.text)).toContain('--one-click')
    expect(argumentHintOf(false)).not.toContain('one-click')
    expect(argumentHintOf(true)).toContain('--one-click')
  })
})
