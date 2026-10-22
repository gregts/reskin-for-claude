// The /skin troubleshooting log: one plain-text entry per /skin run, in ~/Library/Logs/Reskin/skin.log. The tool writes
// the same format for runs started without /skin (an agent or a terminal), so one file tells the whole story.
// Pure helpers only (building, cleaning, reading entries), so they can be tested alone. The rules (redaction, capture,
// summary, writer) are the same as the tool's skin-log.mjs: change both together; the tests run the same cases on both.

import type { Preset } from './logic'

export const LOG_DIR = 'Library/Logs/Reskin' // under the user's home folder
export const LOG_FILE = 'skin.log'
// Past this size the file becomes skin.log.1 (the one older file kept, the one before it dropped) and a new one starts.
export const LOG_MAX_BYTES = 512 * 1024
// Per step, only the start of the output is kept (64 KB, far more than a normal run prints), and of a very long line its
// start. Keeping only starts means a cut can never separate a secret's name from its value; the whole kept text is then
// cleaned in one pass. At most MAX_STEPS steps, and the chat text and command are capped, so one entry stays under the
// writer's ENTRY_MAX_BYTES.
export const RAW_MAX_CHARS = 64 * 1024
export const LINE_MAX_CHARS = 16 * 1024
export const MAX_LINES = 2_000 // per stream: many short lines cost more in the entry (time and indent) than their text
export const MAX_STEPS = 3
export const SHOWN_MAX_CHARS = 8 * 1024
export const COMMAND_MAX_CHARS = 500
export const ENTRY_MAX_BYTES = 256 * 1024
// An entry starts with this line and ends with END. Raw output is indented, so it can never start a line with either.
export const HEAD = '==================== '
export const END = '==================== end'

export type PortState = 'open' | 'closed' | 'unknown'
// exitCode is null when the tool gave none (ended by a signal, did not answer in time, could not start).
export type Step = { argv: string[]; via: string; exitCode: number | null; ms: number; output: string; marks?: string }
export type LogRecord = {
  when: string // local date and time the run started
  command: string // what was typed, for example "/skin tokyo-night day"
  from: string // "/skin mod 0.6.0"
  tool: string // the tool folder, or what went wrong finding it
  claudeVersion: string // installed (the app bundle); the running one comes from the tool's own lines
  appearance: string // Claude's own Settings > Appearance: system, light, dark or unknown
  mac: string // the Mac's light or dark mode
  preset: { name: string; mode: Preset['mode'] } | null
  portBefore: PortState
  portAfter: PortState
  portAfterFrom?: string // where the after-reading came from: the tool's own last check, or a check as the run ended
  steps: Step[]
  shown: string // what the chat showed
  result: string // ok, failed, refused, or answered (the mod answered without the tool)
  exitCode: number | null // the last step's, or null when no step ran
  ms: number
}

export const MODE_WORDS: Record<Preset['mode'], string> = { auto: 'light and dark', dark: 'dark only', light: 'light only', unknown: 'mode not recognised' }

// lsof exits 0 with a listener, 1 with none; anything else (or no answer) is unknown.
export function portOf(r: { exitCode: number; stdout: string; stderr: string } | undefined): PortState {
  if (r === undefined) return 'unknown'
  if (r.exitCode === 0 && r.stdout.trim() !== '') return 'open'
  if (r.exitCode === 1 && r.stdout.trim() === '' && r.stderr.trim() === '') return 'closed'
  return 'unknown'
}

// `defaults read -g AppleInterfaceStyle`: "Dark" in dark mode; in light mode the key is missing (exit 1).
export function macModeOf(r: { exitCode: number; stdout: string; stderr: string } | undefined): 'dark' | 'light' | 'unknown' {
  if (r === undefined) return 'unknown'
  if (r.exitCode === 0 && r.stdout.trim() === 'Dark') return 'dark'
  if (r.exitCode === 1 && /does not exist|Could not find key/.test(r.stderr)) return 'light' // older and newer macOS wording
  return 'unknown'
}

