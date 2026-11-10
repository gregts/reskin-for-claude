#!/usr/bin/env node
// One-step Claude skin, "sidecar Chrome" version (fail-safe pass, 11 Oct 2026).
//
// Why a sidecar: ticking Claude's "Enable Main Process Debugger" menu item makes Claude run
// `open -a "Google Chrome" chrome://inspect`. macOS hands that to whichever Chrome is already
// running, so we start a throwaway Chrome (own empty profile, no window) first. The inspect tab
// lands there, and ending the throwaway Chrome removes it. Your own Chrome and tabs are never touched.
// On a Mac with no Google Chrome at all (asked by name, the way `open -a` asks), there is no throwaway Chrome: Claude's
// open fails, Claude shows a small "Inspector session is active" dialog, and the run clicks its button.
//
//   node skin-auto.mjs tick <preset|file.css|remove>
//                                         "I tick it": checks everything, then asks YOU to tick Developer > Enable Main
//                                         Process Debugger (60 s). No Accessibility, no throwaway Chrome, no AppleScript.
//   node skin-auto.mjs tick off [--want-font=<name|off>] [--want-type=on|off]
//                                         the no-skin tick: starts the colour helper only (no skin put on; any Reskin skin is
//                                         taken off), then brings back the asked and remembered fonts and headers
//   node skin-auto.mjs switch <preset|off|remove>
//                                         ask the colour helper inside Claude to switch (no tick, no port, no Chrome)
//   node skin-auto.mjs status             read-only: is a helper running, how many requests, the last skin
//   node skin-auto.mjs [one-click] <preset|stylesheet.css>
//                                         "one click": the run ticks the menu itself (needs Accessibility)
//   node skin-auto.mjs remove             take the skin off
//   node skin-auto.mjs batch a,b,c [--final previous|off]
//                                         try up to 6 presets in one run (screenshots in previews/batch-*), then restore
//   node skin-auto.mjs --check            read-only: report whether this Mac meets the requirements
//   add --dry-run to apply or remove: start the throwaway Chrome, check it, end it. No menu tick, no skin.
//
// Exit codes: 0 ok, 1 failed, 2 usage, 3 Claude's port could not be confirmed closed, 4 took too
// long, 5 refused before changing anything (see the message), 6 the throwaway Chrome could not be
// confirmed ended, 130 interrupted.
// The last two lines always read `PORT_STATE: closed|open|unknown` and `RESULT: ok|failed|refused`.
import { spawn, spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  CHROME_LOOKUP_JXA, EXIT, MIN_NODE_MAJOR, acquireLock, acquireLockWaiting, parseLockWait, ownTestSheets, chromeLookup, claudeRunning, dialogScript, guardScript,
  hideScript, identityOf, nodeOk, pgrepState, portState, safePid, watchDialog, writeAll,
  closeMessageThenApply, dialogReadScript, parseDialogRead, provesNoDialog, NO_CHROME_GUARD_FIRST_S, NO_CHROME_TIMES,
  CLAUDE_BINARY, TICK, LOCK_PORT, checksLine, helperActiveLine, judgeHealth, bandClaims, healthReport, expectedColours, judgeChecks, liveSession, parsePs, privateDir, readPrefs, sendSwitch,
  stateDirOf, writePrivateJson, writePrivateText, readPrivateJson, debuggerClosedLine, TICK_HINT, REOPENED_WARNING, secondLook, tcpProbe, TYPE_WHAT, typeLine,
  FONT_STACKS, FONT_LINKS, FONT_SIZES, fontFamily, fontName, fontKey, fontKeyOf, fontBase, splitFontKey, SIZE_MENU_LINE, FONT_INSTALLED_JXA, fontInstalled, FONT_MENU_LINE, fontLines, parseSetLine, runSetParts, restoreParts, slotPairOk, slotFailLine, buildPlan, planLine, runPlan, judgeOff, judgeNoSkin,
  SECTIONS, FONT_WEIGHTS, parseLook, lookKey, lookSetWants, lookOffered, lookFonts, fontLabel, fontWords, describeLook, mergeSection,
  RETIRED_SKINS, isRetired, retiredLine,
} from './skin-lib.mjs'
import { loggingOn, startRunLog } from './skin-log.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// The troubleshooting log (~/Library/Logs/Reskin/skin.log): one entry per run started directly. /skin runs are logged
// by the mod. Started first, so even a refusal is recorded. It never holds the run up: the port check runs alongside
// (read at exit; unknown if it had not answered), it copies what the run prints, and the facts, the cleaning and the
// writing happen in a background process after the run has ended.
if (loggingOn()) {
  try {
    const before = { state: 'unknown' }
    const check = spawn('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    let e = ''
    check.stdout.on('data', (d) => { o += d })
    check.stderr.on('data', (d) => { e += d })
    check.on('error', () => {})
    check.on('close', (status) => { before.state = portState({ status, error: null, stdout: o, stderr: e }).state })
    const stop = setTimeout(() => check.kill('SIGKILL'), 2_000)
    stop.unref()
    check.unref()
    process.on('exit', () => { try { check.kill('SIGKILL') } catch {} }) // never outlives the run
    startRunLog({ argv: process.argv.slice(2), tool: here, portBefore: () => before.state })
  } catch {}
}
const SKIN = path.join(here, 'skin.mjs')
const NODE = process.execPath // every child uses the Node that is running us, never whatever PATH finds
const SIDECAR_PREFIX = '/tmp/claude-skin-chrome.'

const finish = (result, code) => { console.log(`RESULT: ${result}`); process.exit(code) }

if (!nodeOk(process.versions.node)) {
  console.error(`Needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}). Nothing was changed.`)
  console.log('PORT_STATE: unknown')
  finish('refused', EXIT.refused)
}

// The run's own start: the deadline below counts from here, so the checks before the prompt (stylesheet, slot-offers,
// installed font) use up the same allowance the /skin mod counts from launching this process.
const RUN_START = Date.now()
// --lock-wait=<ms> (band, 5 Nov 2026) is read here and taken out, so no verb's own parser ever sees it.
const lockWait = parseLockWait(process.argv.slice(2))
const argv0 = lockWait.rest
// The first word may name the way to run: tick ("I tick it"), one-click (the run ticks), switch, status.
const verb = ['tick', 'one-click', 'switch', 'status', 'check', 'type', 'font', 'set', 'look'].includes(argv0[0]) ? argv0[0] : null
const tickMode = verb === 'tick'
const args = verb ? argv0.slice(1) : argv0
const PRESET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const presetFile = (name) => path.join(here, 'presets', `${name}.css`)
const STATE = stateDirOf(homedir())
// A1: the Developer menu only exists once Developer Mode is on. Same words as the /skin mod.
const DEV_MODE_LINE = 'First time only: in Claude choose Help > Troubleshooting > Enable Developer Mode (Claude restarts); the Developer menu then appears.'
const dryRun = args.includes('--dry-run')
const checkOnly = args.includes('--check')
const usage = (m) => { console.error(m); console.log('PORT_STATE: unknown'); finish('refused', EXIT.usage) }
if (lockWait.why) usage(lockWait.why)
// Release switch (B1): the public package ships `tick` only, marked by release.json beside this file with
// {"oneClick": false}. No file at all (a development copy): everything stays. Any file that is there counts as off unless
// it reads cleanly with "oneClick": true; a file that cannot be looked at counts as off too.
const oneClickShipped = (() => {
  const f = path.join(here, 'release.json')
  try { nodeFs.lstatSync(f) } catch (e) { return e.code === 'ENOENT' }
  try { return JSON.parse(readFileSync(f, 'utf8'))?.oneClick === true } catch { return false }
})()
// Every run that is not tick, switch, status, check or --check would tick the menu itself (one-click, batch, no verb).
// Fonts (3 Nov 2026): in the development copy only, until release.json says "font": true. Off also means no font
// sheets for the helper (skin.mjs reads the same file) and no font restored after a tick; the saved font is kept.
const fontShipped = (() => {
  const f = path.join(here, 'release.json')
  try { nodeFs.lstatSync(f) } catch (e) { return e.code === 'ENOENT' }
  try { return JSON.parse(readFileSync(f, 'utf8'))?.font === true } catch { return false }
})()
if ((verb === 'font' || verb === 'look') && !fontShipped) usage('Fonts are not in this release.')
if (!oneClickShipped && !tickMode && !['switch', 'status', 'check', 'type', 'font', 'set', 'look'].includes(verb) && !checkOnly) {
  usage('one-click is not in this release. Use: node skin-auto.mjs tick <preset> (or /skin <name> in Claude), then switch.')
}
const isBatch = args[0] === 'batch'
let dotSheets = [] // dotcheck-* sheets in this batch: deleted when the run ends, only once this run holds the lock
let dropSheets = null // set once this run holds the lock; run (once) before the lock is let go, never after
const dropSheetsOnce = () => { const f = dropSheets; dropSheets = null; f?.() }
if (isBatch && tickMode) usage('Batch mode runs in one-click mode only (it needs Claude in front for screenshots).')
// Batch has its own parser: `--final` takes a value, so the generic "first word" rule below would misread it.
const batchArgs = () => {
  const rest = args.slice(1)
  let final = 'previous'
  const words = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run' || rest[i] === '--screenshots-ok' || rest[i] === '--dot-census') continue
    if (rest[i] === '--final') { final = rest[++i]; continue }
    if (rest[i].startsWith('--')) usage(`Unknown option: ${rest[i]}`)
    words.push(rest[i])
  }
  if (final !== 'previous' && final !== 'off') usage('--final takes previous or off.')
  if (words.length !== 1) usage('Usage: node skin-auto.mjs batch name1,name2,... --screenshots-ok|--dot-census [--final previous|off] [--dry-run]')
  // The screenshots show the whole Claude window, the open chat included, so a real batch needs a clear OK.
  // A dot census takes no screenshots (only colours, kinds and hashed row addresses), so it needs no such OK.
  const dots = rest.includes('--dot-census')
  if (!dryRun && !dots && !rest.includes('--screenshots-ok')) usage('Batch mode saves screenshots of the whole Claude window, including the open chat and anything secret on screen (to a private folder). Open a harmless chat first, then run it again with --screenshots-ok.')
  const names = words[0].split(',')
  if (names.some((n) => !/^[a-z0-9-]+$/.test(n))) usage('Preset names use only lowercase letters, digits and dashes, separated by commas.')
  const retiredIn = names.find((n) => isRetired(n))
  if (retiredIn !== undefined) usage(retiredLine(retiredIn))
  const files = names.map((n) => path.join(here, 'presets', `${n}.css`))
  const missing = files.filter((f) => !existsSync(f))
  if (missing.length > 0) usage(`No such preset: ${missing.map((f) => path.basename(f, '.css')).join(', ')} (see presets/).`)
  // The same offline check skin.mjs runs again later: count, duplicates, inside presets/, stylesheet check.
  const checked = spawnSync(NODE, [SKIN, 'batch-check', final, ...files], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
  if (checked.status !== 0) {
    console.error(`The batch list did not pass the check, so nothing was started: ${(checked.stdout + checked.stderr).replace(/^Stopped: /m, '').trim().slice(0, 300)}`)
    console.log('PORT_STATE: unknown')
    finish('refused', EXIT.refused)
  }
  // Dot census test sheets are deleted when this run ends (any way but a hard kill), so they never linger in presets/.
  dotSheets = files.filter((f) => path.basename(f).startsWith('dotcheck-'))
  if (dotSheets.length > 0 && !dots) usage('dotcheck- presets are dot census test sheets: use them only with --dot-census.')
  return ['batch', final, ...files, ...(dots ? ['--dot-census'] : [])]
}
const arg = isBatch ? 'batch' : args.find((a) => !a.startsWith('--'))
// The no-skin tick (4 Nov 2026): `off` is a target for `tick` only, checked before the generic target handling, so bare
// `off`, `one-click off`, a batch with off and off with --check are refused in every copy. `tick remove` keeps its meaning.
const helperStart = tickMode && arg === 'off'
if (arg === 'off' && !tickMode && (verb === null || verb === 'one-click')) usage('off goes with tick only (node skin-auto.mjs tick off), or with switch through a running colour helper (node skin-auto.mjs switch off).')
if (helperStart && (checkOnly || args.filter((a) => !a.startsWith('--')).length !== 1)) usage('Usage: node skin-auto.mjs tick off [--want-font=<name|name-size|off>] [--want-type=on|off]')
const SET_LINE = `set [<preset>|off]${fontShipped ? ' [font <name>|off]' : ''} [type on|off]`
if (!arg && !checkOnly && verb !== 'status' && verb !== 'check') usage(oneClickShipped ? `Usage: node skin-auto.mjs [tick|one-click] <preset|stylesheet.css> | switch <preset|off|remove> | ${SET_LINE} | status | check | menu-probe | remove | reset | state | selftest | probe | batch a,b,c [--final previous|off] | --check  [--dry-run]`
  : `Usage: node skin-auto.mjs tick <preset|off|remove> | switch <preset|off|remove> | type <on|off>${fontShipped ? ' | font <name|off|list>' : ''} | ${SET_LINE} | status | check`)
// The one-line command's font and type parts on a tick (3 Nov 2026): `tick <preset> --want-font=<name|off>
// --want-type=on|off`. They replace the remembered headers and font in the restore step; a part not given keeps the
// remembered one. Checked here for shape; what this copy offers and whether the font is installed are checked before the
// prompt (below), so nothing is ticked for a line that cannot be done.
const wantOf = (k) => {
  const a = args.filter((x) => x.startsWith(`--want-${k}=`))
  if (a.length > 1) usage(`--want-${k} is given twice.`)
  return a.length === 1 ? a[0].slice(`--want-${k}=`.length) : undefined
}
const wants = { font: wantOf('font'), type: wantOf('type') }
if (args.some((x) => x.startsWith('--want-') && !/^--want-(?:font|type)=/.test(x))) usage('Only --want-font=<name|name-size|off> and --want-type=on|off are understood.')
const hasWants = wants.font !== undefined || wants.type !== undefined
if (hasWants) {
  if (!tickMode) usage('Font and type parts go with a tick only (tick <preset|off> --want-font=<name|off> --want-type=on|off).')
  if (wants.type !== undefined && wants.type !== 'on' && wants.type !== 'off') usage('--want-type takes on or off.')
  if (wants.font !== undefined) {
    if (!fontShipped) usage('Fonts are not in this release.')
    if (wants.font !== 'off') {
      const k = fontKeyOf(wants.font)
      if (k.why) usage(`${k.why} node skin-auto.mjs font list shows them.`)
      wants.font = k.key
    }
  }
}
let skinArgs = []
if (isBatch) skinArgs = batchArgs()
// The public release (tick only) takes a preset or remove; the developer modes (probes, state, selftest, reset) stay
// in the development copy, where release.json is absent.
else if (!oneClickShipped && ['state', 'selftest', 'reset', 'probe', 'type-probe', 'menu-probe'].includes(arg)) usage(`${arg} is a developer mode and is not in this release. Use: node skin-auto.mjs tick <preset|remove>.`)
else if (helperStart) skinArgs = ['start']
else if (['remove', 'state', 'selftest', 'reset', 'probe', 'type-probe', 'menu-probe'].includes(arg)) skinArgs = [arg]
else if (arg && !['switch', 'status', 'check', 'type', 'font', 'set', 'look'].includes(verb)) {
  // A bare preset name means presets/<name>.css. Only Reskin's own presets are applied (as AGENTS.md says), so
  // an agent or a script cannot slip in a stylesheet of its own; a path is accepted only when it is one of those presets.
  const real = (f) => { try { return nodeFs.realpathSync(f) } catch { return null } }
  const asPath = real(path.resolve(arg))
  const named = PRESET_NAME.test(arg) && existsSync(presetFile(arg)) ? arg
    : asPath !== null && path.dirname(asPath) === real(path.join(here, 'presets')) && asPath.endsWith('.css') && PRESET_NAME.test(path.basename(asPath, '.css')) ? path.basename(asPath, '.css') : null
  // A retired name is refused first, before any file lookup, so a leftover presets/verc.css from an older copy never
  // makes it an apply again; a path to such a file counts by its file name.
  const retiredAs = isRetired(arg) ? arg : isRetired(path.basename(String(arg), '.css')) ? path.basename(String(arg), '.css') : null
  if (retiredAs !== null) usage(retiredLine(retiredAs))
  if (named === null) usage(`Not one of Reskin's presets: ${arg}. Use a preset name from presets/ (for example dracula).`)
  if (named.startsWith('dotcheck-')) usage(`${named} is a dot census test sheet: it runs only in a batch with --dot-census.`)
  const css = presetFile(named)
  // Check the stylesheet offline first, so a bad one is refused before anything starts or any menu is ticked.
  const checked = spawnSync(NODE, [SKIN, 'check-css', css], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
  if (checked.status !== 0) {
    console.error(`The stylesheet did not pass the check, so nothing was started: ${(checked.stdout + checked.stderr).replace(/^Stopped: /m, '').trim().slice(0, 300)}`)
    console.log('PORT_STATE: unknown')
    finish('refused', EXIT.refused)
  }
  skinArgs = ['apply', css]
}
// Tick mode: skin.mjs gives Claude extra time to answer (a no-Chrome Mac is frozen until the user clicks OK), starts before
// the prompt and waits for the port itself. A preset apply also leaves the colour checks to the
// helper, after the debugger is closed (P3); a stylesheet that is not a preset is checked inside, as before.
if (tickMode && skinArgs.length > 0) skinArgs.push('--patient', '--wait-open')
// The applied skin's own text, for the sampled colour checks; its preset name, if it is one, for the remembered preference.
const appliedCss = skinArgs[0] === 'apply' ? readFileSync(skinArgs[1], 'utf8') : null
const appliedPreset = skinArgs[0] === 'apply' && path.dirname(skinArgs[1]) === path.join(here, 'presets') ? path.basename(skinArgs[1], '.css') : null
const quickChecks = tickMode && (appliedPreset !== null || helperStart)
if (quickChecks) skinArgs.push('--quick')

// A reader that goes away (Raycast closed, a hook stopped) must never crash the run before its cleanup.
process.stdout.on('error', () => {})
const t0 = Date.now()
const stamp = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`)
const warn = (m) => console.log(`WARNING: ${m}`) // never stamped, so every front end can find it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Every command is bounded; a timeout shows up as status null, which the checks treat as "unknown".
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL' }) // SIGKILL: a stuck child must not hang us
  return { status: r.status, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const osa = (script) => run('/usr/bin/osascript', ['-e', script])
const chromeState = () => pgrepState(run('/usr/bin/pgrep', ['-x', 'Google Chrome']))
const portNow = () => portState(run('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN']))
const claudeNow = () => claudeRunning(run('/bin/ps', ['-ax', '-o', 'comm=']))
// The running Claude's start time (ms), null when none runs; throws when unsure (two Claudes, ps failing).
const claudeStart = () => {
  const r = run('/bin/ps', ['-ax', '-o', 'pid=,comm='])
  if (r.error || r.status !== 0) throw new Error('could not list running programs')
  const pids = String(r.stdout).split('\n').map((l) => /^\s*(\d+)\s+(.+?)\s*$/.exec(l)).filter((m) => m && m[2] === CLAUDE_BINARY).map((m) => Number(m[1]))
  if (pids.length === 0) return null
  if (pids.length > 1) throw new Error(`${pids.length} Claude processes are running`)
  const p = procOf(pids[0])
  if (p === null) return null
  return p.startMs
}
const commandOf = (pid) => run('/bin/ps', ['-o', 'command=', '-p', String(pid)]).stdout
const CHROME_APP = '/Applications/Google Chrome.app'
const chromeInstalled = () => chromeLookup(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CHROME_LOOKUP_JXA]), existsSync(CHROME_APP)) // yes / no / unknown
// Asynchronous AppleScript (the dialog watcher runs while the skin step runs, so it must not block this process).
let osaChild = null // the dialog watcher's current osascript, ended by cleanup so it cannot outlive the run
const osaAsync = (script, ms = 3_000) => new Promise((res) => {
  const p = osaChild = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  const t = setTimeout(() => p.kill('SIGKILL'), ms)
  p.stdout.on('data', (d) => (out += d))
  p.on('error', () => { clearTimeout(t); res('') })
  p.on('close', () => { clearTimeout(t); res(out.trim()) })
})
const identity = (pid) => identityOf(run('/bin/ps', ['-o', 'command=', '-p', String(pid)]), dir) // ours / other / gone / unknown

// ---- switch and status: talk to the colour helper through its private folder. No tick, no port, no Chrome. ----
const procOf = (pid) => parsePs(spawnSync('/bin/ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }))
const portLine = () => { const r = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL' }); return portState({ status: r.status, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }) }
// P5: remember the preference (a preset name), never the permission. Failing to save it never fails a run.
// `type` and `font` keep what was saved unless given: a skin change or Off leaves them as they were.
const savePrefs = (last, type = readPrefs(nodeFs, STATE).type, font = readPrefs(nodeFs, STATE).font) => {
  try {
    if (privateDir(nodeFs, STATE).missing) nodeFs.mkdirSync(STATE, { recursive: true, mode: 0o700 })
    if (privateDir(nodeFs, STATE).ok) writePrivateJson(nodeFs, STATE, 'prefs.json', { v: 1, last, type, font }, randomUUID)
  } catch {}
}
// Is this font installed on this Mac? One fixed read-only script, the family name passed as its argument, 4 s at most.
const installedOne = (name) => fontInstalled(spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FONT_INSTALLED_JXA, fontFamily(name)], { encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL' }))
// A font key or a whole look: 'yes' only when every font it turns on is installed ('no' if any is not; 'failed' if one
// could not be checked). A look with no font of its own needs nothing.
const installedNow = (key) => {
  const ids = parseLook(key)
  if (ids === null) return installedOne(key)
  let out = 'yes'
  for (const f of lookFonts(ids)) { const r = installedOne(f); if (r === 'no') return 'no'; if (r !== 'yes') out = 'failed' }
  return out
}
// What a gen 8 helper offers: its part ids (font picker). A font key or look is offered when every part is.
const partsOf = (live) => (Array.isArray(live.session?.parts) ? live.session.parts : [])
const offersOf = (live) => ({ includes: (key) => lookOffered(key, partsOf(live)) })
// This run's pid in the private folder while it holds the run lock, so an older run's guardian A can tell a
// newer Reskin run (it stands down for it) from any other program on the lock port (it does not). Best effort: without
// the mark, an old guardian simply keeps closing, which is the safe side.
let marked = false
const markRun = () => {
  try {
    if (privateDir(nodeFs, STATE).missing) nodeFs.mkdirSync(STATE, { recursive: true, mode: 0o700 })
    if (privateDir(nodeFs, STATE).ok) { writePrivateText(nodeFs, STATE, 'run-pid', String(process.pid), randomUUID); marked = true }
  } catch {}
}
const unmarkRun = () => {
  if (!marked) return
  try { if (nodeFs.readFileSync(`${STATE}/run-pid`, 'utf8') === String(process.pid)) nodeFs.unlinkSync(`${STATE}/run-pid`) } catch {}
}
// After a restart: the next tick puts the skin on and then restores the remembered headers and font itself (no second
// tick), so the offer names them. Starts with "Reapply " so the mod's list keeps it.
const reapplyOffer = (last, type = false, font = null) => {
  const extras = [type ? 'the project headers' : null, fontShipped && font ? `your fonts (${fontWords(font)})` : null].filter(Boolean).join(' and ')
  // A retired skin cannot come back: say so and name what to pick instead (the offer still starts with "Reapply").
  if (isRetired(last)) return `Reapply a skin? Your last skin, ${last}, was retired (${RETIRED_SKINS[last].why}), so it cannot come back. Pick another, for example /skin ${RETIRED_SKINS[last].try[0]} --tick; it needs one tick of Developer > Enable Main Process Debugger.${extras ? ` That also brings back ${extras}.` : ''}`
  if (last) return `Reapply ${last}? Run: /skin ${last} --tick (or: node skin-auto.mjs tick ${last}); it needs one tick of Developer > Enable Main Process Debugger.${extras ? ` That also brings back ${extras}.` : ''}`
  // No skin was on, only headers or a font: the no-skin tick starts the helper with Claude's own colours and brings them
  // back (4 Nov 2026).
  if (!extras) return null
  const cmd = type ? '/skin type on --tick' : '/skin fonts --tick'
  return `Reapply ${extras}? Run: ${cmd} (or: node skin-auto.mjs tick off); it needs one tick of Developer > Enable Main Process Debugger, puts no skin on, and brings back ${extras}.`
}

// Health check (17 Oct 2026): read-only, through the colour helper. No port, no tick, no stylesheet change.
const TESTED_FILE = path.join(here, 'tested-versions.json')
const testedVersions = () => { try { const v = JSON.parse(readFileSync(TESTED_FILE, 'utf8')).versions; return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }
const lastCheck = () => { const v = readPrivateJson(nodeFs, `${STATE}/last-check.json`, { max: 1024 }).value; return v && typeof v.version === 'string' && typeof v.verdict === 'string' ? v : null }
const HEALTH_WORDS = { pass: 'pass', none: 'no skin on', fail: 'FAIL', structure: 'structure changed', unknown: 'unknown', noanswer: 'helper not answering' }
// For status: the last check, and a nudge when Claude's version changed since then.
function healthHint(live) {
  const last = lastCheck()
  const now = live.state === 'active' ? live.session.version : null
  return [
    last ? `health: last check ${HEALTH_WORDS[last.verdict] ?? 'unknown'} on Claude ${/^\d+(\.\d+){1,3}$/.test(last.version) ? last.version : '?'}` : null,
    typeof now === 'string' && (!last || last.version !== now) ? `Claude ${/^\d+(\.\d+){1,3}$/.test(now) ? now : ''} has not been checked yet: ${Array.isArray(live.session.caps) && live.session.caps.includes('check') ? 'run /skin check (or: node skin-auto.mjs check)' : 'this colour helper started before the check existed; after the next skin applied with a tick (/skin <name> --tick), run /skin check'}`.replace('Claude  ', 'Claude ') : null,
  ]
}
const DEBUGGER_UNUSED = 'debugger: not used (the check needs no port)'
async function healthCheck(live, prefs) {
  if (live.state === 'outdated') return ['refused', EXIT.refused, [`health: unknown (${live.why})`, DEBUGGER_UNUSED]]
  if (live.state === 'unknown') return ['refused', EXIT.refused, [`health: unknown (could not tell whether a colour helper is running: ${live.why})`, DEBUGGER_UNUSED]]
  if (live.state === 'none') {
    return ['ok', EXIT.ok, [`health: unknown (no colour helper in this Claude: ${live.why}; the check works through the helper, which the first skin after Claude starts puts in)`, DEBUGGER_UNUSED, 'helper: none', reapplyOffer(prefs.last, prefs.type, prefs.font)]]
  }
  if (!Array.isArray(live.session.caps) || !live.session.caps.includes('check')) {
    // An older helper would count the request as ignored: nothing is sent.
    return ['ok', EXIT.ok, ['health: unknown (this colour helper started before the check existed, and switching skins keeps using it. To get the check: apply a skin with a new tick (/skin <name> --tick), or quit and reopen Claude and apply a skin)', DEBUGGER_UNUSED, helperActiveLine(live.session.version)]]
  }
  const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, 'check', { randomUUID, waitMs: 10_000 })
  if (ack === null || ack.action !== 'check') {
    // Recorded too, so /skin status never keeps showing an older pass after a check that got no answer.
    if (/^\d+(\.\d+){1,3}$/.test(live.session.version ?? '')) { try { writePrivateJson(nodeFs, STATE, 'last-check.json', { v: 1, version: live.session.version, verdict: 'noanswer', at: new Date().toISOString() }, randomUUID) } catch {} }
    return ['failed', EXIT.failed, ['health: helper not answering (no reply in 10 s; it may be stuck)', 'Repair: quit and reopen Claude, then apply a skin again (one tick). To report it, run /skin log and send the newest entry.', DEBUGGER_UNUSED, 'helper: not answering']]
  }
  const tested = testedVersions()
  const cssOf = (name) => { try { return PRESET_NAME.test(name) && !name.startsWith('dotcheck-') && existsSync(presetFile(name)) ? readFileSync(presetFile(name), 'utf8') : null } catch { return null } }
  const j = judgeHealth({ ...ack, version: ack.version ?? live.session.version }, { cssOf, digestOf: (s) => createHash('sha256').update(s).digest('hex'), tested })
  const rep = healthReport(j, ack, tested)
  if (j.version) {
    try { writePrivateJson(nodeFs, STATE, 'last-check.json', { v: 1, version: j.version, verdict: j.verdict, at: new Date().toISOString() }, randomUUID) } catch {}
  }
  return [rep.code === 0 ? 'ok' : 'failed', rep.code === 0 ? EXIT.ok : EXIT.failed, [...rep.lines, typeLine(ack), ...(fontShipped || typeof ack.font === 'string' ? fontLines(ack, typeof ack.font === 'string' && parseLook(ack.font) !== null ? installedNow(ack.font) : null) : []), '(as the colour helper reports; no debugger checked it)', DEBUGGER_UNUSED, helperActiveLine(live.session.version)]]
}

// Type and font (2 and 3 Nov 2026): both live in one type slot inside Claude, beside the colours, changed through the
// colour helper only (/skin off keeps them, remove takes them). No tick, no port. The helper composes the change from
// what is really on (headers, font) and answers with what it proved; only that proven pair is saved.
const SLOT_WAIT_MS = 30_000 // more than the helper's own budget for a change that clears, applies and cleans up
const NO_PORT = 'debugger: not used (switching needs no port)'
const pairOk = slotPairOk
async function slotChange(live, action, { save = true } = {}) {
  const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, action, { randomUUID, waitMs: SLOT_WAIT_MS })
  if (ack === null || ack.action !== action) return { ack: null }
  if (!save) return { ack } // the one-line command saves once, from its final proven pair
  // Saved only from a proven result, and both halves together, so a later change never builds on a guess.
  // A copy without fonts keeps the remembered font: it cannot see or set one, so its null means nothing.
  if (pairOk(ack.verified)) { const p = readPrefs(nodeFs, STATE); savePrefs(p.last, ack.verified.headers, fontShipped ? ack.verified.font : p.font) }
  return { ack }
}
async function typeRun(live, which) {
  if (which !== 'on' && which !== 'off') return ['refused', EXIT.usage, ['Usage: node skin-auto.mjs type on|off']]
  if (live.state === 'outdated') return ['refused', EXIT.refused, [`${live.why} Nothing was changed.`]]
  if (live.state === 'unknown') return ['refused', EXIT.refused, [`Could not tell whether a colour helper is running (${live.why}). Nothing was changed.`]]
  if (live.state === 'none') {
    return ['refused', EXIT.refused, [`No colour helper is running in this Claude (${live.why}), so nothing was changed. ${which === 'on' ? 'To start the colour helper with no skin, run /skin type on --tick (one tick; or: node skin-auto.mjs tick off --want-type=on), or apply a skin first (/skin <name>, one tick).' : 'Without a helper there is nothing to turn off: quitting and reopening Claude clears it.'}`]]
  }
  if (which === 'on' && (!Array.isArray(live.session.caps) || !live.session.caps.includes('type'))) {
    // The helper generation is current here, so a missing cap means this copy offered no type sheet: a tick cannot fix that.
    // Off is never gated: the helper always accepts type-off, as it only removes.
    return ['refused', EXIT.refused, ['Type is not available in this copy of Reskin (its type sheet is missing or did not pass its check), so nothing was changed. Reinstall Reskin to get it back.', NO_PORT, helperActiveLine(live.session.version)]]
  }
  const { ack } = await slotChange(live, `type-${which}`)
  if (ack === null) return ['failed', EXIT.failed, [`type ${which} unconfirmed: the colour helper did not answer within ${SLOT_WAIT_MS / 1000} s. Nothing else was tried (no tick, no port).`, NO_PORT, 'helper: not answering']]
  const font = pairOk(ack.verified) && ack.verified.font ? ` Fonts stay on: ${fontWords(ack.verified.font)}.` : ''
  return [ack.ok ? 'ok' : 'failed', ack.ok ? EXIT.ok : EXIT.failed, [
    ack.ok ? (which === 'on' ? `Type on: ${TYPE_WHAT}. It stays through skin changes and /skin off; /skin type off or /skin remove takes it off.${font}` : `Type off: Claude's own header type is back${ack.reloaded ? ' (Claude reloaded to be sure)' : ''}.${font}`)
      : slotFailLine(`Type ${which}`, ack),
    '(as the colour helper reports; no debugger checked it)', NO_PORT, helperActiveLine(live.session.version),
  ]]
}
async function fontRun(live, typed) {
  const names = Object.keys(FONT_STACKS)
  const typedKey = typed === 'off' || typed === 'list' ? null : fontKeyOf(typed)
  const which = typed === 'off' || typed === 'list' ? typed : typedKey.key ?? typed
  if (which === 'list') {
    return ['ok', EXIT.ok, [...names.map((n) => { const i = installedNow(n); return `/skin font ${n}  (${fontFamily(n)}, ${i === 'yes' ? 'installed' : i === 'no' ? 'not installed' : 'could not check whether it is installed'}; free download: ${FONT_LINKS[n]})` }), '/skin font off  (back to Claude\'s own font)', `Add a size ${FONT_SIZES[0]} to ${FONT_SIZES[FONT_SIZES.length - 1]} for chat text and the message box: /skin font plex 16 (Claude's own Transcript text size: Small 14, Medium 15, Large 16).`, 'All are free (SIL Open Font License). No tick needed. The full name works too, for example /skin font IBM Plex Sans.']]
  }
  if (which !== 'off' && splitFontKey(which) === null) return ['refused', EXIT.usage, [`Usage: node skin-auto.mjs font <${names.join('|')}>[-<size ${FONT_SIZES[0]} to ${FONT_SIZES[FONT_SIZES.length - 1]}>]|off|list${typedKey?.why ? ` (${typedKey.why})` : ''}`]]
  if (live.state === 'outdated') return ['refused', EXIT.refused, [`${live.why} Nothing was changed.`]]
  if (live.state === 'unknown') return ['refused', EXIT.refused, [`Could not tell whether a colour helper is running (${live.why}). Nothing was changed.`]]
  if (live.state === 'none') {
    return ['refused', EXIT.refused, [`No colour helper is running in this Claude (${live.why}), so nothing was changed. ${which !== 'off' ? `To start the colour helper with no skin, run /skin font ${which.replace(/-(\d+)$/, ' $1')} --tick (one tick; or: node skin-auto.mjs tick off --want-font=${which}), or apply a skin first (/skin <name>, one tick).` : 'Without a helper there is nothing to turn off: quitting and reopening Claude clears it.'}`]]
  }
  if (which !== 'off') {
    if (!Array.isArray(live.session.caps) || !live.session.caps.includes('font') || !offersOf(live).includes(which)) {
      return ['refused', EXIT.refused, [`The font ${which} is not available in this colour helper, so nothing was changed. Apply a skin with a new tick (/skin <name> --tick) to give the helper this copy's fonts.`, NO_PORT, helperActiveLine(live.session.version)]]
    }
    // Inside Claude a missing font would quietly show the system font instead, so it is checked first.
    const i = installedNow(which)
    if (i === 'no') return ['refused', EXIT.refused, [`${fontFamily(which)} is not installed on this Mac, so nothing was changed. It is free: download it from ${FONT_LINKS[fontBase(which)]}, install it (double-click the file, then Install Font), then run /skin font ${which} again.`, NO_PORT]]
    if (i === 'failed') return ['refused', EXIT.refused, [`Could not check whether ${fontFamily(which)} is installed, so nothing was changed. Try again; /skin font off always works.`, NO_PORT]]
  }
  const action = which === 'off' ? 'font-off' : `font-${which}`
  const { ack } = await slotChange(live, action)
  if (ack === null) return ['failed', EXIT.failed, [`font ${which} unconfirmed: the colour helper did not answer within ${SLOT_WAIT_MS / 1000} s. Nothing else was tried (no tick, no port).`, NO_PORT, 'helper: not answering']]
  const headers = pairOk(ack.verified) && ack.verified.headers ? ' The project headers stay on.' : ''
  return [ack.ok ? 'ok' : 'failed', ack.ok ? EXIT.ok : EXIT.failed, [
    ack.ok ? (which === 'off' ? `Font off: Claude's own font is back${ack.reloaded ? ' (Claude reloaded to be sure)' : ''}.${headers}` : `Font ${which} on: ${fontFamily(which)} for chat text, replies, the message box, buttons and the sidebar${splitFontKey(which).size === null ? '' : `, at ${splitFontKey(which).size}px for chat text and the message box`}. It stays through skin changes and /skin off; /skin font off or /skin remove takes it off.${headers}`)
      : slotFailLine(`Font ${which}`, ack),
    which !== 'off' && ack.ok ? FONT_MENU_LINE : null,
    which !== 'off' && ack.ok && splitFontKey(which).size !== null ? SIZE_MENU_LINE : null,
    '(as the colour helper reports; no debugger checked it)', NO_PORT, helperActiveLine(live.session.version),
  ]]
}

