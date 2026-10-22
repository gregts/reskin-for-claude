// Small, testable pieces used by skin-auto.mjs. No side effects on import.
// Every check answers one of three things (found / none / unknown), never "none" by default:
// a failed command must not look like "nothing there".
import { connect as netConnect, createServer } from 'node:net'

export const MIN_NODE_MAJOR = 22

// Exit codes of skin-auto.mjs (also in the README).
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  portNotConfirmed: 3, // Claude's port could not be confirmed closed at the end
  timeout: 4,
  refused: 5, // a precondition failed; nothing was changed
  sidecarLeft: 6, // the throwaway Chrome could not be confirmed ended
  signal: 130,
}

// Write the last output and wait until it has really gone out (process.exit would cut a large report off at 64 KB on a
// pipe), but never more than `ms`: a reader that stalls or goes away must not hang a run that is already finished.
export const writeAll = (text, stream = process.stdout, ms = 5_000) => new Promise((r) => {
  const t = setTimeout(r, ms)
  try { stream.write(text, () => { clearTimeout(t); r() }) } catch { clearTimeout(t); r() }
})

export const nodeOk = (version) => Number(String(version).split('.')[0]) >= MIN_NODE_MAJOR

// pgrep: 0 = match, 1 = none, anything else (or a timeout, status null) = unknown.
export function pgrepState(r) {
  if (r.error || r.status === null) return { state: 'unknown', pids: [] }
  if (r.status === 0) {
    const pids = String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
    return pids.length > 0 && pids.every(Number.isInteger) ? { state: 'found', pids } : { state: 'unknown', pids: [] }
  }
  if (r.status === 1 && String(r.stdout).trim() === '') return { state: 'none', pids: [] }
  return { state: 'unknown', pids: [] }
}

// lsof -iTCP:9229 -sTCP:LISTEN: 0 with rows = open, 1 with nothing at all = closed, otherwise unknown.
export function portState(r) {
  if (r.error || r.status === null) return { state: 'unknown', detail: 'lsof did not finish' }
  if (r.status === 0 && String(r.stdout).trim() !== '') return { state: 'open', detail: String(r.stdout).trim() }
  if (r.status === 1 && String(r.stdout).trim() === '' && String(r.stderr).trim() === '') return { state: 'closed', detail: '' }
  return { state: 'unknown', detail: `lsof exit ${r.status}: ${String(r.stderr).trim().slice(0, 200)}` }
}

// `ps -ax -o comm=` output: is the real Claude desktop app running? (pgrep skips its own
// ancestors, so it can miss Claude when we are started from inside it; a full listing cannot.)
export function claudeRunning(r) {
  if (r.error || r.status !== 0) return 'unknown'
  const suffix = '/Claude.app/Contents/MacOS/Claude'
  return String(r.stdout).split('\n').some((l) => l.trim().endsWith(suffix)) ? 'yes' : 'no'
}

// One run at a time on this Mac, whoever started it (mod, Raycast, terminal): the lock is a loopback TCP port
// that the running process keeps bound. The operating system frees it the instant the process ends, even if
// it is killed outright, so there are no stale locks, no reused process ids, no clock or locale logic and no
// takeover races. A busy port means another run holds it (or something unrelated uses that port: then say so).
export const LOCK_PORT = Number(process.env.SKIN_LOCK_PORT) || 47619
export function acquireLock(port = LOCK_PORT) {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy())
    server.once('error', (e) => {
      resolve({
        ok: false,
        reason: e.code === 'EADDRINUSE'
          ? `another skin change is running (or something else is using local port ${port})`
          : `could not take the run lock on local port ${port}: ${e.code ?? e.message}`,
      })
    })
    server.listen(port, '127.0.0.1', () => resolve({ ok: true, release: () => new Promise((r) => server.close(() => r())) }))
  })
}

// Chrome exactly as we started it: Google Chrome's own executable, with this profile folder as an exact argument.
const CHROME_EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export function isOurSidecarCommand(command, dir) {
  if (dir === null || typeof dir !== 'string' || dir === '') return false
  const c = String(command).trim()
  if (!c.startsWith(CHROME_EXE)) return false
  const rest = c.slice(CHROME_EXE.length)
  return rest === '' || rest.startsWith(' ') ? rest.split(' ').includes(`--user-data-dir=${dir}`) : false
}

// A pid must be a plain positive integer before it goes into an AppleScript line.
export const safePid = (p) => (Number.isInteger(p) && p > 1 ? p : null)

export function hideScript(pid) {
  const p = safePid(pid)
  if (p === null) throw new Error(`not a usable pid: ${pid}`)
  return `tell application "System Events" to repeat 100 times
try
set visible of (first process whose unix id is ${p}) to false
end try
delay 0.05
end repeat`
}