// Claude's Appearance setting, from its config.json. That file also holds sign-in tokens: only this one word is taken
// out, and the rest of the text is never kept or logged.
export function appearanceOf(configText: string | undefined): string {
  if (configText === undefined) return 'unknown'
  const m = /"userThemeMode"\s*:\s*"(system|light|dark)"/.exec(configText)
  return m === null ? 'unknown' : m[1]!
}

// Known secret formats never go in the log (same rules as the tool's skin-log.mjs). Every rule is linear: ids, debugger
// links, URL queries and user:password@ parts, whole Cookie and Authorization values, bearer values, --password style
// flags, long keys, and the value of anything named like a password, token, key, cookie or credential, also when it sits
// inside another value (error: password="x"). A quoted value runs to its closing quote, over line breaks; with no
// closing quote it is redacted to the end. The home folder becomes ~. This is a filter for known formats, not a guarantee.
export const SECRET_NAME = /^(?:[A-Za-z0-9_.-]*(?:token|passw|secret|auth|cookie|credential|api[_-]?key|apikey|session[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*|key|pass|pwd|sid)$/i
const VALUE = String.raw`"[^"\\]*(?:\\[\s\S][^"\\]*)*"?|'[^'\\]*(?:\\[\s\S][^'\\]*)*'?`
// A name and its separator; only a secret name takes the value after it. Any other name is passed over and the scan goes
// on from its value, so a secret inside it is still found. One scan, each name read once.
const PAIR_NAME = /(["']?)([A-Za-z0-9_.-]{1,80})\1(\s*[:=]\s*)/g
const PAIR_VALUE = new RegExp(String.raw`(?:${VALUE}|[^\s&,;"'}]+)`, 'y')
// The space before a flag is looked at, not taken, so a flag that is not secret never hides the next one.
const FLAG_NAME = /(?<=^|\s)(--?)([A-Za-z0-9_.-]{1,80})(=|[ \t]+)/g
const FLAG_VALUE = new RegExp(String.raw`(?:${VALUE}|\S+)`, 'y')
// "Bearer x", "Basic x", "token x": the value may be quoted and run over lines; "token = x" is a named value instead.
// The whole run of spaces is taken (it cannot give back a space to dodge the check) before looking for ":" or "=".
const WORD_NAME = /\b(bearer|basic|token)(?=(\s+))\2(?![:=])/gi
function scan(text: string, nameRe: RegExp, valueRe: RegExp, nameOf: (m: RegExpExecArray) => string, isSecret = (n: string) => SECRET_NAME.test(n)): string {
  let out = ''
  let from = 0
  nameRe.lastIndex = 0
  let m: RegExpExecArray | null
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
export function redact(text: string, home: string | undefined): string {
  let t = text
  if (home && home.length > 1) t = t.split(home).join('~')
  // Named and quoted values first, whole (a quoted value can hold a web address, an escaped quote or a line break), then
  // what is left: web addresses, ids, whole header lines, keys.
  t = scan(t, FLAG_NAME, FLAG_VALUE, m => m[2]!)
  t = scan(t, WORD_NAME, FLAG_VALUE, m => m[1]!, () => true)
  t = scan(t, PAIR_NAME, PAIR_VALUE, m => m[2]!)
  return t
    .replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s\/@:]{1,256}:[^\s\/@]{1,1024}@/gi, '$1<redacted>@')
    .replace(/\b(?:wss?|https?):\/\/[^\s"'?#]{0,2048}[?#][^\s"']*/gi, m => m.replace(/[?#].*$/, '?<redacted>'))
    .replace(/\bwss?:\/\/[^\s"']+/gi, 'ws://<redacted>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*:[ \t]*)[^\n]*/gi, '$1$2<redacted>')
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '<redacted>')
    // A long run of letters and digits with both kinds in it (a key), never a path: "/" is not part of it.
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, m => /\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m)
}
// An argument list: the value after a secret flag (--password, then its value as the next argument) is redacted too.
export function redactArgs(args: readonly string[], home: string | undefined): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const m = /^--?([A-Za-z0-9_.-]{1,80})(=?)/.exec(a)
    if (m && SECRET_NAME.test(m[1]!) && m[2] === '=') { out.push(`${a.slice(0, m[0].length)}<redacted>`); continue } // --password=two words
    out.push(redact(a, home))
    if (m && SECRET_NAME.test(m[1]!) && m[0].length === a.length && i + 1 < args.length) { out.push('<redacted>'); i++ }
  }
  return out
}

// One physical line: a field that holds a line break (a pasted command) can never start a fake entry.
export const oneLine = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
const short = (s: string, n = 300) => s.length > n ? `${s.slice(0, n)} [... cut]` : s

// The chat text: its start and end, after cleaning.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters cut from the middle ...]\n${text.slice(-half)}`
}

// Output with the time each line arrived ([+1.234s] since the step began; "err|" marks stderr). Each stream is kept on its
// own, as plain text, and only from its start: up to half of `max` characters each, and once anything of a stream is cut
// (a line over LINE_MAX_CHARS, or the budget reached) nothing more of that stream is kept, only counted. At the end each
// stream is cleaned whole (so a secret over several lines is seen whole, and no line from the other stream or no time
// stamp can split it), then the lines are put back in time order with their times.
type Pending = { at: number; text: string; extra: number }
type Kept = { lines: string[]; times: number[]; chars: number; stopped: boolean; dropped: number }
export class Capture {
  private streams: Record<'stdout' | 'stderr', Kept> = {
    stdout: { lines: [], times: [], chars: 0, stopped: false, dropped: 0 },
    stderr: { lines: [], times: [], chars: 0, stopped: false, dropped: 0 },
  }
  private pend: Record<'stdout' | 'stderr', Pending | null> = { stdout: null, stderr: null }
  constructor(private max = RAW_MAX_CHARS) {}
  add(ms: number, stream: 'stdout' | 'stderr', text: string): void {
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      const cur = this.pend[stream] ?? { at: ms, text: '', extra: 0 }
      const room = Math.max(0, LINE_MAX_CHARS - cur.text.length)
      cur.text += parts[i]!.slice(0, room)
      cur.extra += Math.max(0, parts[i]!.length - room)
      if (i < parts.length - 1) { this.emit(cur, stream); this.pend[stream] = null } else this.pend[stream] = cur.text === '' && cur.extra === 0 ? null : cur
    }
  }
  finish(clean: (t: string) => string = t => redact(t, undefined)): string {
    for (const s of ['stdout', 'stderr'] as const) { const c = this.pend[s]; if (c) this.emit(c, s); this.pend[s] = null }
    const rows: { at: number; s: 'stdout' | 'stderr'; line: string; i: number }[] = []
    for (const s of ['stdout', 'stderr'] as const) {
      const st = this.streams[s]
      const cleaned = st.lines.length ? clean(st.lines.join('\n')).split('\n') : []
      // Cleaning keeps the line count; if it ever did not, the times are dropped rather than put on the wrong line.
      const timed = cleaned.length === st.times.length
      cleaned.forEach((line, i) => rows.push({ at: timed ? st.times[i]! : st.times[0] ?? 0, s, line, i }))
      if (st.dropped > 0) rows.push({ at: Infinity, s, line: `[... ${st.dropped} more characters of ${s} not kept: only the start of a long output is kept]`, i: Infinity })
    }
    rows.sort((a, b) => a.at - b.at || (a.s === b.s ? a.i - b.i : a.s === 'stdout' ? -1 : 1))
    return rows.map(r => r.at === Infinity ? r.line : `[+${(r.at / 1000).toFixed(3)}s]${r.s === 'stderr' ? ' err|' : ''} ${r.line}`).join('\n')
  }
  private emit(cur: Pending, stream: 'stdout' | 'stderr') {
    const st = this.streams[stream]
    if (st.stopped) { st.dropped += cur.text.length + cur.extra + 1; return }
    if (st.chars + cur.text.length + 1 > this.max / 2 || st.lines.length >= MAX_LINES) { st.stopped = true; st.dropped += cur.text.length + cur.extra + 1; return }
    st.lines.push(cur.text)
    st.times.push(cur.at)
    st.chars += cur.text.length + 1
    if (cur.extra > 0) { st.stopped = true; st.dropped += cur.extra }
  }
}

// The raw text a run's answer is read from (the tool's own last lines, the tick prompt). Bounded: its start (512 KB) and
// its newest end (512 KB to 1 MB) are kept, never more. `newly(marker)` is true once, for the piece in which `marker`
// first arrives, even when it is split across two pieces.
export class BoundedText {
  private head = ''
  private tail = ''
  private cut = 0
  private window = ''
  private seen = new Set<string>()
  constructor(private half = 512 * 1024) {}
  add(t: string): void {
    this.window = this.window.slice(-256) + t
    if (this.tail === '' && this.head.length + t.length <= this.half) { this.head += t; return }
    this.tail += t
    if (this.tail.length > 2 * this.half) { this.cut += this.tail.length - this.half; this.tail = this.tail.slice(-this.half) }
  }
  newly(marker: string): boolean {
    if (this.seen.has(marker) || !this.window.includes(marker)) return false
    this.seen.add(marker)
    return true
  }
  get text(): string { return this.cut > 0 ? `${this.head}\n[... ${this.cut} characters not kept ...]\n${this.tail}` : this.head + this.tail }
  // The text an answer is built from, cleaned: whole when nothing was cut; when the middle was cut, the start is cleaned
  // and of the end only the tool's own one-word report lines are kept (their context, and any secret's name, may be gone).
  cleaned(clean: (t: string) => string = t => redact(t, undefined)): string {
    if (this.cut === 0) return clean(this.head + this.tail)
    const tail = this.tail.split('\n').filter(l => /^(PORT_STATE: (open|closed|unknown)|RESULT: (ok|failed|refused))$/.test(l.trim())).join('\n')
    return `${clean(this.head)}\n[... ${this.cut} characters not kept ...]\n${tail}`
  }
}

// When a skin is applied but cannot show (it has no half for the mode Claude is showing): which mode Claude shows, and
// which the skin needs. Read from the tool's own lines.
export function hiddenInfo(text: string): { claude: 'dark' | 'light'; needs: 'dark' | 'light' } | null {
  const a = /has no (dark|light) version, so it is not showing now/.exec(text)
  if (a) { const claude = a[1] as 'dark' | 'light'; return { claude, needs: claude === 'dark' ? 'light' : 'dark' } }
  const b = /Claude is showing (dark|light) right now and this skin has only a (dark|light) version/.exec(text)
  if (b) return { claude: b[1] as 'dark' | 'light', needs: b[2] as 'dark' | 'light' }
  return null
}
// The Claude version that was really running, when the tool reported it (the helper line or status).
export function runningVersionOf(text: string): string | null {
  return /\(Claude (\d+(?:\.\d+){1,3})\)/.exec(text)?.[1] ?? /\bversion (\d+(?:\.\d+){1,3})\)/.exec(text)?.[1] ?? null
}

