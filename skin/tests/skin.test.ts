import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, Plugin, RenderElement } from 'claude-code'

import { FONT_LABELS, FONT_WEIGHTS, SECTIONS, shortStatus, allPicks, defaultPicks, lookInfoOf, lookSummary, noLookText, picksOf, resultLineOf, setArgs, sizeOptions, weightOptions, withFont, fontOptions } from '../hooks/fonts'
import { ABOUT, CARD, DEV_MODE, TIME_UP, START_DONE, START_FACTS, cardFacts, cardParagraph, planOf, startResult, startStatus, startSummary, countdownSvg, displayName, listText, modeOf, nodeCandidates, nodeMajorOk, noHelper, parse, skinSuggestions, oneClickOf, fontsOf, FONT_NAMES, argumentHintOf, summary, toolDirCandidates } from '../hooks/logic'

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
  test('type on and type off are their own command; anything else after type is refused', () => {
    expect(parse('type on')).toEqual({ kind: 'type', on: true })
    expect(parse('TYPE OFF')).toEqual({ kind: 'type', on: false })
    for (const bad of ['type', 'type bold', 'type on off', 'type on --one-click', 'type off --tick']) expect(parse(bad).kind).toBe('bad')
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
type Answers = { look?: (argv: readonly string[]) => [number, string]; registerThrows?: boolean; defaults?: [number, string, string]; switch?: [number, string]; status?: [number, string]; check?: [number, string]; type?: [number, string]; tick?: string[]; tickCode?: number; spawn?: (argv: readonly string[], signal: AbortSignal) => AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { value: { code: number | null; signal: string | null } }> }
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
    if (e.argv[2] === 'type') {
      runs.push(e.argv)
      const [code, text] = a.type ?? [0, 'Type on: project headers with activity colours (1 of 1 Claude page(s)).\n(as the colour helper reports; no debugger checked it)\ndebugger: not used (switching needs no port)\nhelper: active until Claude quits (Claude 4.4212.0)\nPORT_STATE: closed\nRESULT: ok']
      if (text) yield { stream: 'stdout', text }
      return { value: { code, signal: null } }
    }
    if (e.argv[2] === 'look') {
      runs.push(e.argv)
      const [code, text] = a.look ? a.look(e.argv) : [9, 'unexpected']
      if (text) yield { stream: 'stdout', text }
      return { value: { code, signal: null } }
    }
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

test('/skin type on runs the tool\'s type verb through the helper and shows its report; no tick', OPTS, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const t = (await $.command.run(cmd('type on'))).text ?? ''
  expect(tool(w.runs).at(-1)!.slice(-2)).toEqual(['type', 'on'])
  expect(t.split('\n')[0]).toMatch(/^Type on: project headers with activity colours/)
  expect(t).not.toMatch(/PORT_STATE|RESULT/)
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

describe('fonts (3 Nov 2026)', () => {
  test('/skin font takes one name, off or list, and no options; the tool checks the name itself', () => {
    expect(parse('font inter')).toEqual({ kind: 'font', name: 'inter' })
    expect(parse(' FONT Zen-Maru ')).toEqual({ kind: 'font', name: 'zen-maru' })
    expect(parse('font off')).toEqual({ kind: 'font', name: 'off' })
    expect(parse('font list')).toEqual({ kind: 'font', name: 'list' })
    expect(parse('font IBM Plex Sans')).toEqual({ kind: 'font', name: 'ibm-plex-sans' })
    expect(parse('font IBM+Plex+Sans')).toEqual({ kind: 'font', name: 'ibm-plex-sans' })
    for (const bad of ['font', 'font ../x', 'font a.css', 'font off --tick', 'font list --tick', 'font --one-click inter']) expect(parse(bad).kind).toBe('bad')
    expect((parse('font a.css') as { why: string }).why).toContain('inter-tight, literata, plex')
  })
  test('release.json decides fonts: absent keeps them, present needs "font": true', () => {
    expect(fontsOf(null)).toBe(true)
    expect(fontsOf('{ "oneClick": false }')).toBe(false)
    expect(fontsOf('not json')).toBe(false)
    expect(fontsOf('{ "oneClick": false, "font": true }')).toBe(true)
    expect(argumentHintOf(false, true)).toContain('font <name>|off|list')
    expect(argumentHintOf(false, false)).not.toContain('font')
  })
  test('the list names the font commands only where fonts are shipped; about explains them and the menu override', () => {
    const presets = [{ name: 'nord', mode: 'auto' as const }]
    expect(listText(presets, 'dark', true)).toContain('/skin font list')
    expect(listText(presets, 'dark')).not.toContain('/skin font')
    expect(ABOUT).toContain('/skin font <name>')
    expect(ABOUT).toContain("Claude's own font menu has no effect")
    expect(ABOUT.includes(String.fromCharCode(8212))).toBe(false)
  })
  test('typeahead after font offers font names, off and list where fonts are shipped, never skin names', () => {
    const at = (draft: string, fonts = true) => skinSuggestions(draft, draft.lastIndexOf(' ') + 1, draft.length, ['nord', 'noir'], false, fonts).map(r => r.text)
    expect(at('/skin font n')).toEqual(['noto', 'inter-tight', 'zen-maru'])
    expect(at('/skin font l')).toEqual(['literata', 'lato', 'list', 'plex'])
    expect(at('/skin font o')).toEqual(['off', 'noto', 'roboto', 'lato'])
    expect(at('/skin font n', false)).toEqual([])
    expect(at('/skin font noto')).toEqual([])
    expect(FONT_NAMES.length).toBe(7)
  })
  test('the restore line after a tick always shows, whether it worked, partly worked or got no answer', () => {
    const base = 'sampled colour checks: 5 of 5 passed (0 unknown)\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n'
    for (const r of ['restore: brought back the project headers and the font inter (no second tick; as the colour helper reports)', 'restore: could not bring back the font inter (no answer yet; it may still finish, /skin check shows what is on): the skin itself is on. Run /skin type on or /skin font <name> to try again.']) {
      expect(summary('nord', 0, `${r}\n${base}`, '')).toContain(r)
    }
  })
})


describe('the one-line command (3 Nov 2026)', () => {
  test('a skin with parts, or font and type together, is one line; single parts keep their own kinds', () => {
    expect(parse('dracula font plex type on')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'font', 'plex', 'type', 'on'], font: 'plex', type: true, via: 'auto' })
    expect(parse('dracula type off font IBM Plex Sans')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'type', 'off', 'font', 'ibm', 'plex', 'sans'], font: 'ibm-plex-sans', type: false, via: 'auto' })
    expect(parse('font off type off')).toEqual({ kind: 'set', skin: null, words: ['font', 'off', 'type', 'off'], font: 'off', type: false, via: 'auto' })
    expect(parse('nord type on --tick')).toEqual({ kind: 'set', skin: 'nord', words: ['nord', 'type', 'on'], type: true, via: 'tick' })
    expect(parse('off font off')).toEqual({ kind: 'set', skin: 'off', words: ['off', 'font', 'off'], font: 'off', via: 'auto' })
    expect(parse('font plex')).toEqual({ kind: 'font', name: 'plex' })
    // Sizes (3 Nov 2026): the size rides along as the font key the tool checks, in either part order and with full names.
    expect(parse('font plex 16')).toEqual({ kind: 'font', name: 'plex-16' })
    expect(parse('font ibm plex sans 16')).toEqual({ kind: 'font', name: 'ibm-plex-sans-16' })
    expect(parse('dracula font plex 14')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'font', 'plex', '14'], font: 'plex-14', via: 'auto' })
    expect(parse('dracula type on font zen maru 18 --tick')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'type', 'on', 'font', 'zen', 'maru', '18'], type: true, font: 'zen-maru-18', via: 'tick' })
    expect(parse('nord font inter 13 type off')).toEqual({ kind: 'set', skin: 'nord', words: ['nord', 'font', 'inter', '13', 'type', 'off'], font: 'inter-13', type: false, via: 'auto' })
    expect(parse('font inter-tight 17')).toEqual({ kind: 'font', name: 'inter-tight-17' })
    // plex+16 and plex_16 are refused on every route (alone, in a line, with --tick); + and _ still join family names.
    for (const line of ['font plex+16', 'font plex_16', 'dracula font plex+16', 'dracula font plex_16 type on', 'dracula font plex+16 --tick', 'font ibm+plex+sans+16']) {
      const p = parse(line); expect(p.kind === 'bad' ? p.why : `not refused: ${p.kind}`).toContain('Put a space before the size')
    }
    expect(parse('font ibm+plex+sans 16')).toEqual({ kind: 'font', name: 'ibm-plex-sans-16' })
    expect(parse('dracula font ibm_plex_sans --tick')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'font', 'ibm_plex_sans'], font: 'ibm-plex-sans', via: 'tick' })
    // Malformed sizes and font off with a size are passed on: the tool refuses them before anything changes.
    expect(parse('dracula font off 14')).toEqual({ kind: 'set', skin: 'dracula', words: ['dracula', 'font', 'off', '14'], font: 'off-14', via: 'auto' })
    expect(parse('type on')).toEqual({ kind: 'type', on: true })
    expect(parse('dracula')).toEqual({ kind: 'apply', name: 'dracula', via: 'auto' })
    expect(parse('off --tick')).toEqual({ kind: 'off', via: 'tick' })
    expect(parse('remove --tick')).toEqual({ kind: 'remove', via: 'tick' })
  })
  test('malformed lines are refused here; the tool checks names and the rest', () => {
    const why = (line: string) => { const p = parse(line); return p.kind === 'bad' ? p.why : `not refused: ${p.kind}` }
    expect(why('dracula font plex font lato')).toContain('font is given twice')
    expect(why('dracula type on type off')).toContain('type is given twice')
    expect(why('dracula type maybe')).toContain('type takes on or off')
    expect(why('dracula font')).toContain('font needs a name')
    expect(why('dracula font plex banana type on x')).toContain('I did not understand x')
    expect(why('dracula type on --one-click')).toContain('--tick only')
    expect(why('off type on --tick')).toContain('--tick goes with a skin name')
    expect(parse('font plex type on --tick')).toEqual({ kind: 'start', font: 'plex', type: true }) // the no-skin tick (4 Nov 2026)
    expect(why('Dra.cula type on')).toContain('letters, digits and hyphens')
    expect(why('dracula font a.css')).toContain('Not a font name')
  })
  test('the tick card shows the skin, not a --want option; part: lines survive the summary', () => {
    const base = 'sampled colour checks: 4 of 4 passed (0 unknown)\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n'
    const r = 'part: font plex: done (no second tick; as the colour helper reports)'
    expect(summary('nord', 0, `${r}\n${base}`, '')).toContain(r)
  })
  test('about explains the one line', () => {
    expect(ABOUT).toContain('/skin dracula font plex type on')
  })
})