// The guardian: a shell snippet run by a detached /bin/sh that outlives skin-auto. After `first` seconds it keeps
// closing Claude's debugger port every `gap` seconds (up to `tries` times) until lsof says, with exit 1 and no
// output at all, that nothing listens. Any other lsof outcome (error, timeout, weird output) is "unknown" and
// is retried, never taken as "closed". $0 is Node, $1 is skin.mjs.
// `yieldPort` (tick mode's late-tick guardian): before each close, if that local port is bound (another run holds the run
// lock), this round's close is skipped (that run may own the port) and the guardian keeps checking until its tries end.
// `early`: one extra look this many seconds after the start, but only when the main
// run ($3) is gone: a live run has its own nets and may still be working, so it is left alone. Then the usual rounds from
// `first` seconds after the start.
export const GUARD_GAP_S = 10 // seconds between a guardian's checks (the public docs quote the time this gives)
export const guardScript = ({ lsof = '/usr/sbin/lsof', pgrep = '/usr/bin/pgrep', ps = '/bin/ps', kill = '/bin/kill', first = 30, gap = GUARD_GAP_S, tries = 6, limit = 8, yieldPort = null, early = 0, finWait = 60 } = {}) =>
  // `lim` runs a command and kills it for sure after `limit` seconds (a separate watchdog, not an alarm the
  // command could cancel); its exit status is the command's, or 137 if it had to be killed ("not sure").
  // Output goes to a temp file, never a pipe, so a leftover child of a hung command cannot keep us waiting.
  `lim() { "$@" & p=$!; ( exec >/dev/null 2>&1; sleep ${limit}; kill -9 $p ) & w=$!; wait $p; rc=$?; kill $w 2>/dev/null; return $rc; }; ` +
  // $2, when given, is the throwaway Chrome's profile folder. If this process is still alive after the wait, the main
  // run died without cleaning up. Only a process whose command is Google Chrome's own executable with exactly that
  // profile folder as an argument is ended (same identity rule as the main cleanup).
  // $3 is the main run's pid: while it is alive, the run is simply slow and is left alone.
  `sc() { case "$2" in /tmp/claude-skin-chrome.*) ;; *) return 0;; esac; case "$3" in ''|*[!0-9]*) ;; *) kill -0 "$3" 2>/dev/null && return 0;; esac; scd=1; ` +
  `lim ${pgrep} -f -- "--user-data-dir=$2" >"$g" 2>/dev/null; ` +
  `for q in $(cat "$g"); do case "$q" in ''|*[!0-9]*) continue;; esac; c=$(${ps} -o command= -p "$q" 2>/dev/null); ` +
  `case "$c" in "${CHROME_EXE} "*" --user-data-dir=$2"|"${CHROME_EXE} "*" --user-data-dir=$2 "*|"${CHROME_EXE} --user-data-dir=$2"|"${CHROME_EXE} --user-data-dir=$2 "*) lim ${kill} -TERM "$q" >/dev/null 2>&1;; esac; done; }; ` +
  // The port being closed is not the end of the job when a throwaway Chrome may be left (its run said "the
  // guardian will try to end it"): wait up to 60 s for the main run to end, then end what is demonstrably ours, then exit.
  // (Only when the earlier pass skipped Chrome because the run was still alive; `finWait` is for tests.)
  `fin() { case "$2" in /tmp/claude-skin-chrome.*) [ "$scd" = 1 ] && exit 0; n=0; case "$3" in ''|*[!0-9]*) ;; *) while [ $n -lt ${Number(finWait) | 0} ] && kill -0 "$3" 2>/dev/null; do sleep 1; n=$((n+1)); done;; esac; sc "$0" "$2" "$3";; esac; exit 0; }; ` +
  `f=$(mktemp /tmp/claude-skin-guard.XXXXXX); g=$(mktemp /tmp/claude-skin-guard.XXXXXX); trap 'rm -f "$f" "$g"' EXIT; trap 'exit 1' TERM INT HUP; ` +
  (Number.isInteger(early) && early > 0 && early < first
    ? `s0=$(date +%s); sleep ${early}; case "$3" in ''|*[!0-9]*) ;; *) if ! kill -0 "$3" 2>/dev/null; then lim ${lsof} -nP -iTCP:9229 -sTCP:LISTEN >"$f" 2>&1; rc=$?; out=$(cat "$f"); ` +
      `if [ $rc -eq 1 ] && [ -z "$out" ]; then exit 0; fi; lim "$0" "$1" close >/dev/null 2>&1; fi;; esac; w=$(( ${first} - ($(date +%s) - s0) )); [ $w -gt 0 ] && sleep $w; `
    : `sleep ${first}; `) +
  `sc "$0" "$2" "$3"; i=0; ` +
  `while [ $i -lt ${tries} ]; do lim ${lsof} -nP -iTCP:9229 -sTCP:LISTEN >"$f" 2>&1; rc=$?; out=$(cat "$f"); ` +
  `if [ $rc -eq 1 ] && [ -z "$out" ]; then fin "$0" "$2" "$3"; fi; ` +
  // Yield only to a Reskin run, never to any program that happens to bind that port (it would otherwise
  // switch this guardian off). Every run writes its pid to `run-pid` in Reskin's private folder ($4) when it takes the lock;
  // the guardian yields only when that file is a regular file of this user and exactly that pid holds the lock port. Another
  // account can neither write that file nor be seen by lsof here. (A program of this same user could still fake both; such a
  // program can already do anything this guardian prevents.)
  (Number.isInteger(yieldPort) && yieldPort > 0 && yieldPort < 65536
    ? `yl() { h="$4/run-pid"; [ -n "$4" ] && [ -f "$h" ] && [ ! -L "$h" ] && [ -O "$h" ] || return 1; rp=$(/usr/bin/head -c 12 "$h"); ` +
      `case "$rp" in ''|*[!0-9]*) return 1;; esac; lim ${lsof} -nP -iTCP:${yieldPort} -sTCP:LISTEN -Fp >"$g" 2>/dev/null || return 1; /usr/bin/grep -qx "p$rp" "$g"; }; yl "$@" || `
    : '') +
  `lim "$0" "$1" close >/dev/null 2>&1; sleep ${gap}; i=$((i+1)); done`

// `ps -o command= -p PID`: the pid's identity as ours / not ours / gone / could not tell.
export function identityOf(psResult, dir) {
  if (psResult.error || psResult.status === null) return 'unknown'
  const out = String(psResult.stdout).trim()
  const err = String(psResult.stderr ?? '').trim()
  if (psResult.status === 1 && out === '' && err === '') return 'gone' // ps found no such pid, and said nothing else
  if (psResult.status !== 0 || err !== '' || out === '') return 'unknown' // any error text or a blank answer: cannot tell
  return isOurSidecarCommand(out, dir) ? 'ours' : 'other'
}

// ---- No-Chrome path ----
// Claude's menu tick runs `open -a "Google Chrome" chrome://inspect` AFTER opening its port. Where no app of that name
// exists, the open fails and Claude shows a dialog instead. So "is there a Google Chrome?" must be asked the way `open -a`
// asks it (by name, anywhere on the Mac), not by looking in /Applications: a wrong "no" would let Claude start the user's
// real Chrome. This read-only lookup launches nothing and prompts for nothing.
export const CHROME_LOOKUP_JXA = 'ObjC.import("AppKit"); var p = $.NSWorkspace.sharedWorkspace.fullPathForApplication("Google Chrome"); p.isNil() ? "none" : p.js'

// osascript result plus "does /Applications/Google Chrome.app exist": 'yes' / 'no' / 'unknown'. Only a clean "none"
// with no Chrome in /Applications counts as "no"; any error, odd output or disagreement is "unknown".
// "yes" only leads to the long-standing Chrome path, so a clean path answer counts even with stray warnings on stderr
// (old scripting additions print some); "no" leads to the new path and needs a fully clean answer.
export function chromeLookup(r, inApplications) {
  if (r.error || r.status !== 0) return 'unknown'
  const out = String(r.stdout).trim()
  if (out.startsWith('/') && out.endsWith('.app') && !out.includes('\n')) return 'yes'
  if (out === 'none' && String(r.stderr ?? '').trim() === '') return inApplications ? 'unknown' : 'no'
  return 'unknown'
}

// Claude's own dialog text (a plain English string in Claude's code, not translated). DIALOG_TEXT is its start, used by
// the read-only reader; DIALOG_MESSAGE is the whole message, the only text the clicker accepts.
export const DIALOG_TEXT = 'Inspector session is active'
export const DIALOG_MESSAGE = 'Inspector session is active. Please open Chrome DevTools (chrome://inspect) in a browser of your choice.'

// Clicks the button of Claude's "Inspector session is active" dialog, and nothing else: only a window of the process
// named Claude whose static text is exactly that message, only when exactly one window matches (two or more is
// "ambiguous": nothing is clicked), re-checked right before the click, and only its "OK" button or, failing that, its
// one and only button. Never the frontmost window, never coordinates, never a key press. Prints clicked / none / ambiguous.
// Keeps running the one-shot dialog script until it reports clicked or ambiguous, or `ms` have passed since `start`.
// `once` returns the script's output ('' on any error); everything time-related can be injected for tests.
export async function watchDialog(once, { start = Date.now(), ms = 8_000, gap = 250, now = Date.now, sleep = (t) => new Promise((r) => setTimeout(r, t)), stop = () => false } = {}) {
  while (!stop() && now() - start < ms) {
    const r = await once()
    if (r === 'clicked' || r === 'ambiguous') return r
    await sleep(gap)
  }
  return 'none'
}

