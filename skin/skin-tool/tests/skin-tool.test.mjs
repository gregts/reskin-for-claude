// Run with: node --test 'tests/*.test.mjs'      (no Claude debugger, no Chrome is started by any test here)
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  EXIT, acquireLock, claudeRunning, guardScript, hideScript, identityOf, isOurSidecarCommand, nodeOk, pgrepState, portState, safePid,
} from '../skin-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.resolve(here, '..')
const node = process.execPath
const sh = (file, args, opts = {}) => spawnSync(node, [path.join(tool, file), ...args], { encoding: 'utf8', timeout: 30_000, ...opts })

test('nodeOk needs 22 or newer', () => {
  assert.equal(nodeOk('22.0.0'), true)
  assert.equal(nodeOk('24.1.0'), true)
  assert.equal(nodeOk('20.19.0'), false)
  assert.equal(nodeOk('18.0.0'), false)
})

test('pgrepState never mistakes a failure for "none"', () => {
  assert.deepEqual(pgrepState({ status: 1, stdout: '' }), { state: 'none', pids: [] })
  assert.deepEqual(pgrepState({ status: 0, stdout: '123\n456\n' }), { state: 'found', pids: [123, 456] })
  assert.equal(pgrepState({ status: null, stdout: '' }).state, 'unknown') // timed out
  assert.equal(pgrepState({ status: 2, stdout: '' }).state, 'unknown') // syntax error
  assert.equal(pgrepState({ status: 3, stdout: '' }).state, 'unknown') // fatal
  assert.equal(pgrepState({ status: 1, stdout: 'junk' }).state, 'unknown')
  assert.equal(pgrepState({ status: 0, stdout: 'abc\n' }).state, 'unknown')
  assert.equal(pgrepState({ status: 0, stdout: '' }).state, 'unknown')
  assert.equal(pgrepState({ status: 1, stdout: '', error: new Error('boom') }).state, 'unknown')
})

test('portState: closed only when lsof says nothing at all', () => {
  assert.equal(portState({ status: 1, stdout: '', stderr: '' }).state, 'closed')
  assert.equal(portState({ status: 0, stdout: 'COMMAND PID\nClaude 1', stderr: '' }).state, 'open')
  assert.equal(portState({ status: 1, stdout: '', stderr: 'lsof: permission denied' }).state, 'unknown')
  assert.equal(portState({ status: null, stdout: '', stderr: '' }).state, 'unknown')
  assert.equal(portState({ status: 2, stdout: '', stderr: '' }).state, 'unknown')
  assert.equal(portState({ status: 1, stdout: '', stderr: '', error: new Error('x') }).state, 'unknown')
})

test('claudeRunning reads a full process listing, and says unknown when ps fails', () => {
  const list = '/sbin/launchd\n/Applications/Claude.app/Contents/MacOS/Claude\n/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n'
  assert.equal(claudeRunning({ status: 0, stdout: list }), 'yes')
  assert.equal(claudeRunning({ status: 0, stdout: '/sbin/launchd\n/Applications/Other.app/Contents/MacOS/Other\n' }), 'no')
  assert.equal(claudeRunning({ status: 0, stdout: '/Users/x/Claude.app.bak/MacOS/Claude\n' }), 'no')
  assert.equal(claudeRunning({ status: 1, stdout: '' }), 'unknown')
  assert.equal(claudeRunning({ status: null, stdout: '' }), 'unknown')
})

test('the run lock: one holder at a time, freed on release', async () => {
  const port = 41000 + Math.floor(Math.random() * 10000)
  const a = await acquireLock(port)
  assert.equal(a.ok, true)
  const b = await acquireLock(port)
  assert.equal(b.ok, false)
  assert.match(b.reason, /another skin change is running/)
  await a.release()
  const c = await acquireLock(port)
  assert.equal(c.ok, true)
  await c.release()
})

test('eight real processes racing for the lock: exactly one wins', async () => {
  const port = 41000 + Math.floor(Math.random() * 10000)
  const libUrl = new URL('../skin-lib.mjs', import.meta.url).href
  const code = `import { acquireLock } from ${JSON.stringify(libUrl)};
const r = await acquireLock(${port});
console.log(r.ok ? 'WON' : 'LOST');
if (r.ok) await new Promise((res) => setTimeout(res, 1500)); // hold it while the others try
process.exit(0)`
  const one = () => new Promise((res) => {
    const c = spawn(node, ['--input-type=module', '-e', code])
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => res(out.trim()))
  })
  const results = await Promise.all(Array.from({ length: 8 }, one))
  assert.equal(results.filter((r) => r === 'WON').length, 1, results.join(','))
  assert.equal(results.filter((r) => r === 'LOST').length, 7, results.join(','))
})

test('a holder that is killed outright frees the lock at once (no stale lock, no takeover logic)', async () => {
  const port = 41000 + Math.floor(Math.random() * 10000)
  const libUrl = new URL('../skin-lib.mjs', import.meta.url).href
  const code = `import { acquireLock } from ${JSON.stringify(libUrl)};
const r = await acquireLock(${port}); console.log(r.ok ? 'HELD' : 'NO'); await new Promise(() => {})`
  const holder = spawn(node, ['--input-type=module', '-e', code])
  await new Promise((res) => holder.stdout.once('data', res))
  assert.equal((await acquireLock(port)).ok, false)
  holder.kill('SIGKILL')
  await new Promise((res) => holder.on('close', res))
  const after = await acquireLock(port)
  assert.equal(after.ok, true)
  await after.release()
})

test('identityOf: ours, other, gone and unknown are different answers', () => {
  const dir = '/tmp/claude-skin-chrome.QWE456'
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(identityOf({ status: 0, stdout: `${exe} --user-data-dir=${dir}\n` }, dir), 'ours')
  assert.equal(identityOf({ status: 0, stdout: `${exe}\n` }, dir), 'other')
  assert.equal(identityOf({ status: 1, stdout: '' }, dir), 'gone')
  assert.equal(identityOf({ status: null, stdout: '' }, dir), 'unknown')
  assert.equal(identityOf({ status: 2, stdout: '' }, dir), 'unknown')
  assert.equal(identityOf({ status: 1, stdout: 'x' }, dir), 'unknown')
  assert.equal(identityOf({ status: 1, stdout: '', stderr: 'ps: something failed' }, dir), 'unknown') // error text: cannot tell
  assert.equal(identityOf({ status: 0, stdout: '', stderr: '' }, dir), 'unknown') // blank success: cannot tell
  assert.equal(identityOf({ status: 0, stdout: `${exe} --user-data-dir=${dir}`, stderr: 'warning' }, dir), 'unknown')
  assert.equal(identityOf({ status: 0, stdout: '', error: new Error('x') }, dir), 'unknown')
})