// ---- the fonts card (4 Nov 2026) ----
describe('fonts card helpers', () => {
  test('/skin fonts opens the card, /skin fonts off closes it; nothing else after fonts', () => {
    expect(parse('fonts')).toEqual({ kind: 'fonts', show: true })
    expect(parse('FONTS off')).toEqual({ kind: 'fonts', show: false })
    for (const bad of ['fonts on', 'fonts off --tick', 'fonts off x', 'fonts --one-click']) expect(parse(bad).kind).toBe('bad')
  })
  test('the LOOK line is read strictly; anything odd is no look', () => {
    expect(lookInfoOf('x\nLOOK: {"helper":"active","look":["chat.font.literata","rows.size.13"],"type":"on","parts":[]}\nRESULT: ok')).toEqual({ helper: 'active', look: ['chat.font.literata', 'rows.size.13'], type: 'on' })
    expect(lookInfoOf('LOOK: {"helper":"none"}')).toEqual({ helper: 'none', look: null, type: 'unknown' })
    expect(lookInfoOf('LOOK: {"helper":"active","look":["chat.font.<b>"]}')?.look).toBe(null)
    expect(lookInfoOf('LOOK: not json')).toBe(null)
    expect(lookInfoOf('no line')).toBe(null)
  })
  test('choices per part: fonts, sizes and only the weights the shown font has; a font pick drops a weight it lacks', () => {
    expect(SECTIONS.map(s => s.id)).toEqual(['all', 'chat', 'rows', 'headers', 'ui'])
    expect(fontOptions('all')[0]).toEqual({ value: 'claude', label: "Claude's own" })
    expect(setArgs('all', { font: 'noto', size: 'claude', weight: 'claude' })).toEqual(['look', 'set', 'all', 'font=noto'])
    expect(picksOf(['ui.font.plex', 'chat.font.literata'], 'all')).toEqual({ font: 'plex', size: 'claude', weight: 'claude' })
    expect(sizeOptions('all').map(o => o.value)).toEqual(['claude'])
    expect(fontOptions('chat')[0]).toEqual({ value: 'same', label: 'Same as everything else' })
    expect(fontOptions('ui')[0]).toEqual({ value: 'claude', label: "Claude's own" })
    expect(fontOptions('chat').length).toBe(1 + Object.keys(FONT_LABELS).length)
    expect(sizeOptions('rows').map(o => o.value)).toEqual(['claude', '12', '13', '14', '15'])
    expect(sizeOptions('ui').map(o => o.value)).toEqual(['claude'])
    expect(weightOptions('chat', 'lato', 'claude').map(o => o.value)).toEqual(['claude', '300', '400'])
    expect(weightOptions('chat', 'same', 'zen-maru').map(o => o.value)).toEqual(['claude', '300', '400', '500'], 'same as everything else follows the ui font')
    expect(weightOptions('headers', 'same', 'claude').map(o => o.value)).toEqual(['claude', '400', '500', '600'])
    expect(withFont('chat', { font: 'plex', size: '16', weight: '500' }, 'lato', 'claude')).toEqual({ font: 'lato', size: '16', weight: 'claude' })
    expect(withFont('chat', { font: 'plex', size: '16', weight: '300' }, 'lato', 'claude')).toEqual({ font: 'lato', size: '16', weight: '300' })
    expect(FONT_WEIGHTS.lato).toEqual([300, 400])
  })
  test('the look -> choices, the argv for one part, and the summary in the tool\'s words', () => {
    const look = ['ui.font.plex', 'chat.font.literata', 'chat.size.16', 'chat.weight.300', 'headers.weight.600']
    expect(picksOf(look, 'chat')).toEqual({ font: 'literata', size: '16', weight: '300' })
    expect(picksOf(look, 'rows')).toEqual(defaultPicks('rows'))
    expect(allPicks(look).ui).toEqual({ font: 'plex', size: 'claude', weight: 'claude' })
    expect(setArgs('chat', { font: 'literata', size: '16', weight: '300' })).toEqual(['look', 'set', 'chat', 'font=literata', 'size=16', 'weight=300'])
    expect(setArgs('ui', { font: 'plex', size: 'claude', weight: 'claude' })).toEqual(['look', 'set', 'ui', 'font=plex'])
    expect(lookSummary(look)).toEqual(['Chat text: Literata, 16px, light 300', 'Project headers: the same font as everything else, semibold 600', 'Everything else: IBM Plex Sans'])
    expect(resultLineOf('LOOK: {}\nChat text done. Fonts now: x.\n(as the colour helper reports; no debugger checked it)\nPORT_STATE: closed\nRESULT: ok', '', 0)).toBe('Chat text done. Fonts now: x.')
    expect(resultLineOf('', 'boom\n', 1)).toBe('boom')
    expect(noLookText('none')).toMatch(/--tick/)
    expect(noLookText('old')).toMatch(/Quit and reopen Claude/)
  })
})

