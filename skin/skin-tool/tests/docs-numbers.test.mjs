// The numbers the public documents quote (B6, 18 Oct 2026) must be the numbers in the code. Each check finds its
// sentence by a pattern; a reworded sentence fails here on purpose, so the docs and this list change together.
// The public documents sit at the root of the package (three folders up); elsewhere set RESKIN_DOCS_DIR, or the
// document checks skip. AGENTS.md sits beside the tool and is always checked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, GUARD_GAP_S, LOCK_PORT, MIN_NODE_MAJOR, TICK } from '../skin-lib.mjs'

const tool = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rootGuess = path.resolve(tool, '..', '..')
const docs = process.env.RESKIN_DOCS_DIR ?? (existsSync(path.join(rootGuess, 'SECURITY.md')) ? rootGuess : null)
const read = (f) => readFileSync(f, 'utf8').replace(/\s+/g, ' ')
const skinSrc = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')
const fromSkin = (name) => Number(new RegExp(`const ${name} = ([\\d_]+)`).exec(skinSrc)[1].replaceAll('_', ''))
const num = (text, re, what) => { const m = re.exec(text); assert.ok(m, `${what}: sentence not found (${re})`); return Number(m[1]) }

const TICK_S = TICK.windowMs / 1000
const ARM_S = TICK.armMs / 1000
const FALLBACK_S = fromSkin('FALLBACK_CLOSE_MS') / 1000
const CSS_KB = fromSkin('CSS_MAX') / 1024
// Guardian B: its first look, then up to guardBTries tries GUARD_GAP_S apart. Each try may itself take seconds, so the
// docs give no fixed total ("several minutes"), only these numbers.
// What each exit code means in the docs' words, so a swapped pair fails, not only a missing number.
const EXIT_WORDS = { ok: 'ok', failed: 'failed', usage: 'usage', portNotConfirmed: 'port not confirmed closed', timeout: 'took', refused: 'refused', sidecarLeft: 'a throwaway Chrome', signal: 'interrupted' }

test('AGENTS.md quotes the tick window and both in-Claude timers', () => {
  const t = read(path.join(tool, 'AGENTS.md'))
  assert.equal(num(t, /within (\d+) s\b/, 'tick window'), TICK_S)
  assert.equal(num(t, /after (\d+) s \(a tick-mode preset apply\)/, 'apply timer'), ARM_S)
  assert.equal(num(t, /or (\d+) s \(everything else\)/, 'fallback timer'), FALLBACK_S)
  assert.equal(num(t, /tries up to (\d+) times, \d+ s apart \(`tick`/, 'guardian B tries'), TICK.guardBTries)
  assert.equal(num(t, /tries up to \d+ times, (\d+) s apart \(`tick`/, 'guardian gap'), GUARD_GAP_S)
  assert.equal(num(t, /looks about (\d+) s after it started/, 'guardian A'), TICK.guardAFirstS)
  assert.equal(num(t, /a click after the (\d+) s window/, 'tick window'), TICK_S)
})

// The /skin about text (the mod, one folder up in the package; RESKIN_MOD_DIR elsewhere).
const modLogic = [process.env.RESKIN_MOD_DIR && path.join(process.env.RESKIN_MOD_DIR, 'hooks', 'logic.ts'), path.join(tool, '..', 'hooks', 'logic.ts')].find((f) => f && existsSync(f))
test('/skin about quotes the fallback timer and the guardian span', { skip: !modLogic && 'the mod is not here' }, () => {
  const t = read(modLogic)
  assert.equal(num(t, /closes it within (\d+) seconds/, 'fallback timer'), FALLBACK_S)
  assert.match(t, /only once Reskin has seen it open\. If in doubt, quit and reopen Claude/)
  assert.doesNotMatch(t, /about \d+ minutes/) // no fixed total: each guardian try may take seconds
})

test('README quotes the tick window, the Node minimum and every exit code', { skip: !docs && 'no public docs here' }, () => {
  const t = read(path.join(docs, 'README.md'))
  assert.equal(num(t, /within (\d+) seconds/, 'tick window'), TICK_S)
  assert.equal(num(t, /Node (\d+) or newer/, 'Node minimum'), MIN_NODE_MAJOR)
  const line = /Exit codes of `skin-auto\.mjs`: (.*?130 interrupted)/.exec(t)?.[1]
  assert.ok(line, 'exit code line not found')
  const parts = line.split(/, (?=\d+ )/)
  assert.equal(parts.length, Object.keys(EXIT).length, line)
  for (const [key, code] of Object.entries(EXIT)) {
    const part = parts.find((p) => p.startsWith(`${code} `))
    assert.ok(part, `exit ${code} (${key}) not quoted`)
    assert.ok(part.slice(String(code).length + 1).startsWith(EXIT_WORDS[key]), `exit ${code} should mean ${key}: "${part}"`)
  }
})

test('SECURITY.md quotes the tick window, timers, guardian time, lock port and size limit', { skip: !docs && 'no public docs here' }, () => {
  const t = read(path.join(docs, 'SECURITY.md'))
  assert.equal(num(t, /You have (\d+) seconds\. After that, do not click/, 'tick window'), TICK_S)
  assert.equal(num(t, /looks about (\d+) seconds after it started/, 'guardian A'), TICK.guardAFirstS)
  assert.match(t, /stops at the first look that finds the port closed, so do not rely on it/)
  assert.equal(num(t, /looks after about (\d+) seconds \(after \d+ seconds if Reskin/, 'guardian B start'), TICK.guardBFirstS)
  assert.equal(num(t, /\(after (\d+) seconds if Reskin is already gone\)/, 'guardian B early look'), TICK.guardBEarlyS)
  assert.equal(num(t, /up to \d+ times, (\d+) seconds apart/, 'guardian gap'), GUARD_GAP_S)
  assert.equal(num(t, /up to (\d+) times, \d+ seconds apart/, 'guardian B tries'), TICK.guardBTries)
  assert.match(t, /Each try can itself take a few seconds/)
  assert.equal(num(t, /closes the port after (\d+) s \(painting a skin\)/, 'apply timer'), ARM_S)
  assert.equal(num(t, /or (\d+) s \(anything else\)/, 'fallback timer'), FALLBACK_S)
  assert.equal(num(t, /It sets the (\d+) s timer once it reaches/, 'direct-run timer'), FALLBACK_S)
  assert.equal(num(t, /local port (\d+)\)/, 'lock port'), LOCK_PORT)
  assert.equal(num(t, /at most (\d+) KB/, 'size limit'), CSS_KB)
})

// The run's own messages make no promise the guardians cannot keep (they stop at the first look that finds the port
// closed, a try can fail, and a frozen Claude waits for OK): they say what is tried and how to recover.
test('the tick prompt and the time-up warning promise no guardian closing, and give the way out', () => {
  const src = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  assert.doesNotMatch(src, /closes it if anything goes wrong|guardian closes the debugger within/)
  assert.match(src, /backup guardians try to close it, but if in doubt, quit and reopen Claude/)
  assert.match(src, /Do not tick now\. If you already did, quit and reopen Claude/)
})
