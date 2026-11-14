import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FontsCard, TickCard } from '../types'
import { SECTIONS, allPicks, defaultPicks, fontOptions, lookInfoOf, noLookText, resultLineOf, sectionOf, setArgs, shortStatus, sizeOptions, weightOptions, withFont, CARD_HELP } from './fonts'
import type { SectionId } from './fonts'
import { APPEND_SH, BoundedText, Capture, ENTRY_MAX_BYTES, LOG_DIR, LOG_FILE, LOG_MAX_BYTES, Milestones, appearanceOf, formatEntry, logView, macModeOf, portOf } from './log'
import type { LogRecord, PortState, Step } from './log'
import { ABOUT, CARD, RING_SIZE, cardFacts, cardParagraph, planOf, startResult, startStatus, startSummary, countdownSvg, displayName, listText, modeOf, noHelper, nodeCandidates, nodeMajorOk, isSkinName, parse, skinSuggestions, oneClickOf, fontsOf, argumentHintOf, summary, toolDirCandidates, retiredText, skinAlias } from './logic'
import type { Preset } from './logic'
import { BAND0, FONTS_OPENER, LOCK_WAIT_ARG, LOCK_WAIT_MS, NO_PROOF, OWN_WORK_WAIT_MS, PROOF_TTL_MS, SIDEBAR_OPENER, SIDEBAR_OPTIONS, SKINS_OPENER, STILL_FINISHING, OPENER_LABELS, SHORT_SETUP_BELOW, actionOf, bandStatusOf, bandWord, chipsOf, proofOf, rowState, skinLabel, skinOptions, sidebarDone } from './band'
import type { Band, BandRow, NowOn, Proof, RowId } from './band'

// The tick card above the prompt (null when no run waits for a click).
const card = atom({ plugin: 'skin', key: 'card' } as const, null as TickCard | null)
// The fonts card (4 Nov 2026), null when closed.
const fontsCard = atom({ plugin: 'skin', key: 'fontsCard' } as const, null as FontsCard | null)
// The appearance band (5 Nov 2026): on or off, the open Skins or Sidebar row, and what the openers may claim.
const band = atom({ plugin: 'skin', key: 'band' } as const, BAND0 as Band)
// Band (5 Nov 2026): work the mod stopped waiting for (a change at its soft limit, a read at its deadline), still being
// drained to its end. A tick waits for it, and for a running band operation, first (the tool's lock guards every run).
const tails = new Set<Promise<void>>()
let expiry: { cancel: () => void } | undefined
// The preset names, cached for the Skins dropdown (read when a row opens).
let presetNames: string[] = []
// A change the mod stopped waiting for: it keeps running in the tool, and its answer is not known yet.
class StillFinishing extends Error {}
const LONG_WAIT_MS = 60_000 // after the soft limit: the never-expected last resort before the mod ends the child
const ACCENT = '#d97757'
const DIM = '#8a8f98'
// The tool's tick window (TICK.windowMs in skin-lib.mjs), counted from READY_TO_TICK.
const TICK_WINDOW_S = 60

// Only one run at a time: a tick run waits up to 60 s for the user.
let isRunning = false
// Set when the band actually drew the tick card. Where no band is drawn (a surface without one), the status line under
// the prompt carries the instruction instead, so it is never shown twice.
let cardDrawn = 0 // the run number of the card the band last drew (0: none)
// The newest tick run's number: its card and timers carry it.
let cardRun = 0
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
  // A retired skin's leftover file (verc.css from an older copy) is never listed or applied.
  const names = entries.filter(e => e.kind === 'file' && e.name.endsWith('.css')).map(e => e.name.slice(0, -4)).filter(n => retiredText(n) === null).sort()
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
    list = entries.filter(x => x.kind === 'file' && x.name.endsWith('.css')).map(x => x.name.slice(0, -4)).filter(n => isSkinName(n) && retiredText(n) === null).sort()
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
// Band (5 Nov 2026): every helper verb the mod starts waits for the tool's run lock (--lock-wait), and that
// wait is added to its limit. At the (soft) limit the mod stops waiting and says the change is still finishing, but it
// never ends the child for being slow: the output keeps being drained in the background (a tracked tail) until the tool
// ends by itself. Only a never-expected LONG_WAIT_MS later is the child ended, as the last resort it always was.
const HELPER_VERBS = new Set(['switch', 'status', 'check', 'type', 'font', 'set', 'look'])
async function quick($: EngineInterface, env: Env, args: string[], steps: Steps, via = viaOf(args[0] ?? ''), limitMs = QUICK_LIMIT_MS, opts: { lockWait?: boolean } = {}): Promise<Run> {
  const t = nowOf($)
  const waits = (opts.lockWait ?? true) && HELPER_VERBS.has(args[0] ?? '')
  const argv = [...env.node, `${env.tool}/skin-auto.mjs`, ...args, ...(waits ? [LOCK_WAIT_ARG] : [])]
  const softMs = limitMs + (waits ? LOCK_WAIT_MS : 0)
  const out = new Capture()
  const marks = new Milestones()
  const stdout = new BoundedText()
  const stderr = new BoundedText()
  // After the soft limit: the rest of the output, for the late log entry.
  const lateOut = new Capture()
  const lateText = new BoundedText()
  let exitCode: number | null = null
  let cut = false
  const child = $.process.spawn({ argv, env: TOOL_ENV })
  let timeUp = () => {}
  const limit = new Promise<'cut'>(r => { timeUp = () => r('cut') })
  let timer: { cancel: () => void } | undefined
  try { timer = $.clock.after(softMs, () => { cut = true; timeUp() }) } catch {}
  // The whole run, process result included, sits inside the race: the mod never waits on it unbounded.
  // The process result is waited for even when the stream itself fails, so the child's
  // end is always what `work` (and a tail made from it) waits for.
  const work = (async () => {
    try { for await (const { stream, text } of child) {
      // After the soft limit the rest is drained, not kept (the answer was already given), and the loop is never left
      // early: leaving it would end the child.
      if (cut) { lateOut.add(nowOf($) - t, stream === 'stderr' ? 'stderr' : 'stdout', text); if (stream !== 'stderr') lateText.add(text); continue }
      out.add(nowOf($) - t, stream === 'stderr' ? 'stderr' : 'stdout', text)
      marks.feed(stream === 'stderr' ? 'stderr' : 'stdout', text)
      if (stream === 'stderr') stderr.add(text)
      else stdout.add(text)
    } } catch (err) { out.add(nowOf($) - t, 'stderr', `\nthe output stream failed: ${(err as Error).message}\n`) }
    return await child.result.catch(() => ({ code: null, signal: null as string | null }))
  })()
  try {
    const res = await Promise.race([work, limit])
    if (res === 'cut') {
      let last: { cancel: () => void } | undefined
      try { last = $.clock.after(LONG_WAIT_MS, () => { void child.return(undefined as never).catch(() => {}) }) } catch {}
      const tail: Promise<void> = work.then(res => lateDone($, env, argv, via, t, lateOut.finish(), lateText.cleaned(), res.code), () => lateDone($, env, argv, via, t, lateOut.finish(), lateText.cleaned(), null))
        .finally(() => { last?.cancel(); tails.delete(tail) })
      tails.add(tail)
      out.add(nowOf($) - t, 'stderr', `\n/skin stopped waiting after ${softMs / 1000} s; the tool keeps running until it ends by itself\n`)
      throw new StillFinishing('Reskin is still finishing that change. /skin status shows the result in a moment.')
    }
    const sig = ended(res)
    if (sig) { out.add(nowOf($) - t, 'stderr', `\n${sig}\n`); marks.add(sig) }
    exitCode = res.code
    // The answer is built from cleaned text, so the chat (and the log of it) never shows a secret the tool printed.
    return { exitCode: res.code ?? 1, stdout: stdout.cleaned(), stderr: stderr.cleaned() }
  } catch (err) {
    if (!(err instanceof StillFinishing)) out.add(nowOf($) - t, 'stderr', `\ncould not run: ${(err as Error).message}\n`)
    throw err
  } finally {
    timer?.cancel()
    steps.push({ argv, via, exitCode, ms: nowOf($) - t, output: out.finish(), marks: marks.list().join('\n') })
  }
}

