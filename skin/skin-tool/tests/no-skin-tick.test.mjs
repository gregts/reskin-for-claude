// The no-skin tick (4 Nov 2026, design v2 to v4 in no-skin-tick-20261104/): `tick off [--want-font=] [--want-type=]`
// starts the colour helper only, then (debugger closed) the helper takes any skin off, a check must prove "no skin on",
// and the frozen PLAN runs, stopping at the first part that does not complete. Nothing here reaches a real tick: every
// command line run below is refused before its prompt, and every run that would get further is killed at READY_TO_TICK.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_BINARY, HELPER_GEN, TICK, buildPlan, judgeNoSkin, judgeOff, parsePs, planLine, runPlan } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const autoSrc = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
const skinSrc = readFileSync(path.join(tool, 'skin.mjs'), 'utf8')

const runIn = (dir, args) => {
  const home = mkdtempSync(path.join(tmpdir(), 'reskin-nst-home-'))
  try {
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47697', RESKIN_LOG: 'off' }
    return spawnSync(process.execPath, [path.join(dir, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 20_000, env })
  } finally { rmSync(home, { recursive: true, force: true }) }
}
// A copy of the tool, as the public package ships it (release.json) or as a development copy (none).
const copyOf = (release) => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-nst-copy-'))
  for (const f of readdirSync(tool)) if (/\.(mjs|sh|json)$/.test(f) && f !== 'release.json') copyFileSync(path.join(tool, f), path.join(d, f))
  cpSync(path.join(tool, 'presets'), path.join(d, 'presets'), { recursive: true })
  cpSync(path.join(tool, 'type'), path.join(d, 'type'), { recursive: true })
  if (release) writeFileSync(path.join(d, 'release.json'), JSON.stringify(release))
  return d
}

test('off is a tick target only: bare off, one-click off, batch off and off with --check are refused in both copies', () => {
  const pub = copyOf({ oneClick: false, font: true })
  const dev = copyOf(null)
  try {
    for (const [dir, label] of [[dev, 'development'], [pub, 'public']]) {
      for (const args of [['off'], ['one-click', 'off'], ['off', '--check'], ['--check', 'off'], ['batch', 'off', '--screenshots-ok'], ['batch', 'nord,off', '--dot-census'],
        ['tick', 'off', '--check'], ['tick', 'off', 'nord'], ['one-click', 'off', '--want-type=on'], ['off', '--want-type=on']]) {
        const r = runIn(dir, args)
        assert.notEqual(r.status, 0, `${label}: ${args.join(' ')}`)
        assert.doesNotMatch(r.stdout, /READY_TO_TICK|DISCLOSED|PLAN:/, `${label}: ${args.join(' ')} never reaches a prompt`)
        assert.match(r.stdout, /RESULT: refused/, `${label}: ${args.join(' ')}`)
      }
      // The development copy says why for off itself.
      if (dir === dev) {
        assert.match(runIn(dir, ['off']).stderr, /off goes with tick only/)
        assert.match(runIn(dir, ['one-click', 'off']).stderr, /off goes with tick only/)
      }
    }
  } finally { rmSync(pub, { recursive: true, force: true }); rmSync(dev, { recursive: true, force: true }) }
})