const FONTS_WORLD = (on: On, a: Answers) => {
  const w = world(on, a)
  on('fs.exists', ($, e) => ({ value: false })) // no release.json: the owner's copy, fonts shipped
  return w
}
const LOOK_SHOW = 'LOOK: {"helper":"active","look":["chat.size.16"],"type":"on","parts":[]}\nfonts: Chat text: the same font as everything else, 16px\ndebugger: not used (switching needs no port)\nPORT_STATE: closed\nRESULT: ok'
test('/skin fonts draws the card with four dropdowns; picks stay in the card until Apply, which sends one part through the helper', OPTS, async ($, on) => {
  const sent: (readonly string[])[] = []
  const w = FONTS_WORLD(on, { look: (argv) => {
    sent.push(argv.slice(2))
    if (argv[3] === 'show') return [0, LOOK_SHOW]
    return [0, 'LOOK: {"helper":"active","look":["chat.size.16","rows.font.roboto","rows.size.13"],"type":"on","parts":[]}\nSidebar rows done. Fonts now: Chat text: the same font as everything else, 16px; Sidebar rows: Roboto, 13px.\n(as the colour helper reports; no debugger checked it)\ndebugger: not used (switching needs no port)\nPORT_STATE: closed\nRESULT: ok']
  } })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('fonts'))
  expect(r.text).toMatch(/The fonts card is open above the message box/)
  expect(r.text).toMatch(/All parts sets one font everywhere/) // the help lives in the reply, not the card
  expect(sent).toEqual([['look', 'show']])
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  // One slim row: a short label, no title, no help paragraph, no summary list.
  expect(await ui.find({ type: 'Text', text: 'Fonts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Reskin · fonts|Weight changes|Chat text: / })).toBeUndefined()
  // The card opens on All parts: part and font only.
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(2)
  await ui.select({ key: 'skin-fonts-section', value: 'chat' })
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(4)
  await ui.select({ key: 'skin-fonts-section', value: 'rows' })
  await ui.select({ key: 'skin-fonts-font', value: 'roboto' })
  await ui.select({ key: 'skin-fonts-size', value: '13' })
  expect(sent).toHaveLength(1) // picking sends nothing
  await ui.press({ key: 'skin-fonts-apply' })
  expect(sent.at(-1)).toEqual(['look', 'set', 'rows', 'font=roboto', 'size=13', 'weight=claude'])
  await ui.unmount()
  const after = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await after.find({ type: 'Text', text: 'Applied' })).toBeDefined()
  // Claude's own puts the shown part back: font same, Claude's size and weight.
  await after.press({ key: 'skin-fonts-reset' })
  expect(sent.at(-1)).toEqual(['look', 'set', 'rows', 'font=same', 'size=claude', 'weight=claude'])
  await after.press({ key: 'skin-fonts-close' })
  await after.unmount()
  const gone = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await gone.find({ type: 'Text', text: 'Fonts' })).toBeUndefined()
  await gone.unmount()
  expect(w.spawns).toHaveLength(0) // never a tick
})

