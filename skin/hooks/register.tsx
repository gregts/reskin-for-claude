import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FontsCard, TickCard } from '../types'
import { SECTIONS, allPicks, defaultPicks, fontOptions, lookInfoOf, noLookText, resultLineOf, sectionOf, setArgs, shortStatus, sizeOptions, weightOptions, withFont, CARD_HELP } from './fonts'
import type { SectionId } from './fonts'
import { APPEND_SH, BoundedText, Capture, ENTRY_MAX_BYTES, LOG_DIR, LOG_FILE, LOG_MAX_BYTES, Milestones, appearanceOf, formatEntry, logView, macModeOf, portOf } from './log'
import type { LogRecord, PortState, Step } from './log'
import { ABOUT, CARD, RING_SIZE, cardFacts, cardParagraph, planOf, startResult, startStatus, startSummary, countdownSvg, displayName, listText, modeOf, noHelper, nodeCandidates, nodeMajorOk, isSkinName, parse, skinSuggestions, oneClickOf, fontsOf, argumentHintOf, summary, toolDirCandidates } from './logic'
import type { Preset } from './logic'

// The tick card above the prompt (null when no run waits for a click).
const card = atom({ plugin: 'skin', key: 'card' } as const, null as TickCard | null)
// The fonts card (4 Nov 2026), null when closed.
const fontsCard = atom({ plugin: 'skin', key: 'fontsCard' } as const, null as FontsCard | null)
const ACCENT = '#d97757'
const DIM = '#8a8f98'
// The tool's tick window (TICK.windowMs in skin-lib.mjs), counted from READY_TO_TICK.
const TICK_WINDOW_S = 60

// Only one run at a time: a tick run waits up to 60 s for the user.
let isRunning = false
// Set when the band actually drew the tick card. Where no band is drawn (a surface without one), the status line under
// the prompt carries the instruction instead, so it is never shown twice.
let cardDrawn = false
// The longest a run may take: preparation, the 60 s tick window, the apply and cleanup (the tool stops itself at 150 s).
const RUN_LIMIT_MS = 180_000
// A tick that also carries font and type parts (a combined line): the tool allows itself 210 s (TICK.runLimitWantsMs).
const WANTS_LIMIT_MS = 225_000
// The no-skin tick (4 Nov 2026): after the close the helper also takes any skin off and a check proves it (the tool
// allows itself 184 s, or 220 s with font and type parts: TICK.runLimitStartMs, TICK.runLimitStartWantsMs).
const START_LIMIT_MS = 200_000
const START_WANTS_LIMIT_MS = 235_000

type Env = { tool: string; node: string[] }
// exitCode is what the chat answer is built from (1 when the tool gave none, as before); the log records null then.
type Run = { exitCode: number; stdout: string; stderr: string }
// The steps of one /skin run, for its log entry. The tool is told the mod logs it, so it does not log the step twice.
type Steps = Step[]
const TOOL_ENV = { RESKIN_LOG_BY: 'skin-mod' }
const viaOf = (verb: string) => verb === 'switch' ? 'colour helper' : verb === 'tick' ? 'debugger, you tick' : verb === 'one-click' ? 'debugger, one click' : verb === 'status' ? 'status' : verb === 'check' ? 'health check' : verb === 'type' ? 'type (colour helper)' : verb === 'font' ? 'font (colour helper)' : verb === 'set' ? 'one line (colour helper)' : verb
// A tool ended by a signal has no exit code: the step says so (and records exit 1, as the answer always did).
const ended = (res: { code: number | null; signal?: string | null }) => res.code !== null ? null : res.signal ? `ended by ${res.signal}` : 'ended without an exit code'
// Timings for the log only: the local clock, so no engine call ever sits between a piece of output and the card.
const nowOf = (_$: EngineInterface): number => Date.now()
// A quick run (switch, status) that has not ended by then is stopped (as process.run's limit did before).
const QUICK_LIMIT_MS = 20_000
// Type and font changes: the helper may clear the slot, apply and clean up (up to about 24 s), and the tool waits 30 s.
const SLOT_LIMIT_MS = 40_000
// A combined line through the helper: checks 5 s, colour 10 s, font 30 s, type 30 s, report 2 s (77 s in the tool).
const SET_LIMIT_MS = 85_000
// The fonts card's Apply (look set): a read-only check (10 s), the installed checks (4 s a font, three at most), the slot
// change (30 s), the report.
const LOOK_LIMIT_MS = 60_000
const resultOf = (stdout: string, exitCode: number) => /^RESULT: (ok|failed|refused)$/m.exec(stdout)?.[1] ?? (exitCode === 0 ? 'ok' : 'failed')

// Finds the tool folder and a Node 22 or newer, without any owner-specific path.
async function resolveEnv($: EngineInterface, options: Readonly<Record<string, unknown>>): Promise<Env | string> {
  let tool: string | undefined
  for (const dir of toolDirCandidates(typeof options.toolDir === 'string' ? options.toolDir : undefined, $.plugin.root)) {
    const entries = await $.fs.list(dir).catch(() => [])
    if (entries.some(e => e.name === 'skin-auto.mjs') && entries.some(e => e.name === 'presets')) { tool = dir; break }
  }
  if (tool === undefined) return 'Could not find the Reskin tool folder (skin-tool). Set this mod\'s toolDir option to the folder that holds skin-auto.mjs.'
  for (const node of nodeCandidates(typeof options.node === 'string' ? options.node : undefined)) {
    const r = await $.process.run([...node, '--version'], { timeoutMs: 5_000 }).catch(() => undefined)
    if (r !== undefined && r.exitCode === 0 && nodeMajorOk(r.stdout)) return { tool, node }
  }
  return 'Reskin needs Node 22 or newer, and none was found (looked in /opt/homebrew/bin, /usr/local/bin and PATH). Install it, or set this mod\'s node option.'
}