// The no-Chrome path, after the menu tick. Live probe (12 Oct 2026, two runs): Claude's main process is HELD while its
// "Inspector session is active" message is up (no debugger answers, no timers), so the message is closed FIRST and the
// skin step runs only after. watch({ ms, stop }) -> 'clicked' | 'ambiguous' | 'none' (each AppleScript call capped to
// the time left, so it never runs over `ms`); read() -> parsed reader output or null (at most readMs); runSkin() -> exit
// code (run only after a read confirms the message is gone); stopped() -> true once cleanup has begun (then nothing new starts, and no skin step). A message that could not be
// clicked, or a read that cannot rule one out, means no skin step: Claude would be frozen, and the user must click OK.
// A read proving no message is up lets the skin step run, with a watcher kept on during it in case the message comes late.
// syncOsaMs: skin-auto's limit on each blocking AppleScript (the batch's "bring Claude to the front" and the menu click,
// both after the guardian starts). skinKillMs: skin-auto stops the skin step after this long, whatever it is doing.
export const NO_CHROME_TIMES = { watchMs: 8_000, readMs: 3_000, pauseMs: 300, lateGraceMs: 2_000, lateMaxMs: 30_000, syncOsaMs: 4_000, skinKillMs: 25_000 }
// The guardian's first check, in seconds after its start (just before those two AppleScripts): every permitted delay up
// to the latest moment the skin step can end (two blocking AppleScripts, the watch, the pause and confirm read, the whole
// skin step up to its kill), plus 1 s, so it never closes the port under a permitted skin job or its restore.
const T = NO_CHROME_TIMES
// "I tick it" mode: the tick window, the patient connect (skin.mjs PATIENT_MS) plus its job budget
// (18 s), and the guardians derived from them. Guardian B starts when the port is seen; guardian A, armed before the
// prompt, closes a tick that comes after the window and stands down if another run holds the lock.
// ProbeMs is the fast check for the port opening (one TCP connect at a time, 50 ms apart);
// armMs the in-Claude close timer for a tick-mode apply (it cannot fire while Claude is frozen on its message); readyMs how
// long the pre-started skin step may take to get ready before the prompt; guardBEarlyS the guardian's extra early look
// (only when the main run is gone).
export const TICK = { windowMs: 60_000, pollMs: 250, hintsAtMs: [10_000, 30_000], patientMs: 20_000, jobMs: 18_000, closeMs: 5_000, probeMs: 50, armMs: 8_000, readyMs: 15_000, guardBEarlyS: 6, confirmMs: 12_000 }
// confirmMs: how long skin-auto waits for the helper's re-apply answer (the helper's own 8 s cap, its 1 s poll, margin).
// armMs: the slowest permitted quick apply inside the window (stylesheet change capped at 3 s, helper install at 3 s)
// plus 2 s, so the timer never cuts a legitimate apply.
TICK.applyMs = TICK.patientMs + TICK.jobMs + TICK.closeMs // the skin step's own allowance after the port is seen
TICK.guardBFirstS = Math.ceil(TICK.applyMs / 1_000)
// Guardian B keeps trying for several minutes (43 s, then up to 30 tries 10 s apart, each try bounded by `limit`): on a Mac without Chrome, Claude (and so every close) waits until the user
// clicks OK on its message, however late that is.
TICK.guardBTries = 30
TICK.guardAFirstS = Math.ceil((TICK.windowMs + 30_000) / 1_000)
TICK.runLimitMs = 15_000 + TICK.windowMs + TICK.applyMs + TICK.confirmMs + 20_000 // preparation + window + apply + the helper's proof + cleanup

export const NO_CHROME_GUARD_FIRST_S = Math.ceil((2 * T.syncOsaMs + T.watchMs + T.pauseMs + T.readMs + T.skinKillMs + 1_000) / 1_000)
export async function closeMessageThenApply({ watch, read, runSkin, stopped = () => false, now = Date.now, sleep = (t) => new Promise((r) => setTimeout(r, t)), times = NO_CHROME_TIMES }) {
  const halt = (dialog) => ({ dialog, ran: false, why: 'the run was being stopped' })
  const dialog = await watch({ ms: times.watchMs })
  if (stopped()) return halt(dialog)
  if (dialog === 'clicked') {
    await sleep(times.pauseMs)
    if (stopped()) return halt(dialog)
    // Confirm the press registered: a message still up would leave the skin step talking to a frozen Claude.
    const after = await read()
    if (stopped()) return halt(dialog)
    if (!provesNoDialog(after)) return { dialog, ran: false, ...whyNot(after, 'I pressed its OK button but it still seems to be up') }
    return { dialog, ran: true, code: await runSkin() }
  }
  if (dialog === 'ambiguous') return { dialog, ran: false, messageUp: true, why: 'it had more than one button, so I left it alone' }
  const r = await read()
  if (stopped()) return halt(dialog)
  if (provesNoDialog(r)) {
    let doneAt = null
    const late = watch({ ms: times.lateMaxMs, stop: () => doneAt !== null && now() - doneAt >= times.lateGraceMs })
    const code = await runSkin()
    doneAt = now()
    return { dialog, ran: true, code, noMessage: true, lateDialog: await late }
  }
  return { dialog, ran: false, ...whyNot(r, 'I could not click its OK button') }
}
// Why no skin step, and whether a message is actually on screen (only then is the user told to click OK).
function whyNot(r, upText) {
  if (r === null) return { messageUp: false, why: "I could not read Claude's windows (does this terminal app have Accessibility permission?)" }
  if (r.dialogs.length > 0) return { messageUp: true, why: upText }
  if (r.unreadable > 0) return { messageUp: false, why: `${r.unreadable} of Claude's windows could not be read, so I could not rule the message out` }
  return { messageUp: false, why: `Claude has a window of an unexpected kind (${(r.unsureKinds ?? []).join(', ') || 'unknown'}) that I could not fully search, so I could not rule the message out` }
}

export const dialogScript = () => `tell application "System Events"
if not (exists process "Claude") then return "none"
tell process "Claude"
set found to {}
repeat with i from 1 to (count of windows)
set hit to false
try
set vals to value of every static text of window i
repeat with s in vals
if (s as text) is "${DIALOG_MESSAGE}" then set hit to true
end repeat
end try
if hit then set end of found to i
end repeat
if (count of found) is 0 then return "none"
if (count of found) > 1 then return "ambiguous"
set w to window (item 1 of found)
set still to false
try
set vals to value of every static text of w
repeat with s in vals
if (s as text) is "${DIALOG_MESSAGE}" then set still to true
end repeat
end try
if not still then return "none"
if exists button "OK" of w then
click button "OK" of w
return "clicked"
end if
if (count of buttons of w) is 1 then
click button 1 of w
return "clicked"
end if
return "ambiguous"
end tell
end tell
return "none"`

