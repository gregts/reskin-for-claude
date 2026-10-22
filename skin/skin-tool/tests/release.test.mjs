// Release switch (B1, 18 Oct 2026): the public package ships `tick` only, marked by release.json {"oneClick": false}.
// Runs a copy of the tool in a temporary folder with a temporary HOME, so nothing touches Claude, the real log or state.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tool = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const made = []
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

function copy(release) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reskin-release-'))
  made.push(d)
  for (const f of fs.readdirSync(tool)) if (/\.(mjs|sh)$/.test(f)) fs.copyFileSync(path.join(tool, f), path.join(d, f))
  fs.cpSync(path.join(tool, 'presets'), path.join(d, 'presets'), { recursive: true })
  fs.cpSync(path.join(tool, 'raycast'), path.join(d, 'raycast'), { recursive: true })
  if (release !== undefined) fs.writeFileSync(path.join(d, 'release.json'), release)
  const home = path.join(d, 'home')
  fs.mkdirSync(home)
  return { d, env: { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47693' } }
}
const run = (c, args) => spawnSync(process.execPath, [path.join(c.d, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 30_000, env: c.env })
const NOT_SHIPPED = /one-click is not in this release/

test('with oneClick false, every run that would tick the menu itself is refused before anything starts', () => {
  const c = copy('{"oneClick": false}\n')
  for (const args of [['one-click', 'nord'], ['nord'], ['one-click', 'remove'], ['remove'], ['batch', 'nord', '--dry-run'], ['menu-probe'], ['one-click', 'nord', '--dry-run']]) {
    const r = run(c, args)
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`)
    assert.match(r.stderr, NOT_SHIPPED, args.join(' '))
    assert.match(r.stdout, /PORT_STATE: unknown/)
  }
})

test('with oneClick false, tick, switch, status, check and --check each do their own job', () => {
  const c = copy('{"oneClick": false}')
  const env = { ...c.env, RESKIN_LOG: 'off' }
  const go = (args) => spawnSync(process.execPath, [path.join(c.d, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 30_000, env })
  let r = go(['switch', 'nord'])
  assert.equal(r.status, 5); assert.match(r.stdout, /^No colour helper is running/m)
  r = go(['status'])
  assert.equal(r.status, 0); assert.match(r.stdout, /^helper: none/m); assert.match(r.stdout, /RESULT: ok/)
  r = go(['check'])
  assert.equal(r.status, 0); assert.match(r.stdout, /^health: unknown \(no colour helper/m)
  r = go(['--check']) // read-only checks; may refuse on this Mac (Claude quit, Chrome open), which is its own answer
  assert.match(r.stdout, /Node: /); assert.ok([0, 5].includes(r.status), r.stdout + r.stderr)
  // Tick only: the user's own Chrome may stay open and no permission is asked for, so --check must not say otherwise.
  assert.doesNotMatch(r.stdout, /Your own Chrome is closed|one-click|throwaway|Accessibility for/)
  assert.match(r.stdout, /Help > Troubleshooting > Enable Developer Mode/)
  // tick is only parsed here (a bad name), so nothing waits for a click: the preset check answers, not the switch.
  r = go(['tick', 'Bad_Name'])
  assert.match(r.stderr, /Not one of Reskin's presets: Bad_Name/)
  for (const x of [r, go(['switch', 'nord']), go(['status'])]) assert.doesNotMatch(`${x.stdout}${x.stderr}`, NOT_SHIPPED)
})

test('only a file that reads cleanly with "oneClick": true allows one-click; anything else there counts as off', () => {
  assert.doesNotMatch(run(copy(undefined), ['one-click', 'Bad_Name']).stderr, NOT_SHIPPED) // no file: a development copy
  assert.doesNotMatch(run(copy('{"oneClick": true}'), ['one-click', 'Bad_Name']).stderr, NOT_SHIPPED)
  for (const text of ['{not json', '{}', '{"oneClick":"false"}', '{"oneClick":"true"}', '{"oneClick":null}', '{"oneClick":1}', 'null', '[]', '']) {
    assert.match(run(copy(text), ['one-click', 'nord']).stderr, NOT_SHIPPED, JSON.stringify(text))
  }
  const locked = copy('{"oneClick": true}')
  fs.chmodSync(path.join(locked.d, 'release.json'), 0o000) // cannot be read
  assert.match(run(locked, ['one-click', 'nord']).stderr, NOT_SHIPPED)
  const folder = copy(undefined)
  fs.mkdirSync(path.join(folder.d, 'release.json')) // there, but not a file
  assert.match(run(folder, ['one-click', 'nord']).stderr, NOT_SHIPPED)
  const broken = copy(undefined)
  fs.symlinkSync(path.join(broken.d, 'gone.json'), path.join(broken.d, 'release.json')) // a link to nothing
  assert.match(run(broken, ['one-click', 'nord']).stderr, NOT_SHIPPED)
})

test('Raycast never falls back to one-click when the release says oneClick false', () => {
  for (const f of ['reskin.sh', 'reskin-tokyo-night.sh']) {
    const s = fs.readFileSync(path.join(tool, 'raycast', f), 'utf8')
    const gate = s.indexOf('[ -e "$TOOL/release.json" ] && ! /usr/bin/grep -Eq \'"oneClick"[[:space:]]*:[[:space:]]*true\'')
    const fallback = s.indexOf('skin-auto.mjs" one-click')
    assert.ok(gate > 0 && fallback > gate, `${f}: the release check must come before the one-click fallback`)
  }
  // Live: no helper in the temporary state folder, so switch says so and the script stops with the /skin hint.
  const c = copy('{"oneClick": false}')
  const r = spawnSync('/bin/bash', [path.join(c.d, 'raycast', 'reskin.sh'), 'nord'], { encoding: 'utf8', timeout: 30_000, env: { ...c.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /run \/skin nord in Claude once/)
})