test('skin-auto uses only names it imports from skin-lib (catches a missing import)', () => {
  const lib = readFileSync(path.join(tool, 'skin-lib.mjs'), 'utf8')
  const exported = [...lib.matchAll(/export (?:const|function|async function) (\w+)/g)].map((m) => m[1])
  const auto = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  const importBlock = /import \{([^}]*)\} from '\.\/skin-lib\.mjs'/.exec(auto)[1]
  const imported = importBlock.split(',').map((s) => s.trim()).filter(Boolean)
  for (const name of exported) {
    const body = auto.replace(/import \{[^}]*\} from '\.\/skin-lib\.mjs'/, '')
    const used = new RegExp(`\\b${name}\\b`).test(body)
    if (used) assert.ok(imported.includes(name), `skin-auto.mjs uses ${name} but does not import it`)
  }
  for (const name of imported) assert.ok(exported.includes(name), `skin-auto.mjs imports ${name}, which skin-lib.mjs does not export`)
})

test('skin-auto refuses while another run holds the lock', async (ctx) => {
  const port = 41000 + Math.floor(Math.random() * 10000)
  const held = await acquireLock(port)
  assert.equal(held.ok, true)
  try {
    const r = spawnSync(node, [autoPath(), path.join(path.dirname(autoPath()), 'presets/dracula.css'), '--dry-run'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, SKIN_LOCK_PORT: String(port) } })
    assert.equal(r.status, EXIT.refused)
    assert.match(r.stdout + r.stderr, /another skin change is running/)
    assert.match(r.stdout, /RESULT: refused/)
  } finally {
    await held.release()
  }
})

test('identity and pid guards', () => {
  const dir = '/tmp/claude-skin-chrome.AbC123'
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(isOurSidecarCommand(`${exe} --user-data-dir=${dir} --no-startup-window`, dir), true)
  assert.equal(isOurSidecarCommand(exe, dir), false) // the user's own Chrome
  assert.equal(isOurSidecarCommand(`${exe} --user-data-dir=${dir}X`, dir), false) // not an exact argument
  assert.equal(isOurSidecarCommand(`/tmp/evil/Google Chrome --user-data-dir=${dir}`, dir), false) // wrong executable
  assert.equal(isOurSidecarCommand(`${exe}Helper --user-data-dir=${dir}`, dir), false)
  assert.equal(isOurSidecarCommand('/bin/sleep 1 --user-data-dir=' + dir, dir), false)
  assert.equal(isOurSidecarCommand('whatever', null), false)
  assert.equal(safePid(4242), 4242)
  for (const bad of [0, 1, -5, 3.5, NaN, '12', null, undefined, '1; do shell script']) assert.equal(safePid(bad), null)
  assert.match(hideScript(4242), /unix id is 4242\)/)
  assert.throws(() => hideScript('4242; quit'))
  assert.throws(() => hideScript(null))
})

test('skin-auto: usage errors exit 2, change nothing and still print the status lines', () => {
  for (const args of [[], ['/etc/hosts'], ['/nonexistent/x.css']]) {
    const r = sh('skin-auto.mjs', args)
    assert.equal(r.status, EXIT.usage)
    assert.match(r.stdout, /PORT_STATE: unknown/)
    assert.match(r.stdout, /RESULT: refused/)
  }
})

test('skin-auto --check is read-only and reports each requirement', () => {
  const r = sh('skin-auto.mjs', ['--check'])
  assert.ok([0, EXIT.refused].includes(r.status))
  for (const word of ['Node', 'Claude desktop app installed', 'Google Chrome: ', 'Port 9229']) assert.ok(r.stdout.includes(word), word)
  assert.match(r.stdout, /PORT_STATE: (closed|open|unknown)/)
  assert.match(r.stdout, /RESULT: (ok|refused)/)
})

test('skin-auto refuses a bad stylesheet before starting anything', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-bad-'))
  const f = path.join(d, 'bad.css')
  writeFileSync(f, '@media (prefers-color-scheme: dark) { html { --x: ); --y: (; } }')
  // --dry-run: even if the check were broken, this test could never tick Claude's menu.
  // A stylesheet that is not one of the presets is refused before it is even checked.
  const r = spawnSync(node, [autoPath(), f, '--dry-run'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, EXIT.usage)
  assert.match(r.stdout, /RESULT: refused/)
  assert.match(r.stderr, /Not one of Reskin's presets/)
  assert.ok(!accepted(sh('skin.mjs', ['check-css', f])), 'and the check itself refuses it too')
  assert.ok(!r.stdout.includes('Dry run done'), 'refused before the dry run started')
  for (const step of ['menu ticked', 'throwaway Chrome ready']) assert.ok(!r.stdout.includes(step), step)
})

test('skin-auto refuses when port 9229 is already taken (nothing is clicked)', async (ctx) => {
  const server = createServer()
  try { await new Promise((res, rej) => { server.once('error', rej); server.listen(9229, '127.0.0.1', res) }) } catch { return ctx.skip('port 9229 is busy for real') }
  try {
    const r = spawnSync(node, [autoPath(), path.join(path.dirname(autoPath()), 'presets/dracula.css')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'reskin-port-')), SKIN_LOCK_PORT: String(41000 + Math.floor(Math.random() * 10000)) } })
    const text = r.stdout + r.stderr
    assert.equal(r.status, EXIT.refused)
    assert.match(r.stdout, /RESULT: refused/)
    assert.ok(!r.stdout.includes('menu ticked'))
    assert.ok(!r.stdout.includes('throwaway Chrome ready')) // refused before starting anything
    if (/Your own Chrome is open|Claude desktop app is not running/.test(text)) return ctx.skip('an earlier precheck refused first on this machine')
    assert.match(text, /Port 9229 is already open/) // the precise reason
  } finally {
    server.close()
  }
})