// Window reader for the no-Chrome path (first built for the dialog probe, 12 Oct). Read-only: describes Claude's "Inspector
// session is active" window without clicking anything. Only the matching window's own texts and buttons are read (other
// windows hold chat titles, so they are only counted). A window whose texts cannot be read says so (ERR), so "could not
// read" is never mistaken for "no dialog". Texts are looked for directly in the window and one level down (inside its
// groups), in case the alert nests them. Deeper levels are not searched, so a window without a match that is not an
// ordinary window (subrole AXStandardWindow) is reported as UNSURE: it could be an alert that nests deeper. One line per
// fact: COUNT|n, ERR|i, UNSURE|i|subrole, WIN|i|name|role|subrole, TEXT|value (direct), NTEXT|value (inside a group),
// BUTTON|name.
export const dialogReadScript = () => `tell application "System Events"
if not (exists process "Claude") then return "NOPROC"
set out to ""
tell process "Claude"
set n to (count of windows)
set out to out & "COUNT|" & n & linefeed
repeat with i from 1 to n
set w to window i
set hit to false
set ok to true
set texts to {}
set nested to {}
try
set texts to value of every static text of w
on error
set ok to false
end try
try
repeat with g in (groups of w)
set nested to nested & (value of every static text of g)
end repeat
on error
set ok to false
end try
if not ok then
set out to out & "ERR|" & i & linefeed
else
repeat with s in (texts & nested)
if (s as text) starts with "${DIALOG_TEXT}" then set hit to true
end repeat
if not hit then
set wsub to "unreadable"
try
set wsub to subrole of w as text
end try
if wsub is not "AXStandardWindow" then set out to out & "UNSURE|" & i & "|" & wsub & linefeed
end if
end if
if hit then
set nm to ""
set rl to ""
set sr to ""
try
set nm to name of w as text
end try
try
set rl to role of w as text
end try
try
set sr to subrole of w as text
end try
set out to out & "WIN|" & i & "|" & nm & "|" & rl & "|" & sr & linefeed
repeat with s in texts
set out to out & "TEXT|" & (s as text) & linefeed
end repeat
repeat with s in nested
set out to out & "NTEXT|" & (s as text) & linefeed
end repeat
repeat with b in buttons of w
set bn to ""
try
set bn to name of b as text
end try
set out to out & "BUTTON|" & bn & linefeed
end repeat
end if
end repeat
end tell
end tell
return out`

// The reader's lines as { windows, unreadable, unsure, unsureKinds, dialogs: [{ index, name, role, subrole, texts, nested,
// buttons, exact }] };
// null when the whole read failed. `exact`: one of its DIRECT texts is the full message (what the clicker needs).
export function parseDialogRead(text) {
  const s = String(text ?? '').trim()
  if (s === '' || s === 'NOPROC') return null
  const res = { windows: null, unreadable: 0, unsure: 0, unsureKinds: [], dialogs: [] }
  for (const line of s.split(/\r?\n|\r/)) {
    const [kind, ...rest] = line.split('|')
    const cur = res.dialogs.at(-1)
    if (kind === 'COUNT') res.windows = Number(rest[0])
    else if (kind === 'ERR') res.unreadable++
    else if (kind === 'UNSURE') { res.unsure++; res.unsureKinds.push(rest[1] ?? '') }
    else if (kind === 'WIN') res.dialogs.push({ index: Number(rest[0]), name: rest[1] ?? '', role: rest[2] ?? '', subrole: rest[3] ?? '', texts: [], nested: [], buttons: [], exact: false })
    else if (kind === 'TEXT' && cur) { cur.texts.push(rest.join('|')); if (rest.join('|') === DIALOG_MESSAGE) cur.exact = true }
    else if (kind === 'NTEXT' && cur) cur.nested.push(rest.join('|'))
    else if (kind === 'BUTTON' && cur) cur.buttons.push(rest.join('|'))
  }
  return Number.isInteger(res.windows) ? res : null
}
// A read that proves the message is NOT up: readable, every window readable and fully searched, no match.
export const provesNoDialog = (r) => r !== null && r !== undefined && r.unreadable === 0 && !(r.unsure > 0) && r.dialogs.length === 0

// ---- Two-choice Reskin: sampled colour checks, the colour helper's files, the switch client ----

// Colours as written in a preset (#rgb, #rrggbb) or as Claude reports them (rgb(), rgba()). Anything else is null.
export function parseRgb(s) {
  const t = String(s ?? '').trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(t)
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1)
  m = /^#([0-9a-f]{6})$/.exec(t)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t)
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith('%') ? +m[4].slice(0, -1) / 100 : +m[4]]
  return null
}

// What a preset promises for one mode (`dark` / `light`), for the five sampled places. Only what it declares is checked.
export const CHECKS = ['surface1', 'textPrimary', 'accentFill', 'bodyBg', 'sidebarBg']
export function expectedColours(css, mode) {
  const head = new RegExp(`@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*${mode}\\s*\\)\\s*\\{`, 'i').exec(css)
  if (!head) return {}
  // The block runs to the next top-level colour-scheme block (presets hold at most two).
  const rest = css.slice(head.index + head[0].length)
  const next = rest.search(/@media\s*\(\s*prefers-color-scheme/i)
  const block = next === -1 ? rest : rest.slice(0, next)
  const decl = (re) => re.exec(block)?.[1]?.trim()
  const out = {
    surface1: decl(/--cds-surface-1\s*:\s*([^;!}]+)/),
    textPrimary: decl(/--cds-text-primary\s*:\s*([^;!}]+)/),
    accentFill: decl(/--cds-role-accent-fill\s*:\s*([^;!}]+)/),
    bodyBg: decl(/html,\s*body[^{]*\{\s*background-color\s*:\s*([^;!}]+)/),
    sidebarBg: decl(/\.dframe-sidebar,\s*\.dframe-sidebar-body\s*\{\s*background-color\s*:\s*([^;!}]+)/),
  }
  for (const k of CHECKS) if (out[k] === undefined || parseRgb(out[k]) === null) delete out[k]
  return out
}

// Samples from every Claude page against the expected colours. A missing, unreadable or failed sample is "unknown",
// never a pass. Equal means each channel within 2 of 255 and alpha within 0.02.
// 22 Oct 2026: Claude 3.6556.1 keeps the page body fully see-through after a reload, whatever the skin says, and paints
// the chat area instead (the chat area showed the skin's colour). A fully see-through body is therefore "see-through,
// not checked": neither a pass nor a miss, and left out of the total. The other places still prove the skin.
const seeThrough = (k, c) => k === 'bodyBg' && c !== null && c[3] === 0
export function judgeChecks(samples, expected) {
  const keys = CHECKS.filter((k) => k in expected)
  const res = { passed: 0, failed: 0, unknown: 0, total: 0, misses: [], seeThrough: 0 }
  const pages = Array.isArray(samples) && samples.length > 0 ? samples : [null] // no page at all: every check unknown
  for (const page of pages) {
    for (const k of keys) {
      const got = page && typeof page === 'object' && !page.error ? parseRgb(page[k]) : null
      if (seeThrough(k, got)) { res.seeThrough++; continue }
      res.total++
      if (got === null) { res.unknown++; continue }
      const want = parseRgb(expected[k])
      if (want.every((v, i) => Math.abs(v - got[i]) <= (i === 3 ? 0.02 : 2))) res.passed++
      else { res.failed++; if (res.misses.length < 3) res.misses.push(`${k} is ${page[k]}, expected ${expected[k]}`) }
    }
  }
  return res
}

// The helper line of the run report, naming the Claude version the skin was applied to (scan row 1: a bug report then
// carries it). Only a plain dotted version is printed, so a strange value never reaches the user.
export function helperActiveLine(version) {
  return `helper: active until Claude quits${typeof version === 'string' && /^\d+(\.\d+){1,3}$/.test(version) ? ` (Claude ${version})` : ''}`
}