function bare(l: string): string { return l.replace(/^\[\+[\d.]+s\]( err\|)? /, '').replace(/^\[\d+(?:\.\d+)?s\] /, '').trim() }

// How far a step got, read from its own output. "Opened" needs positive evidence; otherwise it says what is not known.
type StepLike = { via: string; exitCode: number | null; output: string; marks?: string }
export function stepPath(s: StepLike): string {
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
const helperLine = (s: StepLike) => { const l = meaningful(s.output).find(x => /^helper: /.test(x)); return l ? short(l, 120) : '' }
const opened = (s: StepLike) => s.via.startsWith('debugger') && /READY_TO_TICK|DISCLOSED|debugger port seen|DOOR_MS/.test(`${s.output}\n${s.marks ?? ''}`)
// The run's milestones and final report lines, noted from every raw line even when the kept output is cut, so the path,
// the port blame and the summary never depend on what fitted.
export const MARK = /^(READY_TO_TICK|DISCLOSED|PORT_SEEN|DEFERRED_CHECKS)$|debugger port seen|DOOR_MS: \d{1,7}$|Port 9229 closed and confirmed|seen open|Time is up|No colour helper is running|helper: none \(already clean\)|^PORT_STATE: (open|closed|unknown)$|^RESULT: (ok|failed|refused)$|^stopped by (SIGINT|SIGTERM|SIGHUP)$|^ended by (SIGINT|SIGTERM|SIGHUP|SIGKILL|SIGQUIT|SIGABRT|SIGSEGV|SIGBUS|SIGPIPE)$/
// The milestones, kept while every raw piece goes by (lines split across pieces are joined first): each marker word once
// (in the order first seen) plus the latest port state and result. Only fixed words and fixed values are kept (never a
// whole line), so a milestone can never carry part of a secret, and the list can never fill up and lose the final port
// state, whatever is later cut from the kept output.
export class Milestones {
  private seen: string[] = []
  private port: string | null = null
  private result: string | null = null
  private pend: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  feed(stream: 'stdout' | 'stderr', text: string): void {
    const parts = (this.pend[stream] + text).split('\n')
    this.pend[stream] = parts.pop()!.slice(-512)
    for (const l of parts) this.add(l)
  }
  add(line: string): void {
    const m = MARK.exec(bare(line))
    if (!m) return
    if (m[2]) this.port = m[0]
    else if (m[3]) this.result = m[0]
    else { const key = m[0].replace(/ \d+$/, ''); const i = this.seen.findIndex(x => x.replace(/ \d+$/, '') === key); if (i === -1) this.seen.push(m[0]); else this.seen[i] = m[0] }
  }
  list(): string[] {
    for (const s of ['stdout', 'stderr'] as const) { if (this.pend[s]) this.add(this.pend[s]); this.pend[s] = '' }
    return [...this.seen, ...(this.port ? [this.port] : []), ...(this.result ? [this.result] : [])]
  }
}
// The same, from a finished text (tests and simple uses).
export function marksOf(text: string): string[] {
  const m = new Milestones()
  for (const line of text.split('\n')) m.add(line)
  return m.list()
}

// The one plain-English line /skin log shows for an entry, built from the cleaned texts.
const codeOf = (c: number | null) => c === null ? 'no exit code' : `exit ${c}`
const NOISE = /^(PORT_STATE|RESULT|READY_TO_TICK|DISCLOSED|SAMPLES|HELPER|DOOR_MS|DEFERRED_CHECKS|CHILD_READY|PORT_SEEN)\b/
const meaningful = (s: string) => s.slice(0, 50_000).split('\n').map(bare).filter(l => l !== '' && !NOISE.test(l) && !/^(Not started\.|The skin step failed \(exit -?\d+\)\.)$/.test(l))
// The reason for a failure: the last real WARNING, else the first other telling line. Hints ("If ...") and the report's
// own "helper: unchanged (... did not finish)" line are never the reason.
const HINT = /^(WARNING:\s*)?(If |the backup guardian stays)|^helper: |^sampled colour checks: /
const TELLING = /Stopped|stopped by|ended by|interrupted|Took too long|not confirmed|could not|did not|failed|STILL OPEN|Time is up|refused|unconfirmed|Not started|No preset|No colour helper|^FIX |Unexpected error|ended without/i
export function outcome(rec: { command: string; steps: readonly StepLike[]; shown: string; result: string; exitCode: number | null; portBefore: PortState; portAfter: PortState }): string {
  const texts = [rec.shown, ...rec.steps.map(s => `${s.output}\n${s.marks ?? ''}`)]
  const all = texts.flatMap(meaningful)
  // The reason comes from the chat text and the last step only: an earlier step's expected refusal (no helper yet) is
  // never blamed for a later step's failure.
  const own = [rec.shown, rec.steps.at(-1)?.output ?? ''].flatMap(meaningful)
  const why = () => {
    const warn = own.filter(l => /^WARNING:/.test(l) && !HINT.test(l)).at(-1)
    const line = warn ?? own.find(l => TELLING.test(l) && !HINT.test(l))
    return line === undefined ? 'no reason line was printed; see the entry' : short(line.replace(/^Not started:\s*/, '').replace(/^WARNING:\s*/, ''))
  }
  const hidden = hiddenInfo(texts.join('\n'))
  const last = rec.steps.at(-1)
  let what: string
  if (last === undefined) {
    const first = short(meaningful(rec.shown)[0] ?? '')
    what = rec.result === 'refused' ? `refused before anything ran: ${first}` : rec.result === 'failed' ? `FAILED before the tool ran: ${first}` : 'answered without running the tool'
  } else if (last.via.startsWith('status')) {
    what = last.via === 'status check (for the list)'
      ? `listed the skins${last.exitCode !== 0 ? `, but the status check ended with ${codeOf(last.exitCode)}: ${why()}` : ''}`
      : last.exitCode === 0 ? `status shown${helperLine(last) ? `: ${helperLine(last)}` : ''}` : `status not shown (${codeOf(last.exitCode)}): ${why()}`
  } else if (last.via.startsWith('health check')) {
    // The check's own verdict line is the summary, whatever its exit code.
    const verdict = meaningful(last.output).find(l => /^health: /.test(l))
    what = verdict ? `health check: ${short(verdict.slice(8))}` : `health check did not finish (${codeOf(last.exitCode)}): ${why()}`
  } else if (rec.result === 'ok') {
    what = hidden ? `applied, but not visible: the skin is ${hidden.needs} only and Claude was showing ${hidden.claude}`
      : /helper: none \(already clean\)/.test(last.output) ? 'nothing to remove: no colour helper was running (if a skin still shows, /skin remove --tick takes it off)'
      : `worked (${last.via})`
    if (last.exitCode !== 0) what += `, but its last step ended with ${codeOf(last.exitCode)}: ${why()}`
    else {
      // An ok run can still have printed a real warning, or colour checks that did not match: the summary says so.
      const warn = meaningful(last.output).filter(l => /^WARNING:/.test(l) && !HINT.test(l)).at(-1)
      if (warn) what += `, with a warning: ${short(warn.replace(/^WARNING:\s*/, ''))}`
      const misses = /sampled colour checks: \d+ of \d+ passed \(\d+ unknown\); (\d+) did not match/.exec(last.output)
      if (misses) what += `; colour checks: ${misses[1]} did not match`
    }
  } else if (rec.result === 'refused') what = `refused, nothing changed: ${why()}`
  else what = `FAILED (${codeOf(rec.exitCode)}): ${why()}`
  // A run is only blamed for the port when it asked for the debugger.
  const touched = rec.steps.some(opened)
  const port = rec.portAfter === 'closed' ? (rec.portBefore === 'open' ? 'Port 9229 is now closed (it was open before)' : 'Port 9229 closed')
    : rec.portAfter === 'open' ? (!touched ? `Port 9229 is open, but this run did not open it${rec.portBefore === 'open' ? ' (it was already open before)' : ''}`
      : rec.portBefore === 'open' ? 'Port 9229 still OPEN after this run' : 'Port 9229 LEFT OPEN')
    : touched ? 'Port 9229 state unclear afterwards (no clear answer)' : 'Port 9229 not checked clearly; this run did not open it'
  return `${rec.command}: ${what.replace(/[\s.;:]+$/, '')}. ${port}.`
}

const indent = (text: string) => text.split('\n').map(l => `  ${l}`).join('\n')

// Shortens kept outputs (already cleaned, so cutting them can expose nothing) until the whole entry fits the writer's
// limit, so a long output never makes the whole entry disappear.
const bytes = (t: string) => new TextEncoder().encode(t).length
export function fitEntry(render: (outs: string[]) => string, outputs: string[], limit = ENTRY_MAX_BYTES - 4096): string {
  let outs = outputs
  for (let i = 0; i < 20; i++) {
    const text = render(outs)
    const size = bytes(text)
    if (size <= limit || outs.length === 0) return text
    const longest = outs.reduce((a, o, j) => o.length > outs[a]!.length ? j : a, 0)
    const keep = Math.max(0, Math.floor(outs[longest]!.length * Math.min(0.9, limit / size)) - 200)
    outs = outs.map((o, j) => j === longest ? `${o.slice(0, keep)}\n[... the rest of this output was shortened to fit the entry limit]` : o)
  }
  return render(outs.map(() => '[... output left out to fit the entry limit]'))
}

export function formatEntry(rec: LogRecord, home: string | undefined): string {
  const clean = (s: string) => redact(s, home)
  // Every header field is one line; the raw output and the chat text are indented.
  const field = (s: string) => oneLine(clean(s))
  const command = rec.command.length > COMMAND_MAX_CHARS ? `${rec.command.slice(0, COMMAND_MAX_CHARS)} [... cut]` : rec.command
  // The summary and every other line are built from the cleaned texts only.
  const steps = rec.steps.slice(-MAX_STEPS).map(s => ({ ...s, output: clean(s.output), marks: clean(s.marks ?? '') }))
  const shown = clip(clean(rec.shown), SHOWN_MAX_CHARS)
  const running = runningVersionOf(steps.map(s => `${s.output}\n${s.marks}`).join('\n'))
  const head = [
    `${HEAD}${oneLine(rec.when)} (start)`,
    // Built from cleaned parts only, so it is not cleaned a second time (that would eat its punctuation).
    `summary: ${oneLine(outcome({ ...rec, command: clean(command), steps, shown }))}`,
    `command: ${field(command)}`,
    `from: ${field(rec.from)}`,
    `tool: ${field(rec.tool)}`,
    `claude: running ${field(running ?? 'not reported by this run')}; installed ${field(rec.claudeVersion)}; Appearance setting: ${field(rec.appearance)}; Mac: ${field(rec.mac)} (installed version, Appearance and Mac read just after the run)`,
    `preset: ${rec.preset ? field(`${rec.preset.name} (${MODE_WORDS[rec.preset.mode]})`) : 'none'}`,
    `port 9229 before: ${rec.portBefore} (checked as the run started)`,
    `path: ${steps.length === 0 ? 'none (no tool step ran)' : field(steps.map(stepPath).join(', then '))}`,
    `port 9229 after: ${rec.portAfter} (${rec.portAfterFrom ?? 'checked as the run ended'})`,
    `result: ${field(rec.result)}`,
    `exit code: ${rec.exitCode ?? 'none'}`,
    `duration: ${(rec.ms / 1000).toFixed(2)} s`,
  ]
  return fitEntry(outs => {
    const lines = [...head]
    steps.forEach((s, i) => {
      lines.push(`--- step ${i + 1}: ${oneLine(JSON.stringify(redactArgs(s.argv, home)))} (${s.exitCode === null ? 'no exit code' : `exit ${s.exitCode}`}, ${(s.ms / 1000).toFixed(2)} s)`)
      lines.push(`  milestones: ${s.marks ? oneLine(s.marks.split('\n').join(' | ')) : 'none noted'}`)
      lines.push(indent(outs[i]!.trimEnd() || '(no output)'))
    })
    lines.push('--- shown in chat')
    lines.push(indent(shown.trimEnd() || '(nothing)'))
    lines.push(END, '')
    return lines.join('\n')
  }, steps.map(s => s.output))
}

export type LogItem = { when: string; summary: string }
// Reads entries back (oldest first). A torn or foreign last entry still gives its date and summary when present.
export function parseLog(text: string): LogItem[] {
  const items: LogItem[] = []
  let cur: LogItem | null = null
  for (const line of text.split('\n')) {
    if (line === END) { if (cur) items.push(cur); cur = null; continue }
    if (line.startsWith(HEAD)) { if (cur) items.push(cur); cur = { when: line.slice(HEAD.length).replace(/ \(start\)$/, '').trim(), summary: '' }; continue }
    if (cur && cur.summary === '' && line.startsWith('summary: ')) cur.summary = line.slice('summary: '.length)
  }
  if (cur) items.push(cur)
  return items
}

// /skin log: the last few entries, newest first, and where the full file is.
export function logView(older: string, current: string, count: number, shownPath: string): string {
  const items = [...parseLog(older), ...parseLog(current)].slice(-count).reverse()
  if (items.length === 0) return `No /skin runs logged yet. The log will be at ${shownPath}`
  return [
    `Last ${items.length} run${items.length === 1 ? '' : 's'}, newest first:`,
    ...items.map(i => `• ${i.when}  ${i.summary || '(no summary)'}`),
    '',
    `Full details (every step's output, timings, versions, port checks): ${shownPath}`,
    'The older file, if any, is the same name ending in .1. Known secret formats (keys, tokens, passwords, ids) are removed; that is a filter, not a guarantee: read an entry before you share it.',
  ].join('\n')
}

// The one writer, run as `/bin/sh -c APPEND_SH sh <dir> <max bytes> <entry max bytes>` with the entry on stdin. It is the
// same text as the tool's skin-log-append.sh (a tool test checks they match), so both sides follow one protocol. It holds
// a system lock on an open file (lockf on .skin.log.lock): the lock lasts while any part of a writer is still running and
// is freed by macOS when the last part ends, so there is no stale lock and no overlap. It refuses a linked or foreign
// folder, a linked, hard-linked, foreign or non-regular log (and .1), and an entry over the limit; moves the log to
// skin.log.1 when the new entry would pass the size limit (writing nothing if that move fails); appends; and keeps the
// folder and file private. It starts every entry on a fresh line (even after a torn one), waits at most 3 s for the lock
// and removes its own temporary file however it ends.
export const APPEND_SH = String.raw`umask 077
d="$1"; max="$2"; emax="$3"; f="$d/skin.log"; lock="$d/.skin.log.lock"; tmp=""
cleanup() { [ -n "$tmp" ] && /bin/rm -f "$tmp"; }
trap cleanup EXIT
trap 'exit 9' INT TERM HUP
[ -L "$d" ] && exit 3
/bin/mkdir -p "$d" || exit 3
[ -d "$d" ] && [ -O "$d" ] || exit 3
/bin/chmod 700 "$d" 2>/dev/null
[ -L "$lock" ] && exit 3
exec 9>>"$lock" || exit 3
/usr/bin/lockf -s -t 3 9 || exit 4
/usr/bin/find "$d" -maxdepth 1 -name '.entry.*' -type f -mmin +1 -delete 2>/dev/null
tmp=$(/usr/bin/mktemp "$d/.entry.XXXXXX") || exit 3
/usr/bin/head -c $((emax + 1)) > "$tmp"
add=$(/usr/bin/stat -f %z "$tmp")
[ "$add" -gt "$emax" ] && exit 8
mine() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(/usr/bin/stat -f %l "$1")" = 1 ]; }
if [ -e "$f" ] || [ -L "$f" ]; then mine "$f" || exit 5; fi
size=0; [ -f "$f" ] && size=$(/usr/bin/stat -f %z "$f")
sep=0; [ "$size" -gt 0 ] && [ -n "$(/usr/bin/tail -c 1 "$f")" ] && sep=1
if [ $((size + sep + add)) -gt "$max" ] && [ "$size" -gt 0 ]; then
  if [ -e "$f.1" ] || [ -L "$f.1" ]; then mine "$f.1" || exit 6; fi
  /bin/mv -f "$f" "$f.1" || exit 6
  sep=0
fi
[ "$sep" = 1 ] && { printf '\n' >> "$f" || exit 7; }
/bin/cat "$tmp" >> "$f" && /bin/chmod 600 "$f" || exit 7
exit 0`