// ---- skin.mjs: the stylesheet check is the only barrier between a file and Claude's main process ----
// `check-css` validates offline and never touches Claude or any port, so these tests are safe to run any time.
function css(body) { const d = mkdtempSync(path.join(tmpdir(), 'skin-css-')); const f = path.join(d, 't.css'); writeFileSync(f, body); return f }
const accepted = (r) => r.status === 0 && /Stylesheet OK/.test(r.stdout)
const dark = (inner) => `@media (prefers-color-scheme: dark) { ${inner} }`
const light = (inner) => `@media (prefers-color-scheme: light) { ${inner} }`
// Splits a preset into its top-level colour-scheme blocks (one, or two for a pair).
const blocks = (s) => {
  const out = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) { out.push(s.slice(start, i + 1).trim()); start = i + 1 }
  }
  return out
}

test('checkCss accepts one dark or light block', () => {
  assert.ok(accepted(sh('skin.mjs', ['check-css', css(dark('html { color: #ff0000 !important; }'))])))
  assert.ok(accepted(sh('skin.mjs', ['check-css', css(light('html { color: #ff0000 !important; }'))])))
})

test('checkCss accepts a pair (one dark block and one light block, in either order)', () => {
  assert.ok(accepted(sh('skin.mjs', ['check-css', css(dark('html { color: #ff0000 }') + '\n' + light('html { color: #0000ff }'))])))
  assert.ok(accepted(sh('skin.mjs', ['check-css', css(light('html { color: #0000ff }') + dark('html { color: #ff0000 }'))])))
})

test('checkCss refuses two blocks of the same mode, three blocks, an empty sheet, and anything between blocks', () => {
  const bad = [
    dark('html {}') + dark('html {}'),
    light('html {}') + light('html {}'),
    dark('html {}') + light('html {}') + dark('html {}'),
    dark('html {}') + ' body { color: #0000ff } ' + light('html {}'),
    dark('html {}') + '}' + light('html {}'),
    dark('html {}') + light('html {'),
    '',
    '   ',
    dark('html {}') + '\u00a0',
    dark('html {}') + '\u00a0' + light('html {}'),
    dark('html {}') + '\u2028' + light('html {}'),
    dark('html { color: #ff0000 }\u00a0'),
    dark('@media (prefers-color-scheme: light) { html {} }'),
    dark('html {}') + light('@media (prefers-color-scheme: dark) { html {} }'),
    dark('html { --x: ); --y: (; }'), // reversed parentheses
    dark('html { --x: [ ( ] ); }'), // crossed brackets
    dark('html { --x: ( ; }'),
    dark('html { --x: ] ; --y: [ ; }'),
  ]
  for (const b of bad) assert.ok(!accepted(sh('skin.mjs', ['check-css', css(b)])), `should refuse: ${b}`)
})

test('checkCss refuses everything that could fetch, hide in a string, or sit outside the block', () => {
  const bad = [
    'html { color: #ff0000 }', // no media block
    dark('html { background: url(http://x/y) }'),
    dark('@import foo;'),
    dark('html { content: "x" }'),
    dark("html { content: 'x' }"),
    dark('html { color: \\72 ed }'),
    dark('@font-face { font-family: X }'),
    dark('html { background: image-set(a 1x) }'),
    dark('html { color: #ff0000 } /* open'),
    dark('html { color: #ff0000 }') + ' body { color: #0000ff }', // outside the block
    '@media (prefers-color-scheme: sepia) { html {} }',
    '@media screen { html {} }',
    dark('html {'), // unbalanced
  ]
  for (const b of bad) assert.ok(!accepted(sh('skin.mjs', ['check-css', css(b)])), `should refuse: ${b}`)
})

test('every shipped preset passes the stylesheet check', () => {
  const dir = path.join(tool, 'presets')
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'))
  assert.equal(files.length, 16)
  for (const f of files) assert.ok(accepted(sh('skin.mjs', ['check-css', path.join(dir, f)])), f)
})

test('generated files match the generator (no drift)', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'skin-drift-'))
  const r = sh('make-presets.mjs', ['--out', out])
  assert.equal(r.status, 0, r.stderr)
  for (const sub of ['presets', 'raycast']) {
    const fresh = readdirSync(path.join(out, sub)).sort()
    const shipped = readdirSync(path.join(tool, sub)).sort()
    assert.deepEqual(fresh, shipped, `${sub} file list`)
    for (const f of fresh) {
      const a = readFileSync(path.join(out, sub, f), 'utf8').replaceAll(out, tool)
      assert.equal(a, readFileSync(path.join(tool, sub, f), 'utf8'), `${sub}/${f} differs from the generator`)
    }
  }
  assert.equal(readFileSync(path.join(out, 'ATTRIBUTION.md'), 'utf8'), readFileSync(path.join(tool, 'ATTRIBUTION.md'), 'utf8'), 'ATTRIBUTION.md differs from the generator')
  rmSync(out, { recursive: true, force: true })
})

test('no em dash anywhere in the tool files', () => {
  const EM = String.fromCharCode(8212)
  for (const f of ['skin-auto.mjs', 'skin-lib.mjs', 'skin.mjs', 'make-presets.mjs', 'README.md', 'AGENTS.md', 'tests/skin-tool.test.mjs'].filter((x) => existsSync(path.join(tool, x)))) {
    assert.ok(!readFileSync(path.join(tool, f), 'utf8').includes(EM), f)
  }
})

test('every preset reads well enough on page, sidebar, card, pop-up and the hover and selected-row bands (text, secondary, link, muted and status 4.5:1)', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const dir = path.join(tool, 'presets')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const s of blocks(readFileSync(path.join(dir, f), 'utf8'))) {
      const v = (name) => new RegExp(`${name}:(#[0-9a-f]{6})(?![0-9a-f])`).exec(s)?.[1] ?? assert.fail(`${f} sets no ${name}`)
      const side = v('--cds-surface-0'), page = v('--cds-surface-1'), card = v('--cds-surface-2'), pop = v('--cds-surface-3')
      const body = [['page', page, 4.5], ['sidebar', side, 4.5], ['card', card, 4.5], ['pop-up', pop, 4.5]]
      const rows = [...body, ['hover band', v('--df-hover'), 4.5], ['selected row', v('--df-selected'), 4.5]]
      // Status text and icons (the waiting hand, the error triangle) sit on sidebar rows too.
      const status = rows
      const rules = [['--cds-text-primary', rows], ['--cds-text-secondary', rows], ['--cds-text-accent', rows], ['--cds-text-muted', rows],
        ['--cds-text-danger', status], ['--cds-text-success', status], ['--cds-text-warning', status]]
      for (const [name, surfaces] of rules) {
        for (const [where, bg, min] of surfaces) assert.ok(ratio(v(name), bg) >= min, `${f} ${name} on ${where}: ${ratio(v(name), bg).toFixed(2)} (needs ${min})`)
      }
    }
  }
})

