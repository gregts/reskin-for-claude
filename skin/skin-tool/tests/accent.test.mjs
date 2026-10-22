// Accent pass: every skin recolours Claude's blue interaction accent (roles and semantic tokens) to its own accent,
// readable and visible, and leaves named blues, clay and charts alone. Reads the generated presets only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(tool, 'presets')
const files = readdirSync(dir).filter((n) => n.endsWith('.css'))

// Each colour-scheme block of a preset, as { mode, vars, dots }: vars from the skin-wide rule (*, *::before, *::after),
// dots from the .status-dot rule (17 Oct 2026: fixed dot colours per mode, which reuse --cds-fill-accent on the dots only).
const ruleVars = (b, sel) => { const m = new RegExp(`${sel.replace(/[.*[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(b); return m ? Object.fromEntries([...m[1].matchAll(/(--[a-z0-9-]+):([^;]+?) !important;/g)].map((x) => [x[1], x[2].trim()])) : {} }
const blocks = (css) => css.split(/(?=@media \(prefers-color-scheme: )/).filter(Boolean).map((b) => ({
  mode: /prefers-color-scheme: (dark|light)/.exec(b)[1],
  vars: ruleVars(b, '*, *::before, *::after'),
  dots: ruleVars(b, '.status-dot, [data-cds=Pulse]'),
}))
const all = files.flatMap((f) => blocks(readFileSync(path.join(dir, f), 'utf8')).map((b) => ({ f, ...b })))

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const lum = (h) => { const [r, g, b] = rgb(h).map((v) => lin(v / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const oklab = (h) => {
  const [r, g, b] = rgb(h).map((v) => lin(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const dE = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))
const HEX = /^#[0-9a-f]{6}$/
const STEPS = [50, 100, 250, 300, 400, 450, 600, 700, 800, 850]
const sidebarVar = (css, name) => new RegExp(`${name}:(#[0-9a-f]{6})`).exec(css)?.[1]

test('every skin block declares the accent roles and semantic tokens, as plain hex where Claude uses colours', () => {
  assert.equal(files.length, 16)
  assert.equal(all.length, 32) // every skin has a dark and a light half
  for (const b of all) {
    for (const s of STEPS) assert.match(b.vars[`--cds-role-accent-${s}`] ?? '', HEX, `${b.f} ${b.mode}: role ${s}`)
    for (const k of ['--cds-role-accent-fill', '--cds-role-accent-fill-hover', '--cds-role-accent-on', '--cds-fill-accent', '--cds-fill-accent-hover', '--cds-on-accent',
      '--cds-bg-accent', '--cds-bg-accent-chip', '--cds-border-accent', '--cds-radio-group-card-selected', '--cds-text-accent']) {
      assert.match(b.vars[k] ?? '', HEX, `${b.f} ${b.mode}: ${k}`)
    }
    assert.match(b.vars['--cds-bg-accent-muted'] ?? '', /^rgba\(\d+, \d+, \d+, 0\.1\)$/, `${b.f}: muted accent`)
  }
})

test('roles and semantic tokens agree (fill = 450, hover = 400, and the per-mode chip, border and radio steps)', () => {
  const steps = { light: { '--cds-bg-accent': 100, '--cds-border-accent': 250, '--cds-radio-group-card-selected': 50 }, dark: { '--cds-bg-accent': 800, '--cds-border-accent': 700, '--cds-radio-group-card-selected': 850 } }
  for (const { f, mode, vars: v } of all) {
    assert.equal(v['--cds-fill-accent'], v['--cds-role-accent-fill'], f)
    assert.equal(v['--cds-fill-accent'], v['--cds-role-accent-450'], f)
    assert.equal(v['--cds-fill-accent-hover'], v['--cds-role-accent-fill-hover'], f)
    assert.equal(v['--cds-fill-accent-hover'], v['--cds-role-accent-400'], f)
    assert.equal(v['--cds-on-accent'], v['--cds-role-accent-on'], f)
    assert.equal(v['--cds-bg-accent-chip'], v['--cds-bg-accent'], f)
    for (const [k, s] of Object.entries(steps[mode])) assert.equal(v[k], v[`--cds-role-accent-${s}`], `${f} ${mode}: ${k} is role ${s}`)
  }
})

test('button text 4.5:1 on the fill and on its hover; the fill shows 3:1 on every surface and both sidebar row bands', () => {
  for (const { f, mode, vars: v } of all) {
    const css = readFileSync(path.join(dir, f), 'utf8').split(/(?=@media \(prefers-color-scheme: )/).find((b) => b.includes(`prefers-color-scheme: ${mode}`))
    const fill = v['--cds-fill-accent'], on = v['--cds-on-accent'], hover = v['--cds-fill-accent-hover']
    assert.ok(ratio(on, fill) >= 4.5, `${f} ${mode}: button text ${ratio(on, fill).toFixed(2)}:1`)
    assert.ok(ratio(on, hover) >= 4.5, `${f} ${mode}: button text on hover ${ratio(on, hover).toFixed(2)}:1`)
    assert.ok(dE(hover, fill) >= 0.03, `${f} ${mode}: hover too close to the fill`)
    const surfaces = ['--cds-surface-0', '--cds-surface-1', '--cds-surface-2', '--cds-surface-3'].map((k) => v[k])
    surfaces.push(sidebarVar(css, '--df-hover'), sidebarVar(css, '--df-selected'))
    for (const s of surfaces) assert.ok(ratio(fill, s) >= 3, `${f} ${mode}: fill ${fill} on ${s} is ${ratio(fill, s).toFixed(2)}:1`)
  }
})

test('the accent chip shows against the page and keeps links and main text at 4.5:1; the border shows too', () => {
  for (const { f, mode, vars: v } of all) {
    const page = v['--cds-surface-1'], chip = v['--cds-bg-accent']
    assert.ok(dE(chip, page) >= 0.03, `${f} ${mode}: chip ${chip} does not show on ${page}`)
    assert.ok(ratio(v['--cds-text-accent'], chip) >= 4.5, `${f} ${mode}: link on chip`)
    assert.ok(ratio(v['--cds-text-primary'], chip) >= 4.5, `${f} ${mode}: text on chip`)
    assert.ok(dE(v['--cds-border-accent'], page) >= 0.03, `${f} ${mode}: border does not show`)
  }
})

test('the one legacy exception is --accent-100, as a bare HSL triple matching the fill; no other legacy accent', () => {
  const hslToHex = (h, s, l) => {
    s /= 100; l /= 100
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
  }
  for (const { f, mode, vars: v } of all) {
    const m = /^([\d.]+) ([\d.]+)% ([\d.]+)%$/.exec(v['--accent-100'] ?? '')
    assert.ok(m, `${f} ${mode}: --accent-100 must be "h s% l%"`)
    assert.ok(dE(hslToHex(+m[1], +m[2], +m[3]), v['--cds-fill-accent']) < 0.005, `${f} ${mode}: --accent-100 is the fill`)
    for (const k of Object.keys(v)) assert.ok(!/^--accent-(?!100$)/.test(k), `${f}: sets ${k}`)
  }
})

test('named blues, clay, charts and tint colours are left alone', () => {
  for (const f of files) {
    const css = readFileSync(path.join(dir, f), 'utf8')
    for (const re of [/--cds-blue-/, /tint-blue/, /highlight-blue/, /--cds-fill-brand/, /--cds-clay/, /--accent-brand/, /--cds-chart-/, /--color-blue/]) assert.ok(!re.test(css), `${f} sets ${re}`)
  }
})

test('absolutely keeps its clay accent in both halves, clearly different from its danger colour (Warm Dark retired)', () => {
  for (const b of all.filter((x) => x.f === 'absolutely.css')) {
    const v = b.vars
    assert.ok(dE(v['--cds-fill-accent'], '#cc7d5e') <= 0.12, `${b.mode}: fill ${v['--cds-fill-accent']}`)
    assert.ok(dE(v['--cds-fill-accent'], v['--cds-text-danger']) >= 0.05, `${b.mode}: fill vs danger ${dE(v['--cds-fill-accent'], v['--cds-text-danger']).toFixed(3)}`)
  }
})

test('session dots: the same four colours in every skin per mode, 3.4:1 on every sidebar row, clearly apart', () => {
  for (const mode of ['dark', 'light']) {
    const halves = all.filter((b) => b.mode === mode)
    const first = halves[0].dots
    assert.deepEqual(Object.keys(first).sort(), ['--cds-fill-accent', '--cds-fill-danger', '--cds-fill-warning', '--cds-text-muted'])
    for (const b of halves) assert.deepEqual(b.dots, first, `${b.f} ${mode}: dots differ from ${halves[0].f}`)
    const dots = Object.values(first)
    for (const d of dots) assert.match(d, HEX)
    for (const b of halves) {
      const css = readFileSync(path.join(dir, b.f), 'utf8').split(/(?=@media \(prefers-color-scheme: )/).find((x) => x.includes(`prefers-color-scheme: ${mode}`))
      const rows = [b.vars['--cds-surface-0'], sidebarVar(css, '--df-hover'), sidebarVar(css, '--df-selected')]
      for (const d of dots) for (const r of rows) assert.ok(ratio(d, r) >= 3.4, `${b.f} ${mode}: dot ${d} on ${r} is ${ratio(d, r).toFixed(2)}:1`)
    }
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) assert.ok(dE(dots[i], dots[j]) >= 0.12 - 1e-9, `${mode}: ${dots[i]} and ${dots[j]} are ${dE(dots[i], dots[j]).toFixed(3)} apart (generator target 0.12)`)
    // The unread dot no longer follows the skin's accent (buttons keep it).
    assert.ok(halves.some((b) => b.vars['--cds-fill-accent'] !== first['--cds-fill-accent']))
  }
})

test('each fill stays close to its published accent (at most dE 0.12), and every move is recorded', () => {
  const attr = readFileSync(path.join(tool, 'ATTRIBUTION.md'), 'utf8')
  const src = readFileSync(path.join(tool, 'make-presets.mjs'), 'utf8')
  const far = []
  for (const [, name, accent] of src.matchAll(/^  '([a-z-]+)':\s+\{.*?accent: '(#[0-9a-f]{6})'/gm)) {
    const fill = new RegExp(`### ${name} [\\s\\S]*?accent fill (#[0-9a-f]{6})`).exec(attr)[1]
    // A published accent that cannot meet the rules at its own strength uses the closest colour that does (recorded), and may then
    // sit further away, but never past 0.25; the list of such skins is fixed here so a new one is a deliberate change.
    const pale = new RegExp(`### ${name} [\\s\\S]*?the published accent ${accent} cannot carry 4.5:1 button text`).test(attr.split(/(?=^### )/m).find((x) => x.startsWith(`### ${name} `)) ?? '')
    if (pale) far.push(name)
    assert.ok(dE(fill, accent) <= (pale ? 0.25 : 0.12), `${name}: fill ${fill} is ${dE(fill, accent).toFixed(3)} from ${accent}`)
    if (fill !== accent) assert.ok(attr.includes(`accent fill ${accent} moved to ${fill}`), `${name}: move not recorded`)
  }
  assert.deepEqual(far, ['ayu-light'])
})

test('button text is white whenever white reads 4.5:1 on the fill', () => {
  for (const { f, mode, vars: v } of all) {
    if (ratio('#ffffff', v['--cds-fill-accent']) >= 4.5) assert.equal(v['--cds-on-accent'], '#ffffff', `${f} ${mode}`)
  }
})

test('the hover goes away from the button text (more contrast), never toward it', () => {
  for (const { f, mode, vars: v } of all) {
    const on = v['--cds-on-accent']
    assert.ok(ratio(on, v['--cds-fill-accent-hover']) >= ratio(on, v['--cds-fill-accent']) - 1e-9, `${f} ${mode}: hover moves toward the button text`)
  }
})