export function checksLine(j, mode) {
  if (j === null) return 'sampled colour checks: unknown (Claude did not report its colours)'
  // 15 Oct: say plainly how to see it. The mod's hiddenInfo reads "has no <mode> version, so it is not showing now".
  if (j.total === 0) {
    const see = mode === 'dark' ? 'Light' : mode === 'light' ? 'Dark' : null
    return `sampled colour checks: none (this skin has no ${mode ?? 'matching'} version, so it is not showing now${see ? `; to see it, set Claude's Appearance to ${see} in its Settings` : ''})`
  }
  return `sampled colour checks: ${j.passed} of ${j.total} passed (${j.unknown} unknown)${j.failed ? `; ${j.failed} did not match: ${j.misses.join('; ')}` : ''}${j.seeThrough ? '; page background see-through on this Claude, not checked (run /skin check to check the chat area)' : ''}`
}

// ---- Health check (17 Oct 2026): "is my skin still working on this Claude?" ----

// Every place the check reads, its plain name, and whether it must be on screen for a pass (core) or may be absent now.
export const HEALTH_PARTS = {
  surface1: ['main surface colour', true], textPrimary: ['main text colour', true], accentFill: ['accent colour', true],
  bodyBg: ['page background', true], sidebarBg: ['sidebar', true], contentBg: ['chat area', true],
  sidebarBody: ['sidebar body', false], dfHover: ['row hover colour', false], dfSelected: ['selected row colour', false],
  surface2: ['cards', false], bg000: ['raised panels', false], bg200: ['side panels', false], textClass: ['text', false],
  pulseUnread: ['session dot (unread)', false], pulseWaiting: ['session dot (Claude asked)', false],
  pulseError: ['session dot (error)', false], pulseRunning: ['session dot (running)', false],
  pulsePaint: ['session dot (as painted)', false],
}
export const HEALTH_ANCHORS = { root: 'the app frame', sidebar: 'the sidebar', content: 'the chat area' }