test('sidebar hover and selected-row bands stand out from the sidebar (perceived difference), selected more than hover, shared overlays untouched', () => {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lab = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255))
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q]
  }
  const dE = (a, b) => Math.hypot(...lab(a).map((x, i) => x - lab(b)[i]))
  const dir = path.join(tool, 'presets')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const s of blocks(readFileSync(path.join(dir, f), 'utf8'))) {
      const v = (name) => new RegExp(`${name}:(#[0-9a-f]{6})(?![0-9a-f])`).exec(s)?.[1] ?? assert.fail(`${f} sets no ${name}`)
      const side = v('--cds-surface-0')
      assert.ok(dE(v('--df-hover'), side) >= 0.03, `${f}: hover band too faint (${dE(v('--df-hover'), side).toFixed(3)})`)
      assert.ok(dE(v('--df-selected'), side) >= 0.055, `${f}: selected band too faint (${dE(v('--df-selected'), side).toFixed(3)})`)
      assert.ok(dE(v('--df-selected'), v('--df-hover')) >= 0.02, `${f}: hover and selected look too alike (${dE(v('--df-selected'), v('--df-hover')).toFixed(3)})`)
      assert.ok(dE(v('--df-selected'), side) > dE(v('--df-hover'), side), `${f}: selected band is not stronger than hover`)
      // Only the sidebar rows are recoloured; Claude's see-through hover overlays elsewhere must stay untouched.
      assert.ok(!/--cds-fill-ghost-|--cds-bg-neutral-|--cds-fill-secondary-hover/.test(s), `${f}: overrides a shared hover overlay`)
      // The row colours are set only inside the sidebar: every rule that sets them is sidebar-scoped.
      for (const m of s.matchAll(/([^{}]*)\{[^{}]*--df-(?:hover|selected):/g)) assert.equal(m[1].trim(), '.dframe-sidebar, .dframe-sidebar *', `${f}: row colours set outside the sidebar`)
    }
  }
})

test('main text is at least as strong as secondary, and secondary clearly stronger than muted hints', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const dir = path.join(tool, 'presets')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const s of blocks(readFileSync(path.join(dir, f), 'utf8'))) {
      const v = (name) => new RegExp(`${name}:(#[0-9a-f]{6})(?![0-9a-f])`).exec(s)[1]
      const side = v('--cds-surface-0')
      assert.ok(ratio(v('--cds-text-secondary'), side) >= ratio(v('--cds-text-muted'), side) * 1.15 - 1e-9, `${f}: secondary and muted too close`)
      assert.ok(ratio(v('--cds-text-primary'), side) >= ratio(v('--cds-text-secondary'), side) - 1e-9, `${f}: secondary text is stronger than main text`)
    }
  }
})

test('light skins have cards at least as light as the page, and no skin sets legacy bare-HSL variables', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const dir = path.join(tool, 'presets')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const s of blocks(readFileSync(path.join(dir, f), 'utf8'))) {
      assert.ok(!/--bg-\d|--text-\d/.test(s), `${f} sets a legacy --bg-/--text- variable`)
      if (/prefers-color-scheme: light/.test(s)) {
        const page = /--cds-surface-1:(#[0-9a-f]{6})/.exec(s)[1], card = /--cds-surface-2:(#[0-9a-f]{6})/.exec(s)[1]
        assert.ok(lum(card) >= lum(page) - 1e-9, `${f}: card ${card} is darker than page ${page}`)
      }
    }
  }
})

test('the shipped skins are exactly the 16 names, each one file with a dark half then a light half', () => {
  const dir = path.join(tool, 'presets')
  // Written out here on purpose, independent of the generator's own table.
  const SKINS = ['absolutely', 'ayu', 'catppuccin', 'classic', 'dracula', 'github', 'gruvbox', 'linea', 'night-owl', 'nord', 'one', 'rose-pine', 'solarized', 'tokyo-night', 'verc', 'vs']
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.css')).map((n) => n.slice(0, -4)).sort(), SKINS)
  for (const n of SKINS) {
    const parts = blocks(readFileSync(path.join(dir, `${n}.css`), 'utf8'))
    assert.equal(parts.length, 2, n)
    assert.match(parts[0], /^@media \(prefers-color-scheme: dark\)/, n)
    assert.match(parts[1], /^@media \(prefers-color-scheme: light\)/, n)
  }
})