test('/skin fonts with no colour helper says how to start one and offers no Apply; everything else keeps a font only', OPTS, async ($, on) => {
  FONTS_WORLD(on, { look: () => [5, 'LOOK: {"helper":"none"}\nNo colour helper is running in this Claude (no helper session), so nothing was changed.\nPORT_STATE: closed\nRESULT: refused'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('fonts'))
  expect(r.text).toBe(noLookText('none'))
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: noLookText('none') })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'skin-fonts-apply' } as never)).toBeUndefined()
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  await ui.unmount()
  expect((await $.command.run(cmd('fonts off'))).text).toBe('Fonts card closed.')
})

test('two Apply presses at once start one tool run; the card is never left busy', OPTS, async ($, on) => {
  const sent: (readonly string[])[] = []
  FONTS_WORLD(on, { look: (argv) => { sent.push(argv.slice(2)); return [0, argv[3] === 'show' ? LOOK_SHOW : 'LOOK: {"helper":"active","look":["chat.size.16"],"type":"on","parts":[]}\nChat text done.\nPORT_STATE: closed\nRESULT: ok'] } })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('fonts'))
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  await Promise.all([ui.press({ key: 'skin-fonts-apply' }), ui.press({ key: 'skin-fonts-apply' })])
  await ui.unmount()
  expect(sent.filter(a => a[1] === 'set')).toHaveLength(1)
  // A /skin run while nothing runs is not blocked by a stuck guard.
  expect((await $.command.run(cmd('fonts'))).text).toMatch(/fonts card is open/)
  const after = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await after.find({ type: 'Button', text: 'Apply' } as never)).toBeDefined()
  await after.unmount()
})

