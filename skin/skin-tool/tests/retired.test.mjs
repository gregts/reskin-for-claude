// Retired skins (5 Nov 2026): verc left the set when kanagawa came in. A typed or saved retired name changes
// nothing and says so plainly, naming what to pick instead, on every path that takes a skin name (never a quiet swap).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RETIRED_SKINS, isRetired, retiredLine, parseSetLine, writePrivateJson } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORDS = /The skin verc was retired \(its light half looked almost the same as github and ayu\)\. Nothing was changed\. Try github or ayu instead\./

test('verc is retired, has no preset file, and its line names github and ayu', () => {
  assert.deepEqual(Object.keys(RETIRED_SKINS), ['verc'])
  assert.equal(isRetired('verc'), true)
  for (const n of ['github', 'ayu', 'kanagawa', 'constructor', '__proto__', undefined, null]) assert.equal(isRetired(n), false, String(n))
  assert.match(retiredLine('verc'), WORDS)
  assert.equal(retiredLine('nord'), null)
  // A retired name must never be a shipped preset, and every suggestion must be one.
  for (const [n, r] of Object.entries(RETIRED_SKINS)) {
    assert.equal(existsSync(path.join(tool, 'presets', `${n}.css`)), false, n)
    for (const t of r.try) assert.ok(existsSync(path.join(tool, 'presets', `${t}.css`)), t)
  }
})

test('the one-line parser refuses a retired skin with its own line, before anything else', () => {
  assert.throws(() => parseSetLine(['verc', 'font', 'plex'], { isPreset: () => true }), WORDS)
  assert.throws(() => parseSetLine(['VERC'], { isPreset: () => false }), WORDS)
})

test('tick, one-click, switch and set all refuse verc with the retired line, exit 2, and touch nothing', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'reskin-retired-'))
  try {
    const env = { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: path.join(home, 'state') }
    for (const args of [['tick', 'verc'], ['one-click', 'verc'], ['switch', 'verc'], ['set', 'verc', 'type', 'on'], ['tick', 'verc', '--dry-run']]) {
      const r = spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 20_000, env })
      const out = r.stdout + r.stderr
      if (args[0] === 'one-click' && /not in this release/.test(out)) continue // a tick-only copy refuses one-click first
      assert.equal(r.status, 2, `${args.join(' ')}: ${out}`)
      assert.match(out, WORDS, args.join(' '))
      assert.match(r.stdout, /RESULT: refused/, args.join(' '))
    }
    assert.equal(existsSync(path.join(home, 'state', 'prefs.json')), false) // nothing saved
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a saved verc is never offered back: status says it was retired and suggests another skin with a tick', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'reskin-retired-'))
  try {
    const state = path.join(home, 'state')
    mkdirSync(state, { mode: 0o700 })
    writePrivateJson(nodeFs, state, 'prefs.json', { v: 1, last: 'verc', type: true, font: null }, randomUUID)
    const r = spawnSync(process.execPath, [path.join(tool, 'skin-auto.mjs'), 'status'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: state } })
    const out = r.stdout + r.stderr
    assert.doesNotMatch(out, /Reapply verc\?|\/skin verc --tick/)
    // With no helper in this temp state the offer shows: it starts with "Reapply " (the mod keeps such lines) and names github.
    assert.match(out, /^helper: none/m, out) // a temp state folder has no helper session, so the offer must show
    assert.match(out, /^Reapply a skin\? Your last skin, verc, was retired \(.*\), so it cannot come back\. Pick another, for example \/skin github --tick;.* That also brings back the project headers\.$/m)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// An older copy may leave presets/verc.css behind (the generator removes it, a hand-copied update may
// not). It must change nothing: every path refuses verc first, and the helper is never handed it.
test('a leftover verc.css is still refused on every path and never offered to a helper', async () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'reskin-leftover-'))
  try {
    for (const f of readdirSync(tool)) if (/\.(mjs|sh|json)$/.test(f) && f !== 'release.json') copyFileSync(path.join(tool, f), path.join(copy, f))
    cpSync(path.join(tool, 'presets'), path.join(copy, 'presets'), { recursive: true })
    // A leftover file under the retired name that would pass the stylesheet check (a copy of a shipped preset).
    writeFileSync(path.join(copy, 'presets', 'verc.css'), readFileSync(path.join(tool, 'presets', 'github.css'), 'utf8'))
    const env = { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: path.join(copy, 'state') }
    for (const args of [['tick', 'verc', '--dry-run'], ['tick', path.join(copy, 'presets', 'verc.css'), '--dry-run'], ['switch', 'verc'], ['set', 'verc'], ['batch', 'github,verc', '--dot-census', '--dry-run']]) {
      const r = spawnSync(process.execPath, [path.join(copy, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 20_000, env })
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
      assert.match(r.stdout + r.stderr, WORDS, args.join(' '))
    }
    // skin.mjs runs its command line on import: load it without the main() call (as health-check.test.mjs does).
    const src = readFileSync(path.join(copy, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n')
    writeFileSync(path.join(copy, 'skin-lib-free.mjs'), src)
    const { helperPresets } = await import(path.join(copy, 'skin-lib-free.mjs'))
    const { map } = helperPresets(path.join(copy, 'presets'))
    assert.equal(Object.hasOwn(map, 'verc'), false)
    assert.ok(Object.hasOwn(map, 'kanagawa'))
  } finally { rmSync(copy, { recursive: true, force: true }) }
})