test('each skin is built from its own palettes: page and main text of both halves, written out from the sources', () => {
  // Independent of the generator: swapping two palettes between skins would change these.
  const PAGES = {
    classic: ['#262624', '#faf9f5'], catppuccin: ['#1e1e2e', '#eff1f5'], dracula: ['#282a36', '#fffbeb'], github: ['#0d1117', '#ffffff'],
    gruvbox: ['#282828', '#fbf1c7'], nord: ['#2e3440', '#eceff4'], one: ['#282c34', '#fafafa'], 'rose-pine': ['#191724', '#faf4ed'],
    solarized: ['#002b36', '#fdf6e3'], 'tokyo-night': ['#1a1b26', '#e1e2e7'], ayu: ['#10141c', '#fcfcfc'], 'night-owl': ['#011627', '#fbfbfb'],
    vs: ['#1e1e1e', '#ffffff'], absolutely: ['#2d2d2b', '#f9f9f7'], linea: ['#0f0f11', '#fcfcfd'], verc: ['#000000', '#ffffff'],
  }
  const SIDEBARS = { vs: ['#252526', '#f3f3f3'], verc: ['#000000', '#ffffff'], github: ['#010409', '#f6f8fa'], dracula: ['#21222c', '#ece9df'] }
  for (const [skin, [dark, light]] of Object.entries(PAGES)) {
    const [d, l] = blocks(readFileSync(path.join(tool, 'presets', `${skin}.css`), 'utf8'))
    assert.equal(/--cds-surface-1:(#[0-9a-f]{6})/.exec(d)[1], dark, `${skin} dark page`)
    assert.equal(/--cds-surface-1:(#[0-9a-f]{6})/.exec(l)[1], light, `${skin} light page`)
    if (SIDEBARS[skin]) {
      assert.equal(/--cds-surface-0:(#[0-9a-f]{6})/.exec(d)[1], SIDEBARS[skin][0], `${skin} dark sidebar`)
      assert.equal(/--cds-surface-0:(#[0-9a-f]{6})/.exec(l)[1], SIDEBARS[skin][1], `${skin} light sidebar`)
    }
  }
})

test('the generator removes only its own earlier file names, never a file it did not make', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'skin-clean-'))
  mkdirSync(path.join(out, 'presets'))
  for (const n of ['catppuccin-auto', 'warm-dark', 'my-custom', 'constructor', 'dotcheck-test']) writeFileSync(path.join(out, 'presets', `${n}.css`), '')
  const r = sh('make-presets.mjs', ['--out', out])
  assert.equal(r.status, 0, r.stderr)
  const left = readdirSync(path.join(out, 'presets')).filter((n) => n.endsWith('.css')).map((n) => n.slice(0, -4))
  for (const gone of ['catppuccin-auto', 'warm-dark']) assert.ok(!left.includes(gone), gone)
  for (const kept of ['my-custom', 'constructor', 'dotcheck-test']) assert.ok(left.includes(kept), kept)
  assert.match(r.stdout, /WARNING: presets\/my-custom\.css is not one of the 16 skins/)
  rmSync(out, { recursive: true, force: true })
})

test('no preset or script name puts "claude" in a product or skin name', () => {
  for (const f of readdirSync(path.join(tool, 'presets'))) assert.ok(!/claude/i.test(f), f)
})

// The generated Raycast script must surface warnings and refusals, and find its own folder at run time.
test('raycast script: shows the warning, the note or the refusal, from any folder', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'skin-raycast-'))
  mkdirSync(path.join(base, 'skin-tool/raycast'), { recursive: true })
  mkdirSync(path.join(base, 'skin-tool/presets'))
  mkdirSync(path.join(base, 'bin'))
  const script = path.join(base, 'skin-tool/raycast/reskin-tokyo-night.sh')
  writeFileSync(script, readFileSync(path.join(tool, 'raycast/reskin-tokyo-night.sh'), 'utf8'))
  writeFileSync(path.join(base, 'skin-tool/presets/tokyo-night.css'), '')
  const fakeNode = (body) => { writeFileSync(path.join(base, 'bin/node'), `#!/bin/bash\n${body}\n`, { mode: 0o755 }) }
  const go = () => spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { PATH: `${path.join(base, 'bin')}:/usr/bin:/bin` } })
  fakeNode('echo "[1s] x"; echo "WARNING: inspect tab not seen"; echo "PORT_STATE: closed"; echo "RESULT: ok"; exit 0')
  assert.equal(go().stdout.trim(), 'WARNING: inspect tab not seen')
  fakeNode('echo "WARNING: inspect tab not seen"; echo "WARNING: port 9229 is STILL OPEN:"; echo "WARNING: something else"; echo "RESULT: failed"; exit 3')
  assert.match(go().stdout.trim(), /port 9229 is STILL OPEN/) // the port warning wins over the others
  fakeNode('echo "NOTE: this is a dark-mode skin"; echo "RESULT: ok"; exit 0')
  assert.equal(go().stdout.trim(), 'NOTE: this is a dark-mode skin')
  fakeNode('echo "Your own Chrome is open. Quit it first (Cmd-Q)."; echo "PORT_STATE: closed"; echo "RESULT: refused"; exit 5')
  const r = go()
  assert.equal(r.status, 1)
  assert.equal(r.stdout.trim(), 'Failed (exit 5): Your own Chrome is open. Quit it first (Cmd-Q).')
  rmSync(base, { recursive: true, force: true })
})

test('raycast dropdown: lists every pair and Off; off runs remove, a bad or unknown name never runs', () => {
  const src = readFileSync(path.join(tool, 'raycast/reskin.sh'), 'utf8')
  const data = JSON.parse(/"data": (\[.*\]) \}/.exec(src)[1])
  const values = data.map((o) => o.value)
  assert.equal(values[0], 'off')
  for (const f of readdirSync(path.join(tool, 'presets')).filter((n) => n.endsWith('.css'))) assert.ok(values.includes(f.slice(0, -4)), f)
  assert.equal(data.length, 17) // Off plus the 16 skins, each with both halves
  assert.equal(new Set(data.map((o) => o.title)).size, 17, 'titles are unique')
  assert.ok(!data.some((o) => /Github/.test(o.title)), 'GitHub spelling')
  const base = mkdtempSync(path.join(tmpdir(), 'skin-raycast2-'))
  mkdirSync(path.join(base, 'skin-tool/raycast'), { recursive: true })
  mkdirSync(path.join(base, 'skin-tool/presets'))
  mkdirSync(path.join(base, 'bin'))
  const script = path.join(base, 'skin-tool/raycast/reskin.sh')
  writeFileSync(script, src)
  writeFileSync(path.join(base, 'skin-tool/presets/dracula.css'), '')
  writeFileSync(path.join(base, 'bin/node'), `#!/bin/bash\necho "ARGS: $*" >> "${base}/calls"\necho "RESULT: ok"\nexit 0\n`, { mode: 0o755 })
  const go = (name) => spawnSync('/bin/bash', [script, name], { encoding: 'utf8', env: { PATH: `${path.join(base, 'bin')}:/usr/bin:/bin` } })
  // The colour helper is asked first; with a helper running, the debugger is never opened.
  assert.equal(go('off').status, 0)
  assert.deepEqual(readFileSync(path.join(base, 'calls'), 'utf8').trim().split('\n').map((l) => l.replace(/^ARGS: \S+ /, '')), ['switch remove'])
  rmSync(path.join(base, 'calls'))
  assert.equal(go('../x').status, 1)
  assert.equal(go('nosuchskin').status, 1)
  assert.ok(!existsSync(path.join(base, 'calls')), 'a bad or unknown name ran the script')
  assert.equal(go('dracula').status, 0)
  assert.deepEqual(readFileSync(path.join(base, 'calls'), 'utf8').trim().split('\n').map((l) => l.replace(/^ARGS: \S+ /, '')), ['switch dracula'])
  rmSync(path.join(base, 'calls'))
  // No helper: only then does it tick the menu itself (one-click), by preset name.
  writeFileSync(path.join(base, 'bin/node'), `#!/bin/bash\necho "ARGS: $*" >> "${base}/calls"\ncase "$2" in switch) echo "No colour helper is running in this Claude (no helper session), so nothing was changed."; echo "RESULT: refused"; exit 5;; esac\necho "RESULT: ok"\nexit 0\n`, { mode: 0o755 })
  assert.equal(go('dracula').status, 0)
  assert.deepEqual(readFileSync(path.join(base, 'calls'), 'utf8').trim().split('\n').map((l) => l.replace(/^ARGS: \S+ /, '')), ['switch dracula', 'one-click dracula'])
  rmSync(path.join(base, 'calls'))
  // An unconfirmed switch is reported; it is never followed by a tick.
  writeFileSync(path.join(base, 'bin/node'), `#!/bin/bash\necho "ARGS: $*" >> "${base}/calls"\necho "switch unconfirmed: the colour helper did not answer within 2 s."; echo "RESULT: failed"; exit 1\n`, { mode: 0o755 })
  assert.equal(go('dracula').status, 1)
  assert.deepEqual(readFileSync(path.join(base, 'calls'), 'utf8').trim().split('\n').map((l) => l.replace(/^ARGS: \S+ /, '')), ['switch dracula'])
  rmSync(base, { recursive: true, force: true })
})