async function presets($: EngineInterface, tool: string): Promise<Preset[]> {
  const entries = await $.fs.list(`${tool}/presets`)
  const names = entries.filter(e => e.kind === 'file' && e.name.endsWith('.css')).map(e => e.name.slice(0, -4)).sort()
  const out: Preset[] = []
  for (const name of names) {
    const css = await $.fs.read(`${tool}/presets/${name}.css`).catch(() => '')
    out.push({ name, mode: modeOf(typeof css === 'string' ? css : '') })
  }
  return out
}

// Typeahead: skin names come from the tool's presets folder, looked up at most every 30 s (no Node, no process).
// Keystrokes that arrive while a look-up runs share it, so a slow disk never piles up reads.
let names: { at: number; list: string[] } | undefined
let looking: Promise<string[]> | undefined
async function skinNames($: EngineInterface): Promise<string[]> {
  if (names !== undefined && Date.now() - names.at <= 30_000) return names.list
  looking ??= lookUpNames($).finally(() => { looking = undefined })
  return looking
}
async function lookUpNames($: EngineInterface): Promise<string[]> {
  let list: string[] = []
  let oneClick = true
  let fonts = false
  for (const dir of toolDirCandidates(typeof currentOptions.toolDir === 'string' ? currentOptions.toolDir : undefined, $.plugin.root)) {
    const entries = await $.fs.list(`${dir}/presets`).catch(() => [])
    list = entries.filter(x => x.kind === 'file' && x.name.endsWith('.css')).map(x => x.name.slice(0, -4)).filter(isSkinName).sort()
    if (list.length > 0) {
      // The tool's own release switch decides whether --one-click is offered (a tick-only release refuses it anyway).
      const there = await $.fs.exists(`${dir}/release.json`).catch(() => null)
      const release = there === false ? null : there ? await $.fs.read(`${dir}/release.json`).catch(() => '') : ''
      oneClick = oneClickOf(release)
      fonts = fontsOf(release)
      break
    }
  }
  names = { at: Date.now(), list }
  oneClickNow = oneClick
  fontsNow = fonts
  return list
}
let oneClickNow = true
let fontsNow = false

async function macMode($: EngineInterface): Promise<'dark' | 'light' | 'unknown'> {
  return macModeOf(await $.process.run(['/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle']).catch(() => undefined))
}

// Quick runs (switch, status): no waiting on the user. Streamed like the tick runs, so the log has the time each line came.
async function quick($: EngineInterface, env: Env, args: string[], steps: Steps, via = viaOf(args[0] ?? ''), limitMs = QUICK_LIMIT_MS): Promise<Run> {
  const t = nowOf($)
  const argv = [...env.node, `${env.tool}/skin-auto.mjs`, ...args]
  const out = new Capture()
  const marks = new Milestones()
  const stdout = new BoundedText()
  const stderr = new BoundedText()
  let exitCode: number | null = null
  let cut = false
  const child = $.process.spawn({ argv, env: TOOL_ENV })
  let timeUp = () => {}
  const limit = new Promise<'cut'>(r => { timeUp = () => r('cut') })
  let timer: { cancel: () => void } | undefined
  try { timer = $.clock.after(limitMs, () => { cut = true; timeUp(); void child.return(undefined as never).catch(() => {}) }) } catch {}
  const read = async (): Promise<'done'> => {
    for await (const { stream, text } of child) {
      if (cut) break
      out.add(nowOf($) - t, stream === 'stderr' ? 'stderr' : 'stdout', text)
      marks.feed(stream === 'stderr' ? 'stderr' : 'stdout', text)
      if (stream === 'stderr') stderr.add(text)
      else stdout.add(text)
    }
    return 'done'
  }
  try {
    if (await Promise.race([read(), limit]) === 'cut') throw new Error(`the tool did not answer within ${limitMs / 1000} s`)
    const res = await child.result.catch(() => ({ code: null, signal: null as string | null }))
    const sig = ended(res)
    if (sig) { out.add(nowOf($) - t, 'stderr', `\n${sig}\n`); marks.add(sig) }
    exitCode = res.code
    // The answer is built from cleaned text, so the chat (and the log of it) never shows a secret the tool printed.
    return { exitCode: res.code ?? 1, stdout: stdout.cleaned(), stderr: stderr.cleaned() }
  } catch (err) {
    out.add(nowOf($) - t, 'stderr', `\ncould not run: ${(err as Error).message}\n`)
    throw err
  } finally {
    timer?.cancel()
    steps.push({ argv, via, exitCode, ms: nowOf($) - t, output: out.finish(), marks: marks.list().join('\n') })
  }
}