// The font picker (4 Nov 2026): `look show` reads what the helper proves is on now (one fresh read-only check; never a
// saved file) and prints it as one `LOOK: {json}` line for the /skin fonts card, plus plain lines. `look set <section>
// font=<name|same|claude> size=<n|claude> weight=<n|claude>` changes ONE section: it merges the wanted choices into the
// look the helper proves now (refused when that is unknown), checks the whole result (weights the fonts have, every part
// offered by this helper, every font installed), then sends it as one font request. Prefs only from the proven answer.
const LOOK_USAGE = `Usage: node skin-auto.mjs look show | look set <all|${Object.keys(SECTIONS).join('|')}> font=<name|same|claude> size=<number|claude> weight=<number|claude> (all: font only)`
const sectionLabel = (sec) => (sec === 'all' ? 'All parts' : SECTIONS[sec].label)
const lookJson = (o) => `LOOK: ${JSON.stringify(o)}`
// 13 s: the helper's 10 s answer wait plus start-up. A test may shorten it (never lengthen it).
const LOOK_DEADLINE_MS = (() => { const v = Number(process.env.SKIN_LOOK_DEADLINE_MS); return Number.isInteger(v) && v > 0 && v < 13_000 ? v : 13_000 })()
async function lookRun(live) {
  const [sub, sec, ...opts] = args.filter((a) => !a.startsWith('--'))
  if (sub !== 'show' && sub !== 'set') return ['refused', EXIT.usage, [LOOK_USAGE]]
  if (sub === 'show' && (sec !== undefined || opts.length)) return ['refused', EXIT.usage, [LOOK_USAGE]]
  let want = null
  if (sub === 'set') {
    if (sec !== 'all' && !Object.hasOwn(SECTIONS, sec ?? '')) return ['refused', EXIT.usage, [`${sec ? `No section called ${String(sec).slice(0, 20)}. ` : ''}${LOOK_USAGE}`]]
    const w = lookSetWants(sec, opts)
    if (w.why) return ['refused', EXIT.usage, [w.why === 'usage' ? LOOK_USAGE : w.why]]
    want = w.want
  }
  if (live.state === 'outdated') return ['refused', EXIT.refused, [lookJson({ helper: 'outdated' }), `${live.why} Nothing was changed.`]]
  if (live.state === 'unknown') return ['refused', EXIT.refused, [lookJson({ helper: 'unknown' }), `Could not tell whether a colour helper is running (${live.why}). Nothing was changed.`]]
  if (live.state === 'none') return ['refused', EXIT.refused, [lookJson({ helper: 'none' }), `No colour helper is running in this Claude (${live.why}), so nothing was changed. Fonts need it: run /skin fonts --tick (one tick, no skin put on), or start with a skin, for example /skin dracula --tick.`]]
  const caps = Array.isArray(live.session.caps) ? live.session.caps : []
  if (!caps.includes('look') || !caps.includes('check')) return ['refused', EXIT.refused, [lookJson({ helper: 'old' }), 'The font picker needs the new colour helper: quit and reopen Claude, then apply a skin with one tick (/skin <name> --tick). Nothing was changed.', NO_PORT]]
  const { ack: seen } = await sendSwitch(nodeFs, STATE, live.session.session, 'check', { randomUUID, waitMs: 10_000 })
  if (seen === null || seen.action !== 'check') return ['failed', EXIT.failed, [lookJson({ helper: 'noanswer' }), 'The colour helper did not answer within 10 s, so nothing was changed. Try again, or quit and reopen Claude.', NO_PORT, 'helper: not answering']]
  const cur = seen.font === null ? [] : typeof seen.font === 'string' ? parseLook(seen.font) : null
  const shown = { helper: 'active', look: cur, type: seen.type === 'on' ? 'on' : seen.type === 'off' ? 'off' : 'unknown', parts: partsOf(live) }
  if (sub === 'show') {
    // Band (5 Nov 2026): the proven claims, each 'unknown' unless this very answer proves it.
    const cssOf = (name) => { try { return PRESET_NAME.test(name) && !name.startsWith('dotcheck-') && existsSync(presetFile(name)) ? readFileSync(presetFile(name), 'utf8') : null } catch { return null } }
    const claims = bandClaims({ ...seen, version: seen.version ?? live.session.version }, { cssOf, digestOf: (t) => createHash('sha256').update(t).digest('hex') })
    return ['ok', EXIT.ok, [lookJson({ ...shown, ...claims }), cur === null ? 'fonts: not proven now (an earlier change did not finish): /skin font off clears it' : cur.length === 0 ? "fonts: Claude's own everywhere" : `fonts: ${describeLook(cur).join('; ')}`, NO_PORT]]
  }
  if (cur === null) return ['refused', EXIT.refused, [lookJson(shown), 'The font state could not be proven, so nothing was changed. Run /skin font off, then try again.', NO_PORT]]
  const m = mergeSection(cur, sec, want)
  if (m.why) return ['refused', EXIT.usage, [lookJson(shown), `${m.why} Nothing was changed.`]]
  const key = lookKey(m.ids)
  if (key !== null) {
    if (!caps.includes('font') || !lookOffered(key, partsOf(live))) return ['refused', EXIT.refused, [lookJson(shown), 'That choice is not available in this colour helper, so nothing was changed. Apply a skin with a new tick (/skin <name> --tick) to give it this copy\'s fonts.', NO_PORT]]
    for (const f of lookFonts(m.ids)) {
      const i = installedOne(f)
      if (i === 'no') return ['refused', EXIT.refused, [lookJson(shown), `${fontFamily(f)} is not installed on this Mac, so nothing was changed. It is free: download it from ${FONT_LINKS[f]}, install it (double-click the file, then Install Font), then try again.`, NO_PORT]]
      if (i !== 'yes') return ['refused', EXIT.refused, [lookJson(shown), `Could not check whether ${fontFamily(f)} is installed, so nothing was changed. Try again.`, NO_PORT]]
    }
  }
  const { ack } = await slotChange(live, key === null ? 'font-off' : `font-${key}`)
  if (ack === null) return ['failed', EXIT.failed, [lookJson({ ...shown, look: null }), `The change is unconfirmed: the colour helper did not answer within ${SLOT_WAIT_MS / 1000} s. Nothing else was tried (no tick, no port).`, NO_PORT, 'helper: not answering']]
  const proven = pairOk(ack.verified) ? (ack.verified.font === null ? [] : parseLook(ack.verified.font)) : null
  return [ack.ok ? 'ok' : 'failed', ack.ok ? EXIT.ok : EXIT.failed, [
    // An answer without proof says so; "Claude's own everywhere" only for a proven empty look.
    lookJson({ ...shown, look: proven, type: pairOk(ack.verified) ? (ack.verified.headers ? 'on' : 'off') : 'unknown' }),
    !ack.ok ? slotFailLine(sectionLabel(sec), ack)
      : proven === null ? `${sectionLabel(sec)} sent, but what is on now is not proven (something else changed the fonts meanwhile): run /skin check, or open /skin fonts again.`
      : `${sectionLabel(sec)} done. ${proven.length ? `Fonts now: ${describeLook(proven).join('; ')}.` : "Claude's own fonts everywhere now."} It stays through skin changes and /skin off; /skin font off or /skin remove takes it off.`,
    '(as the colour helper reports; no debugger checked it)', NO_PORT, helperActiveLine(live.session.version),
  ]]
}