test('make-presets refuses --muted-min into its own folder and a missing --out value', () => {
  const run = (a) => spawnSync(node, [path.join(tool, 'make-presets.mjs'), ...a], { encoding: 'utf8', cwd: tool })
  assert.notEqual(run(['--muted-min', '3', '--out', tool]).status, 0)
  assert.notEqual(run(['--muted-min', '3']).status, 0)
  assert.notEqual(run(['--out', '--muted-min', '3']).status, 0)
  assert.notEqual(run(['--muted-min', '9', '--out', mkdtempSync(path.join(tmpdir(), 'mp-'))]).status, 0)
})

test('generated raycast scripts contain no machine-specific path', () => {
  for (const f of readdirSync(path.join(tool, 'raycast'))) {
    const s = readFileSync(path.join(tool, 'raycast', f), 'utf8')
    assert.ok(!s.includes('/Users/'), `${f} has a /Users path`)
  }
})

test('regression: pgrep with a pattern that starts with dashes needs "--" (real command, read-only)', () => {
  const pattern = `--user-data-dir=/nonexistent-${randomUUID()}` // unique, so no other process can match it
  const without = spawnSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' })
  assert.equal(without.status, 2) // the bug: illegal option, which pgrepState reports as "unknown", never "none"
  assert.equal(pgrepState(without).state, 'unknown')
  const withDashes = spawnSync('/usr/bin/pgrep', ['-f', '--', pattern], { encoding: 'utf8' })
  assert.equal(pgrepState(withDashes).state, 'none')
})

test('the guardian: closes on unknown or open, stops only on a clean "nothing listening"', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'skin-guard-'))
  const fake = (name, body) => { const f = path.join(base, name); writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return f }
  const log = path.join(base, 'calls.log')
  const fakeNode = fake('node', `echo "close called" >> ${log}`)
  const run = (lsofBody) => {
    rmSync(log, { force: true })
    const lsof = fake('lsof', lsofBody)
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 0, gap: 0, tries: 2 }), fakeNode, '/ignored/skin.mjs'], { encoding: 'utf8', timeout: 20_000 })
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0
  }
  assert.equal(run('exit 1'), 0) // clean "nothing listening": no close attempt
  assert.equal(run('echo "Claude 1 user 22u IPv4 TCP *:9229 (LISTEN)"; exit 0'), 2) // open: tries every time
  assert.equal(run('echo "lsof: some error" >&2; exit 1'), 2) // exit 1 WITH output is unknown: keeps trying
  assert.equal(run('exit 2'), 2) // error exit: unknown, keeps trying
  assert.equal(run('sleep 0; exit 126'), 2) // cannot execute: unknown
  rmSync(base, { recursive: true, force: true })
})

test('skin.mjs verify checks Claude.app offline (exit 0 when the genuine app is installed)', (ctx) => {
  if (!existsSync('/Applications/Claude.app')) return ctx.skip('Claude.app is not installed here')
  const r = sh('skin.mjs', ['verify'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Claude signature OK/)
})

test('the guardian cannot be stalled by a command that hangs or ignores alarms', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'skin-guard-hang-'))
  const fake = (name, body) => { const f = path.join(base, name); writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return f }
  const log = path.join(base, 'calls.log')
  const fakeNode = fake('node', `echo "close called" >> ${log}`)
  const lsof = fake('lsof', 'trap "" ALRM; sleep 60') // ignores alarms and hangs
  const t0 = Date.now()
  spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 0, gap: 0, tries: 1, limit: 1 }), fakeNode, '/ignored/skin.mjs'], { encoding: 'utf8', timeout: 20_000 })
  assert.ok(Date.now() - t0 < 10_000, `the hanging lsof must be killed after the limit (took ${Date.now() - t0} ms)`)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1) // a killed lsof is "not sure": close was attempted
  rmSync(base, { recursive: true, force: true })
})