test('tick off: malformed or impossible parts are refused before the prompt; tick remove keeps its meaning', () => {
  for (const [args, re] of [
    [['tick', 'off', '--want-type=maybe'], /--want-type takes on or off/],
    [['tick', 'off', '--want-font=comic'], /No font called comic/],
    [['tick', 'off', '--want-font=plex-18'], /Sizes are 12 to 16/],
    [['tick', 'remove', '--want-type=on'], /go with a preset or off/],
  ]) {
    const r = runIn(tool, args)
    assert.notEqual(r.status, 0, args.join(' '))
    assert.match(r.stdout + r.stderr, re, args.join(' '))
    assert.doesNotMatch(r.stdout, /READY_TO_TICK/)
  }
  assert.match(autoSrc, /else if \(helperStart\) skinArgs = \['start'\]\nelse if \(\['remove', /, 'tick remove still goes to the remove step')
})

test('a copy without fonts refuses a font part on tick off before the prompt', () => {
  const d = copyOf({ oneClick: false })
  try {
    const r = runIn(d, ['tick', 'off', '--want-font=plex'])
    assert.notEqual(r.status, 0)
    assert.match(r.stdout + r.stderr, /Fonts are not in this release/)
    assert.doesNotMatch(r.stdout, /READY_TO_TICK/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('the start mode in Claude: only with --wait-open --quick, no stylesheet, and never a stylesheet applied inside', () => {
  for (const args of [['start'], ['start', '--quick'], ['start', '--wait-open'], ['start', 'presets/nord.css', '--wait-open', '--quick'], ['start', '--quick', '--no-helper', '--wait-open']]) {
    const r = spawnSync(process.execPath, [path.join(tool, 'skin.mjs'), ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`)
  }
  // Inside the window: the helper only (the same helperCode a skin tick installs), and the run fails if it did not start.
  const block = skinSrc.slice(skinSrc.indexOf('    if (startOnly) {\n      try { helper'), skinSrc.indexOf('    if (mode === \'remove\' || mode === \'reset\') try'))
  assert.match(block, /helperCode\(presets\.map, STATE_DIR, typeSheets\)/)
  assert.match(block, /if \(helper\?\.helper !== 'active'\) failure = /)
  assert.doesNotMatch(block, /setCode|st\.apply/)
  // Not a developer mode: the public copy runs it.
  assert.doesNotMatch(skinSrc, /\['probe', 'type-probe', 'menu-probe', 'state', 'selftest', 'reset', 'batch', 'start'\]/)
  // Its machine lines: DEFERRED_CHECKS only with an active helper.
  assert.match(skinSrc, /if \(startOnly\) \{\n\s+\/\/ Machine lines for skin-auto[^\n]*\n\s+if \(helper\?\.helper === 'active'\) console\.log\('DEFERRED_CHECKS'\)/)
})

test('the plan: asked parts first, then remembered ones; a remembered Off is not in it; no fonts in a copy without them', () => {
  const p = buildPlan({ wants: { type: 'on' }, prefs: { type: false, font: 'plex-14' }, fontShipped: true })
  assert.deepEqual(p.parts, [{ part: 'headers', value: true, asked: true }, { part: 'look', value: 'plex-14', asked: false }])
  assert.equal(p.skin, null); assert.equal(p.headers, true); assert.equal(p.look, 'plex-14')
  assert.equal(p.words, 'turns on the project headers and sets the fonts (Everything else: IBM Plex Sans; Chat text: the same font as everything else, 14px), as last time')
  const q = buildPlan({ wants: { font: 'off', type: 'off' }, prefs: { type: true, font: 'plex' } })
  assert.deepEqual(q.parts, [{ part: 'look', value: 'off', asked: true }, { part: 'headers', value: false, asked: true }], 'explicit Off choices are in the plan; the remembered ones they replace are not')
  assert.match(q.words, /keeps Claude's own fonts and keeps the project headers off/)
  assert.deepEqual(buildPlan({ wants: {}, prefs: { type: false, font: null } }).parts, [])
  assert.deepEqual(buildPlan({ wants: {}, prefs: { type: true, font: 'plex' }, fontShipped: false }).parts, [{ part: 'headers', value: true, asked: false }])
  assert.deepEqual(buildPlan({ wants: {}, prefs: { type: true, font: 'plex' } }).parts.map((x) => x.part), ['headers', 'look'])
  const line = planLine(p)
  assert.match(line, /^PLAN: \{"skin":null,"headers":true,"look":"plex-14","parts":\[/)
  assert.deepEqual(JSON.parse(line.slice('PLAN: '.length)), p)
})

test('the plan is computed once before the prompt, printed after Ready. and before READY_TO_TICK, and that same object is run', () => {
  const at = (s) => { const i = autoSrc.indexOf(s); assert.ok(i > 0, s); return i }
  const build = at("if (helperStart) plan = buildPlan({ wants, prefs: readPrefs(nodeFs, STATE), fontShipped })")
  const ready = at("    'Ready. Before you tick, so nothing surprises you:',")
  const planOut = at('  if (helperStart) console.log(planLine(plan))')
  const prompt = at("  console.log('READY_TO_TICK') // the /skin mod")
  assert.ok(build < ready && ready < planOut && planOut < prompt, 'plan built, then Ready., then PLAN, then READY_TO_TICK')
  assert.equal([...autoSrc.matchAll(/buildPlan\(/g)].length, 1, 'built in one place only')
  assert.match(autoSrc, /const r = await runPlan\(plan, \{/, 'the frozen plan is what runs (never re-read from prefs)')
  // The disclosure for a helper start: skin taken off, a reload, the plan's words, and the helper line for every tick.
  assert.match(autoSrc, /'- This starts the colour helper only\. No skin is put on\. Any Reskin skin is taken off\. A Claude page may reload once\.'/)
  assert.match(autoSrc, /helperStart && plan\.parts\.length > 0 \? `- It also \$\{plan\.words\}\.` : null/)
  assert.match(autoSrc, /skinArgs\[0\] === 'apply' \|\| skinArgs\[0\] === 'start' \? `- \$\{HELPER_STAYS\}` : null/)
  assert.match(autoSrc, /It can only switch between Reskin\\'s own presets, fonts and headers, turn them off, or remove itself; the next change needs no tick\./)
})

// ---- After the close: off, then the check ----
const page = (marker = false) => ({ marker, scheme: 'dark', anchors: {}, parts: {} })
const checkAck = (pages, more = {}) => ({ action: 'check', phase: 'done', ok: true, current: 'off', digest: null, sample: { stable: true, pages }, version: '4.16336.0', ...more })
test('the off answer: only a done, ok answer to off counts', () => {
  assert.equal(judgeOff({ action: 'off', phase: 'done', ok: true, errors: [] }).ok, true)
  assert.equal(judgeOff(null).ok, false)
  assert.equal(judgeOff({ action: 'nord', phase: 'done', ok: true }).ok, false)
  assert.equal(judgeOff({ action: 'off', phase: 'accepted', ok: true }).ok, false)
  const f = judgeOff({ action: 'off', phase: 'done', ok: false, errors: ['a page could not be reached'] })
  assert.equal(f.ok, false); assert.match(f.why, /could not take the skin off: a page could not be reached/)
})
test('no skin on: only a stable check with readable pages and no marker; zero, unreadable, mixed or changing pages are not confirmed', () => {
  assert.equal(judgeNoSkin(checkAck([page(), page()])).ok, true)
  assert.equal(judgeNoSkin(checkAck([])).ok, false, 'zero pages')
  assert.match(judgeNoSkin(checkAck([])).why, /no Claude window/)
  assert.equal(judgeNoSkin(checkAck([{ error: 'gone' }])).ok, false, 'unreadable page')
  assert.equal(judgeNoSkin(checkAck([page(), { error: 'gone' }])).ok, false, 'mixed readable and unreadable')
  assert.equal(judgeNoSkin(checkAck([page()], { sample: { stable: false, pages: [page()] } })).ok, false, 'unstable')
  assert.equal(judgeNoSkin(checkAck([page(), page(true)])).ok, false, 'a marker still on')
  assert.equal(judgeNoSkin(checkAck([page()], { current: 'nord' })).ok, false, 'a skin on')
  assert.equal(judgeNoSkin(checkAck([page()], { ok: false })).ok, false)
  assert.equal(judgeNoSkin(null).ok, false, 'no answer')
  assert.equal(judgeNoSkin({ ...checkAck([page()]), action: 'off' }).ok, false, 'an answer to another request')
})
test('wiring after the close: off, then check, then the plan; any failure stops the run with no second tick', () => {
  const fn = autoSrc.slice(autoSrc.indexOf('async function startChecks()'), autoSrc.indexOf('// The frozen plan, part by part'))
  const iOff = fn.indexOf("report.session, 'off'"), iJudgeOff = fn.indexOf('judgeOff(off)'), iCheck = fn.indexOf("report.session, 'check'"), iNoSkin = fn.indexOf('judgeNoSkin(')
  assert.ok(iOff > 0 && iOff < iJudgeOff && iJudgeOff < iCheck && iCheck < iNoSkin, 'off, its answer judged, then the check, then its verdict')
  assert.ok(fn.indexOf('savePrefs(null)') > iNoSkin, 'no skin is remembered only after the confirmed check')
  assert.match(fn, /live\.session\.session !== report\.session/, 'the exact helper this run started')
  assert.match(autoSrc, /if \(skinOk && report\.deferred && \(await startChecks\(\)\) === 'ok'\) \{ if \(!\(await startPlan\(\)\)\) skinOk = false \}/)
  assert.doesNotMatch(fn, /tickRun|startTickChild|READY_TO_TICK/)
})

// ---- The plan run: stop at the first part that does not complete ----
const ack = (action, ok, verified, extra = {}) => ({ action, ok, verified, ...extra })
const run = (plan, answers, more = {}) => {
  const sent = []
  return runPlan(plan, {
    caps: ['check', 'type', 'font'], fonts: { includes: (k) => ['plex', 'plex-14', 'lato'].includes(k) }, installed: () => 'yes',
    waits: { want: 30_000, restore: 12_000 }, prefs: { type: true, font: 'lato' },
    send: async (action, waitMs) => { sent.push(`${action}@${waitMs}`); return answers[action] ?? null },
    ...more,
  }).then((r) => ({ ...r, sent }))
}
test('the plan run: every part done and proven is ok and saved; asked parts get the full wait', async () => {
  const plan = buildPlan({ wants: { font: 'plex-14' }, prefs: { type: true, font: 'lato' } })
  const r = await run(plan, { 'font-plex-14': ack('font-plex-14', true, { headers: false, font: 'plex-14' }), 'type-on': ack('type-on', true, { headers: true, font: 'plex-14' }) })
  assert.deepEqual(r.sent, ['font-plex-14@30000', 'type-on@12000'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines, ['part: font plex 14px: done (no second tick; as the colour helper reports)', 'part: type on: done (no second tick; as the colour helper reports) [remembered]'])
  assert.deepEqual(r.save, { headers: true, font: 'plex-14' })
})
test('the plan run: a failed REMEMBERED part stops it (the skin-tick restore would go on); the run fails', async () => {
  const plan = buildPlan({ wants: {}, prefs: { type: true, font: 'lato' } })
  const r = await run(plan, { 'type-on': ack('type-on', false, { headers: false, font: null }, { errors: ['apply failed'] }), 'font-lato': ack('font-lato', true, { headers: false, font: 'lato' }) })
  assert.deepEqual(r.sent, ['type-on@12000'], 'the font after it is not sent')
  assert.equal(r.ok, false)
  assert.match(r.lines.at(-1), /^part: the colour helper is on, but type on did not complete\. Not tried: font lato\. No skin was put on\.$/)
  assert.ok(r.lines.some((l) => /^part: font lato: not tried/.test(l)))
  assert.deepEqual(r.save, { headers: true, font: 'lato' }, 'what did not come back stays remembered')
})
test('the plan run: font answered, then headers silent: the font is not proven now, nothing is saved, nothing more sent', async () => {
  const plan = buildPlan({ wants: { font: 'plex', type: 'on' }, prefs: { type: false, font: null } })
  const r = await run(plan, { 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }) })
  assert.deepEqual(r.sent, ['font-plex@30000', 'type-on@30000'])
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], 'part: font plex: done, but not proven now: run /skin check')
  assert.match(r.lines[1], /^part: type on: unconfirmed, the colour helper did not answer within 30 s/)
  assert.match(r.lines.at(-1), /what is on now is not proven \(run \/skin check\)/)
  assert.equal(r.save, null, 'prefs untouched by this run\'s parts')
  // The same with the headers remembered rather than asked.
  const q = await run(buildPlan({ wants: { font: 'plex' }, prefs: { type: true, font: null } }), { 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }) })
  assert.equal(q.ok, false); assert.equal(q.save, null); assert.equal(q.lines[0], 'part: font plex: done, but not proven now: run /skin check')
})
test('the plan run: a later failure whose cleanup took the earlier part off says so; a part the helper does not offer is not sent', async () => {
  const plan = buildPlan({ wants: { font: 'plex', type: 'on' } })
  const r = await run(plan, { 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }), 'type-on': ack('type-on', false, { headers: false, font: null }, { errors: ['x'] }) })
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], 'part: font plex: done, then taken off again when a later step failed')
  const n = await run(buildPlan({ wants: { font: 'noto' } }), {})
  assert.deepEqual(n.sent, [])
  assert.equal(n.ok, false)
  assert.match(n.lines[0], /^part: font noto: did not complete: that font is not available in this colour helper/)
  const i = await run(buildPlan({ wants: { font: 'plex' } }), {}, { installed: () => 'no' })
  assert.deepEqual(i.sent, []); assert.equal(i.ok, false)
  const t = await run(buildPlan({ wants: { type: 'on' } }), {}, { caps: ['check'] })
  assert.deepEqual(t.sent, []); assert.match(t.lines[0], /type is not available/)
  const e = await run(buildPlan({}), {})
  assert.deepEqual([e.ok, e.sent, e.lines, e.save], [true, [], [], null], 'an empty plan sends nothing')
})

test('run limits: the no-skin tick adds the check wait and stays inside the mod\'s allowances', () => {
  assert.equal(TICK.runLimitStartMs, TICK.runLimitMs + TICK.checkMs)
  assert.equal(TICK.runLimitStartWantsMs, TICK.runLimitWantsMs + TICK.checkMs)
  assert.ok(TICK.runLimitStartMs + 10_000 <= 200_000)
  assert.ok(TICK.runLimitStartWantsMs + 10_000 <= 235_000)
  assert.match(autoSrc, /helperStart \? \(hasWants \? TICK\.runLimitStartWantsMs : TICK\.runLimitStartMs\)/)
})

// ---- Under the lock: an existing helper decides, before any prompt (design v4) ----
async function claudeProc() {
  const ps = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
  const line = ps.stdout.split('\n').find((l) => l.trim().endsWith(CLAUDE_BINARY))
  if (!line) return null
  const pid = Number(line.trim().split(/\s+/)[0])
  return { pid, startMs: parsePs(spawnSync('/bin/ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).startMs }
}
// Runs the tool; if it ever reached the prompt it is stopped at once (a sabotaged gate must not leave a run waiting).
function cliStop(dir, ...args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [path.join(tool, 'skin-auto.mjs'), ...args], { env: { ...process.env, RESKIN_LOG: 'off', RESKIN_STATE_DIR: dir, SKIN_LOCK_PORT: '47698' } })
    let out = ''
    const look = (d) => { out += d; if (/READY_TO_TICK|CHILD_READY/.test(out)) p.kill('SIGINT') }
    p.stdout.on('data', look); p.stderr.on('data', look)
    p.on('close', (code) => res({ code, out }))
  })
}
test('tick off with a current helper: refused before any prompt, nothing sent; outdated and unknown refuse as before', async (t) => {
  const claude = await claudeProc()
  if (!claude) return t.skip('Claude is not running on this Mac')
  const dir = mkdtempSync(path.join(tmpdir(), 'reskin-nst-live-'))
  try {
    chmodSync(dir, 0o700)
    const session = (gen) => writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, session: randomUUID(), pid: claude.pid, boot: claude.startMs, version: '9.9.9', gen, caps: ['check', 'type', 'font', 'look'] }), { mode: 0o600 })
    session(HELPER_GEN)
    for (const args of [['tick', 'off'], ['tick', 'off', '--want-type=on'], ['tick', 'off', '--want-font=plex']]) {
      const r = await cliStop(dir, ...args)
      assert.equal(r.code, 5, `${args.join(' ')}: ${r.out}`)
      assert.match(r.out, /A colour helper is already running, so no tick is needed\. Use \/skin type on, \/skin font <name> or \/skin fonts \(without --tick\)\. Nothing was changed\./)
      assert.doesNotMatch(r.out, /READY_TO_TICK|PLAN:/)
      assert.ok(!existsSync(path.join(dir, 'request.json')), 'no request was written to the helper')
    }
    session(HELPER_GEN - 1)
    const old = await cliStop(dir, 'tick', 'off')
    assert.notEqual(old.code, 0); assert.match(old.out, /Quit and reopen Claude once/); assert.doesNotMatch(old.out, /READY_TO_TICK/)
    chmodSync(path.join(dir, 'session.json'), 0o644)
    const unk = await cliStop(dir, 'tick', 'off')
    assert.notEqual(unk.code, 0); assert.match(unk.out, /Could not tell whether a colour helper is already running/); assert.doesNotMatch(unk.out, /READY_TO_TICK/)
    assert.ok(!existsSync(path.join(dir, 'request.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('the active refusal is decided in main(), under the run lock, after the outdated and unknown guards', () => {
  const m = autoSrc.slice(autoSrc.indexOf('async function main()'), autoSrc.indexOf('  if (tickMode) return tickRun()'))
  const lock = m.indexOf('lock = await acquireLock()'), outdated = m.indexOf("live.state === 'outdated'"), active = m.indexOf("helperStart && live.state === 'active'")
  assert.ok(lock > 0 && lock < outdated && outdated < active, 'lock, then the existing guards, then the new one')
})