test('All parts sets one font for the whole app in one Apply, and shows what the helper proved for every part', OPTS, async ($, on) => {
  const sent: (readonly string[])[] = []
  FONTS_WORLD(on, { look: (argv) => {
    sent.push(argv.slice(2))
    if (argv[3] === 'show') return [0, 'LOOK: {"helper":"active","look":["chat.font.literata","chat.size.16","rows.font.roboto"],"type":"on","parts":[]}\nRESULT: ok']
    return [0, 'LOOK: {"helper":"active","look":["ui.font.noto","chat.size.16"],"type":"on","parts":[]}\nAll parts done. Fonts now: x.\nPORT_STATE: closed\nRESULT: ok']
  } })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('fonts'))
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  await ui.select({ key: 'skin-fonts-font', value: 'noto' })
  await ui.press({ key: 'skin-fonts-apply' })
  expect(sent.at(-1)).toEqual(['look', 'set', 'all', 'font=noto'])
  await ui.unmount()
  const after = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await after.find({ type: 'Text', text: 'Applied' })).toBeDefined()
  await after.select({ key: 'skin-fonts-section', value: 'rows' })
  await after.press({ key: 'skin-fonts-apply' })
  expect(sent.at(-1)).toEqual(['look', 'set', 'rows', 'font=same', 'size=claude', 'weight=claude'], 'rows now shows the proved state: its own font is gone')
  await after.unmount()
})

test('the card status is a word when it worked and one short reason when it did not', () => {
  expect(shortStatus('ok', 'Chat text done. Fonts now: a long list.', false)).toBe('Applied')
  expect(shortStatus('ok', 'x', true)).toBe('Reset')
  expect(shortStatus('ok', 'Chat text sent, but what is on now is not proven (something else changed the fonts meanwhile): run /skin check, or open /skin fonts again.', false, false)).toMatch(/not proven/)
  expect(shortStatus('refused', 'Lato has no weight 500 (it has 300, 400). Nothing was changed.', false)).toBe('Lato has no weight 500 (it has 300, 400).')
  expect(shortStatus('failed', 'x'.repeat(300), false).length).toBe(118)
})