// Lesson from 11 Oct 2026: a newline escape inside a template literal broke the code sent into Claude, and no
// offline test noticed. Every code string that skin.mjs sends must at least be valid JavaScript.
test('the code strings skin.mjs sends into Claude are valid JavaScript', async () => {
  const { Script } = await import('node:vm')
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { setCode, SELFTEST, STATE, PROBE, IDENTIFY, ARM, CLOSE, THEME }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-syntax-'))
  const file = path.join(dir, 'skin-copy.mjs')
  writeFileSync(file, src)
  const m = await import(file)
  for (const [name, code] of Object.entries({ off: m.setCode(null), reset: m.setCode(null, true), apply: m.setCode('@media (prefers-color-scheme: dark) {}'), selftest: m.SELFTEST, state: m.STATE, probe: m.PROBE, identify: m.IDENTIFY, arm: m.ARM, close: m.CLOSE, theme: m.THEME })) {
    assert.doesNotThrow(() => new Script(code), name)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('skin.mjs inserts with author priority (user-priority sheets cannot be removed) and proves Off with a marker', () => {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')
  assert.ok(src.includes("cssOrigin: 'author'"))
  assert.ok(!src.includes("cssOrigin: 'user'"))
  assert.ok(src.includes('--reskin-active'))
})

// Runs the real code string that skin.mjs sends into Claude, against a fake Electron, so the apply / Off /
// reload-fallback logic is tested and not just parsed. Fake pages remember inserted sheets; a "broken" page
// accepts removeInsertedCSS and does nothing, which is exactly what Electron did live with user priority.
async function loadSkinCode() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { setCode }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-fake-'))
  const file = path.join(dir, 'skin-copy.mjs')
  writeFileSync(file, src)
  const m = await import(file)
  rmSync(dir, { recursive: true, force: true })
  return m.setCode
}

function fakeElectron(pages) {
  const listeners = new Map()
  const app = { on() {}, removeListener() {} }
  const make = ({ id, url, broken = false }) => {
    const page = { id, url, broken, sheets: new Map(), reloads: 0, next: 1, handlers: new Map() }
    return Object.assign(page, {
      getURL: () => page.url, isDestroyed: () => false,
      insertCSS: async (css, opts) => { const k = String(page.next++); page.sheets.set(k, { css, origin: opts.cssOrigin }); return k },
      removeInsertedCSS: async (k) => { if (!page.broken) page.sheets.delete(k) },
      executeJavaScriptInIsolatedWorld: async () => ([...page.sheets.values()].some((s) => s.css.includes('--reskin-active')) ? '1' : ''),
      reload: () => { page.reloads++; page.sheets.clear(); setTimeout(() => page.handlers.get('did-finish-load')?.forEach((f) => f()), 5) },
      on: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
      once: (e, f) => { page.handlers.set(e, [...(page.handlers.get(e) ?? []), f]) },
      removeListener: (e, f) => { page.handlers.set(e, (page.handlers.get(e) ?? []).filter((x) => x !== f)) },
    })
  }
  const list = pages.map(make)
  return { list, electron: { app, webContents: { getAllWebContents: () => list } } }
}

async function runInFake(code, electron) {
  const { createContext, runInContext } = await import('node:vm')
  // One context per fake app, like the one long-lived Claude process: the skin code keeps its state between runs.
  electron.ctx ??= createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, URL, Promise, setTimeout, clearTimeout, Map, Set, String, Error })
  return runInContext(code, electron.ctx)
}

test('the mode read is read-only and returns Claude\'s own dark flag', async () => {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { THEME }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-theme-'))
  writeFileSync(path.join(d, 'm.mjs'), src)
  const { THEME } = await import(path.join(d, 'm.mjs'))
  assert.equal(await runInFake(THEME, { nativeTheme: { shouldUseDarkColors: true } }), true)
  assert.equal(await runInFake(THEME, { nativeTheme: { shouldUseDarkColors: false } }), false)
})

test('the probe is read-only and keeps its report when the page script fails', async () => {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { PROBE }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-probe-'))
  writeFileSync(path.join(d, 'm.mjs'), src)
  const { PROBE } = await import(path.join(d, 'm.mjs'))
  const calls = []
  const page = { id: 7, getType: () => 'window', getURL: () => 'https://claude.ai/chat', executeJavaScriptInIsolatedWorld: async () => { throw new Error('page gone') },
    insertCSS: () => calls.push('insertCSS'), removeInsertedCSS: () => calls.push('removeInsertedCSS'), reload: () => calls.push('reload') }
  const out = await runInFake(PROBE, { nativeTheme: { themeSource: 'light', shouldUseDarkColors: false }, webContents: { getAllWebContents: () => [page] } })
  assert.deepEqual(JSON.parse(JSON.stringify(out[0])), { nativeTheme: { themeSource: 'light', shouldUseDarkColors: false } })
  assert.match(out[1].page.error, /page gone/)
  assert.deepEqual(calls, []) // nothing written
})

test('skin code: apply goes only into the Claude page, with author priority and the marker; Off removes it with no reload', async () => {
  const setCode = await loadSkinCode()
  const { list, electron } = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }, { id: 2, url: 'https://accounts.example.com/login' }])
  const css = '@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'
  const on = await runInFake(setCode(css), electron)
  assert.equal(on.errors.length, 0)
  assert.equal(list[0].sheets.size, 1)
  assert.equal([...list[0].sheets.values()][0].origin, 'author')
  assert.ok([...list[0].sheets.values()][0].css.includes('--reskin-active'))
  assert.equal(list[1].sheets.size, 0, 'a non-Claude window must not get the skin')
  const off = await runInFake(setCode(null), electron)
  assert.equal(list[0].sheets.size, 0)
  assert.equal(off.reloaded, 0)
  assert.equal(off.leftover, 0)
  assert.equal(off.errors.length, 0)
})

test('skin code: when removal silently does nothing, Off reloads the page and proves the marker is gone', async () => {
  const setCode = await loadSkinCode()
  const { list, electron } = fakeElectron([{ id: 1, url: 'https://claude.ai/chat', broken: true }])
  await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), electron)
  assert.equal(list[0].sheets.size, 1)
  const off = await runInFake(setCode(null), electron)
  assert.equal(list[0].reloads, 1)
  assert.equal(list[0].sheets.size, 0)
  assert.equal(off.reloaded, 1)
  assert.equal(off.leftover, 0)
  assert.equal(off.errors.length, 0)
})

test('skin code: reset reloads even without a marker, and an unfixable page is reported as a failure', async () => {
  const setCode = await loadSkinCode()
  const a = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }])
  a.list[0].sheets.set('9', { css: 'html { color: #ff0000 }', origin: 'user' }) // an old, marker-less sheet
  const reset = await runInFake(setCode(null, true), a.electron)
  assert.equal(a.list[0].reloads, 1)
  assert.equal(reset.errors.length, 0)
  // A page that keeps the marker even after a reload must be reported, never called "removed".
  const b = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }])
  b.list[0].reload = () => { b.list[0].reloads++ } // reload that changes nothing and never finishes loading
  await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), b.electron)
  b.list[0].removeInsertedCSS = async () => {}
  const off = await runInFake(setCode(null), b.electron)
  assert.equal(off.leftover, 1)
  assert.ok(off.errors.some((e) => /Cmd-R/.test(e)))
})

test('check-css refuses unbalanced brackets (they would swallow the skin marker)', () => {
  const css = (b) => { const f = path.join(mkdtempSync(path.join(tmpdir(), 'skin-css-')), 't.css'); writeFileSync(f, b); return f }
  assert.ok(!accepted(sh('skin.mjs', ['check-css', css('@media (prefers-color-scheme: dark) { html { color: rgb(1, 2 } }')])))
  assert.ok(!accepted(sh('skin.mjs', ['check-css', css('@media (prefers-color-scheme: dark) { html { color: #ff0000 ) } }')])))
  assert.ok(accepted(sh('skin.mjs', ['check-css', css('@media (prefers-color-scheme: dark) { html { --cds-x: rgba(1, 2, 3, 0.1) } }')])))
})