// The colour-scheme block of a preset for one mode (the same reading as expectedColours).
function modeBlock(css, mode) {
  const head = new RegExp(`@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*${mode}\\s*\\)\\s*\\{`, 'i').exec(css)
  if (!head) return null
  const rest = css.slice(head.index + head[0].length)
  const next = rest.search(/@media\s*\(\s*prefers-color-scheme/i)
  return next === -1 ? rest : rest.slice(0, next)
}
// What a preset promises for one mode at every health place. Only what it declares (and what parses) is checked.
export function expectedHealth(css, mode) {
  const block = modeBlock(css, mode)
  if (block === null) return {}
  const decl = (re) => re.exec(block)?.[1]?.trim()
  const rule = (sel) => new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(block)?.[1] ?? ''
  const prop = (body, name) => new RegExp(`(?:^|[;\\s{])${name}\\s*:\\s*([^;!}]+)`).exec(body)?.[1]?.trim()
  const rows = rule('\\.dframe-sidebar,\\s*\\.dframe-sidebar \\*')
  const dots = rule('\\.status-dot,\\s*\\[data-cds=Pulse\\]')
  const out = {
    ...expectedColours(css, mode),
    contentBg: decl(/html,\s*body,\s*\.dframe-content\s*\{\s*background-color\s*:\s*([^;!}]+)/),
    sidebarBody: decl(/\.dframe-sidebar,\s*\.dframe-sidebar-body\s*\{\s*background-color\s*:\s*([^;!}]+)/),
    dfHover: prop(rows, '--df-hover'), dfSelected: prop(rows, '--df-selected'),
    surface2: decl(/\.bg-surface-2\s*\{\s*background-color\s*:\s*([^;!}]+)/),
    bg000: decl(/\.bg-surface-3,\s*\.bg-bg-000\s*\{\s*background-color\s*:\s*([^;!}]+)/),
    bg200: decl(/\.bg-bg-200,\s*\.bg-bg-300\s*\{\s*background-color\s*:\s*([^;!}]+)/),
    textClass: decl(/\.text-primary,\s*\.text-text-100\s*\{\s*color\s*:\s*([^;!}]+)/),
    pulseUnread: prop(dots, '--cds-fill-accent'), pulseWaiting: prop(dots, '--cds-fill-warning'),
    pulseError: prop(dots, '--cds-fill-danger'), pulseRunning: prop(dots, '--cds-text-muted'),
  }
  for (const k of Object.keys(out)) if (!(k in HEALTH_PARTS) || out[k] === undefined || parseRgb(out[k]) === null) delete out[k]
  return out
}
const same = (a, b) => a !== null && b !== null && a.every((v, i) => Math.abs(v - b[i]) <= (i === 3 ? 0.02 : 2))
const plainVersion = (v) => typeof v === 'string' && /^\d+(\.\d+){1,3}$/.test(v)

// The verdict from the helper's answer. `cssOf(name)` is the preset text as the helper was given it (null when gone);
// `digestOf(text)` hashes it the way the helper does; `tested` lists Claude versions this skin set was seen working on.
// Answers { verdict: pass|none|fail|structure|unknown, why, misses, unread, absent, mode, version, untested }.
export function judgeHealth(ack, { cssOf, digestOf, tested = [] }) {
  const version = plainVersion(ack?.version) ? ack.version : null
  const base = { why: '', misses: [], unread: [], absent: [], mode: null, version, untested: version !== null && !tested.includes(version) }
  const res = (verdict, more = {}) => ({ ...base, verdict, ...more })
  if (ack?.busy) return res('unknown', { why: 'a batch run owns the colours just now; try again in 30 s' })
  const s = ack?.sample
  if (!ack?.ok || !s || !Array.isArray(s.pages)) return res('unknown', { why: `the helper could not read the pages${ack?.errors?.length ? ` (${String(ack.errors[0]).slice(0, 120)})` : ''}` })
  if (s.stable !== true) return res('unknown', { why: 'Claude was busy changing pages while it looked; run the check again' })
  if (s.pages.length === 0) return res('unknown', { why: 'no Claude window was open to look at' })
  const pages = s.pages
  const unreadable = pages.filter((p) => !p || typeof p !== 'object' || p.error || typeof p.marker !== 'boolean').length
  if (ack.current === 'off') {
    const on = pages.filter((p) => p?.marker === true).length
    if (on > 0) return res('fail', { why: `the skin is off, yet its colours are still on ${on} of ${pages.length} window(s)` })
    if (unreadable > 0) return res('unknown', { why: `could not read ${unreadable} window(s)` })
    return res('none')
  }
  if (ack.current === 'unknown' || typeof ack.current !== 'string') return res('unknown', { why: 'the skin on now is not one of Reskin\'s presets' })
  const css = cssOf(ack.current)
  if (css === null || typeof ack.digest !== 'string' || digestOf(css) !== ack.digest) {
    return res('unknown', { why: `the ${ack.current} preset changed since this helper started; apply it again with one tick (/skin ${ack.current} --tick) to check it` })
  }
  const out = { misses: [], unread: [], absent: new Set(), skipped: new Set(), seeThrough: new Set(), undeclared: new Set(), missingAnchors: new Set(), noMarker: 0, unreadPages: 0, modes: new Set() }
  for (const p of pages) {
    if (!p || typeof p !== 'object' || p.error || typeof p.marker !== 'boolean') { out.unreadPages++; continue }
    if (!p.marker) { out.noMarker++; continue }
    for (const [k, label] of Object.entries(HEALTH_ANCHORS)) if (p.anchors?.[k] !== true) out.missingAnchors.add(label)
    const mode = p.scheme === 'dark' || p.scheme === 'light' ? p.scheme : null
    if (mode === null) { out.unreadPages++; continue }
    out.modes.add(mode)
    const want = expectedHealth(css, mode)
    for (const [k, [label, core]] of Object.entries(HEALTH_PARTS)) {
      // The dot as painted must show one of the skin's four dot colours (a Claude update could keep the colour values yet
      // paint the dot from something else).
      if (k === 'pulsePaint') {
        const dots = ['pulseUnread', 'pulseWaiting', 'pulseError', 'pulseRunning'].filter((d) => d in want)
        if (dots.length === 0) continue
        const got = p.parts?.[k]
        // No answer at all for this place (not even 'not on screen'): a helper from before this check. Unknown, never a pass.
        if (got === undefined) { out.unread.push(`${label} (this colour helper is older than the check; quit and reopen Claude, then apply a skin)`); continue }
        if (got.on !== true) { (got.present === true ? out.skipped : out.absent).add(label); continue }
        const v = parseRgb(got.v)
        if (v === null) { out.unread.push(label); continue }
        if (!dots.some((d) => same(v, parseRgb(want[d])))) out.misses.push(`${label} is ${got.v}, expected one of ${dots.map((d) => want[d]).join(', ')}`)
        continue
      }
      // A core place the skin does not declare for this mode cannot be checked: unknown, never a silent pass.
      if (!(k in want)) { if (core) out.undeclared.add(label); continue }
      const got = p.parts?.[k]
      if (!got || got.on !== true) { out.absent.add(label); continue }
      const v = parseRgb(got.v)
      if (v === null) { out.unread.push(label); continue }
      if (seeThrough(k, v)) { out.seeThrough.add(label); continue }
      if (!same(v, parseRgb(want[k]))) out.misses.push(`${label} is ${got.v}, expected ${want[k]}`)
    }
  }
  const mode = out.modes.size === 1 ? [...out.modes][0] : out.modes.size > 1 ? 'both' : null
  const common = { mode, misses: out.misses.slice(0, 4), unread: [...new Set(out.unread)], absent: [...out.absent], skipped: [...out.skipped], seeThrough: [...out.seeThrough] }
  if (out.missingAnchors.size > 0) return res('structure', { ...common, why: `Reskin could not find ${[...out.missingAnchors].join(', ')}` })
  if (out.noMarker > 0) return res('fail', { ...common, why: `the skin is missing from ${out.noMarker} of ${pages.length} window(s)` })
  if (out.misses.length > 0) return res('fail', { ...common, why: `${out.misses.length} place(s) do not show the skin's colour` })
  // A core place that is not on screen, or anything unreadable, or an unreadable window: not a pass.
  const coreAbsent = Object.entries(HEALTH_PARTS).filter(([, [l, core]]) => core && out.absent.has(l)).map(([, [l]]) => l)
  if (out.unreadPages > 0 || common.unread.length > 0 || coreAbsent.length > 0 || out.undeclared.size > 0) {
    return res('unknown', { ...common, why: [out.undeclared.size ? `the skin does not declare ${[...out.undeclared].join(', ')} for ${[...out.modes].join(' and ')} mode${out.undeclared.size === Object.values(HEALTH_PARTS).filter(([, c]) => c).length ? ' (it may have no half for this mode)' : ''}` : '', out.unreadPages ? `could not read ${out.unreadPages} window(s)` : '', common.unread.length ? `could not read: ${common.unread.join(', ')}` : '', coreAbsent.length ? `not on screen: ${coreAbsent.join(', ')}` : ''].filter(Boolean).join('; ') })
  }
  return res('pass', common)
}

export const HEALTH_REPAIR = 'Repair: /skin off puts Claude\'s own colours back (or quit and reopen Claude). To report it, run /skin log and send the newest entry; it names your Claude version.'
// The plain report lines for a judged check, and the exit code (0 pass, none, unknown; 1 fail, structure).
export function healthReport(j, ack, testedList = []) {
  const name = ack?.current
  const head = j.verdict === 'pass' ? `health: pass (skin ${name} shows its own colours in every place checked)`
    : j.verdict === 'none' ? 'health: no skin on (Claude shows its own colours)'
    : j.verdict === 'fail' ? `health: FAIL (${j.why})`
    : j.verdict === 'structure' ? `health: Claude's structure changed (${j.why}); the skin may only partly show`
    : `health: unknown (${j.why})`
  const lines = [head, ...j.misses.map((m) => `  ${m}`)]
  if (j.verdict === 'pass' || j.verdict === 'fail' || j.verdict === 'structure') {
    if (j.absent.length) lines.push(`not on screen now (not checked): ${j.absent.join(', ')}`)
    if (j.skipped?.length) lines.push(`not checked (dots present, but none could be read safely): ${j.skipped.join(', ')}`)
    if (j.seeThrough?.length) lines.push(`not checked (see-through on this Claude; the chat area is checked instead): ${j.seeThrough.join(', ')}`)
    if (j.mode === 'dark' || j.mode === 'light') lines.push(`checked: ${j.mode} mode only (the ${j.mode === 'dark' ? 'light' : 'dark'} half is checked when Claude shows ${j.mode === 'dark' ? 'light' : 'dark'})`)
  }
  if (j.untested) lines.push(`untested: Claude ${j.version} is not one of the versions this skin set was tested on (${testedList.join(', ') || 'none recorded'}); if something looks wrong, that is the likely reason`)
  if (j.verdict === 'fail' || j.verdict === 'structure') lines.push(HEALTH_REPAIR)
  return { lines, code: j.verdict === 'fail' || j.verdict === 'structure' ? 1 : 0 }
}

// The helper's folder and files. Every read is all-or-nothing through the same gates as the helper's own reads: a regular
// file (not a link) owned by this user, private (600), at most `max` bytes, one whole JSON object.
export const stateDirOf = (home, env = process.env) => env.RESKIN_STATE_DIR || `${home}/Library/Application Support/claude-skin`
export function readPrivateJson(fs, file, { uid = process.getuid(), max = 65_536 } = {}) {
  let s
  try { s = fs.lstatSync(file) } catch (e) { return { missing: e.code === 'ENOENT', error: e.code === 'ENOENT' ? 'missing' : `unreadable (${e.code ?? e.message})` } }
  if (!s.isFile()) return { error: 'not a regular file' }
  if (s.uid !== uid) return { error: 'not owned by you' }
  if ((s.mode & 0o777) !== 0o600) return { error: 'not private (mode 600)' }
  if (s.size > max) return { error: 'too large' }
  let fd
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch (e) { return { error: `could not open (${e.code ?? e.message})` } }
  try {
    const f = fs.fstatSync(fd)
    if (f.ino !== s.ino || f.dev !== s.dev || !f.isFile() || f.size > max) return { error: 'changed while being read' }
    const buf = Buffer.alloc(max + 1)
    const n = fs.readSync(fd, buf, 0, max + 1, 0)
    if (n !== f.size) return { error: 'changed size while being read' }
    const v = JSON.parse(buf.subarray(0, n).toString('utf8'))
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: 'not a JSON object' }
    return { value: v }
  } catch (e) { return { error: `not readable JSON (${e.message})` } } finally { try { fs.closeSync(fd) } catch {} }
}