// An opener another band mod draws (the owner's usage-line hosts one): pressing it opens the card, once, and never resets it.
const OPENER: Plugin = { name: 'bar-host', register: (on) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => { const { Button } = $.ui.resolve(e); return Button({ key: 'skin-fonts-open', label: 'Fonts', plain: true, dimColor: true, onPress: () => {} }) })
} }
test('a Fonts button in another mod toggles the card (no ✕ then); opened by /skin fonts it has a ✕ that gives the way back', { ...OPTS, plugins: [OPENER] }, async ($, on) => {
  const sent: (readonly string[])[] = []
  const w = FONTS_WORLD(on, { look: (argv) => { sent.push(argv.slice(2)); return [0, LOOK_SHOW] } })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const host = await $.ui.mount({ plugin: 'bar-host', surface: 'desktop', ...BAND })
  await host.press({ key: 'skin-fonts-open' })
  await host.unmount()
  expect(sent).toEqual([['look', 'show']])
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Fonts' })).toBeDefined()
  expect(await ui.find({ key: 'skin-fonts-close' })).toBeUndefined() // the opener closes it
  await ui.unmount()
  const host2 = await $.ui.mount({ plugin: 'bar-host', surface: 'desktop', ...BAND })
  await host2.press({ key: 'skin-fonts-open' })
  await host2.unmount()
  expect(sent).toHaveLength(1) // a second press closes it: no second run
  const closed = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await closed.find({ key: 'skin-fonts-apply' })).toBeUndefined()
  await closed.unmount()
  expect((await $.command.run(cmd('fonts'))).text).toMatch(/fonts card is open/)
  const typed = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await typed.find({ key: 'skin-fonts-close' })).toBeDefined()
  await typed.press({ key: 'skin-fonts-close' })
  await typed.unmount()
  expect(w.toasts.some(t => /\/skin fonts brings them back/.test(t))).toBe(true)
})