// A change the mod stopped waiting for has ended: its own log entry with the rest of its output, a short toast with its
// outcome, and the band's claims read again. Read-only runs (look show, status, check) just end.
function lateDone($: EngineInterface, env: Env, argv: string[], via: string, t0: number, output: string, stdout: string, code: number | null) {
  const args = argv.slice(env.node.length + 1)
  if (args[0] === 'status' || args[0] === 'check' || (args[0] === 'look' && args[1] === 'show')) return
  const result = resultOf(stdout, code ?? 1)
  const line = bandStatusOf(stdout, '', code ?? 1)
  try { $.ui.toast(`Reskin finished the earlier change (${result}): ${line}`, { timeoutMs: 12_000 }) } catch {}
  void writeLog($, {
    command: `(finished after /skin stopped waiting) ${args.filter(a => !a.startsWith('--lock-wait')).join(' ')}`, tool: env.tool, preset: null,
    steps: [{ argv, via, exitCode: code, ms: nowOf($) - t0, output, marks: '' }], shown: line, result, exitCode: code, t0, ms: nowOf($) - t0,
    portBefore: Promise.resolve('unknown' as PortState), portAfter: portNow($), portAfterFrom: 'checked as the run ended',
  })
  void readIfShown($)
}

// Before a tick: the mod's own earlier work (a proof read, a change still finishing) must have ended, waited for up to
// OWN_WORK_WAIT_MS. A tick never gets --lock-wait (the tool's tick budget starts when its process starts).
async function ownWorkDone($: EngineInterface, ownOp = false): Promise<boolean> {
  // ownOp: the tick IS the band's operation (its setup button): it does not wait for itself. The set is looked at again
  // after each wait (work can hand over to new work), all within one deadline.
  const now = () => [...tails, ...(op && !ownOp ? [op] : [])]
  let t: { cancel: () => void } | undefined
  let expired = false
  const late = new Promise<void>(r => { try { t = $.clock.after(OWN_WORK_WAIT_MS, () => { expired = true; r() }) } catch { expired = true; r() } })
  try {
    for (;;) {
      const all = now()
      if (all.length === 0) return true
      await Promise.race([Promise.allSettled(all), late])
      if (expired) return now().length === 0
    }
  } finally { t?.cancel() }
}

