// Security fixes (16 Oct 2026): one test per fix, so breaking a fix fails here.
import { test } from 'node:test'
import { autoPath } from './one-click-copy.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardScript, socketOwner } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const SKIN = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')
const AUTO = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')

async function loadSkin() {
  const src = SKIN.replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { UNTICK, CLOSE }\n'
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19-'))
  writeFileSync(path.join(d, 'skin.mjs'), src)
  const m = await import(path.join(d, 'skin.mjs'))
  rmSync(d, { recursive: true, force: true })
  return m
}

// ---- A7: the kernel must show Claude holds the other end of our debugger connection ----

test('socketOwner: ok only when every connection of ours ends inside the checked process', () => {
  const r = (out, status = 0) => ({ status, out, err: '', failed: false })
  assert.deepEqual(socketOwner(r('p1\nf20\nn127.0.0.1:50001->127.0.0.1:9229\n'), r('p9\nf30\nn127.0.0.1:9229->127.0.0.1:50001\nf31\nn127.0.0.1:9229->127.0.0.1:50077\n')), { ok: true })
  assert.equal(socketOwner(r('p1\nn127.0.0.1:50001->127.0.0.1:9229\nn127.0.0.1:50002->127.0.0.1:9229\n'), r('p9\nn127.0.0.1:9229->127.0.0.1:50001\n')).ok, false, 'one connection ends elsewhere')
  assert.equal(socketOwner(r('', 1), r('p9\nn127.0.0.1:9229->127.0.0.1:50001\n')).ok, false, 'no connection of ours')
  assert.equal(socketOwner(r('p1\nn127.0.0.1:50001->127.0.0.1:9229\n'), r('', 1)).ok, false, 'Claude holds none')
  assert.equal(socketOwner({ failed: true }, r('')).ok, false, 'lsof failed')
  assert.equal(socketOwner(r('p1\nn127.0.0.1:50001->127.0.0.1:9229\n'), { status: 2, out: '', err: 'x', failed: false }).ok, false, 'lsof error')
})

test('socketOwner with the real lsof: the process that accepted our connection passes, any other fails', async () => {
  const child = spawn(node, ['-e', "const s=require('net').createServer(c=>c.on('data',()=>{}));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const port = Number(await new Promise((res) => child.stdout.once('data', (d) => res(String(d).trim()))))
    const sock = await new Promise((res, rej) => { const s = connect({ port, host: '127.0.0.1' }, () => res(s)); s.once('error', rej) })
    try {
      await new Promise((r) => setTimeout(r, 100))
      const ls = (pid) => { const x = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fn'], { encoding: 'utf8', timeout: 5_000 }); return { status: x.status, out: x.stdout, err: x.stderr, failed: x.error !== undefined } }
      assert.deepEqual(socketOwner(ls(process.pid), ls(child.pid), port), { ok: true })
      const other = spawn('/bin/sleep', ['5'])
      try { assert.equal(socketOwner(ls(process.pid), ls(other.pid), port).ok, false, 'a process that did not accept it') } finally { other.kill() }
    } finally { sock.destroy() }
  } finally { child.kill() }
})

test('skin.mjs checks the connection before it sends anything, on both paths', () => {
  const main = SKIN.slice(SKIN.indexOf('const owner = checkOwnerFast(claudePid)'))
  const check = main.indexOf('checkSocket(first.pid)')
  assert.ok(check > main.indexOf('conn = await connect(() => deadline)'), 'after the connection is made')
  assert.ok(check < main.indexOf('conn.evaluate(IDENTIFY)'), 'before the first expression')
  assert.equal([...main.matchAll(/conn\.evaluate\(/g)].filter((m) => m.index < check).length, 0, 'no evaluate before the check')
})

// ---- P9: the menu tick is cleared and checked ----

test('UNTICK clears the tick without clicking and says what it did; a missing item or an error is reported', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const { UNTICK } = await loadSkin()
  const run = (menu) => {
    const electron = { Menu: { getApplicationMenu: menu } }
    const ctx = createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, String })
    return runInContext(UNTICK, ctx)
  }
  let clicked = 0
  const item = { label: 'Enable Main Process Debugger', type: 'checkbox', checked: true, click: () => clicked++ }
  const r = run(() => ({ items: [{ label: 'Developer', submenu: { items: [{ label: 'Other', type: 'normal' }, item] } }] }))
  assert.deepEqual({ ...r }, { found: 1, ticked: 0 })
  assert.equal(item.checked, false)
  assert.equal(clicked, 0, 'never clicks')
  assert.deepEqual({ ...run(() => ({ items: [{ label: 'Développeur', submenu: { items: [] } }] })) }, { found: 0, ticked: 0 })
  assert.match(run(() => { throw new Error('no menu') }).error, /no menu/)
})