// ---- the no-skin tick (4 Nov 2026, design v2 to v4) ----
const PLAN_LINE = 'PLAN: {"skin":null,"headers":true,"look":"plex-14","parts":[{"part":"look","value":"plex-14","asked":true},{"part":"headers","value":true,"asked":false}],"words":"sets the fonts (Everything else: IBM Plex Sans; Chat text: the same font as everything else, 14px) and turns on the project headers, as last time"}'
const START_READY = 'Ready. Before you tick, so nothing surprises you:\n- This starts the colour helper only. No skin is put on. Any Reskin skin is taken off. A Claude page may reload once.\n- A "chrome://inspect" tab will open in Chrome. Close it.\n- After this, a small colour helper stays inside Claude until you quit Claude. It can only switch between Reskin\'s own presets, fonts and headers, turn them off, or remove itself; the next change needs no tick.\nNOW: click.\n'
describe('no-skin tick', () => {
  test('routes: fonts, type on, a font with a size, and font with type, each with --tick', () => {
    expect(parse('fonts --tick')).toEqual({ kind: 'start', fonts: true })
    expect(parse('--tick fonts')).toEqual({ kind: 'start', fonts: true })
    expect(parse('type on --tick')).toEqual({ kind: 'start', type: true })
    expect(parse('font plex 14 --tick')).toEqual({ kind: 'start', font: 'plex-14' })
    expect(parse('font IBM Plex Sans --tick')).toEqual({ kind: 'start', font: 'ibm-plex-sans' })
    expect(parse('font plex type on --tick')).toEqual({ kind: 'start', font: 'plex', type: true })
    expect(parse('type on font plex 14 --tick')).toEqual({ kind: 'start', font: 'plex-14', type: true })
    expect(parse('font off type on --tick')).toEqual({ kind: 'start', font: 'off', type: true })
    expect(parse('font plex type off --tick')).toEqual({ kind: 'start', font: 'plex', type: false })
  })
  test('refusals: nothing to turn off, one-click, and /skin off --tick keeps meaning remove', () => {
    for (const bad of ['type off --tick', 'font off --tick', 'font off type off --tick', 'type off font off --tick', 'fonts off --tick']) {
      const r = parse(bad)
      expect(r.kind, bad).toBe('bad')
      expect(r.kind === 'bad' ? r.why : '', bad).toMatch(/Nothing to turn off|fonts --tick/)
    }
    for (const bad of ['type on --one-click', 'font plex --one-click', 'fonts --one-click', 'font plex type on --one-click', 'type on --tick --one-click']) expect(parse(bad).kind, bad).toBe('bad')
    expect(parse('off --tick')).toEqual({ kind: 'off', via: 'tick' })
    expect(parse('off type on --tick').kind).toBe('bad')
    expect(parse('font list --tick').kind).toBe('bad')
  })
  test('the PLAN line: well-formed plain words only; parts none is an empty string; anything odd is no plan', () => {
    expect(planOf(`x\n${PLAN_LINE}\nREADY_TO_TICK`)).toMatch(/^sets the fonts \(Everything else: IBM Plex Sans; Chat text: .*14px\) and turns on the project headers, as last time$/)
    expect(planOf('PLAN: {"skin":null,"headers":null,"look":null,"parts":[],"words":""}')).toBe('')
    expect(planOf('PLAN: {"skin":"dracula","parts":[],"words":""}')).toBe(null)
    expect(planOf('PLAN: not json')).toBe(null)
    expect(planOf('no plan here')).toBe(null)
    expect(planOf(`PLAN: {"skin":null,"parts":[1],"words":"a\\u0007b"}`)).toBe('a b')
  })
  test('card text: start, then the fixed disclosure, then the plan; the fallback line says the same', () => {
    for (const where of ['chrome-running', 'chrome-starts', 'message'] as const) {
      const text = cardParagraph({ skin: 'off', where, start: true, plan: 'turns on the project headers' }).join(CARD.menu)
      expect(text).toMatch(/^To start the colour helper, click Developer › Enable Main Process Debugger in the top menu bar\./)
      expect(text).toContain(START_FACTS)
      expect(text).toContain(`${START_FACTS} It also turns on the project headers.`)
      expect(text).not.toMatch(/skin will be applied|remove the skin|skins stay on/)
    }
    expect(cardParagraph({ skin: 'off', where: 'message', start: true, plan: '' }).join('')).toMatch(/A Claude page may reload once\.$/)
    expect(START_FACTS).toBe('No skin is put on. Any Reskin skin is taken off. A Claude page may reload once.')
    expect(startStatus('turns on the project headers', 60)).toBe(`Reskin: to start the colour helper, click Developer > Enable Main Process Debugger once (60 s). ${START_FACTS} It also turns on the project headers.`)
    expect(startStatus('', 60).endsWith('reload once.')).toBe(true)
    expect(cardFacts(`${START_READY}${PLAN_LINE}`)).toMatchObject({ start: true, helper: true, where: 'chrome-running' })
    expect(cardFacts(START_READY).start).toBe(true)
    expect(cardFacts(START_READY).plan).toBe('')
    expect(CARD.applyingStart).not.toMatch(/Paint/)
  })
  test('the answer: success only on RESULT ok; a failure says the helper and done parts may be on', () => {
    const ok = 'part: type on: done (no second tick; as the colour helper reports) [remembered]\nsampled colour checks: not applicable (no skin put on); no skin on: confirmed (as the colour helper reports; no debugger checked it)\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n'
    const a = startSummary(0, ok, '')
    expect(a.split('\n')[0]).toBe(START_DONE)
    expect(a).toContain('part: type on: done')
    expect(a).not.toContain('Skin removed')
    const bad = 'part: font plex: done, but not proven now: run /skin check\npart: the colour helper is on, but type on did not complete; what is on now is not proven (run /skin check). No skin was put on.\nsampled colour checks: not applicable (no skin put on); no skin on: confirmed\ndebugger: confirmed closed\nhelper: active\nPORT_STATE: closed\nRESULT: failed\n'
    const b = startSummary(1, bad, '')
    expect(b).not.toContain(START_DONE)
    expect(b).toMatch(/^The colour helper start did not finish \(exit 1\)\. The helper and any part reported done may already be on\./)
    expect(b).toContain('part: font plex: done, but not proven now')
    expect(startSummary(0, ok.replace('RESULT: ok', 'RESULT: failed'), '')).not.toContain(START_DONE)
    // A missing result line is never success, nor is exit 0 with refused.
    const none = startSummary(0, '', '')
    expect(none).not.toContain(START_DONE); expect(none).not.toContain('Skin removed')
    expect(none).toMatch(/^The colour helper start did not finish \(exit 0, no result line\)\./)
    expect(startSummary(0, ok.replace('RESULT: ok\n', ''), '')).not.toContain(START_DONE)
    const refused = startSummary(0, 'A colour helper is already running, so no tick is needed.\nPORT_STATE: closed\nRESULT: refused\n', '')
    expect(refused).not.toContain(START_DONE); expect(refused).toContain('Not started.')
    expect([startResult('RESULT: ok'), startResult(''), startResult('RESULT: maybe')]).toEqual(['ok', null, null])
  })
})