// Runs that may wait for the user's tick: the output is streamed, so the tick prompt shows the moment the tool is ready
// (it prints READY_TO_TICK only after every check passed and its safety nets are running), together with the tool's own
// disclosure (what may appear, the debugger, the colour helper). One-click runs print DISCLOSED before their scripted tick.
async function streamed($: EngineInterface, env: Env, args: string[], steps: Steps, limitMs = RUN_LIMIT_MS): Promise<Run> {
  // The skin is the first plain word after the verb (a combined line adds --want-* options after it).
  const skin = args.slice(1).find(a => !a.startsWith('--')) ?? ''
  const t0 = nowOf($)
  const out = new Capture()
  const marks = new Milestones()
  let exitCode: number | null = null
  const argv = [...env.node, `${env.tool}/skin-auto.mjs`, ...args]
  let countdown: { cancel: () => void } | undefined
  let fallback: { cancel: () => void } | undefined
  const child = $.process.spawn({ argv, env: TOOL_ENV })
  const stdout = new BoundedText()
  const stderr = new BoundedText()
  let cut = false
  let starting = false // a no-skin tick (its disclosure or PLAN line said so)
  // An independent cap: the command stops waiting at limitMs even if the child goes silent, and asks the child to
  // end (the tool's own guardian still closes the port).
  let timeUp = () => {}
  const limit = new Promise<'cut'>(r => { timeUp = () => r('cut') })
  const timer = $.clock.after(limitMs, () => { cut = true; timeUp(); void child.return(undefined as never).catch(() => {}) })
  const disclosure = (marker: string) => {
    const all = stdout.text
    const lines = all.slice(0, all.indexOf(marker)).split('\n').map(l => l.trim())
    const from = lines.findIndex(l => l.startsWith('Ready.') || l.startsWith('Reskin will now tick'))
    return from === -1 ? '' : lines.slice(from).filter(l => l !== '' && !l.startsWith('[')).join('\n')
  }
  const read = async (): Promise<'done'> => {
    for await (const { stream, text } of child) {
      if (cut) break
      out.add(nowOf($) - t0, stream === 'stderr' ? 'stderr' : 'stdout', text)
      marks.feed(stream === 'stderr' ? 'stderr' : 'stdout', text)
      if (stream === 'stderr') { stderr.add(text); continue }
      stdout.add(text)
      // Each marker is looked for on every piece, so none is missed when it is split across two pieces.
      const ready = stdout.newly('READY_TO_TICK')
      const nudge = stdout.newly('No debugger yet')
      const disclosed = stdout.newly('DISCLOSED')
      const seenOpen = stdout.newly('debugger port seen')
      if (ready) {
        // The card carries the tool's disclosure in short; the status line stays as a one-line fallback.
        // The no-skin tick's PLAN line is read from the whole output as well (design v3 [r2-1]), never only the disclosure.
        const facts = cardFacts(disclosure('READY_TO_TICK'))
        const whole = planOf(stdout.text)
        const facts2 = whole === null ? facts : { ...facts, start: true, plan: whole }
        starting = facts2.start
        await update($, card, () => ({ skin, left: TICK_WINDOW_S, phase: 'wait', nudged: false, ...facts2 }))
        countdown = $.clock.every(1_000, () => { void update($, card, c => c === null || c.phase !== 'wait' ? c : { ...c, left: Math.max(0, c.left - 1) }) })
        cardDrawn = false
        fallback = $.clock.after(1_500, () => { if (!cardDrawn) $.ui.status(facts2.start ? startStatus(facts2.plan, TICK_WINDOW_S) : `Reskin: click Developer > Enable Main Process Debugger once (${TICK_WINDOW_S} s)`) })
      }
      if (nudge) await update($, card, c => c === null ? c : { ...c, nudged: true })
      if (disclosed) $.ui.toast(disclosure('DISCLOSED'), { timeoutMs: 15_000 })
      if (seenOpen) {
        await update($, card, c => c === null ? c : { ...c, phase: 'applying' as const })
        if (!cardDrawn) $.ui.status(starting ? 'Reskin: starting the colour helper, stop clicking' : 'Reskin: applying, stop clicking')
      }
    }
    return 'done'
  }
  try {
    const how = await Promise.race([read(), limit])
    if (how === 'cut') {
      return { exitCode: 4, stdout: stdout.cleaned(), stderr: `${stderr.cleaned()}\nStopped by /skin after ${limitMs / 1000} s. If the debugger may still be open, untick Developer > Enable Main Process Debugger.` }
    }
    const res = await child.result.catch(() => ({ code: null, signal: null as string | null }))
    const sig = ended(res)
    if (sig) { out.add(nowOf($) - t0, 'stderr', `\n${sig}\n`); marks.add(sig) }
    exitCode = res.code
    return { exitCode: res.code ?? 1, stdout: stdout.cleaned(), stderr: stderr.cleaned() }
  } finally {
    timer.cancel()
    countdown?.cancel()
    fallback?.cancel()
    const ms = nowOf($) - t0
    const tail = cut ? `\n[+${(ms / 1000).toFixed(3)}s] /skin stopped waiting after ${limitMs / 1000} s` : ''
    steps.push({ argv, via: viaOf(args[0] ?? ''), exitCode, ms, output: out.finish() + tail, marks: marks.list().join('\n') })
    await update($, card, () => null)
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  currentOptions = options ?? {}
  // The tick card: only while a tick run waits. Other plugins' bands (usage-line) still draw beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, card)
    if (e.props.hasSurvey) return next(e)
    if (c === null) {
      const f = await read($, fontsCard)
      return f === null ? next(e) : drawFonts($, e, next, f)
    }
    cardDrawn = true
    // Claude Code's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn !== null && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const waiting = c.phase === 'wait'
    // Top row: the title, then the countdown ring and "How it works" in the top right corner. Below it, one paragraph
    // across the full width (mockup, 15 Oct): no columns, so no gap down the middle.
    const ring = Svg !== undefined
      ? (() => { const d = countdownSvg(c.left, TICK_WINDOW_S); return <Svg key="skin-card-ring" source={d.source} alt={d.alt} width={RING_SIZE} height={RING_SIZE} /> })()
      : <Text color={c.left <= 5 ? ACCENT : DIM}>{c.left} s</Text>
    const [before, after] = cardParagraph(c)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text bold color={ACCENT}>Reskin · {c.start ? CARD.startTitle : displayName(c.skin)}</Text>
            {waiting && (
              <Box key="skin-card-corner" flexDirection="row" gap={1} alignItems="center">
                {ring}
                <Text color={DIM}>{CARD.about}</Text>
              </Box>
            )}
          </Box>
          {waiting
            ? <Text color={DIM} wrap="wrap">{before}<Text bold color={DIM}>{CARD.menu}</Text>{after}</Text>
            : <Text>{c.start ? CARD.applyingStart : c.helper ? CARD.applyingHelper : CARD.applying}</Text>}
          {waiting && <Text color={DIM} wrap="wrap">{CARD.devMode}</Text>}
          {waiting && c.nudged && <Text color={ACCENT}>{c.left === 0 ? CARD.timeUp : CARD.nudge}</Text>}
          {waiting && !c.nudged && c.left === 0 && <Text color={ACCENT}>{CARD.timeUp}</Text>}
        </Box>
        {below}
      </Box>
    )
  })

  // The fonts card's buttons: the work runs here, with this hook's own engine interface (the buttons' closures do nothing).
  on('ui.press', async ($, e, next) => {
    // An opener any band mod may draw (a Button keyed skin-fonts-open, documented in the README): it opens the fonts card
    // at once, mid-turn too, and prints nothing in the chat (a command run by a mod would wait until Claude is idle).
    if (e.element === FONTS_OPENER) { await openFromButton($); return next(e) }
    if (e.plugin !== 'skin') return next(e)
    if (e.element === 'skin-fonts-close') {
      await update($, fontsCard, () => null)
      // Once per Claude session: how to get the row back (the card itself is gone now).
      if (!closeHintShown) { closeHintShown = true; $.ui.toast('Fonts closed. /skin fonts brings them back.', { timeoutMs: 6_000 }) }
    }
    else if (e.element === 'skin-fonts-apply') await applyFonts($, false)
    else if (e.element === 'skin-fonts-reset') await applyFonts($, true)
    return next(e)
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const base = await next(e)
    if (!/^\s*\/skin\s/i.test(e.text)) return base
    const mine = skinSuggestions(e.text, e.start, e.cursor, await skinNames($), oneClickNow, fontsNow)
    return mine.length ? { suggestions: [...base.suggestions, ...mine] } : base
  })

  on('session.start', async ($, e, next) => {
    // Another plugin (for example claude-skins) may already own /skin: say so instead of failing silently.
    try {
      await $.command.register({
        name: 'skin',
        description: 'Recolour the whole Claude app: /skin <name>, /skin off, /skin remove, /skin status, /skin check, /skin type on|off, /skin type on --tick (no skin), /skin list, /skin log, /skin about',
        argumentHint: argumentHintOf((await skinNames($), oneClickNow), fontsNow),
      })
    } catch {
      $.ui.status('Reskin: /skin is taken by another plugin. Disable one of them to use Reskin.')
    }
    return next(e)
  })

  on('command.run', { command: 'skin' }, async ($, e) => {
    const parsed = parse(e.args, (await skinNames($), oneClickNow))
    if (parsed.kind === 'about') return { text: ABOUT }
    if (parsed.kind === 'log') return { text: await showLog($) }
    // Every other /skin run leaves one entry in the log, whatever happens.
    const t0 = nowOf($)
    const steps: Steps = []
    // The port is checked alongside the run, never before it: the answer never waits for the log.
    const portBefore = portNow($)
    let preset: LogRecord['preset'] = null
    let tool = 'not looked up'
    let answer: { text: string; result: string }
    try {
      answer = await handle($, parsed, steps, (t: string) => { tool = t }, (p: LogRecord['preset']) => { preset = p })
    } catch (err) {
      answer = { text: `The skin step did not finish: ${(err as Error).message}`, result: 'failed' }
    }
    // The answer never waits for the log: the entry is written after it, in the background. What the run itself decides
    // is fixed now: its duration, the tool's own last port check, and a port check started as it ends.
    const ms = nowOf($) - t0
    // From the step's milestones (noted from every raw line), so a cut in the kept output never loses it.
    const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
    void writeLog($, {
      command: `/skin ${e.args.trim()}`.trim(), tool, preset, steps, shown: answer.text, result: answer.result,
      exitCode: steps.at(-1)?.exitCode ?? null, t0, ms, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
    })
    return { text: answer.text }
  })
}