// Whole private files only: a fresh temp file (600, no links followed), then renamed into place.
export function writePrivateJson(fs, dir, name, value, randomUUID) {
  const tmp = `${dir}/.${name}.${randomUUID()}`
  const C = fs.constants
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, JSON.stringify(value)) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, `${dir}/${name}`) } catch (e) { try { fs.unlinkSync(tmp) } catch {} throw e }
}

// The same for a plain text file (the run mark that guardian A reads with the shell).
export function writePrivateText(fs, dir, name, text, randomUUID) {
  const tmp = `${dir}/.${name}.${randomUUID()}`
  const C = fs.constants
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, String(text)) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, `${dir}/${name}`) } catch (e) { try { fs.unlinkSync(tmp) } catch {} throw e }
}

// The folder itself must be a private real folder of this user, as the helper requires.
export function privateDir(fs, dir, uid = process.getuid()) {
  try {
    const s = fs.lstatSync(dir)
    if (!s.isDirectory() || s.isSymbolicLink()) return { error: 'not a real folder' }
    if (s.uid !== uid) return { error: 'not owned by you' }
    if ((s.mode & 0o777) !== 0o700) return { error: 'not private (mode 700)' }
    return { ok: true }
  } catch (e) { return { missing: e.code === 'ENOENT', error: e.code === 'ENOENT' ? 'missing' : `unreadable (${e.code ?? e.message})` } }
}

// Is there a live helper? Only when session.json names the very Claude process running now: same pid, still Claude's
// own binary, and started when the helper says (pid reuse after a restart is caught by the start time). `proc(pid)` answers
// { comm, startMs } or null (gone) or throws (cannot tell).
export const CLAUDE_BINARY = '/Applications/Claude.app/Contents/MacOS/Claude'
// The helper's generation. Raise it whenever the code the helper runs inside Claude changes in a way the client relies on
// (names, markers, actions). A helper of another generation is still running OLD code inside Claude: switching through
// it, checking through it or ticking a new one beside it could leave two skins on, so every path refuses until Claude
// is quit and reopened (which ends the old helper and its colours).
export const HELPER_GEN = 2
export const OUTDATED_WHY = 'Reskin was updated after the colour helper inside Claude started. Quit and reopen Claude once (that ends the old helper and its colours), then run /skin again.'
export function liveSession(fs, dir, proc, { uid = process.getuid(), claudeStart } = {}) {
  // A folder or session file that cannot be trusted is not proof of a running helper: a helper lives only inside the
  // Claude that was running when it wrote session.json. With `claudeStart` (the running Claude's start time in ms, null
  // when no Claude runs, throws when unsure), a session file older than this Claude, or none at all, is a leftover, so
  // quitting and reopening Claude is always a way out. Its contents are never read for this.
  const leftover = (why) => {
    if (typeof claudeStart !== 'function') return { state: 'unknown', why }
    let start
    try { start = claudeStart() } catch (e) { return { state: 'unknown', why: `${why}; could not check Claude (${e.message})` } }
    if (start === null) return { state: 'none', why: `${why}; Claude is not running, so no helper is` }
    // The session file's time, or, when it cannot be looked at (a folder that cannot be opened), the folder's own time:
    // a helper writing session.json since this Claude started would have changed both.
    let t
    try { t = fs.lstatSync(`${dir}/session.json`).mtimeMs } catch (e) {
      if (e.code === 'ENOENT') return { state: 'none', why: `${why}; no helper session (the next skin repairs the folder)` }
      try { t = fs.lstatSync(dir).mtimeMs } catch { return { state: 'unknown', why } }
    }
    // Accepted risk: a program running as this user that backdates these times, or a clock set
    // back by more than 2 s, could make a live old helper look like a leftover; the harm is a second skin on top.
    if (Number.isFinite(start) && t < start - 2_000) return { state: 'none', why: `${why}; it is older than this Claude, so it is a leftover` }
    return { state: 'unknown', why }
  }
  const d = privateDir(fs, dir, uid)
  if (!d.ok) return d.missing ? { state: 'none', why: `helper folder ${d.error}` } : leftover(`helper folder ${d.error}`)
  const r = readPrivateJson(fs, `${dir}/session.json`, { uid, max: 4096 })
  if (r.missing) return { state: 'none', why: 'no helper session' }
  if (r.error) return leftover(`session.json ${r.error}`)
  const v = r.value
  if (v.v !== 1 || typeof v.session !== 'string' || !/^[0-9a-f-]{36}$/.test(v.session) || !Number.isInteger(v.pid) || v.pid < 2 || !Number.isFinite(v.boot)) return { state: 'unknown', why: 'session.json is not in the expected form' }
  let p
  try { p = proc(v.pid) } catch (e) { return { state: 'unknown', why: `could not check Claude's process (${e.message})` } }
  if (p === null) return { state: 'none', why: 'the Claude that had the helper has quit', stale: v }
  if (p.comm !== CLAUDE_BINARY) return { state: 'none', why: 'that process is no longer Claude', stale: v }
  if (!Number.isFinite(p.startMs) || Math.abs(p.startMs - v.boot) > 5_000) return { state: 'none', why: 'Claude was restarted since the helper started', stale: v }
  if (v.gen !== HELPER_GEN) return { state: 'outdated', why: OUTDATED_WHY, session: v }
  return { state: 'active', session: v }
}

