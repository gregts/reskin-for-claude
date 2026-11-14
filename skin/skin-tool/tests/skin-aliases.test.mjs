// Short and old skin names (14 Nov 2026): every alias points at a shipped preset, never shadows one, never takes a
// command word, and is never a retired name. Offline: no Claude, no helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKIN_ALIASES, skinAlias, isRetired, parseSetLine } from '../skin-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const presets = readdirSync(path.join(here, '..', 'presets')).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4))
const WORDS = ['off', 'on', 'remove', 'list', 'status', 'check', 'about', 'log', 'font', 'fonts', 'type', 'band', 'look', 'set', 'switch', 'tick', 'one-click', 'batch', 'all', 'chat', 'rows', 'headers', 'ui']

test('every alias points at a shipped preset', () => {
  for (const [k, v] of Object.entries(SKIN_ALIASES)) assert.ok(presets.includes(v), `${k} -> ${v} is not in presets/`)
})
test('no alias shadows a preset, a command word or a retired name', () => {
  for (const k of Object.keys(SKIN_ALIASES)) {
    assert.ok(!presets.includes(k), `${k} is a preset name`)
    assert.ok(!WORDS.includes(k), `${k} is a command word`)
    assert.ok(!isRetired(k), `${k} is retired`)
    assert.match(k, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  }
})
test('every preset with a name longer than three letters has a short name', () => {
  const short = new Set(Object.entries(SKIN_ALIASES).filter(([k]) => k.length <= 3).map(([, v]) => v))
  for (const p of presets) if (p.length > 3) assert.ok(short.has(p), `${p} has no short name`)
})
test('skinAlias maps aliases and leaves everything else alone', () => {
  assert.equal(skinAlias('dra'), 'dracula')
  assert.equal(skinAlias('tokyo-night-day'), 'tokyo-night')
  assert.equal(skinAlias('dracula'), 'dracula')
  assert.equal(skinAlias('verc'), 'verc')
  assert.equal(skinAlias('off'), 'off')
  assert.equal(skinAlias(undefined), undefined)
})
test('the one-line command reads a short name as its skin', () => {
  const isPreset = (n) => presets.includes(n)
  assert.equal(parseSetLine(['dra', 'font', 'plex'], { isPreset }).skin, 'dracula')
  assert.equal(parseSetLine(['rose-pine-dawn', 'type', 'on'], { isPreset }).skin, 'rose-pine')
  assert.throws(() => parseSetLine(['verc', 'type', 'on'], { isPreset }), /retired/)
})
test('the mod carries the same alias table as the tool', () => {
  // In the package the mod sits beside the tool (skin/hooks); a development copy names it with RESKIN_MOD_DIR.
  const dirs = [path.join(here, '..', '..'), process.env.RESKIN_MOD_DIR].filter(Boolean)
  let src
  for (const d of dirs) { try { src = readFileSync(path.join(d, 'hooks', 'logic.ts'), 'utf8'); break } catch {} }
  if (src === undefined) return // no mod beside this copy of the tool
  for (const [k, v] of Object.entries(SKIN_ALIASES)) {
    const key = /^[a-z0-9]+$/.test(k) ? `${k}: '${v}'` : `'${k}': '${v}'`
    assert.ok(src.includes(key), `mod is missing ${key}`)
  }
})
test('the light flavour carries the same alias table as the tool', () => {
  // In the package the light flavour sits beside the full one (reskin-light/hooks/skins.ts); RESKIN_LIGHT_DIR in development.
  const dirs = [path.join(here, '..', '..', '..', 'reskin-light'), process.env.RESKIN_LIGHT_DIR].filter(Boolean)
  let src
  for (const d of dirs) { try { src = readFileSync(path.join(d, 'hooks', 'skins.ts'), 'utf8'); break } catch {} }
  if (src === undefined) return // no light flavour beside this copy of the tool
  const at = src.indexOf('export const ALIASES')
  assert.ok(at >= 0, 'skins.ts has no ALIASES table')
  const table = JSON.parse(src.slice(src.indexOf('{', at), src.indexOf('}', at) + 1))
  assert.deepEqual(table, { ...SKIN_ALIASES })
})