type Found = (tool: string) => void
type Chosen = (p: LogRecord['preset']) => void
const said = (text: string, result: string) => ({ text, result })

// One /skin run. `result` is what the log records: the tool's own RESULT line when a step ran, otherwise refused or
// answered (the mod answered by itself).
async function handle($: EngineInterface, parsed: ReturnType<typeof parse>, steps: Steps, found: Found, chosen: Chosen): Promise<{ text: string; result: string }> {
  if (parsed.kind === 'bad') return said(parsed.why, 'refused')
  if (isRunning) return said('A skin change is already running. Wait for it to finish.', 'refused')
  // The guard is claimed before the first wait, so two runs can never start together.
  isRunning = true
  try {
    const env = await resolveEnv($, currentOptions)
    if (typeof env === 'string') { found(env); return said(env, 'refused') }
    found(env.tool)
    const last = (r: Run) => resultOf(r.stdout, r.exitCode)
    if (parsed.kind === 'status') {
      const r = await quick($, env, ['status'], steps)
      return said(r.stdout.split('\n').filter(l => l.trim() && !/^(PORT_STATE|RESULT):/.test(l)).join('\n') || summary('status', r.exitCode, r.stdout, r.stderr), last(r))
    }
    if (parsed.kind === 'check') {
      // Read-only, through the colour helper: no tick, no port. The tool prints the whole plain report.
      const r = await quick($, env, ['check'], steps)
      return said(r.stdout.split('\n').filter(l => l.trim() && !/^(PORT_STATE|RESULT):/.test(l)).join('\n') || [`The check did not finish (exit ${r.exitCode}).`, ...r.stderr.split('\n').filter(l => l.trim()).slice(-3)].join('\n'), last(r))
    }
    if (parsed.kind === 'type') {
      // Through the colour helper only: no tick, no port. The tool prints the plain report.
      const r = await quick($, env, ['type', parsed.on ? 'on' : 'off'], steps, undefined, SLOT_LIMIT_MS)
      return said(r.stdout.split('\n').filter(l => l.trim() && !/^(PORT_STATE|RESULT):/.test(l)).join('\n') || [`type did not finish (exit ${r.exitCode}).`, ...r.stderr.split('\n').filter(l => l.trim()).slice(-3)].join('\n'), last(r))
    }
    if (parsed.kind === 'fonts') {
      if (!fontsNow) return said('Fonts are not in this release.', 'refused')
      if (!parsed.show) { await update($, fontsCard, () => null); return said('Fonts card closed.', 'answered') }
      const { helper, result } = await openCard($, env, steps)
      return said(helper === 'active' ? CARD_HELP : noLookText(helper), result)
    }
    if (parsed.kind === 'font') {
      // Through the colour helper only: no tick, no port. The tool checks the name, the release switch and that the font
      // is installed, and prints the plain report.
      const r = await quick($, env, ['font', parsed.name], steps, undefined, SLOT_LIMIT_MS)
      return said(r.stdout.split('\n').filter(l => l.trim() && !/^(PORT_STATE|RESULT):/.test(l)).join('\n') || [`font did not finish (exit ${r.exitCode}).`, ...r.stderr.split('\n').filter(l => l.trim()).slice(-3)].join('\n'), last(r))
    }
    if (parsed.kind === 'set') {
      // The one-line command (3 Nov 2026). Through the colour helper when there is one (the tool checks the whole line
      // first, then skin, font, type). With no helper and a skin name: one tick that also carries the font and type
      // parts. The tick happens only on the tool's own "no helper" refusal, which comes before anything is sent.
      const plain = (r: Run) => r.stdout.split('\n').filter(l => l.trim() && !/^(PORT_STATE|RESULT):/.test(l)).join('\n') || [`The line did not finish (exit ${r.exitCode}).`, ...r.stderr.split('\n').filter(l => l.trim()).slice(-3)].join('\n')
      if (parsed.via === 'auto') {
        const r = await quick($, env, ['set', ...parsed.words], steps, undefined, SET_LIMIT_MS)
        if (!(r.exitCode === 5 && noHelper(r.stdout) && parsed.skin !== null && parsed.skin !== 'off')) return said(plain(r), last(r))
      }
      if (parsed.skin === null || parsed.skin === 'off') return said('A tick goes with a skin name, for example /skin dracula font plex type on.', 'refused')
      const all = await presets($, env.tool).catch(() => [] as Preset[])
      const p = all.find(x => x.name === parsed.skin)
      if (p === undefined) return said(`No skin called ${parsed.skin}. ${listText(all, await macMode($), fontsNow)}`, 'refused')
      chosen({ name: p.name, mode: p.mode })
      const wants = [...(parsed.font !== undefined ? [`--want-font=${parsed.font}`] : []), ...(parsed.type !== undefined ? [`--want-type=${parsed.type ? 'on' : 'off'}`] : [])]
      const r = await streamed($, env, ['tick', p.name, ...wants], steps, WANTS_LIMIT_MS)
      return said(summary(p.name, r.exitCode, r.stdout, r.stderr), last(r))
    }
    if (parsed.kind === 'start') {
      // The no-skin tick (4 Nov 2026): straight to the tool, which decides everything under its run lock (an old, unknown
      // or already running helper refuses before any prompt). No status read first, never one-click.
      // The tool refuses a font in a copy without fonts itself; the fonts card is the mod's own, so it is gated here.
      if (parsed.fonts && !fontsNow) return said('Fonts are not in this release.', 'refused')
      const wants = [...(parsed.font !== undefined ? [`--want-font=${parsed.font}`] : []), ...(parsed.type !== undefined ? [`--want-type=${parsed.type ? 'on' : 'off'}`] : [])]
      const r = await streamed($, env, ['tick', 'off', ...wants], steps, wants.length ? START_WANTS_LIMIT_MS : START_LIMIT_MS)
      const text = startSummary(r.exitCode, r.stdout, r.stderr)
      // Only the tool's own RESULT line counts here; a missing one is recorded as failed, never inferred from exit 0.
      const result = startResult(r.stdout) ?? 'failed'
      if (parsed.fonts && r.exitCode === 0 && result === 'ok') {
        // The helper is on now: the fonts card opens, as /skin fonts would.
        const o = await openCard($, env, steps).catch(() => ({ helper: 'unread', result: 'failed' }))
        return said([text, o.helper === 'active' ? CARD_HELP : noLookText(o.helper)].join('\n'), result)
      }
      return said(text, result)
    }
    if (parsed.kind === 'list') {
      const all = await presets($, env.tool).catch(() => [] as Preset[])
      if (all.length === 0) return said(`No skins found in ${env.tool}/presets.`, 'failed')
      const st = await quick($, env, ['status'], steps, 'status check (for the list)').catch(() => undefined)
      const extra = st?.stdout.split('\n').filter(l => /^(helper:|Reapply )/.test(l)) ?? []
      await skinNames($).catch(() => [])
      return said([listText(all, await macMode($), fontsNow), ...extra].join('\n'), 'ok')
    }
    if (parsed.kind === 'off' || parsed.kind === 'remove') {
      // Through the helper when there is one (no tick); --tick takes everything off with a new tick.
      const args = parsed.via === 'tick' ? ['tick', 'remove'] : parsed.via === 'one-click' ? ['one-click', 'remove'] : ['switch', parsed.kind]
      const r = parsed.via === 'auto' ? await quick($, env, args, steps) : await streamed($, env, args, steps)
      return said(summary('off', r.exitCode, r.stdout, r.stderr), last(r))
    }
    if (parsed.kind !== 'apply') return said('Nothing to do.', 'answered')
    // A preset: only a name that really is a preset file gets through.
    const all = await presets($, env.tool).catch(() => [] as Preset[])
    if (all.length === 0) return said(`No skins found in ${env.tool}/presets.`, 'failed')
    const p = all.find(x => x.name === parsed.name)
    if (p === undefined) return said(`No skin called ${parsed.name}. ${listText(all, await macMode($))}`, 'refused')
    chosen({ name: p.name, mode: p.mode })
    if (parsed.via === 'auto') {
      const r = await quick($, env, ['switch', parsed.name], steps)
      if (!(r.exitCode === 5 && noHelper(r.stdout))) return said(summary(parsed.name, r.exitCode, r.stdout, r.stderr), last(r))
    }
    const r = await streamed($, env, [parsed.via === 'one-click' ? 'one-click' : 'tick', parsed.name], steps)
    return said(summary(parsed.name, r.exitCode, r.stdout, r.stderr), last(r))
  } finally {
    isRunning = false
  }
}