test('/skin type on --tick goes straight to tick off: no status or switch first, never one-click', OPTS, async ($, on) => {
  const w = world(on, { tick: ['Ready. x\n', 'READY_TO_TICK\n', 'part: type on: done\nsampled colour checks: not applicable (no skin put on); no skin on: confirmed\ndebugger: confirmed closed\nhelper: active until Claude quits\nPORT_STATE: closed\nRESULT: ok\n'] })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('type on --tick'))
  expect(w.spawns.map(a => a.slice(2))).toEqual([['tick', 'off', '--want-type=on']])
  expect(tool(w.runs)).toHaveLength(0)
  expect(r.text.split('\n')[0]).toBe(START_DONE)
  await $.command.run(cmd('font plex 14 --tick'))
  await $.command.run(cmd('font plex type on --tick'))
  await $.command.run(cmd('off --tick'))
  expect(w.spawns.map(a => a.slice(2))).toEqual([['tick', 'off', '--want-type=on'], ['tick', 'off', '--want-font=plex-14'], ['tick', 'off', '--want-font=plex', '--want-type=on'], ['tick', 'remove']])
  expect(tool(w.runs)).toHaveLength(0)
})

test('/skin fonts --tick opens the fonts card after a good run, and not after a failed one', OPTS, async ($, on) => {
  let code = 0
  let noResult = false
  on('fs.exists', () => ({ value: false })) // no release.json: the owner's copy, fonts shipped
  mock.clock(on)
  const w = world(on, {
    look: () => [0, 'LOOK: {"helper":"active","look":[],"type":"off","parts":[]}\nPORT_STATE: closed\nRESULT: ok'],
    spawn: async function* () {
      yield { stream: 'stdout', text: 'Ready. x\nREADY_TO_TICK\n' }
      yield { stream: 'stdout', text: `debugger: confirmed closed\nhelper: active\nPORT_STATE: closed\n${noResult ? '' : `RESULT: ${code === 0 ? 'ok' : 'failed'}\n`}` }
      return { value: { code, signal: null } }
    },
  })
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(cmd('fonts --tick'))
  expect(w.spawns.map(a => a.slice(2))).toEqual([['tick', 'off']])
  expect(tool(w.runs).map(a => a.slice(2))).toEqual([['look', 'show']])
  expect(r.text).toContain(START_DONE)
  expect(r.text).toContain('The fonts card is open')
  await $.command.run(cmd('fonts off'))
  code = 1
  const f = await $.command.run(cmd('fonts --tick'))
  expect(tool(w.runs).map(a => a.slice(2))).toEqual([['look', 'show']]) // no second look: the card stays closed
  expect(f.text).toMatch(/^The colour helper start did not finish/)
  // Exit 0 but no RESULT line: not a success, and the card stays closed.
  code = 0; noResult = true
  const g = await $.command.run(cmd('fonts --tick'))
  expect(tool(w.runs).map(a => a.slice(2))).toEqual([['look', 'show']])
  expect(g.text).toMatch(/^The colour helper start did not finish \(exit 0, no result line\)/)
})

test('the no-skin card: title, disclosure and plan from a PLAN line split across output pieces; the fallback line too', OPTS, async ($, on) => {
  let finish = () => {}
  const done = new Promise<void>(r => { finish = r })
  const w = world(on, { spawn: async function* () {
    yield { stream: 'stdout', text: START_READY }
    yield { stream: 'stdout', text: PLAN_LINE.slice(0, 40) }
    yield { stream: 'stdout', text: `${PLAN_LINE.slice(40)}\nREAD` }
    yield { stream: 'stdout', text: 'Y_TO_TICK\n' }
    await done
    yield { stream: 'stdout', text: '[3.00s] debugger port seen: stop clicking\n' }
    yield { stream: 'stdout', text: 'debugger: confirmed closed\nPORT_STATE: closed\nRESULT: ok\n' }
    return { value: { code: 0, signal: null } }
  } })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const running = $.command.run(cmd('type on --tick'))
  await clock.advance(0)
  // Not drawn yet: the one-line fallback carries the same words.
  await clock.advance(1_600)
  expect(w.statuses).toContain(startStatus('sets the fonts (Everything else: IBM Plex Sans; Chat text: the same font as everything else, 14px) and turns on the project headers, as last time', 60))
  const ui = await $.ui.mount({ plugin: 'skin', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Reskin · colour helper' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^To start the colour helper, click Developer › Enable Main Process Debugger.*No skin is put on\. Any Reskin skin is taken off\. A Claude page may reload once\. It also sets the fonts \(Everything else: IBM Plex Sans.*and turns on the project headers, as last time\.$/ })).toBeDefined()
  await ui.unmount()
  finish()
  await clock.advance(0)
  await running
})