async function helperRun() {
  const lock = await acquireLockWaiting(lockWait.ms)
  if (!lock.ok) { console.error(`Not started: ${lock.reason}.`); console.log(`PORT_STATE: ${portLine().state}`); finish('refused', EXIT.refused) }
  // Band (5 Nov 2026): a read (look show) ends itself LOOK_DEADLINE_MS after taking the lock, whatever happens, so the
  // operating system frees the lock on time and a queued command (--lock-wait) can follow. Every wait inside is async or
  // a spawnSync with its own timeout, so this timer always gets to run. A change (look set) is never cut short.
  if (verb === 'look' && args.filter((a) => !a.startsWith('--'))[0] === 'show' && args.filter((a) => !a.startsWith('--')).length === 1) {
    setTimeout(() => { console.log(lookJson({ helper: 'noanswer' })); console.log('The colour helper did not answer in time. Nothing was changed.'); console.log(NO_PORT); finish('failed', EXIT.failed) }, LOOK_DEADLINE_MS).unref()
    // Test only, and only with a shortened deadline: stand in for a helper that never answers.
    // `sync`: a real blocking child begun just before the deadline (the longest any check here may block, 4 s).
    if (LOOK_DEADLINE_MS < 13_000 && process.env.SKIN_TEST_LOOK_STALL === 'sync') { await new Promise((r) => setTimeout(r, Math.max(0, LOOK_DEADLINE_MS - 200))); spawnSync('/bin/sleep', ['30'], { timeout: 4_000, killSignal: 'SIGKILL' }) }
    if (LOOK_DEADLINE_MS < 13_000 && (process.env.SKIN_TEST_LOOK_STALL === '1' || process.env.SKIN_TEST_LOOK_STALL === 'sync')) await new Promise(() => setInterval(() => {}, 1_000))
  }
  const live = liveSession(nodeFs, STATE, procOf, { claudeStart })
  const prefs = readPrefs(nodeFs, STATE)
  const end = async (result, code, lines) => {
    for (const l of lines.filter(Boolean)) console.log(l)
    console.log(`PORT_STATE: ${portLine().state}`)
    await lock.release()
    finish(result, code)
  }
  if (verb === 'status') {
    const ack = live.state === 'active' ? readPrivateJson(nodeFs, `${STATE}/ack.json`).value : null
    const same = ack?.session === live.session?.session
    return end('ok', EXIT.ok, [
      live.state === 'active' ? `helper: active until Claude quits (Claude pid ${live.session.pid}, version ${live.session.version})` : `helper: ${live.state} (${live.why})`,
      live.state === 'active' ? `requests: ${same ? ack.requests : 0} handled, ${same ? ack.ignored : 0} ignored${same ? `; last: ${ack.action} (${ack.ok ? 'ok' : 'failed'})` : ''}` : null,
      `last skin: ${prefs.last ?? 'none'}`,
      ...healthHint(live),
      `type: ${prefs.type ? 'on when last set' : 'off'}`,
      fontShipped ? `font: ${prefs.font ? `${fontWords(prefs.font)} when last set` : 'off'}` : null,
      fontShipped && prefs.font && live.state === 'active' ? FONT_MENU_LINE : null,
      live.state === 'outdated' || live.state === 'unknown' ? (live.state === 'outdated' ? live.why : 'Quit and reopen Claude, then run /skin again.') : live.state !== 'active' ? reapplyOffer(prefs.last, prefs.type, prefs.font) : null,
    ])
  }
  if (verb === 'check') return end(...(await healthCheck(live, prefs)))
  if (verb === 'type') return end(...(await typeRun(live, args[0])))
  if (verb === 'font') return end(...(await fontRun(live, args.filter((a) => !a.startsWith('--')).join(' '))))
  if (verb === 'set') return end(...(await setRun(live)))
  if (verb === 'look') return end(...(await lookRun(live)))
  const action = args[0]
  if (isRetired(action)) return end('refused', EXIT.usage, [retiredLine(action)])
  if (!action || !(action === 'off' || action === 'remove' || (PRESET_NAME.test(action) && !action.startsWith('dotcheck-') && existsSync(presetFile(action))))) {
    return end('refused', EXIT.usage, [`Usage: node skin-auto.mjs switch <preset|off|remove>. ${action ? `No preset called ${action}.` : ''}`])
  }
  if (live.state === 'outdated') return end('refused', EXIT.refused, [`${live.why} Nothing was changed.`])
  if (live.state === 'unknown') return end('refused', EXIT.refused, [`Could not tell whether a colour helper is running (${live.why}). Nothing was changed.`])
  if (live.state === 'none') {
    // No helper is no proof that no skin is on (an apply without a helper leaves its colours), so an
    // Off or a removal is refused here, never reported as done.
    return end('refused', EXIT.refused, [
      action === 'off' || action === 'remove' ? `No colour helper is running in this Claude (${live.why}), so nothing was removed this way. If Claude still shows a skin, take it off with: /skin remove --tick (or: node skin-auto.mjs tick remove)` : `No colour helper is running in this Claude (${live.why}), so nothing was changed.`,
      action !== 'off' && action !== 'remove' ? `To apply ${action}, run /skin ${action} --tick (or: node skin-auto.mjs tick ${action}); it needs one tick of Developer > Enable Main Process Debugger.` : null,
    ])
  }
  const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, action, { randomUUID })
  if (ack === null) {
    return end('failed', EXIT.failed, [
      'switch unconfirmed: the colour helper did not answer within 2 s. Nothing else was tried (no tick, no port).',
      `If the colours did not change, apply with a new tick: /skin ${action === 'off' ? 'remove' : action} --tick (or: node skin-auto.mjs tick ${action === 'off' ? 'remove' : action})`,
    ])
  }
  if (action === 'remove') {
    // The first answer only says "accepted"; success needs the helper's final "done" answer and the session file gone.
    let done = ack.phase === 'done' ? ack : null
    for (let i = 0; i < 200 && done === null; i++) { // 20 s: more than the helper's own removal budget (12 s)
      const r = readPrivateJson(nodeFs, `${STATE}/ack.json`).value
      if (r?.session === live.session.session && r.nonce === ack.nonce && r.phase === 'done') done = r
      else await new Promise((res) => setTimeout(res, 100))
    }
    const gone = readPrivateJson(nodeFs, `${STATE}/session.json`).missing === true
    const ok = done?.ok === true && gone
    if (ok) savePrefs(null, false, null)
    return end(ok ? 'ok' : 'failed', ok ? EXIT.ok : EXIT.failed, [
      ok ? 'Skin and colour helper removed, as the helper itself reports (no debugger was used to check it, and a program running as you could fake that report; quitting and reopening Claude is the proof). The next skin needs one tick.'
        : done === null ? 'Removal not confirmed: the helper accepted it but did not report that it finished. Check with /skin status (or: node skin-auto.mjs status).'
        : `Removal not complete: ${(done.errors ?? []).join('; ') || 'the session file is still there'}. Press Cmd-R in Claude, or quit and reopen it.`,
      'sampled colour checks: not applicable (skin removed)',
      'debugger: not used (switching needs no port)',
      'helper: ' + (gone ? 'none (as the helper reports)' : 'unknown'),
    ])
  }
  return end(ack.ok ? 'ok' : 'failed', ack.ok ? EXIT.ok : EXIT.failed, [
    ...colourResult(action, ack),
    'debugger: not used (switching needs no port)',
    helperActiveLine(live.session.version),
  ])
}
// A colour switch's answer (a preset or off) -> its two report lines; the preference is saved only when it went on.
function colourResult(action, ack) {
  const mode = ack.dark === true ? 'dark' : ack.dark === false ? 'light' : null
  const checks = action === 'off' ? null : mode === null ? null : judgeChecks(ack.samples, expectedColours(readFileSync(presetFile(action), 'utf8'), mode))
  if (ack.ok) savePrefs(action === 'off' ? null : action)
  return [
    ack.ok ? (action === 'off' ? 'Skin off (the helper stays, so the next skin needs no tick).' : `Skin ${action} applied by the colour helper.`) : `The helper could not apply it: ${(ack.errors ?? []).join('; ') || 'no reason given'}`,
    action === 'off' ? 'sampled colour checks: not applicable (skin off)' : checksLine(checks, mode),
  ]
}