test('every close checks the untick, and the run warns not to click the item when it is not confirmed', () => {
  const stop = SKIN.slice(SKIN.indexOf('const stop = async () => {'), SKIN.indexOf('// A batch cut off by a signal'))
  const u = stop.indexOf('untick = await conn.evaluate(UNTICK')
  assert.ok(u >= 0 && u < stop.indexOf('conn.evaluate(CLOSE'), 'untick checked first')
  assert.match(stop, /untick\?\.found === 1 && untick\?\.ticked === 0/)
  assert.match(SKIN, /WARNING: the menu item Developer > Enable Main Process Debugger may still show a tick[\s\S]{0,200}Do not click it/)
})

// ---- A23: the throwaway Chrome has no debugging port of its own ----

test('the throwaway Chrome is started without a remote debugging port', () => {
  assert.doesNotMatch(AUTO, /'--remote-debugging-port/)
  assert.doesNotMatch(AUTO, /DevToolsActivePort/)
})

// ---- A cancelled one-click run never clicks or starts a guardian afterwards ----

test('one-click: a stop check sits right before every scripted click and every guardian start', () => {
  const lines = AUTO.split('\n')
  const near = (i) => lines.slice(Math.max(0, i - 3), i).some((l) => /if \(stopping\) refuse\(/.test(l))
  const clicks = lines.map((l, i) => (/const click = osa\(/.test(l) ? i : -1)).filter((i) => i >= 0)
  assert.equal(clicks.length, 2)
  for (const i of clicks) assert.ok(near(i), `click at line ${i + 1}`)
  const guards = lines.map((l, i) => (/^\s*guardian = spawn\('\/bin\/sh', \['-c', guardScript\((\)|\{ first: NO_CHROME|GUARD)/.test(l) || /guardian = spawn\('\/bin\/sh', \['-c', GUARD,/.test(l) ? i : -1)).filter((i) => i >= 0)
  assert.equal(guards.length, 2)
  for (const i of guards) assert.ok(lines.slice(Math.max(0, i - 3), i).some((l) => /if \(stopping\) refuse\(/.test(l)), `guardian at line ${i + 1}`)
  assert.ok(/if \(stopping\) refuse\([^\n]*\n\s*ticked = true \/\/ set BEFORE the prompt/.test(AUTO), 'tick mode: before the prompt')
})

// ---- Stylesheets: colours only; presets only ----

const check = (body) => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19css-'))
  const f = path.join(d, 't.css')
  writeFileSync(f, body)
  const r = spawnSync(node, [path.join(tool, 'skin.mjs'), 'check-css', f], { encoding: 'utf8', timeout: 10_000 })
  rmSync(d, { recursive: true, force: true })
  return r.status === 0 && /Stylesheet OK/.test(r.stdout)
}
const dark = (inner) => `@media (prefers-color-scheme: dark) { ${inner} }`

test('checkCss refuses anything that could hide, move, cover or relabel Claude, and accepts the presets\' own shapes', () => {
  for (const bad of [
    '.x { opacity: 0 }', '.x { display: none }', '.x { visibility: hidden }', '.x { pointer-events: none }', '.x { position: fixed }',
    '.x { transform: scale(0) }', '.x { content: x }', '.x { font-size: 0 }', '.x { --tw-scale-x: 0 }', '.x { --cds-a: 0 }',
    '.x { color: transparent }', '.x { color: rgba(1, 2, 3, 0.5) }', '.x { --cds-a: rgba(1, 2, 3, 0) }', '.x { --cds-a: rgba(1, 2, 3, 0.01) }',
    '.x { color: red }', '.x { --cds-a: var(--b) }', '.x { --cds-text: 210 49% 60% }', '.x { --cds-text-primary: #ffffff00 }', '.x { --cds-a: #fff0 }',
    'button { color: #fff }', '.x:hover { color: #fff }', '.x::before { color: #fff }', '[data-x] { color: #fff }', '.x > .y { color: #fff }',
    '.x:has(.y) { color: #fff }', '@supports (color: red) { .x { color: #fff } }', '.x { color: #fff } @media (min-width: 1px) { .y { color: #fff } }',
  ]) assert.ok(!check(dark(bad)), bad)
  assert.ok(!check(dark('.x { color: #fff }'.repeat(1200))), 'larger than 16 KB')
  for (const good of [
    '.text-primary, .text-text-100 { color: #f8f8f2 !important; }', '.dframe-sidebar, .dframe-sidebar * { --df-hover: #353747 !important; }',
    'html, body, .dframe-content { background-color: #282a36 !important; }', '*, *::before, *::after { --cds-border: rgba(248, 248, 242, 0.12) !important; }',
    ':root { --accent-100: 264.706 89.4737% 77.6471% !important; --cds-role-accent-fill: #bd93f9 }',
  ]) assert.ok(check(dark(good)), good)
  for (const f of ['dracula', 'catppuccin', 'tokyo-night', 'absolutely', 'vs']) assert.ok(check(readFileSync(path.join(tool, 'presets', `${f}.css`), 'utf8')), f)
})

test('skin-auto applies only the presets: another stylesheet is refused before anything starts; a path to a preset is fine', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19p-'))
  try {
    const own = path.join(d, 'nord.css')
    writeFileSync(own, readFileSync(path.join(tool, 'presets', 'nord.css'))) // a copy outside presets/ is not a preset
    const r = spawnSync(node, [autoPath(), 'tick', own, '--dry-run'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', SKIN_LOCK_PORT: String(42000 + Math.floor(Math.random() * 5000)) } })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Not one of Reskin's presets/)
    assert.match(r.stdout, /RESULT: refused/)
    symlinkSync(path.join(path.dirname(autoPath()), 'presets'), path.join(d, 'p'))
    const ok = spawnSync(node, [autoPath(), 'tick', path.join(d, 'p', 'nord.css'), '--dry-run'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', SKIN_LOCK_PORT: String(47000 + Math.floor(Math.random() * 500)) } })
    assert.doesNotMatch(ok.stdout + ok.stderr, /Not one of Reskin's presets/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- Batch screenshots: private, outside the project ----

test('batch pictures go to a private folder (700, files 600), never through a link, by default outside the project', async () => {
  const src = SKIN.replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href))
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19b-'))
  try {
    writeFileSync(path.join(d, 'skin.mjs'), src)
    const m = await import(path.join(d, 'skin.mjs'))
    assert.match(SKIN, /export function writeBatch\(report, root = path\.join\(STATE_DIR, 'previews'\)/)
    const report = () => ({ items: [{ n: 1, name: 'nord', mode: 'dark', status: 'applied', notes: [], shot: { window: Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64') } }], notes: [] })
    const folder = m.writeBatch(report(), path.join(d, 'previews'), new Date(2026, 9, 16, 1, 2, 3))
    assert.equal(lstatSync(path.join(d, 'previews')).mode & 0o777, 0o700)
    assert.equal(lstatSync(folder).mode & 0o777, 0o700)
    for (const f of ['report.json', 'index.html', '01-nord-dark.jpg']) assert.equal(lstatSync(path.join(folder, f)).mode & 0o777, 0o600, f)
    mkdirSync(path.join(d, 'elsewhere'))
    symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'linked'))
    assert.throws(() => m.writeBatch(report(), path.join(d, 'linked'), new Date()), /not a private folder/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- Guardians ----

test('the guardian still ends a leftover throwaway Chrome when the run was alive at its first pass and ends later', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'skin-c19g-'))
  try {
    const fake = (name, body) => { const f = path.join(base, name); writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return f }
    const log = path.join(base, 'kill.log')
    const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const dir = '/tmp/claude-skin-chrome.XyZ789'
    const pgrep = fake('pgrep', 'echo 111')
    const ps = fake('ps', `echo "${CHROME} --user-data-dir=${dir}"`)
    const kill = fake('kill', `echo "$@" >> ${log}`)
    const lsof = fake('lsof', 'exit 1') // port already closed
    // The main run: alive at the first pass, gone 2 s later. Not our own child (a child of a blocked test process would stay
    // a zombie, which still counts as alive), as the real run is not the guardian's.
    const mainPid = spawnSync('/bin/sh', ['-c', 'sleep 2 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()
    spawnSync('/bin/sh', ['-c', guardScript({ lsof, pgrep, ps, kill, first: 0, gap: 0, tries: 1, finWait: 10 }), fake('node', 'true'), '/x/skin.mjs', dir, mainPid], { encoding: 'utf8', timeout: 20_000 })
    assert.deepEqual(existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], ['-TERM 111'])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('Raycast asks the helper first and never passes a stylesheet path', () => {
  for (const f of ['reskin.sh', 'reskin-tokyo-night.sh']) {
    const s = readFileSync(path.join(tool, 'raycast', f), 'utf8')
    assert.ok(s.indexOf('skin-auto.mjs" switch "$SW"') < s.indexOf('skin-auto.mjs" one-click "$SW"'), f)
    assert.doesNotMatch(s, /presets\/\$NAME\.css" 2>&1/, f)
  }
})

test('the socket check looks twice before refusing (a finished HTTP connection may close between the two snapshots)', () => {
  const fn = SKIN.slice(SKIN.indexOf('async function checkSocket'), SKIN.indexOf('function checkSignature'))
  assert.match(fn, /for \(let i = 0; i < 2; i\+\+\)/)
  assert.match(fn, /if \(r\.ok\) return/)
  assert.match(fn, /throw new Error/)
})

test('guardian A stands down only for the run whose pid is in the private run mark and holds the lock port', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19y-'))
  try {
    const state = path.join(d, 'state')
    mkdirSync(state, { mode: 0o700 })
    const lsof = path.join(d, 'lsof')
    writeFileSync(lsof, `#!/bin/sh\ncase "$*" in *47619*) echo p4242; exit 0;; *) echo open; exit 0;; esac\n`, { mode: 0o755 })
    const close = path.join(d, 'close')
    writeFileSync(close, `#!/bin/sh\necho closed >> "${d}/closes"\n`, { mode: 0o755 })
    const closes = (dir = state) => {
      rmSync(path.join(d, 'closes'), { force: true })
      spawnSync('/bin/sh', ['-c', guardScript({ lsof, first: 0, gap: 0, tries: 1, limit: 3, yieldPort: 47619 }), close, 'x', '', '', dir], { encoding: 'utf8', timeout: 20_000 })
      return existsSync(path.join(d, 'closes'))
    }
    const mark = path.join(state, 'run-pid')
    writeFileSync(mark, '4242', { mode: 0o600 })
    assert.equal(closes(), false, 'the marked run holds the lock: stand down')
    assert.equal(closes(''), true, 'no folder given: never stands down')
    writeFileSync(mark, '999')
    assert.equal(closes(), true, 'the lock holder is not the marked run (a squatter)')
    rmSync(mark)
    assert.equal(closes(), true, 'no mark')
    writeFileSync(path.join(d, 'elsewhere'), '4242')
    symlinkSync(path.join(d, 'elsewhere'), mark)
    assert.equal(closes(), true, 'a mark that is a link')
    rmSync(mark)
    writeFileSync(mark, '42x42')
    assert.equal(closes(), true, 'a mark that is not a number')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('skin-auto marks the run while it holds the lock, clears its own mark at the end, and hands the folder to guardian A', () => {
  assert.match(AUTO, /if \(!lock\.ok\) refuse\(`Not started: \$\{lock\.reason\}\.`\)\n  markRun\(\)/)
  assert.ok(AUTO.indexOf("attempt('run mark', unmarkRun)") < AUTO.indexOf("attempt('lock', () => { void lock?.release?.() })"))
  assert.match(AUTO, /guardScript\(\{ first: TICK\.guardAFirstS, yieldPort: LOCK_PORT \}\), NODE, SKIN, '', String\(process\.pid\), STATE\]/)
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19m-'))
  try {
    const r = spawnSync(node, [autoPath(), 'tick', 'nord', '--dry-run'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: d, SKIN_LOCK_PORT: String(44000 + Math.floor(Math.random() * 3000)) } })
    assert.match(r.stdout, /RESULT:/)
    assert.ok(!existsSync(path.join(d, 'run-pid')), 'the mark is gone after the run')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('switch off or remove with no colour helper is refused, never reported as done', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'skin-c19n-'))
  try {
    for (const action of ['remove', 'off']) {
      const r = spawnSync(node, [autoPath(), 'switch', action], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: path.join(d, 'none'), SKIN_LOCK_PORT: String(43000 + Math.floor(Math.random() * 5000)) } })
      assert.equal(r.status, 5, action)
      assert.match(r.stdout, /RESULT: refused/, action)
      assert.match(r.stdout, /^No colour helper is running.*nothing was removed this way/m, action)
      assert.doesNotMatch(r.stdout, /already clean/, action)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ---- Final round ----

test('the untick warning also survives a signal, and every cleanup close passes it on', () => {
  assert.match(SKIN, /process\.once\(sig, \(\) => \{ shutdown \?\?= [^\n]*finally\(\(\) => stop\(\)\)\.finally\(\(\) => \{ const w = untickLine\(\); if \(w\) console\.log\(w\) \}\)\.finally\(\(\) => process\.exit\(130\)\)/)
  const close = AUTO.slice(AUTO.indexOf('const closeClaudePort = () => {'), AUTO.indexOf('// One cleanup for everyone'))
  assert.match(close, /startsWith\('WARNING: the menu item'\)/)
  assert.match(close, /if \(w\) console\.log\(w\)/)
})

test('a removal through the helper is reported as the helper\'s own word, never as checked', () => {
  const rm = AUTO.slice(AUTO.indexOf("if (action === 'remove') {"), AUTO.indexOf('const mode = ack.dark === true'))
  assert.match(rm, /as the helper itself reports \(no debugger was used to check it/)
  assert.match(rm, /'none \(as the helper reports\)'/)
  assert.doesNotMatch(rm, /'Skin and colour helper removed\. The next/)
})

test('a real batch needs --screenshots-ok (the pictures show the open chat); a dry run does not', () => {
  const r = spawnSync(node, [autoPath(), 'batch', 'nord'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, RESKIN_LOG: 'off', SKIN_LOCK_PORT: String(45000 + Math.floor(Math.random() * 3000)) } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /screenshots of the whole Claude window[\s\S]*--screenshots-ok/)
  assert.match(r.stdout, /RESULT: refused/)
  assert.ok(!r.stdout.includes('menu ticked'))
})