// Runs that may wait for the user's tick: the output is streamed, so the tick prompt shows the moment the tool is ready
// (it prints READY_TO_TICK only after every check passed and its safety nets are running), together with the tool's own
// disclosure (what may appear, the debugger, the colour helper). One-click runs print DISCLOSED before their scripted tick.
async function streamed($: EngineInterface, env: Env, args: string[], steps: Steps, limitMs = RUN_LIMIT_MS, ownOp = false): Promise<Run> {
  if (!(await ownWorkDone($, ownOp))) throw new StillFinishing(STILL_FINISHING)
  // The skin is the first plain word after the verb (a combined line adds --want-* options after it).
  const skin = args.slice(1).find(a => !a.startsWith('--')) ?? ''
  const t0 = nowOf($)
  const out = new Capture()
  const marks = new Milestones()
  let exitCode: number | null = null
  const argv = [...env.node, `${env.tool}/skin-auto.mjs`, ...args]
  let countdown: { cancel: () => void } | undefined
  let fallback: { cancel: () => void } | undefined
  // This run's own card: every card write and timer checks, inside its callback, that this
  // run is still the newest and still live, so a run that timed out can never put its card back over a newer one.
  const myRun = ++cardRun
  let live = true
  const mine = () => live && cardRun === myRun
  const child = $.process.spawn({ argv, env: TOOL_ENV })
  const stdout = new BoundedText()
  const stderr = new BoundedText()
  let cut = false
  let starting = false // a no-skin tick (its disclosure or PLAN line said so)
  // An independent cap: the command stops waiting at limitMs even if the child goes silent, and asks the child to
  // end (the tool's own guardian still closes the port).
  let timeUp = () => {}
  const limit = new Promise<'cut'>(r => { timeUp = () => r('cut') })
  const timer = $.clock.after(limitMs, () => { cut = true; live = false; timeUp(); void child.return(undefined as never).catch(() => {}) })
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
        // The no-skin tick's PLAN line is read from the whole output as well, never only the disclosure.
        const facts = cardFacts(disclosure('READY_TO_TICK'))
        const whole = planOf(stdout.text)
        const facts2 = whole === null ? facts : { ...facts, start: true, plan: whole }
        starting = facts2.start
        await update($, card, c => (mine() ? { skin, left: TICK_WINDOW_S, phase: 'wait', nudged: false, run: myRun, ...facts2 } : c))
        // Never leave the loop early (that would end the child): a run that is no longer live just starts no timers.
        if (mine()) countdown = $.clock.every(1_000, () => { void update($, card, c => !mine() || c === null || c.run !== myRun || c.phase !== 'wait' ? c : { ...c, left: Math.max(0, c.left - 1) }) })
        if (mine()) cardDrawn = 0
        if (mine()) fallback = $.clock.after(1_500, () => { if (mine() && cardDrawn !== myRun) $.ui.status(facts2.start ? startStatus(facts2.plan, TICK_WINDOW_S) : `Reskin: click Developer > Enable Main Process Debugger once (${TICK_WINDOW_S} s)`) })
      }
      if (nudge) await update($, card, c => !mine() || c === null || c.run !== myRun ? c : { ...c, nudged: true })
      if (disclosed) $.ui.toast(disclosure('DISCLOSED'), { timeoutMs: 15_000 })
      if (seenOpen) {
        await update($, card, c => !mine() || c === null || c.run !== myRun ? c : { ...c, phase: 'applying' as const })
        if (mine() && cardDrawn !== myRun) $.ui.status(starting ? 'Reskin: starting the colour helper, stop clicking' : 'Reskin: applying, stop clicking')
      }
    }
    return 'done'
  }
  try {
    // The run's limit covers the process result too.
    // The result is waited for even when the stream fails.
    const rd = read().catch(() => 'done' as const).then(() => child.result.catch(() => ({ code: null, signal: null as string | null })))
    const how = await Promise.race([rd, limit])
    if (how === 'cut') {
      // The child was asked to end; until it has, it is tracked like any work the mod stopped waiting for.
      const tail: Promise<void> = rd.then(() => {}, () => {}).finally(() => { tails.delete(tail) })
      tails.add(tail)
      return { exitCode: 4, stdout: stdout.cleaned(), stderr: `${stderr.cleaned()}\nStopped by /skin after ${limitMs / 1000} s. If the debugger may still be open, quit and reopen Claude (Cmd+Q, then open it again).` }
    }
    const res = how
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
    live = false
    // Only this run's card goes, and the status line only if no newer run owns it.
    await update($, card, c => (c !== null && c.run !== undefined && c.run !== myRun ? c : null))
    if (cardRun === myRun) $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  currentOptions = options ?? {}
  // The tick card: only while a tick run waits. Other plugins' bands still draw beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, card)
    if (e.props.hasSurvey) return next(e)
    if (c === null) {
      const f = await read($, fontsCard)
      const b = await read($, band)
      // The band on: its two lines (openers, then the open row). Off: only an open row, in the look it had before.
      if (b.on || b.row !== null || f !== null) return drawBand($, e, next, b, f)
      return next(e)
    }
    cardDrawn = c.run ?? 0
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
  // `{ plugin: '*' }` (2.1.0): since Claude Code 2.1.32x a press hook with no matcher hears only this mod's own buttons,
  // so another mod's opener never arrived. Row buttons below still act only when e.plugin is 'skin'.
  on('ui.press', { plugin: '*' }, async ($, e, next) => {
    // An opener any band mod may draw (keyed skin-fonts-open, skin-skins-open, skin-sidebar-open, documented in the
    // README): it opens its row at once, mid-turn too, and prints nothing in the chat. The press is passed on first, then
    // the row opens: opening redraws the band, and a press passed on after that would find its drawing gone (the
    // opener's own onPress does nothing).
    // Busy (an operation or a /skin run): refused at once with a note, before anything else.
    const opener = e.element === FONTS_OPENER || e.element === SKINS_OPENER || e.element === SIDEBAR_OPENER
    if (opener && !freeNow()) { toast($, BUSY_NOTE); return next(e) }
    if (e.element === FONTS_OPENER) { const r = await next(e); await openFromButton($); return r }
    if (e.element === SKINS_OPENER || e.element === SIDEBAR_OPENER) { const r = await next(e); await openRow($, e.element === SKINS_OPENER ? 'skins' : 'sidebar'); return r }
    // Every row button acts only when it is Reskin's own.
    if (e.plugin !== 'skin') return next(e)
    if (e.element === 'skin-band-close') await closeRow($, 'band')
    else if (e.element === 'skin-band-apply') await bandAction($, 'band', 'apply')
    else if (e.element === 'skin-band-reset') await bandAction($, 'band', 'reset')
    else if (e.element === 'skin-band-setup') await bandAction($, 'band', 'setup')
    else if (e.element === 'skin-fonts-setup') await bandAction($, 'fonts', 'setup')
    else if (e.element === 'skin-fonts-close') {
      // Once per Claude session: how to get the row back (the card itself is gone now).
      if ((await closeRow($, 'fonts')) === 'closed' && !closeHintShown) { closeHintShown = true; toast($, 'Fonts closed. /skin fonts brings them back.', 6_000) }
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
        description: 'Recolour the whole Claude app: /skin <name>, /skin off, /skin remove, /skin status, /skin check, /skin type on|off, /skin type on --tick (no skin), /skin band on|off, /skin list, /skin log, /skin about',
        argumentHint: argumentHintOf((await skinNames($), oneClickNow), fontsNow),
      })
    } catch {
      $.ui.status('Reskin: /skin is taken by another plugin. Disable one of them to use Reskin.')
    }
    // The appearance band, if it was left on: drawn at once with plain words, its claims read in the background.
    await restoreBand($)
    return next(e)
  })

  on('command.run', { command: 'skin' }, async ($, e, next) => {
    // Reskin light (2.1.0): a mod loaded after this one (the light flavour) sees every /skin first, so its Code tab
    // colours follow /skin <name> and /skin off whichever mod loads first. Its answer is not used here; a failure in it
    // never stops this command.
    await Promise.resolve().then(() => next(e)).catch(() => undefined)
    // The appearance band (5 Nov 2026): /skin band on|off, remembered. Changes nothing in Claude's look.
    const bw = bandWord(e.args)
    if (bw === 'bad') return { text: 'Use /skin band on or /skin band off.' }
    if (bw !== null) return { text: await setBand($, bw) }
    // Bounded: a slow folder read never holds a typed command; the last list is used then.
    const parsed = parse(e.args, (await within($, skinNames($), names?.list ?? [], 10_000), oneClickNow))
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
      answer = await handle($, parsed, steps, (x: string) => { tool = x }, (p: LogRecord['preset']) => { preset = p })
    } catch (err) {
      answer = { text: err instanceof StillFinishing ? err.message : `The skin step did not finish: ${(err as Error).message}`, result: 'failed' }
    }
    // The band's claims were cleared when the change started; read them again now it has ended.
    if (changes(parsed.kind)) void readIfShown($)
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
// The /skin runs that may change what Claude looks like.
const changes = (kind: string) => ['apply', 'off', 'remove', 'type', 'font', 'set', 'start'].includes(kind)

// ---- The appearance band (5 Nov 2026), one operation at a time ----
// The rule: at most ONE band operation runs at a time (`op`): opening a row (with its read of what is on), Apply, Reset,
// setup, and the proof read the mod starts by itself. A press while one runs, or while a /skin run holds the run guard,
// changes nothing and says so in a short note. A typed /skin command waits for a running band operation (up to
// OP_WAIT_MS) before it takes the run guard, so it is never refused because of the band. Closing a row and the dropdowns
// change the atom in one synchronous update each and are ignored while an operation runs. Nothing about the band ever
// overlaps, so no answer can arrive for a row or a proof that changed meanwhile.
let op: Promise<void> | null = null
const OP_WAIT_MS = 20_000
const BUSY_NOTE = 'Reskin is busy with another step. Try again in a moment.'
const toast = ($: EngineInterface, text: string, ms = 5_000) => { try { $.ui.toast(text, { timeoutMs: ms }) } catch {} }
// Every lookup inside an operation has a time limit, so an operation always ends.
const LOOKUP_MS = 10_000
const envIn = ($: EngineInterface) => within($, resolveEnv($, currentOptions), 'Reskin could not find its tool in time. Try again.', LOOKUP_MS)
const presetsIn = ($: EngineInterface, tool: string) => within($, presets($, tool).catch(() => [] as Preset[]), [] as Preset[], LOOKUP_MS)
// Free right now for a press (no operation, no /skin run): checked before anything else a press does.
const freeNow = () => op === null && !isRunning
let fontsOpenSeq = 0
// Runs `fn` as the band's one operation, or refuses at once (the run guard or another operation): never waits.
// ownRun: the caller is a typed /skin run that holds the run guard itself (its own /skin fonts off), so only `op` counts.
function runOp($: EngineInterface, fn: () => Promise<void>, quiet = false, ownRun = false): Promise<boolean> {
  if (op !== null || (isRunning && !ownRun)) { if (!quiet) toast($, BUSY_NOTE); return Promise.resolve(false) }
  // True only when the operation finished without an error; admission alone is not success.
  // A failure in an operation the user started always shows a note; the mod's own reads stay quiet.
  let ok = true
  const p = fn().catch((err) => { ok = false; if (!quiet) toast($, `That step could not finish (${String((err as Error)?.message ?? err).slice(0, 80)}). Try again.`, 8_000) }).finally(() => { if (op === p) op = null })
  op = p
  return p.then(() => ok)
}
// For a typed /skin command: waits for the band's operation to end (bounded). True when none is running now.
// One operation can hand over to the next (band on, then its read): the current one is looked at again after each wait,
// all within one deadline.
async function waitOp($: EngineInterface): Promise<boolean> {
  if (op === null) return true
  let t: { cancel: () => void } | undefined
  let expired = false
  const late = new Promise<void>(r => { try { t = $.clock.after(OP_WAIT_MS, () => { expired = true; r() }) } catch { expired = true; r() } })
  try {
    while (op !== null && !expired) await Promise.race([op, late])
    return op === null
  } finally { t?.cancel() }
}

// /skin band on|off, remembered: an operation like any other (waited for, as for any typed command), so it never
// overlaps a row opening or an Apply, and two of them apply in order.
async function setBand($: EngineInterface, on: boolean): Promise<string> {
  if (!(await waitOp($)) || isRunning) return BUSY_NOTE
  const ran = await runOp($, async () => {
    await saveBand($, on)
    if (on) { await update($, band, b => ({ ...b, on: true })); return }
    // Off: the rows close too (no operation is running now, so none is busy). The claims keep their own expiry.
    await update($, band, b => ({ ...b, on: false, row: null, rowId: b.rowId + 1 }))
    await update($, fontsCard, () => null)
  })
  if (!ran) return op !== null || isRunning ? BUSY_NOTE : 'The band could not be changed just now. Try again.'
  if (!on) return 'Appearance band off. /skin band on brings it back; /skin fonts still opens the fonts row.'
  void readProof($, true)
  return 'Appearance band on: Skins, Fonts and Sidebar above the message box. Press one to open its row; nothing changes until you press Apply. /skin band off hides it.'
}
// The remembered on/off: writes go one after another in the order asked, so a slow older write can never land after a
// newer one. The command does not wait more than LOOKUP_MS for it.
let storeChain: Promise<unknown> = Promise.resolve()
function saveBand($: EngineInterface, on: boolean): Promise<unknown> {
  const p = storeChain.then(() => $.store.set('band', on)).catch(() => {})
  storeChain = p
  return within($, p.then(() => true), false, LOOKUP_MS)
}
// The band left on in an earlier session: drawn at once with plain words, its claims read in the background.
async function restoreBand($: EngineInterface) {
  let on = false
  await runOp($, async () => {
    on = (await within($, $.store.get('band').catch(() => undefined), undefined, LOOKUP_MS)) === true
    if (on) await update($, band, b => ({ ...b, on: true }))
  }, true)
  if (on) void readProof($, false)
}
// A /skin run that may change the look starts: the claims go at once. (Runs and band operations never overlap.)
async function clearClaims($: EngineInterface) {
  await update($, band, b => ({ ...b, gen: b.gen + 1, proof: null, now: null }))
}
// After a change: a fresh read, if the band or one of its rows is showing (the fonts row shows what its own Apply proved).
async function readIfShown($: EngineInterface) {
  const b = await read($, band)
  if (b.on || b.row !== null) await readProof($, false)
}

// The proof read (`look show`), as the band's operation (quiet: a read the mod starts by itself never shows a note).
// lockWait: a read the user asked for waits for the tool's run lock like any command; one the mod starts does not.
function readProof($: EngineInterface, lockWait: boolean): Promise<boolean> {
  return runOp($, async () => { await applyProof($, await lookShow($, lockWait)) }, true)
}
// One `look show`, bounded (READ_WAIT_MS): its output, or null when it failed or ran out of time. Inside an operation only.
const READ_WAIT_MS = 15_000
async function lookShow($: EngineInterface, lockWait: boolean, steps: Steps = []): Promise<string | null> {
  let out: string | null = null
  const work = (async () => {
    const env = await envIn($)
    if (typeof env === 'string') return
    out = (await quick($, env, ['look', 'show'], steps, 'band (colour helper)', QUICK_LIMIT_MS, { lockWait })).stdout
  })().catch(() => {})
  let t: { cancel: () => void } | undefined
  const late = new Promise<'late'>(r => { try { t = $.clock.after(READ_WAIT_MS, () => r('late')) } catch { r('late') } })
  const how = await Promise.race([work.then(() => 'done' as const), late]).finally(() => t?.cancel())
  // Out of time: the answer is not used, and the work still under way is tracked like any
  // work the mod stopped waiting for (a tick waits for it; the tool's lock keeps every other run behind it).
  if (how === 'late') {
    const tail: Promise<void> = work.finally(() => { tails.delete(tail) })
    tails.add(tail)
    return null
  }
  return out
}
// A read's answer (inside an operation): claims, the helper state for the rows, the open row's untouched dropdowns, and
// "Checking…" ends. A failed read claims nothing. Expires PROOF_TTL_MS later.
let latestProofId = 0
async function applyProof($: EngineInterface, stdout: string | null) {
  const proof = stdout === null ? NO_PROOF : proofOf(stdout)
  let id = 0
  await update($, band, b => {
    id = b.proofId + 1
    const drafts = b.row === null || b.touched || b.busy ? b.drafts : {
      skin: proof.skin === 'unknown' ? b.drafts.skin : proof.skin,
      sidebar: proof.sidebar === 'unknown' ? b.drafts.sidebar : proof.sidebar,
    }
    return { ...b, proof, proofId: id, helper: proof.helper, drafts, checking: 0 }
  })
  latestProofId = id
  expiry?.cancel()
  try { expiry = $.clock.after(PROOF_TTL_MS, () => { void update($, band, b => (b.proofId === id ? { ...b, proof: null, now: null } : b)) }) } catch {}
}

// ---- Rows ----
// An opener's press toggles its row: open when closed (the other rows close: one row at a time), closed when open. The
// whole decision is the operation: it looks at the rows only once admitted.
async function openRow($: EngineInterface, row: BandRow) {
  await runOp($, async () => {
    const b = await read($, band)
    if (b.row === row) { await update($, band, x => ({ ...x, row: null, rowId: x.rowId + 1 })); return }
    const env = await envIn($)
    if (typeof env !== 'string') presetNames = (await presetsIn($, env.tool)).map(p => p.name)
    await update($, fontsCard, () => null)
    await update($, band, x => ({
      ...x, row, rowId: x.rowId + 1, touched: false, checking: 1, status: '', now: null,
      drafts: x.proof === null ? x.drafts : { skin: x.proof.skin === 'unknown' ? x.drafts.skin : x.proof.skin, sidebar: x.proof.sidebar === 'unknown' ? x.drafts.sidebar : x.proof.sidebar },
    }))
    await applyProof($, await lookShow($, true))
  })
}

// ✕ on a band row, ✕ on the fonts row, /skin fonts off: an operation too (refused with a note while one runs).
// ownRun: typed /skin fonts off, which holds the run guard itself.
async function closeRow($: EngineInterface, which: 'band' | 'fonts', ownRun = false): Promise<'none' | 'busy' | 'closed'> {
  let r: 'none' | 'busy' | 'closed' = 'none'
  const ran = await runOp($, async () => {
    if (which === 'band') {
      const b = await read($, band)
      if (b.row === null) return
      await update($, band, x => ({ ...x, row: null, rowId: x.rowId + 1 }))
    } else {
      if ((await read($, fontsCard)) === null) return
      await update($, fontsCard, () => null)
    }
    r = 'closed'
  }, false, ownRun)
  return ran ? r : 'busy'
}

// The fonts row's content from one read (inside an operation or the run guard). Closes any band row (one row at a time).
let closeHintShown = false
async function installFonts($: EngineInterface, stdout: string | null, fromButton: boolean): Promise<{ helper: string; result: string }> {
  await applyProof($, stdout)
  const info = lookInfoOf(stdout ?? '')
  const helper = info?.helper ?? 'unread'
  const look = info?.look ?? null
  await update($, band, x => (x.row === null || x.busy ? x : { ...x, row: null, rowId: x.rowId + 1 }))
  await update($, fontsCard, () => ({ helper, look, section: 'all', picks: allPicks(look ?? []), busy: false, fromButton, openId: ++fontsOpenSeq,
    status: helper !== 'active' ? '' : look === null ? 'The fonts that are on now could not be proven. Choose and apply, or run /skin font off first.' : '' }))
  return { helper, result: stdout === null ? 'failed' : resultOf(stdout, 0) }
}

// The Fonts opener (any band mod may draw it): toggles the fonts row, prints nothing in the chat, logged. The whole
// decision is the operation.
async function openFromButton($: EngineInterface) {
  const steps: Steps = []
  const t0 = nowOf($)
  const portBefore = portNow($)
  let shown = '', result = 'failed'
  await runOp($, async () => { try {
    if (!fontsNow) await within($, skinNames($).catch(() => []), [], LOOKUP_MS) // the release switch is read with the presets
    if (!fontsNow) { toast($, 'Fonts are not in this release.'); return }
    if ((await read($, fontsCard)) !== null) { await update($, fontsCard, () => null); return }
    const o = await installFonts($, await lookShow($, true, steps), true)
    shown = o.helper === 'active' ? 'fonts card opened' : noLookText(o.helper)
    result = o.result
  } catch (err) { shown = `The fonts row could not be opened (${(err as Error).message}).`; throw err } })
  if (steps.length > 0) {
    const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
    void writeLog($, {
      command: '/skin fonts (opener button)', tool: 'see step', preset: null, steps, shown, result,
      exitCode: steps.at(-1)?.exitCode ?? null, t0, ms: nowOf($) - t0, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
    })
  }
}

// ---- Actions: Apply, Reset, setup (band rows and the fonts row), each the band's one operation ----
// The run guard is held too, so no typed /skin run starts meanwhile; the choices are read once, at the start, and the
// dropdowns ignore picks until the operation ends.
async function bandAction($: EngineInterface, which: 'band' | 'fonts', button: 'apply' | 'reset' | 'setup') {
  await runOp($, async () => {
    // The row is marked busy and its choices are read in ONE update: a dropdown pick lands either
    // before it (and is what gets sent) or after it (and is ignored, the row being busy); never in between.
    let b: Band = BAND0
    let f: FontsCard | null = null
    let claimed = false
    if (which === 'band') await update($, band, x => { b = x; if (x.row === null || x.busy) return x; claimed = true; return { ...x, busy: true, status: 'Applying…', now: null } })
    else {
      b = await read($, band)
      await update($, fontsCard, c => { f = c; if (c === null || c.busy) return c; claimed = true; return { ...c, busy: true, status: 'Applying…' } })
    }
    if (!claimed) return
    const setStatus = (status: string, busy: boolean) => (which === 'fonts'
      ? update($, fontsCard, c => (c === null ? c : { ...c, busy, status }))
      : update($, band, x => ({ ...x, busy, status, ...(busy ? {} : { touched: false }) })))
    const fc = f as FontsCard | null
    const row: RowId = which === 'fonts' ? 'fonts' : b.row!
    const helper = which === 'fonts' ? fc!.helper : b.helper
    const act = actionOf(row, button, b.drafts)
    if (act === null || (act.runner === 'tick' ? helper !== 'none' : helper !== 'active')) { await setStatus('', false); return }
    isRunning = true
    const steps: Steps = []
    const t0 = nowOf($)
    const portBefore = portNow($)
    let shown = '', result = 'failed', toolDir = 'not looked up', shownFull = ''
    let started = false
    // The skin a Skins-row Apply or setup sends, for the log header (it said "none" before, 5 Nov 2026 live look).
    let logPreset: LogRecord['preset'] = null
    try {
      await setStatus(act.runner === 'tick' ? 'Setting up: follow the card above.' : 'Applying…', true)
      await clearClaims($)
      const env = await envIn($)
      if (typeof env === 'string') { shown = env; result = 'refused'; return }
      toolDir = env.tool
      const sent = row === 'skins' ? act.args[1] : undefined
      if (sent !== undefined && sent !== 'off') {
        const p = (await presetsIn($, env.tool)).find(x => x.name === sent)
        logPreset = { name: sent, mode: p?.mode ?? 'unknown' }
      }
      if (act.runner === 'quick') {
        const r = await quick($, env, act.args, steps, 'band (colour helper)', act.args[0] === 'type' ? SLOT_LIMIT_MS : QUICK_LIMIT_MS)
        result = resultOf(r.stdout, r.exitCode)
        shown = bandStatusOf(r.stdout, r.stderr, r.exitCode)
        if (row === 'sidebar' && result === 'ok') { shownFull = shown; shown = sidebarDone(act.args[1] ?? 'on') }
      } else {
        const noSkin = act.args[1] === 'off'
        const r = await streamed($, env, act.args, steps, act.args.some(a => a.startsWith('--want-')) ? START_WANTS_LIMIT_MS : noSkin ? START_LIMIT_MS : RUN_LIMIT_MS, true)
        result = noSkin ? (startResult(r.stdout) ?? 'failed') : resultOf(r.stdout, r.exitCode)
        const text = noSkin ? startSummary(r.exitCode, r.stdout, r.stderr) : summary(act.args[1] ?? '', r.exitCode, r.stdout, r.stderr)
        shown = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? (result === 'ok' ? 'Done.' : 'Did not finish.')
        started = result === 'ok'
        // A run that worked can still carry a safety warning (2.0: the debugger opened again after the run and was
        // closed; the menu item may still show a tick). The whole answer is then shown as well, as after a failure.
        const warned = text.split('\n').some(l => l.includes('WARNING:'))
        if (result === 'ok' && warned) {
          toast($, text, 60_000)
          shown = `${shown} (with a warning: read the message above; /skin log has all of it)`
        }
        if (result !== 'ok') {
          // The whole answer stays visible: a long toast with every line, and the
          // status line under the prompt keeps the recovery step (never the tick instruction itself) until the next run.
          const recovery = text.split('\n').map(l => l.trim()).find(l => l !== '' && !/^NOW:/i.test(l) && !/\bclick\b/i.test(l) && /untick|still (be )?open|quit and reopen/i.test(l))
          const portBad = /^PORT_STATE: (open|unknown)$/m.test(r.stdout)
          const urgent = recovery ?? (portBad ? 'the debugger port may still be open: quit and reopen Claude (Cmd+Q, then open it again).' : null)
          toast($, text, 60_000)
          if (urgent) { try { $.ui.status(`Reskin: ${urgent}`) } catch {} }
          shown = `${shown} (details in the message above; /skin log has all of it)`
        }
        shownFull = text
      }
    } catch (err) {
      shown = err instanceof StillFinishing ? err.message : `Did not finish: ${(err as Error).message}`
    } finally {
      isRunning = false
      await setStatus(shown, false)
      const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
      void writeLog($, {
        command: `/skin band (${row}: ${button})`, tool: toolDir, preset: logPreset, steps, shown: shownFull || shown, result,
        exitCode: steps.at(-1)?.exitCode ?? null, t0, ms: nowOf($) - t0, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
      })
    }
    // Still the same operation: the row shows what is on now (after a good setup on the fonts row, its fonts).
    const stdout = await lookShow($, false)
    if (row === 'fonts' && started && (await read($, fontsCard)) !== null) await installFonts($, stdout, fc?.fromButton ?? true)
    else await applyProof($, stdout)
    // Option C: an Apply the tool reported done AND this read proves (the same skin on now) says so by name, with six
    // chips from the skin's own preset file. Anything less keeps the tool's own line.
    const asked = act.args[1] ?? ''
    if (which === 'band' && row === 'skins' && button === 'apply' && result === 'ok' && asked !== 'off' && stdout !== null && proofOf(stdout).skin === asked && toolDir !== 'not looked up') {
      const css = await within($, $.fs.read(`${toolDir}/presets/${asked}.css`).catch(() => ''), '', LOOKUP_MS)
      const chips = chipsOf(typeof css === 'string' ? css : '')
      // Only with all six colours read: otherwise the tool's own line stays.
      if (chips !== null) await update($, band, x => (x.row !== 'skins' || x.busy || x.touched || x.proof?.skin !== asked ? x : { ...x, status: '', now: { skin: asked, light: chips.light, dark: chips.dark } }))
    }
  })
}

// Apply (or "Claude's own") on the fonts row: one tool run, `look set`, through the colour helper only (no tick, no
// port), as the band's one operation. Logged like every /skin run. The row then shows what the helper proved.
async function applyFonts($: EngineInterface, reset: boolean) {
  await runOp($, async () => {
    // Busy and the choices in ONE update, as for the band's Apply.
    let f: FontsCard | null = null
    await update($, fontsCard, c => { if (c === null || c.busy || c.helper !== 'active') return c; f = c; return { ...c, busy: true, status: 'Applying…' } })
    if (f === null) return
    const fc: FontsCard = f
    const id = fc.section as SectionId
    const picks = reset ? defaultPicks(id) : fc.picks[id]
    isRunning = true
    const steps: Steps = []
    const t0 = nowOf($)
    const portBefore = portNow($)
    let shown = '', result = 'failed', toolDir = 'not looked up', status = ''
    let more: Partial<FontsCard> = {}
    try {
      await clearClaims($)
      const env = await envIn($)
      if (typeof env === 'string') { shown = env; status = env; result = 'refused'; return }
      toolDir = env.tool
      const r = await quick($, env, setArgs(id, picks), steps, 'fonts card (colour helper)', LOOK_LIMIT_MS)
      const info = lookInfoOf(r.stdout)
      shown = resultLineOf(r.stdout, r.stderr, r.exitCode)
      result = resultOf(r.stdout, r.exitCode)
      status = shortStatus(result, shown, reset, info !== null && info.look !== null)
      if (info) {
        const proved = info.look
        more = { helper: info.helper, look: proved }
        // The part just sent shows what the helper proved; the other parts keep their unsent choices (All parts changes
        // every part's font, so then every part shows what was proved).
        if (proved) more.picks = id === 'all' ? allPicks(proved) : { ...fc.picks, [id]: allPicks(proved)[id], all: allPicks(proved).all }
      }
    } catch (err) {
      shown = err instanceof StillFinishing ? err.message : `The change did not finish: ${(err as Error).message}`
      status = shown
    } finally {
      isRunning = false
      await update($, fontsCard, c => (c === null ? c : { ...c, ...more, busy: false, status }))
      const toolPort = [...(steps.at(-1)?.marks ?? '').matchAll(/PORT_STATE: (open|closed|unknown)$/gm)].at(-1)?.[1] as PortState | undefined
      void writeLog($, {
        command: `/skin fonts (${reset ? 'Claude\'s own' : 'apply'}: ${id})`, tool: toolDir, preset: null, steps, shown, result,
        exitCode: steps.at(-1)?.exitCode ?? null, t0, ms: nowOf($) - t0, portBefore, portAfter: toolPort ?? portNow($), portAfterFrom: toolPort ? 'the tool\'s own last check' : 'checked as the run ended',
      })
    }
    const b = await read($, band)
    if (b.on || b.row !== null) await applyProof($, await lookShow($, false))
  })
}

// One /skin run. `result` is what the log records: the tool's own RESULT line when a step ran, otherwise refused or
// answered (the mod answered by itself).
async function handle($: EngineInterface, parsed: ReturnType<typeof parse>, steps: Steps, found: Found, chosen: Chosen): Promise<{ text: string; result: string }> {
  if (parsed.kind === 'bad') return said(parsed.why, 'refused')
  // A band operation (a row opening, Apply, the band's own read) finishes first: a typed command waits for it.
  if (!(await waitOp($)) || op !== null) return said(BUSY_NOTE, 'refused')
  if (isRunning) return said('A skin change is already running. Wait for it to finish.', 'refused')
  // The guard is claimed before the first wait, so two runs can never start together (and no band operation starts).
  isRunning = true
  try {
    // A run that may change the look: the band's claims go at once.
    if (changes(parsed.kind)) await clearClaims($)
    const env = await envIn($)
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
      if (!parsed.show) { const r = await closeRow($, 'fonts', true); return said(r === 'busy' ? 'The fonts row is still being applied; close it when it is done.' : 'Fonts card closed.', 'answered') }
      const o = await installFonts($, await lookShow($, true, steps), false)
      return said(o.helper === 'active' ? CARD_HELP : noLookText(o.helper), o.result)
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
      if (retiredText(parsed.skin) !== null) return said(retiredText(parsed.skin)!, 'refused')
      const all = await presets($, env.tool).catch(() => [] as Preset[])
      const p = all.find(x => x.name === parsed.skin) ?? all.find(x => x.name === skinAlias(parsed.skin!))
      if (p === undefined) return said(retiredText(parsed.skin) ?? `No skin called ${parsed.skin}. ${listText(all, await macMode($), fontsNow)}`, 'refused')
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
        const o = await installFonts($, await lookShow($, true, steps), false).catch(() => ({ helper: 'unread', result: 'failed' }))
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
    if (retiredText(parsed.name) !== null) return said(retiredText(parsed.name)!, 'refused')
    const all = await presets($, env.tool).catch(() => [] as Preset[])
    if (all.length === 0) return said(`No skins found in ${env.tool}/presets.`, 'failed')
    // A short or old name (14 Nov 2026) is looked up after the typed name, so a real preset file always wins.
    const p = all.find(x => x.name === parsed.name) ?? all.find(x => x.name === skinAlias(parsed.name))
    if (p === undefined) return said(retiredText(parsed.name) ?? `No skin called ${parsed.name}. ${listText(all, await macMode($))}`, 'refused')
    chosen({ name: p.name, mode: p.mode })
    if (parsed.via === 'auto') {
      const r = await quick($, env, ['switch', p.name], steps)
      if (!(r.exitCode === 5 && noHelper(r.stdout))) return said(summary(p.name, r.exitCode, r.stdout, r.stderr), last(r))
    }
    const r = await streamed($, env, [parsed.via === 'one-click' ? 'one-click' : 'tick', p.name], steps)
    return said(summary(p.name, r.exitCode, r.stdout, r.stderr), last(r))
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

// ---- The fonts card (4 Nov 2026) and the appearance band (5 Nov 2026; layout C) ----
// Drawn above the message box (the tick card goes first). One outer renderer composes the band, the open row and the
// other plugins' drawing (next(e)) once.
// - Band on: Reskin's own quiet line of three plain openers at the left (Skins, Fonts, Sidebar), and under it the open
//   row, one at a time, after a one-step gap: the dropdown(s), then Apply and Reset, together at the left, and the ✕
//   alone at the far right (the owner's live look, 5 Nov). Whole dropdowns wrap to the next line when the window is narrow;
//   Apply and Reset stay together. Any message (status, checking, the helper's state) follows Reset, or takes its own
//   line and wraps when it does not fit, never cut. The open opener is bold in the proven skin's accent.
// - Band off, a row opened by another band's opener: the same row alone.
// - Band off, the fonts row opened by typing /skin fonts: the 1.7.2 look (✕ on the left, under the message box's +).
// Each dropdown sits in a Box that never shrinks, at its natural width (held): in the old squeezed row it collapsed
// (live test, 5 Nov 2026).
type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Parts = { controls: unknown[]; notes: unknown[]; apply: unknown; reset: unknown; setup: unknown }
function drawBand($: EngineInterface, e: any, next: (e: any) => unknown, b: Band, f: FontsCard | null) {
  return (async () => {
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn !== null && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const accent = b.proof?.accent ?? undefined
    const open: RowId | null = f !== null ? 'fonts' : b.row
    const op = (key: string, id: RowId, label: string) => open === id
      ? <Button key={key} plain onPress={() => {}}><Text bold color={accent}>{label}</Text></Button>
      : <Button key={key} label={label} plain dimColor onPress={() => {}} />
    const openers = b.on && (
      <Box key="skin-band-openers" flexDirection="row" gap={2} alignItems="center">
        {op(SKINS_OPENER, 'skins', OPENER_LABELS.skins)}
        {op(FONTS_OPENER, 'fonts', OPENER_LABELS.fonts)}
        {op(SIDEBAR_OPENER, 'sidebar', OPENER_LABELS.sidebar)}
      </Box>
    )
    // The row under the openers, or alone.
    let row: unknown = null
    if (f !== null && !b.on && !f.fromButton) row = fontsTyped($, ui, f, accent)
    else if (open !== null) {
      const cols = e.props?.bodyColumns
      const compact = typeof cols === 'number' && cols < SHORT_SETUP_BELOW
      const parts = open === 'fonts' && f !== null ? fontsParts($, ui, f, accent, compact) : bandParts($, ui, b, accent, compact)
      const close = <Button key={open === 'fonts' ? 'skin-fonts-close' : 'skin-band-close'} label="✕" plain dimColor onPress={() => {}} />
      const actions = parts.setup !== null || parts.apply !== null
        ? (
          <Box key="skin-band-actions" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {(parts.setup ?? parts.apply) as any}
            {parts.setup === null && (parts.reset as any)}
          </Box>
        )
        : null
      // The owner's live looks (5 Nov 2026): a gap under the openers; the choices tight at the left; any message right after
      // Reset (it moves to its own line and wraps only when it does not fit); the ✕ alone at the far right. The left
      // group wraps whole dropdowns in a narrow window; the ✕ never moves off the right edge.
      row = (
        <Box key="skin-band-row" flexDirection="column" paddingTop={b.on ? 1 : 0}>
          <Box key="skin-band-rowline" flexDirection="row" alignItems="center">
            {/* The owner's live look (5 Nov 2026, 1.9.0): the desktop draws a dropdown's frame about one cell left of its slot, so
                a row that starts with a dropdown sat left of the "Skins" opener above it. One cell in lines the frame up. */}
            <Box key="skin-band-line" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} alignItems="center" flexShrink={1} minWidth={0} paddingLeft={(parts.controls as unknown[]).length > 0 ? 1 : 0}>
              {parts.controls as any}
              {actions}
              {notesBox(ui, parts.notes)}
            </Box>
            <Box flexGrow={1} />
            <Box key="skin-band-close-cell" flexShrink={0}>{close}</Box>
          </Box>
        </Box>
      )
    }
    if (!openers && row === null) return below
    return (
      <Box flexDirection="column">
        {openers || null}
        {row as any}
        {below}
      </Box>
    )
  })()
}

// A dropdown in its own box that never shrinks, at the dropdown's natural width. the owner's live look 2 (5 Nov 2026): a
// width guessed from the longest choice left wide empty gaps, because the desktop draws the dropdown narrower; the
// collapse in the first live test came from shrinking, which flexShrink 0 alone stops (live look 1).
function held(ui: Ui, key: string, _options: readonly { value: string; label?: string }[], select: unknown) {
  const { Box } = ui
  return <Box key={`${key}-box`} flexShrink={0}>{select as any}</Box>
}

// The row's messages, last in the wrapping group: right after Reset when they fit, else on a line of their own,
// wrapped to the row's width (they may shrink; their text wraps, never cut).
function notesBox(ui: Ui, notes: unknown[]) {
  const { Box } = ui
  if (notes.length === 0) return null
  return <Box key="skin-band-notes" flexDirection="column" flexShrink={1} minWidth={0}>{notes as any}</Box>
}

// The Skins and Sidebar rows' controls: one dropdown (drafts only), and the row's messages.
function bandParts($: EngineInterface, ui: Ui, b: Band, accent: string | undefined, compact = false): Parts {
  const { Text, Button } = ui
  const Select = 'Select' in ui ? ui.Select : undefined
  const st = rowState(b.helper)
  // Ignored while a band operation runs (its choices were read when it started).
  const pick = (fn: (d: Band['drafts']) => Band['drafts']) => { if (!freeNow()) return; void update($, band, x => (x.busy || x.rowId !== b.rowId ? x : { ...x, drafts: fn(x.drafts), touched: true, status: '', now: null })) }
  const controls: unknown[] = []
  const notes: unknown[] = []
  if (b.checking && b.helper === 'unread') notes.push(<Text key="skin-band-checking" dimColor>Checking…</Text>)
  else if (!st.controls) notes.push(<Text key="skin-band-text" dimColor wrap="wrap">{st.text}</Text>)
  else if (Select === undefined) notes.push(<Text key="skin-band-nosel" dimColor wrap="wrap">Use the desktop app to choose.</Text>)
  else if (b.row === 'skins') {
    const options = skinOptions(presetNames)
    controls.push(held(ui, 'skin-band-skin', options, <Select key="skin-band-skin" value={b.drafts.skin} options={options} onSelect={(v: string) => pick(d => ({ ...d, skin: v }))} />))
  } else {
    controls.push(held(ui, 'skin-band-sidebar', SIDEBAR_OPTIONS, <Select key="skin-band-sidebar" value={b.drafts.sidebar} options={[...SIDEBAR_OPTIONS]} onSelect={(v: string) => pick(d => ({ ...d, sidebar: v === 'off' ? 'off' : 'on' }))} />))
  }
  if (b.status !== '') notes.push(<Text key="skin-band-status" dimColor wrap="wrap">{b.status}</Text>)
  // Only while a current read still proves that very skin: an expired or cleared proof drops it.
  else if (b.row === 'skins' && b.now !== null && b.proof !== null && b.proof.skin === b.now.skin) notes.push(nowOnLine(ui, b.now, accent))
  const ready = st.controls && !(b.checking && b.helper === 'unread') && Select !== undefined
  const apply = ready && !st.setup ? <Button key="skin-band-apply" plain onPress={() => {}}><Text bold color={accent}>{b.busy ? 'Applying…' : 'Apply'}</Text></Button> : null
  const reset = ready && !st.setup && b.row === 'skins' ? <Button key="skin-band-reset" label="Reset" plain dimColor onPress={() => {}} /> : null
  const setup = ready && st.setup ? <Button key="skin-band-setup" plain onPress={() => {}}><Text bold color={accent}>{b.busy ? 'Setting up…' : compact ? 'Set up…' : 'Set up with one tick…'}</Text></Button> : null
  return { controls, notes, apply, reset, setup }
}

// Option C's line (the owner's pick, 5 Nov 2026): "✓ Now on:
// <skin>" and six chips (light page, sidebar, accent, a gap, dark page, sidebar, accent). Each chip is two spaces on its
// colour. The line never shrinks (layout C: natural widths, no cut-off text); in a narrow window it moves whole to its
// own line, as any message does.
function nowOnLine(ui: Ui, now: NowOn, accent: string | undefined) {
  const { Box, Text } = ui
  const chip = (c: string, k: string) => <Text key={k} backgroundColor={c}>{'  '}</Text>
  return (
    <Box key="skin-band-now" flexDirection="row" alignItems="center" flexShrink={0} columnGap={1}>
      <Text bold color={accent}>✓ Now on:</Text>
      <Text key="skin-band-now-name" bold>{skinLabel(now.skin)}</Text>
      <Box key="skin-band-chips" flexDirection="row" flexShrink={0}>
        {now.light.map((c, i) => chip(c, `skin-chip-l${i}`))}
        <Text>{' '}</Text>
        {now.dark.map((c, i) => chip(c, `skin-chip-d${i}`))}
      </Box>
    </Box>
  )
}

// The fonts row's controls (the four dropdowns), its messages, and its own Apply and Reset.
function fontsParts($: EngineInterface, ui: Ui, f: FontsCard, accent: string | undefined, compact = false): Parts {
  const { Text, Button } = ui
  const Select = 'Select' in ui ? ui.Select : undefined
  const sec = sectionOf(f.section)
  const p = f.picks[sec.id]
  const uiFont = f.picks.ui.font
  // Only the fonts row this dropdown belongs to, and never while busy.
  const set = (fn: (c: FontsCard) => FontsCard) => { if (!freeNow()) return; void update($, fontsCard, c => (c === null || c.busy || c.openId !== f.openId ? c : fn(c))) }
  const active = f.helper === 'active'
  const controls: unknown[] = []
  const notes: unknown[] = []
  if (!active) notes.push(<Text key="skin-fonts-text" dimColor wrap="wrap">{noLookText(f.helper)}</Text>)
  if (active && Select === undefined) notes.push(<Text key="skin-fonts-nosel" dimColor wrap="wrap">Use the desktop app to choose fonts.</Text>)
  if (active && Select !== undefined) {
    const secOpts = SECTIONS.map(s => ({ value: s.id, label: s.label }))
    controls.push(held(ui, 'skin-fonts-section', secOpts, <Select key="skin-fonts-section" value={sec.id} options={secOpts}
      onSelect={(v: string) => set(c => ({ ...c, section: sectionOf(v).id, status: '' }))} />))
    const fontOpts = fontOptions(sec.id)
    controls.push(held(ui, 'skin-fonts-font', fontOpts, <Select key="skin-fonts-font" value={p.font} options={fontOpts}
      onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: withFont(sec.id, c.picks[sec.id], v, sec.id === 'ui' ? v : c.picks.ui.font) }, status: '' }))} />))
    if (sec.sizes.length > 0) {
      const sizeOpts = sizeOptions(sec.id)
      controls.push(held(ui, 'skin-fonts-size', sizeOpts, <Select key="skin-fonts-size" value={p.size} options={sizeOpts}
        onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: { ...c.picks[sec.id], size: v } }, status: '' }))} />))
    }
    if (sec.weights.length > 0) {
      const weightOpts = weightOptions(sec.id, p.font, uiFont)
      controls.push(held(ui, 'skin-fonts-weight', weightOpts, <Select key="skin-fonts-weight" value={p.weight} options={weightOpts}
        onSelect={(v: string) => set(c => ({ ...c, picks: { ...c.picks, [sec.id]: { ...c.picks[sec.id], weight: v } }, status: '' }))} />))
    }
  }
  if (f.status !== '') notes.push(<Text key="skin-fonts-status" dimColor wrap="wrap">{f.status}</Text>)
  const ready = active && Select !== undefined
  const apply = ready ? <Button key="skin-fonts-apply" plain onPress={() => {}}><Text bold color={accent}>{f.busy ? 'Applying…' : 'Apply'}</Text></Button> : null
  const reset = ready ? <Button key="skin-fonts-reset" label="Reset" plain dimColor onPress={() => {}} /> : null
  const setup = f.helper === 'none' && Select !== undefined ? <Button key="skin-fonts-setup" plain onPress={() => {}}><Text bold color={accent}>{f.busy ? 'Setting up…' : compact ? 'Set up…' : 'Set up with one tick…'}</Text></Button> : null
  return { controls, notes, apply, reset, setup }
}

// The fonts row opened by typing /skin fonts with the band off. Owner's screenshots (5 Nov 2026): no gap above or
// below, and no left gap while the ✕ leads the row, so the ✕ lines up with the message box's +. Since layout C
// it wraps like the band's row: the dropdowns never shrink, so a row that does not
// fit moves whole dropdowns, then Apply and Reset together, to the next line. Messages after Reset, as in the band row.
function fontsTyped($: EngineInterface, ui: Ui, f: FontsCard, accent: string | undefined) {
  const { Box, Text, Button } = ui
  const parts = fontsParts($, ui, f, accent)
  return (
    <Box key="skin-fonts-row" flexDirection="column">
      <Box key="skin-fonts-line" flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" paddingRight={1}>
        <Button key="skin-fonts-close" label="✕" plain dimColor onPress={() => {}} />
        <Text bold color={accent}>Fonts</Text>
        {parts.controls as any}
        {(parts.apply !== null || parts.setup !== null) && (
          <Box key="skin-band-actions" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {(parts.setup ?? parts.apply) as any}
            {parts.setup === null && (parts.reset as any)}
          </Box>
        )}
        {notesBox(ui, parts.notes)}
      </Box>
    </Box>
  )
}