test('skin code: an unreadable marker is never "absent"; Off reports it, and apply is proven on every Claude page', async () => {
  const setCode = await loadSkinCode()
  // 1. Marker cannot be read at all: Off must fail loudly.
  const a = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }])
  await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), a.electron)
  a.list[0].executeJavaScriptInIsolatedWorld = async () => { throw new Error('page is gone') }
  const off = await runInFake(setCode(null), a.electron)
  assert.equal(off.unverified, 1)
  assert.ok(off.errors.some((e) => /could not confirm/.test(e) && /Cmd-R/.test(e)))
  // 2. Apply with no Claude page at all is an error, not a success.
  const b = fakeElectron([{ id: 2, url: 'https://accounts.example.com/login' }])
  const none = await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), b.electron)
  assert.equal(none.eligible, 0)
  assert.ok(none.errors.some((e) => /no Claude page/.test(e)))
  // 3. Apply where the marker never shows up (sheet accepted but not effective) is an error.
  const c = fakeElectron([{ id: 3, url: 'https://claude.ai/chat' }])
  c.list[0].executeJavaScriptInIsolatedWorld = async () => ''
  const bad = await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), c.electron)
  assert.equal(bad.applied, 0)
  assert.ok(bad.errors.some((e) => /did not show up/.test(e)))
  // 4. Normal apply reports eligible = applied.
  const d = fakeElectron([{ id: 4, url: 'https://claude.ai/chat' }])
  const good = await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), d.electron)
  assert.equal(good.eligible, 1)
  assert.equal(good.applied, 1)
  assert.equal(good.errors.length, 0)
})

test('skin code: an insert that finishes late, after a newer run, cleans up after itself', async () => {
  const setCode = await loadSkinCode()
  const { list, electron } = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }])
  const page = list[0]
  const realInsert = page.insertCSS
  page.insertCSS = async (css, opts) => { await new Promise((r) => setTimeout(r, 150)); return realInsert(css, opts) } // slow insert
  const first = runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), electron)
  await new Promise((r) => setTimeout(r, 20))
  const second = runInFake(setCode(null, true), electron) // a reset does not wait for queued inserts
  await Promise.all([first, second])
  await new Promise((r) => setTimeout(r, 300)) // let the slow insert land
  assert.equal(page.sheets.size, 0, 'the late sheet must not survive a reset that came after it')
})

test('the guardian ends only a leftover throwaway Chrome that is exactly ours (identity checked, /tmp profile only)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'skin-guard-sc-'))
  const fake = (name, body) => { const f = path.join(base, name); writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return f }
  const log = path.join(base, 'kill.log')
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const dir = '/tmp/claude-skin-chrome.AbC123'
  const pgrep = fake('pgrep', 'echo 111; echo 222; echo 333; echo 444')
  // 111 is ours; 222 only mentions the folder in another program's argument; 333 is a different Chrome profile; 444 is ours with the flag first.
  const ps = fake('ps', `case "$4" in 111) echo "${CHROME} --user-data-dir=${dir} --no-first-run";; 222) echo "/usr/bin/vim --user-data-dir=${dir}";; 333) echo "${CHROME} --user-data-dir=/Users/x/Library/Chrome";; 444) echo "${CHROME} --foo --user-data-dir=${dir}";; esac`)
  const kill = fake('kill', `echo "$@" >> ${log}`)
  const lsof = fake('lsof', 'exit 1') // port already closed
  const fakeNode = fake('node', 'true')
  let mainPid = '99999999' // no such process: the main run is gone
  const run = (dirArg) => {
    rmSync(log, { force: true })
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, pgrep, ps, kill, first: 0, gap: 0, tries: 1, finWait: 1 }), fakeNode, '/ignored/skin.mjs', dirArg, mainPid], { encoding: 'utf8', timeout: 20_000 })
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  }
  assert.deepEqual(run(dir), ['-TERM 111', '-TERM 444'])
  assert.deepEqual(run(''), [], 'no folder given: nothing is ended')
  assert.deepEqual(run('/Users/someone/Library/Chrome'), [], 'a folder that is not our throwaway one is never touched')
  mainPid = String(process.pid) // the main run is still alive (just slow): leave its Chrome alone
  assert.deepEqual(run(dir), [], 'a live main run is never interrupted by the guardian')
  rmSync(base, { recursive: true, force: true })
})

test('exit code 6 exists for a throwaway Chrome that could not be ended', async () => {
  const { EXIT } = await import(path.join(tool, 'skin-lib.mjs'))
  assert.equal(EXIT.sidecarLeft, 6)
})

test('skin code: a marker that fails once is retried; a failed removal of a late sheet is remembered and a later Off cleans it', async () => {
  const setCode = await loadSkinCode()
  // 1. Marker read fails the first time only: the retry must succeed, with no reload.
  const a = fakeElectron([{ id: 1, url: 'https://claude.ai/chat' }])
  await runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), a.electron)
  const real = a.list[0].executeJavaScriptInIsolatedWorld
  let calls = 0
  a.list[0].executeJavaScriptInIsolatedWorld = async (...args) => { if (calls++ === 0) throw new Error('page is navigating'); return real(...args) }
  const off = await runInFake(setCode(null), a.electron)
  assert.equal(off.errors.length, 0, off.errors.join('; '))
  assert.equal(off.unverified, 0)
  // 2. A late insert whose removal fails is kept in orphans, and a later Off removes it.
  const b = fakeElectron([{ id: 2, url: 'https://claude.ai/chat' }])
  const page = b.list[0]
  const realInsert = page.insertCSS, realRemove = page.removeInsertedCSS
  page.insertCSS = async (css, o) => { await new Promise((r) => setTimeout(r, 120)); return realInsert(css, o) }
  let failRemovals = true
  page.removeInsertedCSS = async (k) => { if (failRemovals) throw new Error('removal refused'); return realRemove(k) }
  const first = runInFake(setCode('@media (prefers-color-scheme: dark) { html { color: #ff0000 } }'), b.electron)
  await new Promise((r) => setTimeout(r, 20))
  const reset = runInFake(setCode(null, true), b.electron)
  await Promise.all([first, reset])
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(page.sheets.size, 1, 'the late sheet landed and could not be removed yet')
  failRemovals = false
  const finalOff = await runInFake(setCode(null), b.electron)
  assert.equal(page.sheets.size, 0, 'a later Off removes the remembered sheet')
  assert.equal(finalOff.leftover, 0)
})