// The one-line command through the helper (3 Nov 2026): the whole line is checked first (any bad part refuses it, nothing
// sent), then skin, font, type in that order, each through its own reviewed request. It stops at the first part that
// fails or gets no answer; parts before it stay (no rollback), parts after it are not tried. The font and type parts are
// reported from the helper's last proven pair, so a part that a later cleanup took off again says so, and after an
// unanswered request nothing is called proven. Prefs are saved from that final proven pair only.
const SET_SWITCH_WAIT_MS = 10_000 // the helper allows a colour change 8 s
const isPresetName = (n) => PRESET_NAME.test(n) && !n.startsWith('dotcheck-') && !isRetired(n) && existsSync(presetFile(n))
async function setRun(live) {
  if (args.some((a) => a.startsWith('--'))) return ['refused', EXIT.usage, ['set takes no options. Without a colour helper, use: node skin-auto.mjs tick <preset> --want-font=<name|off> --want-type=on|off']]
  let line
  try { line = parseSetLine(args, { isPreset: isPresetName, fonts: fontShipped }) } catch (e) { return ['refused', EXIT.usage, [String(e.message)]] }
  if (live.state === 'outdated') return ['refused', EXIT.refused, [`${live.why} Nothing was changed.`]]
  if (live.state === 'unknown') return ['refused', EXIT.refused, [`Could not tell whether a colour helper is running (${live.why}). Nothing was changed.`]]
  if (live.state === 'none') {
    // Nothing was sent. With a preset, /skin starts a tick run that carries the font and type parts (--want-*).
    const wantArgs = [line.font === undefined ? null : `--want-font=${line.font === 'off' ? 'off' : fontKey(line.font.name, line.font.size)}`, line.type === undefined ? null : `--want-type=${line.type ? 'on' : 'off'}`].filter(Boolean).join(' ')
    return ['refused', EXIT.refused, [`No colour helper is running in this Claude (${live.why}), so nothing was changed. ${line.skin !== null && line.skin !== 'off'
      ? `It needs one tick of Developer > Enable Main Process Debugger: /skin ${args.join(' ')} --tick (or: node skin-auto.mjs tick ${line.skin}${wantArgs ? ` ${wantArgs}` : ''}).`
      : 'Start with a skin, for example /skin dracula font plex type on (one tick), or with no skin: /skin font plex type on --tick (one tick). Turning colours off while setting a font or type needs a running colour helper.'}`]]
  }
  // Every part is checked before anything is sent. Turning something off is never gated (the helper always accepts it).
  const caps = Array.isArray(live.session.caps) ? live.session.caps : []
  const fonts = offersOf(live)
  if (line.type === true && !caps.includes('type')) return ['refused', EXIT.refused, ['Type is not available in this colour helper (this copy offered no type sheet), so nothing was changed.', NO_PORT, helperActiveLine(live.session.version)]]
  if (line.font !== undefined && line.font !== 'off') {
    const n = fontKey(line.font.name, line.font.size)
    if (!caps.includes('font') || !fonts.includes(n)) return ['refused', EXIT.refused, [`The font ${n} is not available in this colour helper, so nothing was changed. Apply a skin with a new tick (/skin <name> --tick) to give the helper this copy's fonts.`, NO_PORT, helperActiveLine(live.session.version)]]
    const i = installedNow(n)
    if (i === 'no') return ['refused', EXIT.refused, [`${fontFamily(n)} is not installed on this Mac, so nothing was changed. It is free: download it from ${FONT_LINKS[fontBase(n)]}, install it, then run the line again.`, NO_PORT]]
    if (i === 'failed') return ['refused', EXIT.refused, [`Could not check whether ${fontFamily(n)} is installed, so nothing was changed. Try again.`, NO_PORT]]
  }
  const { failed, final, out } = await runSetParts(line, {
    colour: async (skin) => {
      const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, skin, { randomUUID, waitMs: SET_SWITCH_WAIT_MS })
      return ack === null ? null : { ok: ack.ok === true, lines: colourResult(skin, ack) }
    },
    slot: async (action) => (await slotChange(live, action, { save: false })).ack,
    colourWaitS: SET_SWITCH_WAIT_MS / 1000, slotWaitS: SLOT_WAIT_MS / 1000,
  })
  if (final !== null) { const p = readPrefs(nodeFs, STATE); savePrefs(p.last, final.headers, fontShipped ? final.font : p.font) }
  const fontOn = final !== null && final.font !== null && line.font !== undefined && line.font !== 'off'
  return [failed ? 'failed' : 'ok', failed ? EXIT.failed : EXIT.ok, [
    ...out,
    fontOn ? FONT_MENU_LINE : null,
    fontOn && splitFontKey(final.font)?.size ? SIZE_MENU_LINE : null,
    '(as the colour helper reports; no debugger checked it)', NO_PORT, helperActiveLine(live.session.version),
  ]]
}
// A combined tick line: before anything starts (no lock, no prompt, no tick), every part that turns something on is
// checked against what this copy would give the new helper (skin.mjs slot-offers, the same checked sheets) and, for a
// font, against what is installed. Turning something off is never gated.
if (hasWants) {
  if (appliedPreset === null && !helperStart) usage('Font and type parts go with a preset or off, for example: node skin-auto.mjs tick dracula --want-font=plex --want-type=on')
  if ((wants.font !== undefined && wants.font !== 'off') || wants.type === 'on') {
    const r = spawnSync(NODE, [SKIN, 'slot-offers'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
    let offers = null
    try { offers = r.status === 0 ? JSON.parse(String(r.stdout).trim()) : null } catch {}
    const early = (m) => { console.error(m); console.log('PORT_STATE: unknown'); finish('refused', EXIT.refused) }
    if (offers === null || typeof offers !== 'object' || !Array.isArray(offers.parts)) early('Could not check which font and type sheets this copy offers, so nothing was started.')
    if (wants.type === 'on' && offers.headers !== true) early('Type is not available in this copy of Reskin (its type sheet is missing or did not pass its check), so nothing was started.')
    if (wants.font !== undefined && wants.font !== 'off') {
      if (!lookOffered(wants.font, offers.parts)) early(`The font ${wants.font} is not available in this copy of Reskin, so nothing was started.`)
      const i = installedNow(wants.font)
      if (i === 'no') early(`${fontLabel(wants.font)} is not installed on this Mac, so nothing was started. Each font is free: /skin font list shows where to download it.`)
      if (i === 'failed') early(`Could not check whether ${fontLabel(wants.font)} is installed, so nothing was started. Try again.`)
    }
  }
}
if (verb === 'switch' || verb === 'status' || verb === 'check' || verb === 'type' || verb === 'font' || verb === 'set' || verb === 'look') await helperRun()

if (checkOnly) {
  const chrome = chromeState()
  const port = portNow()
  const claude = claudeNow()
  const rows = [
    ['Node', `${process.versions.node}`, nodeOk(process.versions.node)],
    ['Claude desktop app installed', existsSync('/Applications/Claude.app') ? 'yes' : 'no', existsSync('/Applications/Claude.app')],
    ['Claude desktop app running', claude, claude === 'yes'],
    ...(() => {
      const c = chromeInstalled()
      // A tick-only release (release.json) never starts a throwaway Chrome, so the user's own Chrome may stay open.
      if (!oneClickShipped) return [['Google Chrome', c === 'yes' ? 'installed (when you tick, a chrome://inspect tab opens in it: close it)' : c === 'no' ? 'not installed (when you tick, Claude shows a small message: click OK)' : 'could not tell', c !== 'unknown']]
      return [['Google Chrome', c === 'yes' ? 'installed (a throwaway Chrome takes the inspect tab)' : c === 'no' ? 'not installed (Claude shows a small message; the run closes it)' : 'could not tell', c !== 'unknown'],
        ['Your own Chrome is closed', chrome.state === 'none' ? 'yes' : chrome.state, chrome.state === 'none']]
    })(),
    ['Port 9229 is closed', port.state, port.state === 'closed'],
  ]
  for (const [name, value, good] of rows) console.log(`${good ? 'ok  ' : 'FIX '} ${name}: ${value}`)
  console.log(oneClickShipped
    ? 'Also needed: Developer Mode on in Claude. one-click mode only: Accessibility for the program that runs this (System Settings > Privacy & Security); tick mode needs none.'
    : 'Also needed: Developer Mode on in Claude (first time only: Help > Troubleshooting > Enable Developer Mode; Claude restarts). No Accessibility or other permission is needed.')
  console.log(`PORT_STATE: ${port.state}`)
  const allGood = rows.every((r) => r[2])
  finish(allGood ? 'ok' : 'refused', allGood ? 0 : EXIT.refused)
}

// ---- state that cleanup needs ----
let dir = null
let sidecarPid = null
let hideProc = null
let guardian = null
let watchdog = null
let deadline = null
let skinProc = null
let ticked = false // set BEFORE the click: even a click that "failed" may have opened the port
let skinOk = null // null = not started
let lock = null // the held run lock (a bound loopback port); released at the end
let exitOverride = null
let front = 'Claude'
let stopping = false // set when cleanup begins
// The three-line report, filled from skin.mjs's machine lines and printed by cleanup.
const report = { checks: null, helper: null, doorMs: null, deferred: false, session: null }
let tickPortSeen = false // tick mode: did the port open inside the window? If not, guardian A stays for a late tick.
let guardianB = null // tick mode: the guardian started when the port is seen
let parentWatch = null // tick mode: this run's own port watch, stopped by cleanup
let portOpenedSeen = false // tick mode: this run itself saw the port open (even if the skin step never said so)
let plan = null // the no-skin tick's plan, computed once before the prompt (buildPlan)

// What the colour helper can do, in the words every tick prints.
const HELPER_STAYS = 'After this, a small colour helper stays inside Claude until you quit Claude. It can only switch between Reskin\'s own presets, fonts and headers, turn them off, or remove itself; the next change needs no tick.'
// One-click runs say what will happen before the scripted tick.
function disclose() {
  console.log([
    'Reskin will now tick Developer > Enable Main Process Debugger for you. The debugger is open for a few seconds; while it is open, any program on this Mac could run code inside Claude. Reskin closes it at once, with a backup guardian.',
    skinArgs[0] === 'apply' ? HELPER_STAYS : null,
  ].filter(Boolean).join('\n'))
  console.log('DISCLOSED')
}

// One way to run skin.mjs for every path (one-click with Chrome, without Chrome, tick), so they cannot drift.
async function runSkinChild(killMs) {
  skinProc = spawn(NODE, [SKIN, ...skinArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  skinProc.stdout.on('data', (d) => (out += d))
  skinProc.stderr.on('data', (d) => (out += d))
  const killer = setTimeout(() => { warn(`the skin step took over ${Math.round(killMs / 1000)} s; stopping it.`); skinProc.kill('SIGTERM') }, killMs)
  const code = await new Promise((res) => {
    skinProc.on('error', (e) => { out += `\ncould not start skin.mjs: ${e.message}`; res(-1) })
    skinProc.on('close', (c) => res(c ?? -1))
  })
  clearTimeout(killer)
  absorb(out, code)
  return { code, out }
}

// Reads skin.mjs's machine lines into the report: the sampled colours (judged here against the skin's own text) and
// whether the helper started. Missing or unreadable samples are "unknown", never a pass.
function absorb(out, code) {
  const door = out.split('\n').find((l) => l.startsWith('DOOR_MS: '))
  if (door && /^DOOR_MS: \d+$/.test(door)) report.doorMs = Number(door.slice('DOOR_MS: '.length)) // every operation (P5)
  if (skinArgs[0] === 'remove' || skinArgs[0] === 'reset') {
    report.checks = 'sampled colour checks: not applicable (skin removed)'
    report.helper = code === 0 ? 'helper: none (removed)' : 'helper: unknown (the removal did not fully succeed; check with /skin status or node skin-auto.mjs status)'
    if (code === 0) savePrefs(null, false, null)
    return
  }
  if (skinArgs[0] === 'start') {
    // The helper only: no skin was put on inside the window, no colours to judge yet. Nothing is saved here.
    report.deferred = out.split('\n').includes('DEFERRED_CHECKS')
    const h = out.split('\n').find((l) => l.startsWith('HELPER: '))
    if (h?.startsWith('HELPER: active ')) report.session = h.slice('HELPER: active '.length).trim()
    report.checks = 'sampled colour checks: not applicable (no skin put on)'
    report.helper = h?.startsWith('HELPER: active ') ? 'helper: started (no skin put on; checked after the debugger closed)'
      : h ? `helper: not confirmed started (${h.slice('HELPER: none '.length)}); /skin status shows whether one runs` : 'helper: not confirmed started (the start did not finish); /skin status shows whether one runs'
    return
  }
  if (skinArgs[0] !== 'apply') return
  report.deferred = out.split('\n').includes('DEFERRED_CHECKS')
  const line = out.split('\n').find((l) => l.startsWith('SAMPLES: '))
  let sample = null
  try { sample = line ? JSON.parse(line.slice('SAMPLES: '.length)) : null } catch {}
  const mode = sample?.mode === 'dark' || sample?.mode === 'light' ? sample.mode : null
  report.checks = report.deferred ? null : sample === null || mode === null ? checksLine(null) : checksLine(judgeChecks(sample.samples, expectedColours(appliedCss, mode)), mode)
  if (sample?.version) report.version = sample.version
  const h = out.split('\n').find((l) => l.startsWith('HELPER: '))
  if (h?.startsWith('HELPER: active ')) report.session = h.slice('HELPER: active '.length).trim()
  report.helper = h?.startsWith('HELPER: active ') ? helperActiveLine(sample?.version)
    : h ? `helper: not started this time (${h.slice('HELPER: none '.length)})` : 'helper: unchanged (the apply did not finish)'
  if (code === 0 && appliedPreset) savePrefs(appliedPreset)
}
const refocus = () => osa(`tell application "System Events" to set frontmost of process "${front.replace(/["\\]/g, '')}" to true`)
const attempt = (label, fn) => { try { return fn() } catch (e) { console.log(`cleanup step "${label}" failed: ${e.message}`) } }
// A close that could not clear the menu tick says so; that warning is passed on, never swallowed.
const closeClaudePort = () => {
  const r = spawnSync(NODE, [SKIN, 'close'], { encoding: 'utf8', timeout: 6_000, killSignal: 'SIGKILL' })
  const w = String(r.stdout ?? '').split('\n').find((l) => l.startsWith('WARNING: the menu item'))
  if (w) console.log(w)
  return r
}

// One cleanup for everyone: a second signal, the deadline and the normal end all wait for the same promise.
let cleanupPromise = null
const cleanup = (reason) => (cleanupPromise ??= doCleanup(reason))

// Ends every process that is demonstrably our throwaway Chrome: first the one we know, then anything
// carrying our profile folder as an exact argument (covers an interrupted start). Every question has three
// answers; "unknown" never counts as "gone", so the profile folder is kept whenever we are unsure.
async function endSidecar() {
  const look = () => {
    const pids = new Set(sidecarPid ? [sidecarPid] : [])
    let known = true
    if (dir) {
      const q = pgrepState(run('/usr/bin/pgrep', ['-f', '--', `--user-data-dir=${dir}`]))
      if (q.state === 'unknown') known = false
      for (const p of q.pids) pids.add(p)
    }
    const ours = []
    for (const p of pids) {
      const who = identity(p)
      if (who === 'ours') ours.push(p)
      else if (who === 'unknown') known = false
    }
    return { ours, known }
  }
  const t = Date.now()
  for (const p of look().ours) attempt('end throwaway Chrome', () => process.kill(p, 'SIGTERM')) // normal end of session: no dialog
  let killed = false
  while (Date.now() - t < 9_000) {
    const { ours, known } = look()
    if (known && ours.length === 0) return true
    if (!killed && Date.now() - t > 5_000) { killed = true; for (const p of ours) attempt('force end', () => process.kill(p, 'SIGKILL')) }
    await sleep(250)
  }
  const last = look()
  return last.known && last.ours.length === 0
}

async function doCleanup() {
  stopping = true // nothing new may start from here on (the no-Chrome path checks this before its skin step)
  attempt('hide loop', () => hideProc?.kill('SIGTERM'))
  attempt('dialog watcher', () => { if (osaChild && osaChild.exitCode === null) osaChild.kill('SIGKILL') })
  attempt('skin child', () => skinProc?.kill('SIGTERM'))
  // 1. Claude's debugger port first. Nothing that could close it again is switched off until the very end.
  if (ticked) {
    let closed = false
    for (let i = 0; i < 3 && !closed; i++) {
      attempt('check port', () => { closed = portNow().state === 'closed' })
      if (!closed) { attempt('close port', closeClaudePort); await sleep(300) }
    }
  }
  // The port is handled first; only then is a skin child that ignored the stop ended for sure.
  attempt('port watch', () => clearInterval(parentWatch))
  await endSkinChild()
  // While we waited for the child, guardian B skipped its early look (it only acts once this run is gone),
  // so the port is checked and closed once more here.
  if (ticked) {
    let closed = false
    attempt('check port again', () => { closed = portNow().state === 'closed' })
    if (!closed) attempt('close port again', closeClaudePort)
  }
  // 2. The throwaway Chrome, only what is demonstrably ours; keep its folder if anything survived or we cannot tell.
  const ended = await endSidecar()
  if (sidecarPid || dir) stamp(ended ? 'throwaway Chrome ended' : 'throwaway Chrome could NOT be ended')
  if (!ended && (sidecarPid || dir)) exitOverride ??= EXIT.sidecarLeft // a leftover Chrome is a failed run, not a footnote
  if (!ended) warn(`the throwaway Chrome may still be running; end it with: kill -TERM ${sidecarPid ?? '(see Activity Monitor)'} (its folder ${dir} was kept)`)
  attempt('delete folder', () => { if (ended && dir && dir.startsWith(SIDECAR_PREFIX)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) }) // Chrome may still be writing for a moment after it ends
  if (!tickMode) attempt('refocus', refocus) // tick mode never uses AppleScript
  // 3. Final, honest report, from a fresh look at the port.
  if (!tickMode) attempt('final checks', () => {
    const chrome = chromeState()
    if (chrome.state === 'found') warn(`Chrome is still running (pid ${chrome.pids.join(', ')}). Check it by hand.`)
    if (chrome.state === 'unknown') warn('could not check whether Chrome is still running.')
  })
  const look = () => { try { return portNow() } catch (e) { return { state: 'unknown', detail: e.message } } }
  let port = look()
  // Tick mode, the port was seen open and is now closed: one more look a few seconds later (secondLook), before any
  // safety net stands down, so a second click on the menu item right after the run is caught and closed. Whatever that
  // look finds is what the report says; it only starts when its whole worst case fits in the run's own limit.
  let stillClosedS = null
  if (ticked && tickMode && (tickPortSeen || portOpenedSeen) && port.state === 'closed') {
    // The port is confirmed closed, so the watchdog (a close that can block for 6 s) is retired here: firing during the
    // second look it would stretch the run past its limit. The guardians and the deadline stay until the report.
    attempt('watchdog', () => { if (watchdog) clearTimeout(watchdog); watchdog = null })
    const r = await secondLook({ look, close: () => attempt('close reopened port', closeClaudePort), sleep, leftMs: RUN_LIMIT_MS - (Date.now() - RUN_START) })
    if (r.note) stamp(r.note)
    if (r.reopened) warn(REOPENED_WARNING)
    if (r.port) port = r.port
    stillClosedS = r.stillClosedS
  }
  // The three lines every run that reached Claude reports.
  if (ticked) {
    if (report.checks) console.log(report.checks)
    console.log(port.state === 'closed' ? debuggerClosedLine(report.doorMs, tickMode && !tickPortSeen && !portOpenedSeen, stillClosedS)
      : `debugger: NOT confirmed closed (${port.state}). Fix: quit and reopen Claude (Cmd+Q, then open it again); leave the Developer menu item alone.`)
    console.log(report.helper ?? 'helper: unchanged (nothing was applied)')
  }
  console.log(`PORT_STATE: ${port.state}`)
  // Only our own business if we ticked the menu; a refused run never touched the port.
  if (ticked && port.state === 'open') warn(`port 9229 is STILL OPEN:\n${port.detail}\nQuit and reopen Claude (Cmd+Q, then open it again); leave the Developer menu item alone.`)
  if (ticked && port.state === 'unknown') warn(`could not confirm port 9229 is closed (${port.detail}). Quit and reopen Claude to be sure.`)
  if (ticked && port.state !== 'closed') {
    exitOverride = EXIT.portNotConfirmed
    warn('the backup guardian stays on duty for a few minutes and keeps retrying; after that, quit and reopen Claude.')
  } else if (!ended && (sidecarPid || dir)) {
    // The port is closed but the throwaway Chrome is not confirmed gone: the guardian stays to end it.
    warn('the backup guardian may try once more to end the leftover throwaway Chrome, if this run has ended within about a minute. If it is still running after that, end it with the kill command above.')
  } else {
    // Closure confirmed (or never opened) and no Chrome left: only now are the safety nets switched off.
    attempt('timers', () => { if (watchdog) clearTimeout(watchdog); if (deadline) clearTimeout(deadline) })
    // Tick mode, the user was asked to tick and no port came in the window: guardian A stays, to close a tick that comes
    // after it (it stands down for a newer run). Everything else (dry run, refused before the prompt, port seen): done.
    if (!(tickMode && ticked && !tickPortSeen)) attempt('guardian', () => { if (guardian) process.kill(-guardian.pid, 'SIGTERM') })
    attempt('guardian B', () => { if (guardianB) process.kill(-guardianB.pid, 'SIGTERM') })
  }
  attempt('run mark', unmarkRun)
  attempt('test sheets', dropSheetsOnce) // while the lock is still held: a next run cannot have taken the sheet yet
  attempt('lock', () => { void lock?.release?.() })
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  // Say plainly that the run was stopped (5 Nov 2026: a Ctrl-C run ended with only "RESULT: failed"); the cleanup lines
  // that follow say what state things were left in.
  process.on(sig, () => {
    console.log(sig === 'SIGINT' ? 'Stopped: you pressed Ctrl-C.' : `Stopped: asked to end (${sig}).`)
    void cleanup('signal').finally(() => { console.log('RESULT: failed'); process.exit(exitOverride ?? EXIT.signal) })
  })
}
// After 60 s the run stops waiting and starts cleaning up (cleanup itself is bounded by per-command limits, so the
// total can be longer; the mod allows 180 s).
const RUN_LIMIT_MS = tickMode ? (helperStart ? (hasWants ? TICK.runLimitStartWantsMs : TICK.runLimitStartMs) : hasWants ? TICK.runLimitWantsMs : TICK.runLimitMs) : 60_000
deadline = setTimeout(() => {
  console.error(`Took too long (${RUN_LIMIT_MS / 1000} s); stopping and starting cleanup.`)
  void cleanup('timeout').finally(() => { console.log('RESULT: failed'); process.exit(exitOverride ?? EXIT.timeout) })
}, Math.max(1_000, RUN_LIMIT_MS - (Date.now() - RUN_START)))

class Refused extends Error {}
const refuse = (m) => { throw new Refused(m) }

async function main() {
  // 1. One run at a time on this Mac (a bound loopback port, freed by the OS even if we are killed).
  lock = await acquireLockWaiting(lockWait.ms)
  if (!lock.ok) refuse(`Not started: ${lock.reason}.`)
  markRun()
  // Only the run holding the lock owns the test sheets: a refused second run never deletes the first run's sheet.
  // An exit that skips cleanup still holds the lock (the OS frees it only when this process is gone), so it may delete too.
  if (dotSheets.length > 0 && !dryRun) { dropSheets = ownTestSheets(dotSheets, nodeFs); process.on('exit', dropSheetsOnce) }
  // An older helper still running inside Claude: a new tick would put a second skin beside its colours.
  // A helper that cannot be checked (unknown) may be such an old one too, so it refuses as well.
  if (!dryRun) {
    const live = liveSession(nodeFs, STATE, procOf, { claudeStart })
    if (live.state === 'outdated') refuse(`${live.why} Nothing was changed.`)
    if (live.state === 'unknown') refuse(`Could not tell whether a colour helper is already running (${live.why}). Quit and reopen Claude, then try again. Nothing was changed.`)
    // The no-skin tick: decided here, under the lock. A current helper means no tick is needed; nothing
    // is sent to it (it may be stuck: the user's next command goes through the helper paths, which say so).
    if (helperStart && live.state === 'active') refuse('A colour helper is already running, so no tick is needed. Use /skin type on, /skin font <name> or /skin fonts (without --tick). Nothing was changed.')
  }
  if (tickMode) return tickRun()

  // 2. Your own Chrome must be closed (it would receive the inspect tab). Unknown counts as "not safe".
  const chrome = chromeState()
  if (chrome.state === 'unknown') refuse('Could not check whether Chrome is running, so I did not start. Nothing was changed.')
  if (chrome.state === 'found') {
    refuse(commandOf(chrome.pids[0]).includes(SIDECAR_PREFIX)
      ? `A leftover throwaway Chrome is running (pid ${chrome.pids[0]}). End it with: kill -TERM ${chrome.pids[0]}`
      : 'Your own Chrome is open. Quit it first (Cmd-Q), then run this again. Nothing was changed.')
  }
  // 3. Claude must be running and its debugger port closed (a toggle click on an open port would close it).
  if (!dryRun) {
    const claude = claudeNow()
    if (claude !== 'yes') refuse(claude === 'no' ? 'The Claude desktop app is not running. Nothing was changed.' : 'Could not check whether Claude is running. Nothing was changed.')
    const port = portNow()
    if (port.state === 'open') refuse('Port 9229 is already open (a manual tick, or an earlier run). Quit and reopen Claude (Cmd+Q, then open it again), then try again. Nothing was changed.')
    if (port.state === 'unknown') refuse(`Could not check port 9229 (${port.detail}). Nothing was changed.`)
    // If we cannot even verify Claude's signature, skin.mjs could never close the port again: refuse BEFORE the click.
    const verify = spawnSync(NODE, [SKIN, 'verify'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
    if (verify.status !== 0) refuse(`Claude's signature could not be verified, so I did not touch it: ${(verify.stdout + verify.stderr).trim().slice(0, 200)}`)
  }
  front = osa('tell application "System Events" to get name of first process whose frontmost is true').stdout.trim() || 'Claude'

  // 3b. Is there a Google Chrome on this Mac at all (asked by name, as Claude's `open -a` will)? Unsure means stop.
  const installed = chromeInstalled()
  if (installed === 'unknown') refuse('Could not tell whether Google Chrome is installed, so I did not start. Nothing was changed.')
  if (installed === 'no') return noChromeRun()

  // 4. Start the throwaway Chrome: hidden, own folder, no window.
  dir = mkdtempSync(SIDECAR_PREFIX)
  run('/usr/bin/open', ['-gj', '-b', 'com.google.Chrome', '--args', `--user-data-dir=${dir}`,
    '--no-startup-window', '--no-first-run', '--no-default-browser-check',
    '--disable-session-crashed-bubble'])
  // No --remote-debugging-port. That port had no password and any account on this Mac could drive the
  // throwaway Chrome through it; it was only used to see Chrome was ready and where the inspect tab landed.

  // 5. Wait up to 10 s for it to start and prove it is the one we started, then for macOS to list it as a running app
  // (what Claude's `open` hands the inspect tab to), plus a moment to settle.
  for (let i = 0; i < 40 && !sidecarPid && !stopping; i++) {
    const started = chromeState()
    if (started.state === 'found' && started.pids.length === 1 && identity(started.pids[0]) === 'ours') sidecarPid = started.pids[0]
    else await sleep(250)
  }
  let listed = false
  for (let i = 0; i < 20 && sidecarPid && !listed && !stopping; i++) {
    listed = osa(`tell application "System Events" to exists (first process whose unix id is ${safePid(sidecarPid)})`).stdout.trim() === 'true'
    if (!listed) await sleep(250)
  }
  if (!sidecarPid || !listed) {
    // Cleanup ends anything carrying our profile folder; nothing in Claude has been touched yet.
    refuse('The throwaway Chrome did not start properly. Nothing in Claude was touched.')
  }
  await sleep(1_000)
  stamp(`throwaway Chrome ready (pid ${sidecarPid})`)
  if (dryRun) {
    // Exercise the guardian start-up path too (inert: it would only wake after an hour; cleanup stops it at once).
    guardian = spawn('/bin/sh', ['-c', guardScript({ first: 3600 }), NODE, SKIN], { detached: true, stdio: 'ignore' })
    guardian.on('error', () => { guardian = null })
    guardian.unref()
    if (!Number.isInteger(guardian?.pid)) refuse('Could not start the backup guardian.')
    console.log('Dry run done: throwaway Chrome and guardian started and will now be ended.')
    return EXIT.ok
  }

  // Whether the skin matches the mode Claude is showing is checked inside the run (skin.mjs reads Claude's own
  // nativeTheme), which is exact; the Mac's mode is not, since Claude may be set to Light or Dark.

  // 6. Safety net in this process (25 s). The independent guardian is started right before the click (step 7).
  watchdog = setTimeout(() => { closeClaudePort() }, 25_000)

  // 7. Last look: still exactly our throwaway Chrome and nothing else, right before the click.
  const again = chromeState()
  if (again.state !== 'found' || again.pids.length !== 1 || again.pids[0] !== sidecarPid || identity(sidecarPid) !== 'ours') {
    refuse('Another Chrome appeared just before the click, so I stopped. Nothing in Claude was touched.')
  }
  // The guardian survives even if this process is killed outright. It waits 30 s, then keeps closing
  // Claude's port every 10 s (up to 6 tries) until nothing listens on 9229. It starts immediately before the click.
  if (stopping) refuse('Stopped before the click (the run was cancelled). Nothing in Claude was touched.')
  const GUARD = guardScript()
  guardian = spawn('/bin/sh', ['-c', GUARD, NODE, SKIN, dir ?? '', String(process.pid)], { detached: true, stdio: 'ignore' })
  guardian.on('error', () => { guardian = null })
  guardian.unref()
  if (!Number.isInteger(guardian.pid)) refuse('Could not start the backup guardian, so I did not touch Claude. Nothing was changed.')
  hideProc = spawn('/usr/bin/osascript', ['-e', hideScript(sidecarPid)], { stdio: 'ignore' }) // hides only OUR Chrome
  // Screenshots need Claude's window painted: bring it to the front (cleanup puts the previous app back).
  if (isBatch) osa('tell application "System Events" to set frontmost of process "Claude" to true')
  disclose()
  if (stopping) refuse('Stopped before the click (the run was cancelled). Nothing in Claude was touched.')
  skinOk = false
  ticked = true
  const click = osa('tell application "System Events" to tell process "Claude" to click menu item "Enable Main Process Debugger" of menu "Developer" of menu bar item "Developer" of menu bar 1')
  if (click.status !== 0) { console.error('Could not click the menu item:', click.stderr.trim() || 'no answer'); return EXIT.failed }
  stamp('menu ticked')

  // 8. Apply the skin; skin.mjs closes and confirms the port itself.
  const { code, out } = await runSkinChild(25_000)
  skinOk = code === 0
  stamp(`skin step finished (exit ${code})`)
  console.log(out.trim())
  // A batch that did not finish its final step may have left a test skin on (it survives reloads until Claude restarts).
  if (isBatch && !/^FINAL: ok$/m.test(out)) {
    const last = [...out.matchAll(/^LAST_APPLIED: ([a-z0-9-]+)$/gm)].pop()?.[1]
    if (last) warn(`Claude may still show the test skin "${last}". Put things back with: node skin-auto.mjs remove (or /skin <your skin>).`)
  }

  return skinOk ? EXIT.ok : EXIT.failed
}

// No Google Chrome on this Mac: no throwaway Chrome. After the tick Claude's own `open` fails and Claude shows its
// "Inspector session is active" dialog (its port is already open by then). The skin step starts at once; in parallel a
// watcher clicks that dialog's button for up to 8 s. Port closing and its safety nets are exactly as in the Chrome path.
async function noChromeRun() {
  stamp('no Google Chrome on this Mac: no throwaway Chrome needed')
  if (dryRun) {
    guardian = spawn('/bin/sh', ['-c', guardScript({ first: 3600 }), NODE, SKIN], { detached: true, stdio: 'ignore' })
    guardian.on('error', () => { guardian = null })
    guardian.unref()
    if (!Number.isInteger(guardian?.pid)) refuse('Could not start the backup guardian.')
    console.log('Dry run done: no-Chrome path chosen, guardian started and will now be ended.')
    return EXIT.ok
  }
  watchdog = setTimeout(() => { closeClaudePort() }, 25_000)
  // Last look right before the click: still no Chrome running and still none installed.
  if (chromeState().state !== 'none' || chromeInstalled() !== 'no') {
    refuse('Google Chrome appeared just before the click, so I stopped. Nothing in Claude was touched.')
  }
  // Read Claude's windows before the click: if the message could not be ruled out afterwards (unreadable windows, a
  // window of an unexpected kind, or the message already up), refuse now, before the port is ever opened.
  const pre = parseDialogRead(osa(dialogReadScript()).stdout)
  if (!provesNoDialog(pre)) {
    refuse(pre === null ? "I could not read Claude's windows (does this terminal app have Accessibility permission?). Nothing in Claude was touched."
      : pre.dialogs.length > 0 ? 'Claude is already showing an "Inspector session is active" message: click its OK button, then run this again. Nothing else was touched.'
      : pre.unreadable > 0 ? `${pre.unreadable} of Claude's windows could not be read, so I could not check for its message afterwards. Nothing in Claude was touched.`
      : `Claude has a window of an unexpected kind (${pre.unsureKinds.join(', ') || 'unknown'}) that I could not fully search, so I could not check for its message afterwards. Close it and try again. Nothing in Claude was touched.`)
  }
  // The guardian waits longer here: the message is closed before the skin step, and that wait must not eat its allowance.
  if (stopping) refuse('Stopped before the click (the run was cancelled). Nothing in Claude was touched.')
  guardian = spawn('/bin/sh', ['-c', guardScript({ first: NO_CHROME_GUARD_FIRST_S }), NODE, SKIN, '', String(process.pid)], { detached: true, stdio: 'ignore' })
  guardian.on('error', () => { guardian = null })
  guardian.unref()
  if (!Number.isInteger(guardian.pid)) refuse('Could not start the backup guardian, so I did not touch Claude. Nothing was changed.')
  if (isBatch) osa('tell application "System Events" to set frontmost of process "Claude" to true')
  disclose()
  if (stopping) refuse('Stopped before the click (the run was cancelled). Nothing in Claude was touched.')
  skinOk = false
  ticked = true
  const click = osa('tell application "System Events" to tell process "Claude" to click menu item "Enable Main Process Debugger" of menu "Developer" of menu bar item "Developer" of menu bar 1')
  if (click.status !== 0) { console.error('Could not click the menu item:', click.stderr.trim() || 'no answer'); return EXIT.failed }
  stamp('menu ticked')

  // Claude freezes while its "Inspector session is active" message is up (live probe, 12 Oct 2026), so the message is
  // closed first (watcher: 8 s from the click) and the skin step runs only after. No click, no skin step.
  let out = ''
  const step = await closeMessageThenApply({
    watch: ({ ms, stop = () => false }) => {
      const start = Date.now()
      const once = () => osaAsync(dialogScript(), Math.max(300, Math.min(3_000, start + ms - Date.now()))) // never past `ms`
      return watchDialog(once, { start, ms, stop: () => stopping || stop() })
    },
    read: async () => parseDialogRead(await osaAsync(dialogReadScript(), NO_CHROME_TIMES.readMs)),
    stopped: () => stopping,
    runSkin: async () => {
      if (stopping) return -1 // cleanup has begun: never start a skin step now
      clearTimeout(watchdog) // a fresh 25 s for the skin step itself (skin.mjs keeps its own budget from its start)
      watchdog = setTimeout(() => { closeClaudePort() }, 25_000)
      const r = await runSkinChild(NO_CHROME_TIMES.skinKillMs)
      out += r.out
      return r.code
    },
  })
  if (step.dialog === 'clicked') stamp("Claude's \"Inspector session is active\" message closed")
  else if (step.noMessage) {
    stamp('no "Inspector session is active" message appeared before the skin step')
    if (step.lateDialog === 'clicked') stamp('it appeared late, during the skin step, and was closed')
    else warn('If a small message, "Inspector session is active", shows up in Claude, click its OK button (Claude is frozen while it is up).')
  }
  if (!step.ran) {
    if (step.messageUp) warn(`Claude is showing a small message, "Inspector session is active", and is frozen until it closes: ${step.why}. Click its OK button now. Nothing was applied. If the port is reported open below, clicking OK is what lets the backup guardian close it.`)
    else warn(`Nothing was applied: ${step.why}. If a small message, "Inspector session is active", is showing in Claude, click its OK button (Claude is frozen while it is up).`)
    return EXIT.failed
  }
  const code = step.code
  skinOk = code === 0
  stamp(`skin step finished (exit ${code})`)
  console.log(out.trim())
  if (isBatch && !/^FINAL: ok$/m.test(out)) {
    const last = [...out.matchAll(/^LAST_APPLIED: ([a-z0-9-]+)$/gm)].pop()?.[1]
    if (last) warn(`Claude may still show the test skin "${last}". Put things back with: node skin-auto.mjs remove (or /skin <your skin>).`)
  }
  return skinOk ? EXIT.ok : EXIT.failed
}

// "I tick it": everything is checked and every safety net is running BEFORE the user is
// asked to tick. No AppleScript, no Accessibility, no throwaway Chrome: the user's own Chrome may stay open (Claude's
// inspect tab lands there). The port is watched for TICK.windowMs; skin.mjs then runs with --patient (a Mac without Chrome
// is frozen until the user clicks OK on Claude's message). Guardian A (armed before the prompt) closes a tick that comes
// after the window and stands down if another run holds the lock; guardian B starts when the port is seen.
async function tickRun() {
  const claude = claudeNow()
  if (claude !== 'yes') refuse(claude === 'no' ? 'The Claude desktop app is not running. Nothing was changed.' : 'Could not check whether Claude is running. Nothing was changed.')
  const port0 = portNow()
  if (port0.state === 'open') refuse('Port 9229 is already open (a manual tick, or an earlier run). Quit and reopen Claude (Cmd+Q, then open it again), then try again. Nothing was changed.')
  if (port0.state === 'unknown') refuse(`Could not check port 9229 (${port0.detail}). Nothing was changed.`)
  const verify = spawnSync(NODE, [SKIN, 'verify'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
  if (verify.status !== 0) refuse(`Claude's signature could not be verified, so I did not ask for the tick: ${(verify.stdout + verify.stderr).trim().slice(0, 200)}`)
  // Which way Claude's inspect tab goes, for the disclosure only. No AppleScript in this mode, so only the usual places
  // are looked at; when Chrome is not there, both outcomes are described.
  const installed = existsSync(CHROME_APP) || existsSync(path.join(homedir(), 'Applications', 'Google Chrome.app')) ? 'yes' : 'maybe-no'
  const running = chromeState().state
  if (dryRun) {
    guardian = spawn('/bin/sh', ['-c', guardScript({ first: 3600, yieldPort: LOCK_PORT }), NODE, SKIN], { detached: true, stdio: 'ignore' })
    guardian.on('error', () => { guardian = null })
    guardian.unref()
    if (!Number.isInteger(guardian?.pid)) refuse('Could not start the backup guardian.')
    console.log('Dry run done: tick mode checks passed, guardian started and will now be ended. Nothing was asked of you.')
    return EXIT.ok
  }
  guardian = spawn('/bin/sh', ['-c', guardScript({ first: TICK.guardAFirstS, yieldPort: LOCK_PORT }), NODE, SKIN, '', String(process.pid), STATE], { detached: true, stdio: 'ignore' })
  guardian.on('error', () => { guardian = null })
  guardian.unref()
  if (!Number.isInteger(guardian.pid)) refuse('Could not start the backup guardian, so I did not ask for the tick. Nothing was changed.')
  // The skin step starts now, does its slow checks, and waits for the port itself, so nothing has to
  // start once the debugger is open. The prompt comes only after it says it is ready.
  const child = startTickChild()
  const ready = await child.until(['CHILD_READY'], TICK.readyMs)
  if (ready !== 'CHILD_READY') {
    attempt('skin child', () => skinProc?.kill('SIGTERM'))
    refuse(`The skin step could not get ready, so I did not ask for the tick. Nothing was changed. ${child.text().replace(/^Stopped: /m, '').trim().slice(0, 300)}`)
  }
  // The no-skin tick's plan: computed once, here, before the prompt; what is announced is what is done after the close.
  if (helperStart) plan = buildPlan({ wants, prefs: readPrefs(nodeFs, STATE), fontShipped })
  if (stopping) refuse('Stopped before the prompt (the run was cancelled). Nothing was changed.')
  ticked = true // set BEFORE the prompt: from here on the user may open the port at any moment
  skinOk = false
  console.log([
    'Ready. Before you tick, so nothing surprises you:',
    helperStart ? '- This starts the colour helper only. No skin is put on. Any Reskin skin is taken off. A Claude page may reload once.' : null,
    helperStart && plan.parts.length > 0 ? `- It also ${plan.words}.` : null,
    installed !== 'yes' ? '- Claude will probably show a small message, "Inspector session is active": click its OK button (Claude\'s window stops updating until you do). If a "chrome://inspect" tab opens instead, close it.'
      : running === 'found' ? '- A "chrome://inspect" tab will open in Chrome. Close it.'
      : '- Chrome will open with a "chrome://inspect" tab. Close it.',
    '- While the debugger is open (a few seconds; on a Mac without Chrome, until you click OK), any program on this Mac could run code inside Claude. Reskin closes it at once; if Reskin stops part-way, backup guardians try to close it, but if in doubt, quit and reopen Claude.',
    skinArgs[0] === 'apply' || skinArgs[0] === 'start' ? `- ${HELPER_STAYS}` : null,
    `NOW: in Claude's top menu bar (Developer sits next to Window), click Developer > Enable Main Process Debugger once. You have ${TICK.windowMs / 1000} seconds. Press Ctrl-C to cancel.`,
    DEV_MODE_LINE,
  ].filter(Boolean).join('\n'))
  // After `Ready.` and before READY_TO_TICK, so the /skin card reads it with the disclosure.
  if (helperStart) console.log(planLine(plan))
  console.log('READY_TO_TICK') // the /skin mod shows the tick prompt the moment it reads this line
  // The port is also watched here, independently of the skin step, so guardian B starts even if the skin
  // step hangs before it reports the port (on a Mac without Chrome only B covers a late OK click).
  // A non-blocking probe, one at a time, so a slow check never delays the skin step's lines.
  let watching = false
  parentWatch = setInterval(async () => {
    if (watching) return
    watching = true
    // A probe that answers after cleanup began must not start a guardian.
    try { if ((await tcpProbe()).state === 'open' && !stopping) { portOpenedSeen = true; startGuardianB() } } catch {} finally { watching = false }
  }, 1_000)
  // Never once cleanup has begun or either watch has seen the port: a hint then could prompt a second click.
  const hints = TICK.hintsAtMs.map((ms) => setTimeout(() => { if (!stopping && !portOpenedSeen) console.log(TICK_HINT) }, ms))
  // The child ends the window itself (WINDOW_ENDED); the extra seconds only cover a child that hangs.
  const seen = await child.until(['PORT_SEEN'], TICK.windowMs + 5_000)
  for (const h of hints) clearTimeout(h)
  clearInterval(parentWatch)
  if (seen !== 'PORT_SEEN') {
    if (stopping) return EXIT.signal
    if (seen === 'exit' && child.code() === 130) return EXIT.signal
    attempt('skin child', () => skinProc?.kill('SIGTERM'))
    // A waiting skin step has nothing to close, so one that ignores the stop is ended for sure.
    try { if (portNow().state === 'open') { portOpenedSeen = true; startGuardianB() } } catch {}
    if (seen === 'exit' && child.code() !== 5) {
      warn(`The skin step stopped before the debugger opened, so nothing was applied: ${child.text().split('\n').filter((l) => !['CHILD_READY', 'PORT_SEEN', 'WINDOW_ENDED'].includes(l.trim())).join(' ').replace(/^Stopped: /, '').trim().slice(0, 300)}`)
      return EXIT.failed
    }
    warn(`Time is up (${TICK.windowMs / 1000} s) and nothing was applied. No Developer menu? Turn on Help > Troubleshooting > Enable Developer Mode first (Claude restarts). Do not tick now. If you already did, quit and reopen Claude (a backup guardian may close the debugger, but do not rely on it). To try again: run the same command.`)
    return EXIT.timeout
  }
  tickPortSeen = true
  stamp('debugger port seen: stop clicking')
  startGuardianB()
  watchdog = setTimeout(() => { closeClaudePort() }, TICK.applyMs + 2_000)
  if (installed !== 'yes') console.log('If Claude shows "Inspector session is active", click OK now.')
  const killer = setTimeout(() => { warn(`the skin step took over ${Math.round(TICK.applyMs / 1000)} s; stopping it.`); skinProc?.kill('SIGTERM') }, TICK.applyMs)
  await child.until([], Infinity)
  clearTimeout(killer)
  const code = child.code()
  absorb(child.text(), code)
  skinOk = code === 0
  stamp(`skin step finished (exit ${code})`)
  console.log(child.text().split('\n').filter((l) => !['CHILD_READY', 'PORT_SEEN', 'DEFERRED_CHECKS'].includes(l) && !l.startsWith('DOOR_MS: ')).join('\n').trim())
  // P3: the colour checks, now that the debugger is closed: the helper puts the same preset on again and answers with
  // the sampled colours and Claude's mode. No port, no tick; an unanswered check is "unknown", never a pass.
  if (helperStart) {
    // No-skin tick: the helper takes any skin off and the check must prove "no skin on"; only then the plan, which stops
    // at the first part that does not complete. Any silence or failure ends the run here, never with a second tick.
    if (skinOk && report.deferred && (await startChecks()) === 'ok') { if (!(await startPlan())) skinOk = false }
    else {
      if (skinOk) skinOk = false
      if (plan?.parts.length) console.log(`part: not tried: ${plan.words} (the colour helper was not confirmed with no skin on). No skin was put on.`)
    }
    return skinOk ? EXIT.ok : EXIT.failed
  }
  if (skinOk && report.deferred && (await deferredChecks()) === 'failed') skinOk = false
  // An explicit font or type part of a combined line that does not complete fails the run, although the skin is on.
  if (skinOk && appliedPreset !== null && !(await restoreSlot())) skinOk = false
  return skinOk ? EXIT.ok : EXIT.failed
}

// After a restart (3 Nov 2026): the remembered headers and font come back in the same tick run, through the helper this
// run just started, with no second tick. Only after the skin is confirmed and the debugger confirmed closed, while this
// run still holds the lock. A restore that fails or gets no answer never fails the skin; it says so on its own line.
// A copy without fonts (release.json) skips the font and keeps it remembered.
// A combined tick line (--want-font, --want-type) sends its own parts first, through the same steps as the helper path
// (runSetParts: font, then type, stop at the first that does not complete, judged from the last proven pair), each with
// the full slot wait; a part it names replaces the remembered one, a part it leaves out is restored as before.
// Returns false only when a part of the line did not complete (the run then fails although the skin is on).
async function restoreSlot() {
  const prefs = readPrefs(nodeFs, STATE)
  const font = wants.font !== undefined ? null : fontShipped ? prefs.font : null
  const type = wants.type !== undefined ? false : prefs.type
  if (!hasWants && !type && font === null) return true
  const say = (m) => console.log(`restore: ${m}`)
  const tell = (m) => console.log(`part: ${m}`)
  const skip = (why) => {
    if (hasWants) tell(`font and type parts not tried (${why}): the skin itself is on. Run the same /skin line again (no tick needed once the helper answers).`)
    if (type || font !== null) say(`skipped (${why}): run /skin type on or /skin font <name> yourself`)
    return !hasWants
  }
  if (!report.session || !/^[0-9a-f-]{36}$/.test(report.session) || !Number.isFinite(report.doorMs) || portNow().state !== 'closed') return skip('the debugger was not confirmed closed, or no new colour helper')
  const live = liveSession(nodeFs, STATE, procOf, { claudeStart })
  if (live.state !== 'active' || live.session.session !== report.session) return skip('the colour helper this run started is not the one answering')
  const r = await restoreParts({
    wants, prefs, type, font, fontShipped,
    caps: Array.isArray(live.session.caps) ? live.session.caps : [], fonts: offersOf(live),
    installed: installedNow, waits: { want: TICK.wantMs, restore: TICK.restoreMs / 2 },
    send: async (action, waitMs) => { const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, action, { randomUUID, waitMs }); return ack !== null && ack.action === action ? ack : null },
  })
  for (const l of r.lines) console.log(l)
  if (r.save !== null) savePrefs(readPrefs(nodeFs, STATE).last, r.save.headers, r.save.font)
  return r.ok
}

// The no-skin tick, after the close: through the exact helper this run started, debugger
// closed. `off` must come back done and ok from that helper, then a read-only `check` must give a stable "no skin on"
// with at least one readable Claude page. Anything else is unconfirmed and fails the run (the helper may be on).
async function startChecks() {
  const unconfirmed = (why) => {
    report.checks = `sampled colour checks: not applicable (no skin put on); no skin on: NOT confirmed (${why})`
    warn(`the colour helper may be on, but I could not confirm that no skin is on (${why}). Nothing else was tried. Run /skin check, or quit and reopen Claude.`)
    return 'failed'
  }
  if (!report.session || !/^[0-9a-f-]{36}$/.test(report.session) || !Number.isFinite(report.doorMs)) return unconfirmed('no new colour helper, or the debugger was not confirmed closed')
  if (portNow().state !== 'closed') return unconfirmed('the debugger was not confirmed closed')
  const live = liveSession(nodeFs, STATE, procOf, { claudeStart })
  if (live.state !== 'active' || live.session.session !== report.session) return unconfirmed('the colour helper this run started is not the one answering')
  let off = null
  try { ({ ack: off } = await sendSwitch(nodeFs, STATE, report.session, 'off', { randomUUID, waitMs: TICK.confirmMs })) } catch {}
  const o = judgeOff(off)
  if (!o.ok) return unconfirmed(o.why)
  let seen = null
  try { ({ ack: seen } = await sendSwitch(nodeFs, STATE, report.session, 'check', { randomUUID, waitMs: TICK.checkMs })) } catch {}
  const j = judgeNoSkin(seen === null ? null : { ...seen, version: seen.version ?? live.session.version }, { tested: testedVersions(), digestOf: (x) => createHash('sha256').update(x).digest('hex') })
  if (j.version && j.verdict) { try { writePrivateJson(nodeFs, STATE, 'last-check.json', { v: 1, version: j.version, verdict: j.verdict, at: new Date().toISOString() }, randomUUID) } catch {} }
  if (!j.ok) return unconfirmed(j.why)
  // Confirmed: no skin is on now, so none is remembered (the reapply offer must not bring one back). Headers and font stay.
  savePrefs(null)
  report.checks = 'sampled colour checks: not applicable (no skin put on); no skin on: confirmed (as the colour helper reports; no debugger checked it)'
  report.helper = helperActiveLine(live.session.version)
  return 'ok'
}
// The frozen plan, part by part through that helper (runPlan stops at the first part that does not complete).
async function startPlan() {
  if (plan === null || plan.parts.length === 0) return true
  const live = liveSession(nodeFs, STATE, procOf, { claudeStart })
  if (live.state !== 'active' || live.session.session !== report.session) {
    console.log(`part: not tried: ${plan.words} (the colour helper this run started is not the one answering). No skin was put on.`)
    return false
  }
  const prefs = readPrefs(nodeFs, STATE)
  const r = await runPlan(plan, {
    caps: Array.isArray(live.session.caps) ? live.session.caps : [], fonts: offersOf(live), installed: installedNow, prefs,
    waits: { want: TICK.wantMs, restore: TICK.restoreMs / 2 },
    send: async (action, waitMs) => { const { ack } = await sendSwitch(nodeFs, STATE, live.session.session, action, { randomUUID, waitMs }); return ack !== null && ack.action === action ? ack : null },
  })
  for (const l of r.lines) console.log(l)
  if (r.save !== null) savePrefs(null, r.save.headers, fontShipped ? r.save.font : prefs.font)
  return r.ok
}

// Ends the skin child for sure: it was asked to stop; after 3 s (time for a running step to close the port) it is
// killed, then we wait up to 1 s more. Bounded, so cleanup never hangs on it.
async function endSkinChild() {
  const p = skinProc
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  const gone = (ms) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(true); const t = setTimeout(() => r(false), ms); p.once('exit', () => { clearTimeout(t); r(true) }) })
  if (await gone(3_000)) return
  try { p.kill('SIGKILL') } catch {}
  await gone(1_000)
}

// Guardian B, started once: when the skin step reports the port, or when this run sees it open itself.
function startGuardianB() {
  if (guardianB || stopping) return // never a new guardian once cleanup has begun
  guardianB = spawn('/bin/sh', ['-c', guardScript({ first: TICK.guardBFirstS, tries: TICK.guardBTries, early: TICK.guardBEarlyS }), NODE, SKIN, '', String(process.pid)], { detached: true, stdio: 'ignore' })
  guardianB.on('error', () => { guardianB = null })
  guardianB.unref()
}

// The pre-started skin step of tick mode: its output is collected, and `until(lines, ms)` waits for one of those exact
// lines, the child's end ('exit'), or the time ('timeout').
function startTickChild() {
  let out = ''
  let exitCode = null
  const waiters = new Set()
  const p = skinProc = spawn(NODE, [SKIN, ...skinArgs], { stdio: ['pipe', 'pipe', 'pipe'] }) // stdin stays open: the child stops waiting if we go
  const check = () => { for (const w of waiters) w() }
  p.stdout.on('data', (d) => { out += d; check() })
  p.stderr.on('data', (d) => { out += d; check() })
  p.stdin.on('error', () => {})
  p.on('error', (e) => { out += `\ncould not start skin.mjs: ${e.message}`; exitCode ??= -1; check() })
  p.on('close', (c) => { exitCode = c ?? -1; check() })
  const lines = () => out.split('\n').map((l) => l.trim())
  return {
    text: () => out,
    code: () => exitCode,
    until: (want, ms) => new Promise((res) => {
      let t = null
      const w = () => {
        const hit = want.find((l) => lines().includes(l))
        const r = hit ?? (exitCode !== null ? 'exit' : null)
        if (r !== null) { waiters.delete(w); clearTimeout(t); res(r) }
      }
      if (Number.isFinite(ms)) t = setTimeout(() => { waiters.delete(w); res('timeout') }, ms)
      waiters.add(w)
      w()
    }),
  }
}

async function deferredChecks() {
  // The proof that the skin shows on every page now comes from here (the quick apply skipped it inside the window), so
  // no answer means the apply is NOT confirmed, and the run says so.
  const unconfirmed = (why) => {
    report.checks = `sampled colour checks: unknown (${why})`
    warn(`the skin was put on, but I could not confirm it shows on every Claude page (${why}). Look at Claude; if it is not right, run /skin ${appliedPreset} again or press Cmd-R in Claude.`)
    return 'failed'
  }
  if (!report.session || !/^[0-9a-f-]{36}$/.test(report.session)) return unconfirmed('no colour helper to ask')
  let ack = null
  try { ({ ack } = await sendSwitch(nodeFs, STATE, report.session, appliedPreset, { randomUUID, waitMs: TICK.confirmMs })) } catch {}
  if (ack === null) return unconfirmed('the colour helper did not answer')
  if (ack.ok !== true) {
    // An explicit failure is a failed run, not an unknown: the skin may not be fully on.
    const errs = (Array.isArray(ack.errors) ? ack.errors : []).slice(0, 3).map(String).join('; ') || 'no reason given'
    report.checks = `sampled colour checks: failed (the colour helper could not put ${appliedPreset} on again: ${errs})`
    warn(`the skin did not fully apply: ${errs}. Try /skin ${appliedPreset} again, or press Cmd-R in Claude.`)
    return 'failed'
  }
  const mode = ack.dark === true ? 'dark' : ack.dark === false ? 'light' : null
  report.checks = mode === null ? checksLine(null) : checksLine(judgeChecks(ack.samples, expectedColours(appliedCss, mode)), mode)
  report.helper = helperActiveLine(typeof ack.version === 'string' ? ack.version : null)
  return 'ok'
}

let exitCode = EXIT.failed
let refused = false
try { exitCode = await main() } catch (e) {
  if (e instanceof Refused) { console.error(e.message); refused = true; exitCode = EXIT.refused } else console.error('Unexpected error:', e.message)
}
await cleanup('done')
const final = exitOverride ?? exitCode
// Wait for the write to finish: process.exit would cut a large report (a probe) off at 64 KB on a pipe.
// At most 5 s, and a broken pipe is ignored: cleanup is already done, so a stuck reader must not hang the run.
await writeAll(`RESULT: ${final === EXIT.ok ? 'ok' : refused && final === EXIT.refused ? 'refused' : 'failed'}\n`)
process.exit(final)