// The mod's options, kept from register (handle runs outside it).
let currentOptions: Readonly<Record<string, unknown>> = {}

const run = ($: EngineInterface, argv: string[], timeoutMs = 2_000) => $.process.run(argv, { timeoutMs }).catch(() => undefined)
const portNow = async ($: EngineInterface): Promise<PortState> => portOf(await run($, ['/usr/sbin/lsof', '-nP', '-iTCP:9229', '-sTCP:LISTEN']))
const logPath = (home: string) => `${home}/${LOG_DIR}/${LOG_FILE}`

// Adds the entry to the log. Logging never changes or fails a /skin run: any problem here is ignored.
type Pending = Pick<LogRecord, 'command' | 'tool' | 'preset' | 'steps' | 'shown' | 'result' | 'exitCode' | 'ms' | 'portAfterFrom'> &
  { t0: number; portBefore: Promise<PortState>; portAfter: PortState | Promise<PortState> }
// Every lookup has its own limit, and at most a few entries wait to be written at once (a stuck disk can never pile up
// runs' data); a lookup that does not answer in time is written as unknown.
const FACT_MS = 2_000
const MAX_WAITING = 4
let waiting = 0
function within<T>($: EngineInterface, p: Promise<T>, fallback: T, ms = FACT_MS): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<T>(r => { try { timer = $.clock.after(ms, () => r(fallback)) } catch {} })
  return Promise.race([p.catch(() => fallback), late]).finally(() => timer?.cancel())
}
async function writeLog($: EngineInterface, r: Pending) {
  if (waiting >= MAX_WAITING) return
  waiting++
  try {
    await writeEntry($, r)
  } finally {
    waiting--
  }
}
async function writeEntry($: EngineInterface, r: Pending) {
  try {
    const home = await within($, $.env.get('HOME'), undefined)
    if (home === undefined || !home.startsWith('/')) return
    const [portBefore, portAfter, version, mac, when, config, manifest] = await Promise.all([
      within<PortState>($, r.portBefore, 'unknown'),
      within<PortState>($, Promise.resolve(r.portAfter), 'unknown'),
      within($, run($, ['/usr/bin/plutil', '-extract', 'CFBundleShortVersionString', 'raw', '/Applications/Claude.app/Contents/Info.plist']), undefined),
      within($, run($, ['/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle']), undefined),
      within($, run($, ['/bin/date', '-r', String(Math.floor(r.t0 / 1000)), '+%Y-%m-%d %H:%M:%S %z']), undefined), // when the run started
      // Only a small regular file is read (never a link or a pipe); only its Appearance word is kept.
      within($, $.fs.stat(`${home}/Library/Application Support/Claude/config.json`).then(st => st.kind === 'file' && !st.isLink && st.size < 1_000_000
        ? $.fs.read(`${home}/Library/Application Support/Claude/config.json`) : undefined), undefined),
      within($, $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`), undefined),
    ])
    const v = version?.exitCode === 0 ? version.stdout.trim() : ''
    const modVersion = typeof manifest === 'string' ? /"version"\s*:\s*"([^"]{1,20})"/.exec(manifest)?.[1] : undefined
    const rec: LogRecord = {
      when: when?.exitCode === 0 && when.stdout.trim() !== '' ? when.stdout.trim() : new Date(r.t0).toISOString(),
      command: r.command, from: `/skin mod ${modVersion ?? '(version unknown)'}`, tool: r.tool,
      claudeVersion: /^[\w.-]{1,30}$/.test(v) ? v : 'unknown',
      appearance: appearanceOf(typeof config === 'string' ? config : undefined), mac: macModeOf(mac),
      preset: r.preset, portBefore, portAfter, portAfterFrom: r.portAfterFrom, steps: r.steps, shown: r.shown, result: r.result, exitCode: r.exitCode,
      ms: r.ms,
    }
    // One shared, locked writer (APPEND_SH): no linked file is followed, rotation happens under the lock, and a failed
    // rotation writes nothing, so the two files stay bounded.
    await $.process.run(['/bin/sh', '-c', APPEND_SH, 'sh', `${home}/${LOG_DIR}`, String(LOG_MAX_BYTES), String(ENTRY_MAX_BYTES)],
      { stdin: formatEntry(rec, home), timeoutMs: 5_000 })
  } catch {}
}

// /skin log: the last few entries in plain English, and where the file is. Only small regular files are read, within 3 s,
// and when the log turned over between the two reads they are read again, so the view never skips or repeats entries.
const LOG_READ_MS = 3_000
async function showLog($: EngineInterface): Promise<string> {
  const shownPath = `~/${LOG_DIR}/${LOG_FILE}`
  // '' when the file is not there; null when it is there but cannot be read (a link, too big, an error), or when even
  // whether it is there cannot be told.
  const readOne = async (f: string): Promise<string | null> => {
    const there = await $.fs.exists(f).catch(() => null)
    if (there === null) return null
    if (!there) return ''
    const st = await $.fs.stat(f).catch(() => undefined)
    if (st === undefined || st.kind !== 'file' || st.isLink || st.size > 2 * LOG_MAX_BYTES) return null
    const t = await $.fs.read(f).catch(() => null)
    return typeof t === 'string' ? t : null
  }
  // Everything, the home folder lookup included, is inside the 3 s limit.
  const readBoth = async (): Promise<string> => {
    const home = await $.env.get('HOME').catch(() => undefined)
    if (home === undefined) return 'Could not find your home folder, so the log could not be read.'
    const file = logPath(home)
    for (let i = 0; i < 3; i++) {
      const current = await readOne(file)
      const older = await readOne(`${file}.1`)
      const again = await readOne(file)
      if (current === null || again === null || older === null) return `The log is there but could not be read (a linked or oversized file, or a read error). The file is ${shownPath}`
      if (again.startsWith(current)) return logView(older, again, 5, shownPath)
    }
    return `The log was changing while it was read; try /skin log again. The file is ${shownPath}`
  }
  let timer: { cancel: () => void } | undefined
  const late = new Promise<string>(r => { try { timer = $.clock.after(LOG_READ_MS, () => r(`The log could not be read within ${LOG_READ_MS / 1000} s. The file is ${shownPath}`)) } catch {} })
  try { return await Promise.race([readBoth().catch(() => `The log could not be read. The file is ${shownPath}`), late]) } finally { timer?.cancel() }
}

// ---- The fonts card (4 Nov 2026) ----
// Drawn above the message box while open (the tick card goes first). Dropdowns for the part of the app, the font, the
// size and the weight; Apply sends that one part's choices through the colour helper; "Claude's own" puts that part back.
function drawFonts($: EngineInterface, e: any, next: (e: any) => unknown, f: FontsCard) {
  return (async () => {
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn !== null && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Select = 'Select' in ui ? ui.Select : undefined
    const sec = sectionOf(f.section)
    const p = f.picks[sec.id]
    const uiFont = f.picks.ui.font
    const set = (fn: (c: FontsCard) => FontsCard) => { void update($, fontsCard, c => (c === null ? c : fn(c))) }
    const active = f.helper === 'active'
    // One slim row in the band (owner's look, 4 Nov 2026): the four dropdowns, Apply, Reset and a close mark; no title,
    // help or summary (the dropdowns show what is chosen; /skin fonts explains it in the chat). A short status after.
    return (
      <Box flexDirection="column">
        {/* Owner's screenshots (5 Nov 2026): a top gap sat the row low when shown alone, and a bottom gap left a blank
            strip under it inside a bar. No gap above or below: the band's own box centres the row, and a bar that hosts
            it adds its own gap. No left gap while the ✕ leads the row (its button brings its own), so the ✕ lines up
            with the message box's +; with no ✕ (opened from a bar), "Fonts" keeps the bar's left edge. */}
        <Box key="skin-fonts-row" flexDirection="row" gap={1} alignItems="center" paddingLeft={f.fromButton ? 1 : 0} paddingRight={1}>
          {/* Owner's layout (4 Nov 2026, from a screenshot): Reset ends under the band's "Fonts" opener at the right end.
              Opened by that opener, the opener closes it too (no ✕); opened by /skin fonts, a ✕ opens the row. */}
          {!f.fromButton && <Button key="skin-fonts-close" label="✕" plain dimColor onPress={() => {}} />}
          <Text color={ACCENT}>Fonts</Text>
          {!active && <Text color={DIM} wrap="truncate-end">{noLookText(f.helper)}</Text>}
          {active && Select === undefined && <Text color={DIM} wrap="truncate-end">Use the desktop app to choose fonts.</Text>}
          {active && Select !== undefined && <Select key="skin-fonts-section" value={sec.id} options={SECTIONS.map(s => ({ value: s.id, label: s.label }))}
            onSelect={(v: string) => set(c => ({ ...c, section: sectionOf(v).id, status: '' }))} />}
          {active && Select !== undefined && <Select key="skin-fonts-font" value={p.font} options={fontOptions(sec.id)}
            onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: withFont(sec.id, c.picks[sec.id], v, sec.id === 'ui' ? v : c.picks.ui.font) }, status: '' }))} />}
          {active && Select !== undefined && sec.sizes.length > 0 && <Select key="skin-fonts-size" value={p.size} options={sizeOptions(sec.id)}
            onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: { ...c.picks[sec.id], size: v } }, status: '' }))} />}
          {active && Select !== undefined && sec.weights.length > 0 && <Select key="skin-fonts-weight" value={p.weight} options={weightOptions(sec.id, p.font, uiFont)}
            onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: { ...c.picks[sec.id], weight: v } }, status: '' }))} />}
          {f.status !== '' && <Text color={DIM} wrap="truncate-end">{f.status}</Text>}
          <Box flexGrow={1} />
          {/* Plain (no button chrome), so they stand no taller than the dropdowns (owner's look, 4 Nov 2026). The desktop
              draws a native button with its own side padding, so the last button ends one cell (about 9 pt) short of the
              band's right edge (screenshot, 4 Nov 2026): both shifted right by that cell, out of the flow, desktop only. */}
          {active && Select !== undefined && (
            <Box flexDirection="row" gap={1} alignItems="center" position="relative" left={1}>
              <Button key="skin-fonts-apply" plain onPress={() => {}}><Text bold color={ACCENT}>{f.busy ? 'Applying…' : 'Apply'}</Text></Button>
              <Button key="skin-fonts-reset" plain dimColor onPress={() => {}}>Reset</Button>
            </Box>
          )}
        </Box>
        {below}
      </Box>
    )
  })()
}

// Apply (or "Claude's own") for the part shown: one tool run, `look set`, through the colour helper only (no tick, no
// port). Logged like every /skin run. The card then shows what the helper proved.
async function applyFonts($: EngineInterface, reset: boolean) {
  const f = await read($, fontsCard)
  if (f === null || f.busy || f.helper !== 'active') return
  const say = (status: string, more: Partial<FontsCard> = {}) => update($, fontsCard, c => (c === null ? c : { ...c, ...more, status }))
  if (isRunning) { await say('Another skin change is running. Try again in a moment.'); return }
  // Claimed before the first wait; every later step sits inside the try, so the finally releases it.
  isRunning = true
  const steps: Steps = []
  const t0 = nowOf($)
  const portBefore = portNow($)
  let shown = ''
  let result = 'failed'
  let toolDir = 'not looked up'
  const id = f.section as SectionId
  const picks = reset ? defaultPicks(id) : f.picks[id]
  try {
    const env = await resolveEnv($, currentOptions)
    if (typeof env === 'string') { shown = env; result = 'refused'; await say(env, { busy: false }); return }
    toolDir = env.tool
    await say('Applying…', { busy: true })
    const r = await quick($, env, setArgs(id, picks), steps, 'fonts card (colour helper)', LOOK_LIMIT_MS)
    const info = lookInfoOf(r.stdout)
    shown = resultLineOf(r.stdout, r.stderr, r.exitCode)
    result = resultOf(r.stdout, r.exitCode)
    const status = shortStatus(result, shown, reset, info !== null && info.look !== null)
    await update($, fontsCard, c => (c === null ? c : {
      ...c, busy: false, status, helper: info?.helper ?? c.helper, look: info ? info.look : c.look,
      // The part just sent shows what the helper proved; the other parts keep their unsent choices.
      // (All parts changes every part's font, so then every part shows what was proved.)
      picks: info?.look ? (id === 'all' ? allPicks(info.look) : { ...c.picks, [id]: allPicks(info.look)[id], all: allPicks(info.look).all }) : c.picks,
    }))
  } catch (err) {
    shown = `The change did not finish: ${(err as Error).message}`
    await say(shown, { busy: false })
  } finally {
    isRunning = false
    const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
    void writeLog($, {
      command: `/skin fonts (${reset ? 'Claude\'s own' : 'apply'}: ${id})`, tool: toolDir, preset: null, steps, shown, result,
      exitCode: steps.at(-1)?.exitCode ?? null, t0, ms: nowOf($) - t0, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
    })
  }
}

// The fonts card opens from /skin fonts or from an opener button. Read-only, through the colour helper: what is on now,
// as the helper proves it. Returns the helper's state and the run's result.
const FONTS_OPENER = 'skin-fonts-open'
let closeHintShown = false
async function openCard($: EngineInterface, env: Env, steps: Steps, fromButton = false): Promise<{ helper: string; result: string }> {
  const r = await quick($, env, ['look', 'show'], steps, 'fonts card (colour helper)', QUICK_LIMIT_MS)
  const info = lookInfoOf(r.stdout)
  const helper = info?.helper ?? 'unread'
  const look = info?.look ?? null
  await update($, fontsCard, () => ({ helper, look, section: 'all', picks: allPicks(look ?? []), busy: false, fromButton,
    status: helper !== 'active' ? '' : look === null ? 'The fonts that are on now could not be proven. Choose and apply, or run /skin font off first.' : '' }))
  return { helper, result: resultOf(r.stdout, r.exitCode) }
}
// The opener's press toggles the card (owner, 4 Nov 2026): open when closed, closed when open. Never a tick, never a
// second run while one is going.
async function openFromButton($: EngineInterface) {
  if (!fontsNow) { await skinNames($).catch(() => []) } // the release switch is read with the presets
  if (!fontsNow) { $.ui.toast('Fonts are not in this release.', { timeoutMs: 5_000 }); return }
  const open = await read($, fontsCard)
  if (open !== null) {
    if (open.busy) { $.ui.toast('Fonts are still being applied. Press again when it is done.', { timeoutMs: 5_000 }); return }
    await update($, fontsCard, () => null)
    return
  }
  if (isRunning) { $.ui.toast('A skin change is already running. Wait for it to finish.', { timeoutMs: 5_000 }); return }
  isRunning = true
  const steps: Steps = []
  const t0 = nowOf($)
  const portBefore = portNow($)
  let shown = '', result = 'failed', toolDir = 'not looked up'
  try {
    const env = await resolveEnv($, currentOptions)
    if (typeof env === 'string') { shown = env; result = 'refused'; $.ui.toast(env, { timeoutMs: 8_000 }); return }
    toolDir = env.tool
    const o = await openCard($, env, steps, true)
    shown = o.helper === 'active' ? 'fonts card opened' : noLookText(o.helper)
    result = o.result
  } catch (err) {
    shown = `The fonts card did not open: ${(err as Error).message}`
    $.ui.toast(shown, { timeoutMs: 8_000 })
  } finally {
    isRunning = false
    const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
    void writeLog($, {
      command: '/skin fonts (opener button)', tool: toolDir, preset: null, steps, shown, result,
      exitCode: steps.at(-1)?.exitCode ?? null, t0, ms: nowOf($) - t0, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
    })
  }
}
