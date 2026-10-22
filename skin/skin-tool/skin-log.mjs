// The troubleshooting log for runs of skin-auto.mjs started directly (by an agent, a terminal or Raycast). /skin runs are
// logged by the /skin mod instead (it sets RESKIN_LOG_BY=skin-mod), in the same file and the same format, so one file
// tells the whole story: ~/Library/Logs/Reskin/skin.log, plus skin.log.1, the one older file kept.
// The format and rules are shared with the mod's hooks/log.ts (an entry starts with HEAD, has a "summary:" line, ends with
// END; every raw line is indented so it can never look like either; the same redaction, capture and summary rules; the
// same writer script). Change both together: the tests run the same cases on both.
//
// Run as `node skin-log.mjs --finish <record.json>`, this file is also the small background process that writes a direct
// run's entry after the run has ended, so logging never adds work to a run's exit.
import { spawn, spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOG_DIR_REL = 'Library/Logs/Reskin'
export const LOG_FILE = 'skin.log'
export const LOG_MAX_BYTES = 512 * 1024
// Per step, only the start of the output is kept (64 KB, far more than a normal run prints), and of a very long line its
// start. Keeping only starts means a cut can never separate a secret's name from its value; the whole kept text is then
// cleaned in one pass.
export const RAW_MAX_CHARS = 64 * 1024
export const LINE_MAX_CHARS = 16 * 1024
export const MAX_LINES = 2_000 // per stream: many short lines cost more in the entry (time and indent) than their text
export const COMMAND_MAX_CHARS = 500
export const ENTRY_MAX_BYTES = 256 * 1024 // a last guard: a larger entry is not written
export const HEAD = '==================== '
export const END = '==================== end'

const HERE = fileURLToPath(import.meta.url)
export const logDirOf = (home, env = process.env) => env.RESKIN_LOG_DIR || path.join(home, LOG_DIR_REL)
// Off when the /skin mod logs the run itself, when asked (RESKIN_LOG=off), and inside the test runner unless a test
// points the log at its own folder (so tests never write to the real log).
export function loggingOn(env = process.env) {
  if (env.RESKIN_LOG_BY === 'skin-mod' || env.RESKIN_LOG === 'off') return false
  if (env.NODE_TEST_CONTEXT && !env.RESKIN_LOG_DIR) return false
  return true
}

const MODE_WORDS = { auto: 'light and dark', dark: 'dark only', light: 'light only', unknown: 'mode not recognised' }
// CSS comments removed in one linear pass (an unclosed "/*" ends the text).
export function stripComments(css) {
  let out = ''
  let i = 0
  for (;;) {
    const s = css.indexOf('/*', i)
    if (s === -1) return out + css.slice(i)
    out += `${css.slice(i, s)} `
    const e = css.indexOf('*/', s + 2)
    if (e === -1) return out
    i = e + 2
  }
}
// Same rule as the mod's modeOf: one dark and one light block is a pair.
export function presetMode(css) {
  const found = [...stripComments(css).matchAll(/prefers-color-scheme\s*:\s*(dark|light)/gi)].map((m) => m[1].toLowerCase())
  if (found.length === 2 && found[0] !== found[1]) return 'auto'
  if (found.length === 1) return found[0]
  return 'unknown'
}

// Claude's config.json also holds sign-in tokens: only the one Appearance word is taken out.
export function appearanceOf(configText) {
  if (typeof configText !== 'string') return 'unknown'
  const m = /"userThemeMode"\s*:\s*"(system|light|dark)"/.exec(configText)
  return m === null ? 'unknown' : m[1]
}
export function macModeOf(r) {
  if (!r) return 'unknown'
  if (r.status === 0 && String(r.stdout).trim() === 'Dark') return 'dark'
  if (r.status === 1 && /does not exist|Could not find key/.test(String(r.stderr))) return 'light' // older and newer macOS wording
  return 'unknown'
}

// Known secret formats never go in the log (same rules as the mod's redact; the tests run the same cases on both). Every
// rule is linear: ids, debugger links, URL queries and user:password@ parts, whole Cookie and Authorization values,
// bearer values, --password style flags, long keys, and the value of anything named like a password, token, key,
// cookie or credential, also when it sits inside another value (error: password="x"). A quoted value runs to its
// closing quote, over line breaks; with no closing quote it is redacted to the end. This is a filter for known formats,
// not a guarantee.
export const SECRET_NAME = /^(?:[A-Za-z0-9_.-]*(?:token|passw|secret|auth|cookie|credential|api[_-]?key|apikey|session[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*|key|pass|pwd|sid)$/i
const VALUE = String.raw`"[^"\\]*(?:\\[\s\S][^"\\]*)*"?|'[^'\\]*(?:\\[\s\S][^'\\]*)*'?`
// A name and its separator; only a secret name takes the value after it. Any other name is passed over and the scan
// goes on from its value, so a secret inside it is still found. One scan, each name read once.
const PAIR_NAME = /(["']?)([A-Za-z0-9_.-]{1,80})\1(\s*[:=]\s*)/g
const PAIR_VALUE = new RegExp(String.raw`(?:${VALUE}|[^\s&,;"'}]+)`, 'y')
// The space before a flag is looked at, not taken, so a flag that is not secret never hides the next one.
const FLAG_NAME = /(?<=^|\s)(--?)([A-Za-z0-9_.-]{1,80})(=|[ \t]+)/g
const FLAG_VALUE = new RegExp(String.raw`(?:${VALUE}|\S+)`, 'y')
// "Bearer x", "Basic x", "token x": the value may be quoted and run over lines; "token = x" is a named value instead.
// The whole run of spaces is taken (it cannot give back a space to dodge the check) before looking for ":" or "=".
const WORD_NAME = /\b(bearer|basic|token)(?=(\s+))\2(?![:=])/gi
function scan(text, nameRe, valueRe, nameOf, isSecret = (n) => SECRET_NAME.test(n)) {
  let out = ''
  let from = 0
  nameRe.lastIndex = 0
  let m
  while ((m = nameRe.exec(text)) !== null) {
    if (!isSecret(nameOf(m))) continue
    valueRe.lastIndex = nameRe.lastIndex
    if (valueRe.exec(text) === null || valueRe.lastIndex === nameRe.lastIndex) continue // no value: left as it is
    const end = valueRe.lastIndex
    // The line breaks inside a removed value stay, so each kept line keeps its own time.
    out += `${text.slice(from, nameRe.lastIndex)}<redacted>${'\n'.repeat((text.slice(nameRe.lastIndex, end).match(/\n/g) ?? []).length)}`
    from = end
    nameRe.lastIndex = end
  }
  return out + text.slice(from)
}
export function redact(text, home) {
  let t = String(text)
  if (home && home.length > 1) t = t.split(home).join('~')
  // Named and quoted values first, whole (a quoted value can hold a web address, an escaped quote or a line break), then
  // what is left: web addresses, ids, whole header lines, keys.
  t = scan(t, FLAG_NAME, FLAG_VALUE, (m) => m[2])
  t = scan(t, WORD_NAME, FLAG_VALUE, (m) => m[1], () => true)
  t = scan(t, PAIR_NAME, PAIR_VALUE, (m) => m[2])
  return t
    .replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s\/@:]{1,256}:[^\s\/@]{1,1024}@/gi, '$1<redacted>@')
    .replace(/\b(?:wss?|https?):\/\/[^\s"'?#]{0,2048}[?#][^\s"']*/gi, (m) => m.replace(/[?#].*$/, '?<redacted>'))
    .replace(/\bwss?:\/\/[^\s"']+/gi, 'ws://<redacted>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*:[ \t]*)[^\n]*/gi, '$1$2<redacted>')
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '<redacted>')
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
}
// An argument list: the value after a secret flag (--password, then its value as the next argument) is redacted too.
export function redactArgs(args, home) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const m = /^--?([A-Za-z0-9_.-]{1,80})(=?)/.exec(a)
    if (m && SECRET_NAME.test(m[1]) && m[2] === '=') { out.push(`${a.slice(0, m[0].length)}<redacted>`); continue } // --password=two words
    out.push(redact(a, home))
    if (m && SECRET_NAME.test(m[1]) && m[0].length === a.length && i + 1 < args.length) { out.push('<redacted>'); i++ }
  }
  return out
}

// One physical line: a field with a line break can never start a fake entry.
export const oneLine = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)} [... cut]` : s)

// Output with the time each line arrived ([+1.234s] since the step began; "err|" marks stderr). Each stream is kept on its
// own, as plain text, and only from its start: up to half of `max` characters each, and once anything of a stream is cut
// (a line over LINE_MAX_CHARS, or the budget reached) nothing more of that stream is kept, only counted. At the end each
// stream is cleaned whole (so a secret over several lines is seen whole, and no line from the other stream or no time
// stamp can split it), then the lines are put back in time order with their times. `onLine` sees every whole raw line,
// so the RESULT and PORT_STATE lines are never lost.
export function capture(max = RAW_MAX_CHARS, onLine = () => {}) {
  const streams = { stdout: { lines: [], times: [], chars: 0, stopped: false, dropped: 0 }, stderr: { lines: [], times: [], chars: 0, stopped: false, dropped: 0 } }
  const pend = { stdout: null, stderr: null }
  const emit = (cur, stream) => {
    try { onLine(stream, cur.text) } catch {}
    const st = streams[stream]
    if (st.stopped) { st.dropped += cur.text.length + cur.extra + 1; return }
    if (st.chars + cur.text.length + 1 > max / 2 || st.lines.length >= MAX_LINES) { st.stopped = true; st.dropped += cur.text.length + cur.extra + 1; return }
    st.lines.push(cur.text)
    st.times.push(cur.at)
    st.chars += cur.text.length + 1
    if (cur.extra > 0) { st.stopped = true; st.dropped += cur.extra }
  }
  return {
    add(ms, stream, text) {
      const parts = String(text).split('\n')
      for (let i = 0; i < parts.length; i++) {
        const cur = pend[stream] ?? { at: ms, text: '', extra: 0 }
        const room = Math.max(0, LINE_MAX_CHARS - cur.text.length)
        cur.text += parts[i].slice(0, room)
        cur.extra += Math.max(0, parts[i].length - room)
        if (i < parts.length - 1) { emit(cur, stream); pend[stream] = null } else pend[stream] = cur.text === '' && cur.extra === 0 ? null : cur
      }
    },
    finish(clean = (t) => redact(t)) {
      for (const s of ['stdout', 'stderr']) { if (pend[s]) emit(pend[s], s); pend[s] = null }
      const rows = []
      for (const s of ['stdout', 'stderr']) {
        const st = streams[s]
        const cleaned = st.lines.length ? clean(st.lines.join('\n')).split('\n') : []
        // Cleaning keeps the line count; if it ever did not, the times are dropped rather than put on the wrong line.
        const timed = cleaned.length === st.times.length
        cleaned.forEach((line, i) => rows.push({ at: timed ? st.times[i] : st.times[0] ?? 0, s, line, i }))
        if (st.dropped > 0) rows.push({ at: Infinity, s, line: `[... ${st.dropped} more characters of ${s} not kept: only the start of a long output is kept]`, i: Infinity })
      }
      rows.sort((a, b) => a.at - b.at || (a.s === b.s ? a.i - b.i : a.s === 'stdout' ? -1 : 1))
      return rows.map((r) => (r.at === Infinity ? r.line : `[+${(r.at / 1000).toFixed(3)}s]${r.s === 'stderr' ? ' err|' : ''} ${r.line}`)).join('\n')
    },
  }
}

export function hiddenInfo(text) {
  const a = /has no (dark|light) version, so it is not showing now/.exec(text)
  if (a) return { claude: a[1], needs: a[1] === 'dark' ? 'light' : 'dark' }
  const b = /Claude is showing (dark|light) right now and this skin has only a (dark|light) version/.exec(text)
  if (b) return { claude: b[1], needs: b[2] }
  return null
}
// The Claude version that was really running, when the tool reported it (the helper line or status).
export function runningVersionOf(text) {
  return /\(Claude (\d+(?:\.\d+){1,3})\)/.exec(text)?.[1] ?? /\bversion (\d+(?:\.\d+){1,3})\)/.exec(text)?.[1] ?? null
}

function bare(l) { return l.replace(/^\[\+[\d.]+s\]( err\|)? /, '').replace(/^\[\d+(?:\.\d+)?s\] /, '').trim() }

// How far a step got, read from its own output. "Opened" needs positive evidence; otherwise it says what is not known.
export function stepPath(s) {
  const o = `${s.output}\n${s.marks ?? ''}`
  if (s.via.startsWith('debugger')) {
    if (/debugger port seen|DOOR_MS|Port 9229 closed and confirmed|seen open/.test(o)) return `${s.via} (the debugger opened)`
    if (/READY_TO_TICK/.test(o)) return `${s.via} (asked for the click; ${/Time is up/.test(o) ? 'no click came in time' : 'the debugger opening was not confirmed'})`
    if (/DISCLOSED/.test(o)) return `${s.via} (started; the debugger opening was not confirmed)`
    return `${s.via} (stopped before the debugger was asked for)`
  }
  if (s.via === 'colour helper' && /No colour helper is running|helper: none \(already clean\)/.test(o)) return `${s.via} (none running)`
  return s.via
}
const helperLine = (s) => { const l = meaningful(s.output).find((x) => /^helper: /.test(x)); return l ? short(l, 120) : '' }
const opened = (s) => s.via.startsWith('debugger') && /READY_TO_TICK|DISCLOSED|debugger port seen|DOOR_MS/.test(`${s.output}\n${s.marks ?? ''}`)
// The run's milestones and final report lines, noted from every raw line even when the kept output is cut, so the path,
// the port blame and the summary never depend on what fitted.
export const MARK = /^(READY_TO_TICK|DISCLOSED|PORT_SEEN|DEFERRED_CHECKS)$|debugger port seen|DOOR_MS: \d{1,7}$|Port 9229 closed and confirmed|seen open|Time is up|No colour helper is running|helper: none \(already clean\)|^PORT_STATE: (open|closed|unknown)$|^RESULT: (ok|failed|refused)$|^stopped by (SIGINT|SIGTERM|SIGHUP)$|^ended by (SIGINT|SIGTERM|SIGHUP|SIGKILL|SIGQUIT|SIGABRT|SIGSEGV|SIGBUS|SIGPIPE)$/
// The milestones, kept while every raw line goes by: each marker word once (in the order first seen) plus the latest
// port state and result. Only fixed words and fixed values are kept (never a whole line), so a milestone can never carry
// part of a secret, and the list can never fill up and lose the final port state.
export function milestones() {
  const seen = []
  let port = null
  let result = null
  return {
    add(line) {
      const m = MARK.exec(bare(line))
      if (!m) return
      if (m[2]) port = m[0]
      else if (m[3]) result = m[0]
      else { const key = m[0].replace(/ \d+$/, ''); const i = seen.findIndex((x) => x.replace(/ \d+$/, '') === key); if (i === -1) seen.push(m[0]); else seen[i] = m[0] }
    },
    list() { return [...seen, ...(port ? [port] : []), ...(result ? [result] : [])] },
  }
}

// The one plain-English line /skin log shows for an entry, built from the cleaned texts. `rec`: command, steps [{via,
// exitCode, output}], shown (the chat text; '' for a direct run), result, exitCode, portBefore, portAfter.
const NOISE = /^(PORT_STATE|RESULT|READY_TO_TICK|DISCLOSED|SAMPLES|HELPER|DOOR_MS|DEFERRED_CHECKS|CHILD_READY|PORT_SEEN)\b/
const meaningful = (s) => s.slice(0, 50_000).split('\n').map(bare).filter((l) => l !== '' && !NOISE.test(l) && !/^(Not started\.|The skin step failed \(exit -?\d+\)\.)$/.test(l))
// The reason for a failure: the last real WARNING, else the first other telling line. Hints ("If ...") and the report's
// own "helper: unchanged (... did not finish)" line are never the reason.
const HINT = /^(WARNING:\s*)?(If |the backup guardian stays)|^helper: |^sampled colour checks: /
const TELLING = /Stopped|stopped by|ended by|interrupted|Took too long|not confirmed|could not|did not|failed|STILL OPEN|Time is up|refused|unconfirmed|Not started|No preset|No colour helper|^FIX |Unexpected error|ended without/i
export function outcome(rec) {
  const texts = [rec.shown ?? '', ...rec.steps.map((s) => `${s.output}\n${s.marks ?? ''}`)]
  const all = texts.flatMap(meaningful)
  // The reason comes from the chat text and the last step only: an earlier step's expected refusal (no helper yet) is
  // never blamed for a later step's failure.
  const own = [rec.shown ?? '', rec.steps.at(-1)?.output ?? ''].flatMap(meaningful)
  const why = () => {
    const warn = own.filter((l) => /^WARNING:/.test(l) && !HINT.test(l)).at(-1)
    const line = warn ?? own.find((l) => TELLING.test(l) && !HINT.test(l))
    return line === undefined ? 'no reason line was printed; see the entry' : short(line.replace(/^Not started:\s*/, '').replace(/^WARNING:\s*/, ''))
  }
  const hidden = hiddenInfo(texts.join('\n'))
  const last = rec.steps.at(-1)
  let what
  if (rec.steps.length === 0) {
    const first = short(meaningful(rec.shown ?? '')[0] ?? '')
    what = rec.result === 'refused' ? `refused before anything ran: ${first}` : rec.result === 'failed' ? `FAILED before the tool ran: ${first}` : 'answered without running the tool'
  } else if (last.via.startsWith('status')) {
    what = last.via === 'status check (for the list)'
      ? `listed the skins${last.exitCode !== 0 ? `, but the status check ended with exit ${last.exitCode}: ${why()}` : ''}`
      : last.exitCode === 0 ? `status shown${helperLine(last) ? `: ${helperLine(last)}` : ''}` : `status not shown (exit ${last.exitCode}): ${why()}`
  } else if (last.via.startsWith('health check')) {
    // The check's own verdict line is the summary, whatever its exit code.
    const verdict = meaningful(last.output).find((l) => /^health: /.test(l))
    what = verdict ? `health check: ${short(verdict.slice(8))}` : `health check did not finish (exit ${last.exitCode}): ${why()}`
  } else if (rec.result === 'ok') {
    what = hidden ? `applied, but not visible: the skin is ${hidden.needs} only and Claude was showing ${hidden.claude}`
      : /helper: none \(already clean\)/.test(last.output) ? 'nothing to remove: no colour helper was running (if a skin still shows, /skin remove --tick takes it off)'
      : `worked (${last.via})`
    if (last.exitCode !== 0) what += `, but its last step ended with exit ${last.exitCode}: ${why()}`
    else {
      // An ok run can still have printed a real warning, or colour checks that did not match: the summary says so.
      const warn = meaningful(last.output).filter((l) => /^WARNING:/.test(l) && !HINT.test(l)).at(-1)
      if (warn) what += `, with a warning: ${short(warn.replace(/^WARNING:\s*/, ''))}`
      const misses = /sampled colour checks: \d+ of \d+ passed \(\d+ unknown\); (\d+) did not match/.exec(last.output)
      if (misses) what += `; colour checks: ${misses[1]} did not match`
    }
  } else if (rec.result === 'refused') what = `refused, nothing changed: ${why()}`
  else what = `FAILED (${rec.exitCode === null || rec.exitCode === undefined ? 'no exit code' : `exit ${rec.exitCode}`}): ${why()}`
  // A run is only blamed for the port when it asked for the debugger.
  const touched = rec.steps.some(opened)
  const port = rec.portAfter === 'closed' ? (rec.portBefore === 'open' ? 'Port 9229 is now closed (it was open before)' : 'Port 9229 closed')
    : rec.portAfter === 'open' ? (!touched ? `Port 9229 is open, but this run did not open it${rec.portBefore === 'open' ? ' (it was already open before)' : ''}`
      : rec.portBefore === 'open' ? 'Port 9229 still OPEN after this run' : 'Port 9229 LEFT OPEN')
    : touched ? 'Port 9229 state unclear afterwards (no clear answer)' : 'Port 9229 not checked clearly; this run did not open it'
  return `${rec.command}: ${what.replace(/[\s.;:]+$/, '')}. ${port}.`
}

const indent = (text) => text.split('\n').map((l) => `  ${l}`).join('\n')
const localTime = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`
}

// Shortens kept output (already cleaned, so cutting it can expose nothing) until the whole entry fits the writer's
// limit, so a long output never makes the whole entry disappear.
export function fitEntry(render, outputs, limit = ENTRY_MAX_BYTES - 4096) {
  let outs = outputs
  for (let i = 0; i < 20; i++) {
    const text = render(outs)
    const size = Buffer.byteLength(text)
    if (size <= limit) return text
    const longest = outs.reduce((a, o, j) => (o.length > outs[a].length ? j : a), 0)
    const keep = Math.max(0, Math.floor(outs[longest].length * Math.min(0.9, limit / size)) - 200)
    outs = outs.map((o, j) => (j === longest ? `${o.slice(0, keep)}\n[... the rest of this output was shortened to fit the entry limit]` : o))
  }
  return render(outs.map(() => '[... output left out to fit the entry limit]'))
}

export function formatEntry(rec, home) {
  const clean = (s) => redact(s, home)
  const field = (s) => oneLine(clean(s))
  const command = rec.command.length > COMMAND_MAX_CHARS ? `${rec.command.slice(0, COMMAND_MAX_CHARS)} [... cut]` : rec.command
  // The summary and every other line are built from the cleaned output only.
  const output = clean(rec.output)
  const marks = clean((rec.marks ?? []).join('\n'))
  const step = { via: rec.via, exitCode: rec.exitCode, output, marks }
  const running = runningVersionOf(`${output}\n${marks}`)
  const head = [
    `${HEAD}${localTime(rec.at)} (start)`,
    // Built from cleaned parts only, so it is not cleaned a second time (that would eat its punctuation).
    `summary: ${oneLine(outcome({ ...rec, command: clean(command), steps: [step], shown: '' }).split(home || '\0').join('~'))}`,
    `command: ${field(command)}`,
    ...(rec.exact ? [`exact: ${field(rec.exact.length > 2 * COMMAND_MAX_CHARS ? `${rec.exact.slice(0, 2 * COMMAND_MAX_CHARS)} [... cut]` : rec.exact)}`] : []),
    `from: ${field(rec.from)}`,
    `tool: ${field(rec.tool)}`,
    `claude: running ${field(running ?? 'not reported by this run')}; installed ${field(rec.claudeVersion)}; Appearance setting: ${field(rec.appearance)}; Mac: ${field(rec.mac)} (installed version, Appearance and Mac read just after the run)`,
    `preset: ${rec.preset ? field(`${rec.preset.name} (${MODE_WORDS[rec.preset.mode] ?? rec.preset.mode})`) : 'none'}`,
    `port 9229 before: ${field(rec.portBefore)} (checked as the run started; unknown when the run ended before the check answered)`,
    `path: ${field(stepPath(step))}`,
    `port 9229 after: ${field(rec.portAfter)} (the tool's own last check)`,
    `result: ${field(rec.result)}`,
    `exit code: ${rec.exitCode}`,
    `duration: ${(rec.ms / 1000).toFixed(2)} s`,
    `milestones: ${marks ? oneLine(marks.split('\n').join(' | ')) : 'none noted'}`,
  ]
  return fitEntry(([out]) => [...head, `--- output (times since the run began)`, indent(out.trimEnd() || '(no output)'), END, ''].join('\n'), [output])
}

// The one writer both sides use (skin-log-append.sh; the mod carries the same text as APPEND_SH, and a test checks they
// match). It holds a system lock on an open file (lockf on .skin.log.lock): the lock lasts while any part of a writer is
// still running and is freed by macOS when the last part ends, so there is no stale lock and no overlap. It refuses a
// linked or foreign folder, a linked, hard-linked, foreign or non-regular log (and .1), and an entry over
// ENTRY_MAX_BYTES; moves the log to skin.log.1 when the new entry would pass the limit (writing nothing if that move
// fails); appends; and keeps the folder and file private. It waits at most 3 s for the lock. Never throws.
export const APPEND_SCRIPT = path.join(path.dirname(HERE), 'skin-log-append.sh')
export function appendEntry(fs, dir, text, max = LOG_MAX_BYTES) {
  try {
    if (Buffer.byteLength(text) > ENTRY_MAX_BYTES) return false
    const r = spawnSync('/bin/sh', [APPEND_SCRIPT, dir, String(max), String(ENTRY_MAX_BYTES)], { input: text, encoding: 'utf8', timeout: 6_000, killSignal: 'SIGKILL' })
    return r.status === 0
  } catch { return false }
}

// A file read for the log only: a small regular file (never a link, pipe or device), every look through a command with a
// 2 s limit, so a slow or hung disk or network folder can only cost those seconds.
function readSmall(fs, f, max = 1_000_000) {
  try {
    const st = spawnSync('/usr/bin/stat', ['-f', '%HT|%z', f], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' })
    const [kind, size] = st.status === 0 ? st.stdout.trim().split('|') : []
    if (kind !== 'Regular File' || !(Number(size) < max)) return null
    const r = spawnSync('/usr/bin/head', ['-c', String(max), f], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: max + 1024 })
    return r.status === 0 ? r.stdout : null
  } catch { return null }
}
export function claudeFacts(fs, home) {
  const q = (cmd, a) => { try { return spawnSync(cmd, a, { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' }) } catch { return null } }
  const v = q('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '/Applications/Claude.app/Contents/Info.plist'])
  const version = v?.status === 0 && /^[\w.-]{1,30}$/.test(v.stdout.trim()) ? v.stdout.trim() : 'unknown'
  return {
    claudeVersion: version,
    appearance: appearanceOf(readSmall(fs, path.join(home, 'Library/Application Support/Claude/config.json')) ?? undefined),
    mac: macModeOf(q('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle'])),
  }
}
// The skin's mode, from the file the command named (a preset name, a stylesheet path, or a batch list).
export function presetOf(fs, toolDir, args, cwd = process.cwd(), late = () => false, home = homedir()) {
  const verb = ['tick', 'one-click', 'switch', 'status', 'check'].includes(args[0]) ? args[0] : null
  const rest = verb ? args.slice(1) : args
  const word = rest.find((x) => !x.startsWith('--'))
  const modeOfFile = (f) => { if (late()) return null; const css = readSmall(fs, f); return css === null ? null : presetMode(css) }
  if (word === 'batch') {
    const words = []
    const after = rest.slice(rest.indexOf('batch') + 1)
    for (let i = 0; i < after.length; i++) { if (after[i] === '--final') i++; else if (!after[i].startsWith('--')) words.push(after[i]) }
    const names = (words[0] ?? '').split(',').filter((n) => /^[a-z0-9-]+$/.test(n)).slice(0, 10)
    return names.length ? { name: `batch ${names.join(', ')}`, mode: names.map((n) => `${n}: ${modeOfFile(path.join(toolDir, 'presets', `${n}.css`)) ?? 'not found'}`).join(', ') } : null
  }
  if (!word) return null
  // The arguments arrive cleaned, so a path may start with ~ (the home folder): it is turned back for the lookup.
  const file = word.startsWith('~/') ? path.join(home, word.slice(2)) : word
  const css = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(word) ? path.join(toolDir, 'presets', `${word}.css`) : file.endsWith('.css') ? path.resolve(cwd, file) : null
  const mode = css ? modeOfFile(css) : null
  return mode ? { name: path.basename(css, '.css'), mode } : null
}
export function viaOf(args) {
  const verb = ['tick', 'one-click', 'switch', 'status', 'check'].includes(args[0]) ? args[0] : null
  const word = (verb ? args.slice(1) : args).find((x) => !x.startsWith('--'))
  return args.includes('--dry-run') ? 'dry run (no tick, nothing applied)' : args.includes('--check') ? 'read only (check)'
    : verb === 'switch' ? 'colour helper' : verb === 'status' ? 'status (read only)' : verb === 'check' ? 'health check (read only)' : verb === 'tick' ? 'debugger, you tick'
    : word === 'batch' ? 'debugger, batch' : 'debugger, one click'
}

// Starts recording this process's own output (everything it writes still goes to the screen as before). At exit it only
// cleans what it holds and starts the background writer (`--finish`), handing it that cleaned record in its environment:
// no file is written and nothing waits on a disk at exit. The writer looks up the facts and appends the entry after
// this process has gone. `portBefore` is read at exit from a port check started with the run ("unknown" if it had not
// answered). A signal is always noted; while nothing else handles it (a switch or status run) it ends the run as before,
// through process.exit, so the entry is still written; once the tool has its own signal handlers (the debugger runs),
// this one stands aside and theirs keep their cleanup order. A run killed outright (SIGKILL) leaves no entry.
export const RECORD_ENV = 'RESKIN_LOG_RECORD'
// The record handed over must fit, with the rest of the environment and the arguments, in what the system allows a new
// process (about 1 MB). It is measured in bytes; long arguments and output are shortened first, and if it still does not
// fit, a minimal record (no output, short arguments) is handed over instead, so an entry is never lost to its size.
export const RECORD_MAX_BYTES = 256 * 1024
const envBytes = (env) => Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(`${k}=${v ?? ''}`) + 1, 0)
const shortArgs = (args, n = 200) => args.slice(0, 40).map((a) => (a.length > n ? `${a.slice(0, n)} [... cut]` : a))
export function handoff(rec, env = process.env, max = RECORD_MAX_BYTES) {
  const room = Math.max(16 * 1024, Math.min(max, 900 * 1024 - envBytes(env)))
  const fits = (j) => Buffer.byteLength(j) <= room
  let json = JSON.stringify(rec)
  if (fits(json)) return json
  const args = shortArgs(rec.argv)
  const slim = { ...rec, argv: args, execArgs: shortArgs(rec.execArgs), command: `node skin-auto.mjs ${args.join(' ')}`.trim().slice(0, 1000) }
  for (const keep of [32_000, 8_000, 0]) {
    json = JSON.stringify({ ...slim, output: keep ? `${rec.output.slice(0, keep)}\n[... output shortened to hand it over]` : '[... output left out to hand it over]' })
    if (fits(json)) return json
  }
  return JSON.stringify({ ...slim, argv: shortArgs(rec.argv, 40).slice(0, 8), execArgs: [], command: 'node skin-auto.mjs (arguments too long to keep)', output: '[... left out]', cwd: '' })
}
export function startRunLog({ argv, tool, portBefore, env = process.env, now = Date.now }) {
  if (!loggingOn(env)) return null
  const t0 = now()
  let result = null
  let port = null
  const marks = milestones()
  const out = capture(RAW_MAX_CHARS, (stream, line) => {
    marks.add(line)
    if (stream !== 'stdout') return
    // Only the tool's own exact report lines count (the same values the milestones accept).
    const r = /^RESULT: (ok|failed|refused)$/.exec(line)
    if (r) result = r[1]
    const p = /^PORT_STATE: (open|closed|unknown)$/.exec(line)
    if (p) port = p[1]
  })
  for (const stream of ['stdout', 'stderr']) {
    const target = process[stream]
    const write = target.write.bind(target)
    target.write = (chunk, ...rest) => {
      try { out.add(now() - t0, stream, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) } catch {}
      return write(chunk, ...rest)
    }
  }
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => {
      out.add(now() - t0, 'stderr', `\nstopped by ${sig}\n`) // noted only; nothing is printed
      if (process.listenerCount(sig) > 1) return // the tool's own handler cleans up, then exits
      process.exit(128 + n)
    })
  }
  process.on('exit', (code) => {
    try {
      const home = homedir()
      const args = redactArgs(argv, home)
      const rec = {
        at: t0, argv: args, command: `node skin-auto.mjs ${args.join(' ')}`.trim(), execArgs: redactArgs([process.execPath, process.argv[1] ?? 'skin-auto.mjs', ...argv], home),
        // The tool folder and working folder stay as they are: the writer needs them to find the skin file. They are only
        // handed over in memory, and cleaned when the entry is written.
        from: 'skin-auto.mjs, run directly (not through /skin)', tool, via: viaOf(argv), cwd: process.cwd(),
        portBefore: typeof portBefore === 'function' ? portBefore() : portBefore,
        portAfter: ['open', 'closed', 'unknown'].includes(port) ? port : 'unknown', marks: marks.list(),
        result: result ?? (code === 0 ? 'ok' : 'failed'), exitCode: code, ms: now() - t0, output: out.finish((t) => redact(t, home)), logDir: logDirOf(home, env),
      }
      const json = handoff(rec)
      const child = spawn(process.execPath, [HERE, '--finish'], { detached: true, stdio: 'ignore', env: { ...process.env, [RECORD_ENV]: json } })
      child.on('error', () => {})
      child.unref()
    } catch {}
  })
  return true
}

// The background writer: adds the facts and appends the entry. A watchdog outside it ends it, and everything it
// started, after 30 s whatever it is doing; every look at a file or a command also has its own short limit.
export function finish(fs, rec, home = homedir(), started = Date.now()) {
  const late = () => Date.now() - started > 25_000
  // The record was cleaned before it was handed over; it is cleaned again here, so nothing depends on that alone.
  const args = redactArgs(rec.argv ?? [], home)
  const facts = claudeFacts(fs, home)
  if (late()) return false
  // A stylesheet named by its full path is shown by its file name (the full path stays in the exact line).
  const shortArg = (a) => (/\.css$/.test(a) && a.includes('/') ? path.basename(a) : a)
  const entry = {
    ...rec,
    at: new Date(rec.at),
    argv: args,
    command: `node skin-auto.mjs ${args.map(shortArg).join(' ')}`.trim(),
    exact: `${JSON.stringify(redactArgs(rec.execArgs ?? [], home))} in ${redact(String(rec.cwd ?? ''), home)}`,
    preset: presetOf(fs, rec.tool, args, rec.cwd, late, home), // the cleaned arguments: a secret's value is never looked up
    ...facts,
  }
  if (late()) return false
  return appendEntry(fs, rec.logDir, formatEntry(entry, home))
}

if (process.argv[2] === '--finish' && path.resolve(process.argv[1] ?? '') === HERE) {
  const json = process.env[RECORD_ENV] ?? ''
  delete process.env[RECORD_ENV] // not passed on to the commands it runs
  let dog = null
  try {
    dog = spawn('/bin/sh', ['-c', '/bin/sleep 30 && kill -9 -"$1" 2>/dev/null', 'sh', String(process.pid)], { detached: true, stdio: 'ignore' })
    dog.unref()
    finish(nodeFs, JSON.parse(json))
  } catch {}
  try { if (dog?.pid) process.kill(-dog.pid, 'SIGKILL') } catch {}
  process.exit(0)
}