// `ps -o lstart=,comm= -p PID`, run with TZ=UTC -> { comm, startMs }, null when the pid is gone, throws when unsure.
// UTC (23 Oct 2026): a local time is ambiguous in the hour repeated when daylight saving ends.
export function parsePs(r) {
  if (r.error || r.status === null) throw new Error('ps did not finish')
  const out = String(r.stdout).trim()
  if (r.status === 1 && out === '') return null
  if (r.status !== 0 || out === '') throw new Error(`ps exit ${r.status}`)
  const m = /^(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(out)
  if (!m) throw new Error('ps output not understood')
  const startMs = Date.parse(`${m[1]} GMT`)
  if (!Number.isFinite(startMs)) throw new Error('ps start time not understood')
  return { comm: m[2].trim(), startMs }
}

// The next request number: above both the last ack and any request still lying there, of this session only, so a lost
// ack never makes us reuse a number the helper has already taken (it would silently ignore it).
export function nextNonce(fs, dir, session, uid = process.getuid()) {
  let n = 0
  for (const f of ['ack.json', 'request.json']) {
    const r = readPrivateJson(fs, `${dir}/${f}`, { uid })
    if (r.value?.session === session && Number.isSafeInteger(r.value.nonce)) n = Math.max(n, r.value.nonce)
  }
  return n + 1
}

// Sends one switch request and waits for the helper's answer for this session and number. Never falls back to a tick:
// no answer is "unconfirmed", and the user decides what to do next.
export async function sendSwitch(fs, dir, session, action, { uid = process.getuid(), randomUUID, waitMs = 2_000, gap = 50, now = Date.now, sleep = (t) => new Promise((r) => setTimeout(r, t)) } = {}) {
  const nonce = nextNonce(fs, dir, session, uid)
  writePrivateJson(fs, dir, 'request.json', { v: 1, session, nonce, action }, randomUUID)
  const start = now()
  let ack = null
  while (now() - start <= waitMs) {
    const r = readPrivateJson(fs, `${dir}/ack.json`, { uid })
    if (r.value?.session === session && r.value.nonce === nonce) { ack = r.value; break }
    await sleep(gap)
  }
  // Only our own request is tidied away, and only once it was answered.
  if (ack !== null) {
    const r = readPrivateJson(fs, `${dir}/request.json`, { uid })
    if (r.value?.session === session && r.value.nonce === nonce) { try { fs.unlinkSync(`${dir}/request.json`) } catch {} }
  }
  return { nonce, ack }
}

// P5: remember the preference, never the permission. Only a preset name (or nothing) is kept.
export function readPrefs(fs, dir, uid = process.getuid()) {
  const r = readPrivateJson(fs, `${dir}/prefs.json`, { uid, max: 1024 })
  const last = r.value?.last
  return typeof last === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(last) ? { last } : { last: null }
}

// Tick mode's wait: polls the port until it opens, the window ends, or the run is stopping. A tick exactly at the end of
// the window still counts only if the port is seen before `windowMs` has passed. Answers { result: open|timeout|stopped }.
export async function waitForTick({ portNow, now = Date.now, sleep, stopped = () => false, onHint = () => {}, windowMs = TICK.windowMs, pollMs = TICK.pollMs, hintsAtMs = TICK.hintsAtMs }) {
  const t0 = now()
  const hints = [...hintsAtMs]
  while (!stopped() && now() - t0 < windowMs) {
    const st = await portNow()
    if (stopped()) break // cancelled while the check ran: an open port found now does not count
    // The answer counts only if it came inside the window: a slow check that ends after the window is a late tick.
    if (st.state === 'open') return now() - t0 < windowMs ? { result: 'open', at: now() - t0, port: st } : { result: 'timeout', late: true }
    if (hints.length > 0 && now() - t0 >= hints[0]) { hints.shift(); onHint() }
    await sleep(pollMs)
  }
  return { result: stopped() ? 'stopped' : 'timeout' }
}

// Is anything accepting connections on the debugger port? One plain TCP connect, nothing is sent, the
// socket is destroyed on every outcome (connected, refused, error, timeout). 'open' / 'closed' (refused) / 'unknown'.
// An open port says nothing about WHO listens: the owner is checked separately before any code is sent.
export function tcpProbe({ port = 9229, host = '127.0.0.1', ms = 200, connect = netConnect } = {}) {
  return new Promise((resolve) => {
    let done = false
    let sock = null
    const end = (state) => {
      if (done) return
      done = true
      clearTimeout(t)
      try { sock?.destroy() } catch {}
      resolve({ state })
    }
    const t = setTimeout(() => end('unknown'), ms)
    try {
      sock = connect({ port, host })
      sock.once('connect', () => end('open'))
      sock.once('error', (e) => end(e?.code === 'ECONNREFUSED' ? 'closed' : 'unknown'))
    } catch { end('unknown') }
  })
}

// `lsof -nP -iTCP:9229 -sTCP:LISTEN -Fpn` output: 'none', one { pid, names }, or throws when unsure (same rules as before:
// exit 1 with no output at all is the only "none"; more than one owner is refused).
export function parseListener(r, port = 9229) {
  if (r.failed) throw new Error('Could not run lsof, so the port state is unknown.')
  if (r.status === 1 && String(r.out).trim() === '' && String(r.err).trim() === '') return 'none'
  if (r.status !== 0) throw new Error(`lsof failed (${r.status}): ${String(r.err).trim()}`)
  const owners = new Map()
  let pid = null
  for (const row of String(r.out).split('\n')) {
    if (row.startsWith('p')) {
      pid = Number(row.slice(1))
      owners.set(pid, [])
    } else if (row.startsWith('n') && pid !== null) owners.get(pid).push(row.slice(1))
  }
  if (owners.size !== 1) throw new Error(`Port ${port} has ${owners.size} owners; expected one.`)
  const [[only, names]] = owners
  return { pid: only, names }
}

// Who holds the other end of OUR debugger connections, as the kernel reports it (not as the debugger
// says). `mine` and `theirs` are `lsof -nP -a -p <pid> -iTCP:9229 -sTCP:ESTABLISHED -Fn` for this process and for the
// checked Claude. Every connection this process has to the port must end inside Claude, and there must be at least one:
// a program that took the port between the owner check and the connect holds the other end itself, so it is refused
// before anything is sent. Answers { ok: true } or { ok: false, why }; a failed or unclear lsof is never ok.
export function socketOwner(mine, theirs, port = 9229) {
  const rows = (r) => {
    if (r.failed) return null
    if (r.status === 1 && String(r.out).trim() === '') return []
    if (r.status !== 0) return null
    return String(r.out).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
  }
  const a = rows(mine)
  const b = rows(theirs)
  if (a === null || b === null) return { ok: false, why: 'Could not check who holds the debugger connection.' }
  const ours = a.map((n) => new RegExp(`^127\\.0\\.0\\.1:(\\d+)->127\\.0\\.0\\.1:${port}$`).exec(n)?.[1]).filter(Boolean)
  const claude = new Set(b.map((n) => new RegExp(`^127\\.0\\.0\\.1:${port}->127\\.0\\.0\\.1:(\\d+)$`).exec(n)?.[1]).filter(Boolean))
  if (ours.length === 0) return { ok: false, why: 'No debugger connection of mine was found.' }
  const stray = ours.filter((p) => !claude.has(p))
  if (stray.length > 0) return { ok: false, why: `The other end of my debugger connection is not held by Claude (local port ${stray.join(', ')}).` }
  return { ok: true }
}

// `ps -ax -o pid=,comm=` output: the one running Claude main process (its own binary), or throws when there is not
// exactly one (none running, or more than one: then it is unclear which Claude would open the port).
export function claudePidOf(r, binary = CLAUDE_BINARY) {
  if (r.failed || r.status !== 0) throw new Error('Could not list running programs, so I could not find Claude.')
  const pids = String(r.out).split('\n').map((l) => /^\s*(\d+)\s+(.+?)\s*$/.exec(l)).filter((m) => m && m[2] === binary).map((m) => Number(m[1]))
  if (pids.length !== 1) throw new Error(pids.length === 0 ? 'The Claude desktop app is not running.' : `${pids.length} Claude processes are running; expected one.`)
  return pids[0]
}

// The debugger line names the measured time, from the moment Reskin saw the port open to the moment it
// confirmed it closed. The time before Reskin saw it (at most one probe gap) is not in it, and the words say so.
export function debuggerClosedLine(doorMs, neverOpened = false) {
  if (neverOpened) return 'debugger: confirmed closed (it never opened)'
  return Number.isFinite(doorMs) && doorMs >= 0
    ? `debugger: confirmed closed (seen open -> confirmed closed: ${(doorMs / 1000).toFixed(1)} s)`
    : 'debugger: confirmed closed'
}

// Dot census test sheets (dotcheck-*): the run that holds the lock owns them and deletes them when it ends, but only the
// very file it saw (same inode, size and time): a sheet written again meanwhile, for a later run, is left alone.
export function ownTestSheets(files, fs) {
  const seen = []
  for (const f of files) { try { const s = fs.lstatSync(f); if (s.isFile()) seen.push({ f, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }) } catch {} }
  return () => {
    for (const { f, ino, size, mtimeMs } of seen) {
      try { const s = fs.lstatSync(f); if (s.isFile() && s.ino === ino && s.size === size && s.mtimeMs === mtimeMs) fs.unlinkSync(f) } catch {}
    }
  }
}
