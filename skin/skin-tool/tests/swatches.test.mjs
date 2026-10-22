// The preview pictures in swatches/ are drawn from the presets by make-swatches.mjs (B9, 18 Oct 2026). They must match
// the presets, never come from a screenshot, and never guess a colour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { halfColours, swatch } from '../make-swatches.mjs'

const tool = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('swatches/ holds one up-to-date picture per preset and nothing else', () => {
  const r = spawnSync(process.execPath, [path.join(tool, 'make-swatches.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const presets = readdirSync(path.join(tool, 'presets')).filter((f) => f.endsWith('.css') && !f.startsWith('dotcheck-')).map((f) => f.slice(0, -4)).sort()
  assert.deepEqual(readdirSync(path.join(tool, 'swatches')).map((f) => f.replace(/\.svg$/, '')).sort(), presets)
})

test('a picture holds only colours, shapes and the skin name: no image, link or script', () => {
  for (const f of readdirSync(path.join(tool, 'swatches'))) {
    const svg = readFileSync(path.join(tool, 'swatches', f), 'utf8')
    assert.doesNotMatch(svg, /<image|<script|href=|<foreignObject|data:/i, f)
  }
})

test('a half without a colour the picture needs is refused, never guessed', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  assert.throws(() => halfColours(css.replace(/--cds-surface-2:#[0-9a-f]{6}/g, ''), 'dark'), /no --cds-surface-2/)
  assert.throws(() => halfColours(css.replace(/\.status-dot, \[data-cds=Pulse\]/g, '.x'), 'light'), /other rules/)
  assert.throws(() => swatch('x', css.replace('(prefers-color-scheme: light)', '(min-width: 1px)')), /no light half/)
  const dark = halfColours(css, 'dark')
  assert.equal(dark.page, /--cds-surface-1:(#[0-9a-f]{6})/.exec(css)[1])
})

test('a painted colour that differs from its token, a colour hidden in a comment, or a doubled rule is refused', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  const page = halfColours(css, 'dark').page
  // the page really painted in another colour: the picture must not keep showing the token's colour
  const painted = css.replace(`html, body, .dframe-content { background-color:${page}`, 'html, body, .dframe-content { background-color:#123456')
  assert.notEqual(painted, css)
  assert.throws(() => halfColours(painted, 'dark'), /paints page #123456/)
  // a colour inside a comment is not a colour: with the real token gone, the comment must not stand in for it
  const commented = css.replace(/--cds-surface-2:#[0-9a-f]{6} !important;/, '/* --cds-surface-2:#abcdef; */')
  assert.throws(() => halfColours(commented, 'dark'), /no --cds-surface-2/)
  assert.throws(() => halfColours(css.replace('.bg-surface-2 {', '.bg-surface-2 { color:#000000 !important; } .bg-surface-2 {'), 'dark'), /twice/)
})

test('a name that is not a plain skin name never reaches the picture', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  for (const bad of ['x" onload="alert(1)', 'a<b', 'Nord', '', 'a b', '-x']) assert.throws(() => swatch(bad, css), /not a skin name/, bad)
})

test('an extra rule that paints over a shown colour, or an extra property in a painting rule, is refused', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  const lightAt = css.indexOf('@media (prefers-color-scheme: light)')
  const darkEnd = css.lastIndexOf('}', lightAt)
  const extra = css.slice(0, darkEnd) + '  .dframe-content { background-color:#123456 !important; }\n' + css.slice(darkEnd)
  assert.throws(() => halfColours(extra, 'dark'), /other rules/)
  assert.throws(() => halfColours(css.replace('.bg-surface-2 { background-color:', '.bg-surface-2 { color:#000000 !important; background-color:'), 'dark'), /sets color, background-color/)
})

test('a token rule that also paints (a background on the dots, or anything but tokens in the token rule) is refused', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  const dots = css.replace('.status-dot, [data-cds=Pulse] { ', '.status-dot, [data-cds=Pulse] { background-color:#123456 !important; ')
  assert.notEqual(dots, css)
  assert.throws(() => halfColours(dots, 'dark'), /sets background-color/)
  assert.throws(() => halfColours(css.replace('*, *::before, *::after {', '*, *::before, *::after { color:#123456 !important;'), 'dark'), /token rule sets color/)
  assert.throws(() => halfColours(css.replace('.dframe-sidebar, .dframe-sidebar * { ', '.dframe-sidebar, .dframe-sidebar * { background-color:#123456 !important; '), 'dark'), /sets background-color/)
})

test('a declaration without !important is refused (it would lose to the token rule and paint another colour)', () => {
  const css = readFileSync(path.join(tool, 'presets', 'nord.css'), 'utf8')
  const weak = css.replace('--cds-fill-accent:#5ca3fe !important;', '--cds-fill-accent:#5ca3fe;')
  assert.notEqual(weak, css)
  assert.throws(() => halfColours(weak, 'dark'), /is not !important/)
})
