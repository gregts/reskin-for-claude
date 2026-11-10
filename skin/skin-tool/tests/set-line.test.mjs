// The one-line command (3 Nov 2026): `set [<preset>|off] [font <name>|off] [type on|off]` through the colour helper, and
// `tick <preset> --want-font=... --want-type=...` when there is none. The parser, the ordered steps with their report,
// and the refusals that come before anything starts. Nothing here talks to a real Claude: every run below uses a private
// temporary state folder, and every tick line tested is one the tool refuses before its prompt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_KEYS, FONT_SIZES, LOOK_PARTS, TICK, fontLines, parseSetLine, restoreParts, runSetParts, slotPairOk } from '../skin-lib.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const isPreset = (n) => existsSync(path.join(tool, 'presets', `${n}.css`))
const parse = (line, fonts = true) => parseSetLine(line.split(' '), { isPreset, fonts })
const refuses = (line, re, fonts = true) => assert.throws(() => parse(line, fonts), re, line)

test('the line: skin first, then font and type in either order, each once; full family names work', () => {
  assert.deepEqual(parse('dracula font plex type on'), { skin: 'dracula', font: { name: 'plex', size: null }, type: true })
  assert.deepEqual(parse('dracula type off font plex'), { skin: 'dracula', font: { name: 'plex', size: null }, type: false })
  assert.deepEqual(parse('font ibm plex sans type on'), { skin: null, font: { name: 'plex', size: null }, type: true })
  assert.deepEqual(parse('font Zen Maru Gothic'), { skin: null, font: { name: 'zen-maru', size: null }, type: undefined })
  assert.deepEqual(parse('nord type off'), { skin: 'nord', font: undefined, type: false })
  assert.deepEqual(parse('off font off type off'), { skin: 'off', font: 'off', type: false })
  assert.deepEqual(parse('font off type off'), { skin: null, font: 'off', type: false }, 'font off then a type part is fine')
  assert.deepEqual(parse('DRACULA FONT Inter'), { skin: 'dracula', font: { name: 'inter-tight', size: null }, type: undefined }, 'inter quietly means Inter Tight')
  assert.deepEqual(parse('dracula'), { skin: 'dracula', font: undefined, type: undefined })
})

test('the line: every malformed part is refused with its own reason, before anything is sent', () => {
  refuses('', /Use: \/skin/)
  refuses('comic font plex', /No skin called comic/)
  refuses('font plex dracula', /No font called plex dracula/)
  refuses('font plex type on dracula', /Put the skin name first/)
  refuses('font plex type on off', /Put the skin name first/)
  refuses('dracula font plex font lato', /font is given twice/)
  refuses('dracula type on type off', /type is given twice/)
  refuses('dracula type', /type takes on or off/)
  refuses('dracula type maybe', /type takes on or off/)
  refuses('dracula font', /font needs a name/)
  refuses('dracula font type on', /font needs a name/)
  refuses('dracula font off 14', /font off takes nothing after it/)
  refuses('dracula font list', /font list goes on its own/)
  refuses('dracula font comic sans', /No font called comic sans/)
  refuses('dracula font __proto__', /No font called/)
  refuses('dracula banana', /I did not understand banana/)
  refuses('remove font off', /remove takes everything off; use it on its own/)
  refuses('dracula font plex check', /check goes on its own/)
  refuses('status type on', /status goes on its own/)
  refuses('dracula font plex', /Fonts are not in this release/, false)
  assert.deepEqual(parse('dracula type on', false), { skin: 'dracula', font: undefined, type: true }, 'type works in a copy without fonts')
})

test('sizes: exact table strings only, never coerced, and only after a font name', () => {
  assert.deepEqual(FONT_SIZES, [12, 13, 14, 15, 16])
  assert.deepEqual(parse('dracula font plex 14'), { skin: 'dracula', font: { name: 'plex', size: 14 }, type: undefined })
  assert.deepEqual(parse('type on font ibm plex sans 12'), { skin: null, font: { name: 'plex', size: 12 }, type: true })
  assert.deepEqual(parse('font inter 13'), { skin: null, font: { name: 'inter-tight', size: 13 }, type: undefined })
  assert.deepEqual(parse('font zen maru gothic 13 type off'), { skin: null, font: { name: 'zen-maru', size: 13 }, type: false })
  for (const bad of ['012', '014', '11', '17', '18', '0', '140']) refuses(`font plex ${bad} type on`, /Sizes are 12 to 16/)
  refuses('font plex 14px', /No font called plex 14px/)
  refuses('font plex 1e1', /No font called plex 1e1/)
  refuses('font 14', /No font called 14/)
  refuses('font off 14', /font off takes nothing after it/)
  // One parser for every path: a joined key means the same as two words; signs and doubled dashes are refused.
  assert.deepEqual(parse('dracula font plex-16'), parse('dracula font plex 16'))
  assert.deepEqual(parse('font zen-maru-15 type on'), { skin: null, font: { name: 'zen-maru', size: 15 }, type: true })
  refuses('font plex -16', /Not a font and size/)
  refuses('font plex--16', /Not a font and size/)
  refuses('font plex +16', /No font called plex \+16|Not a font and size/)
  refuses('font plex 16 16', /Not a font and size|No font called/)
})

// ---- The ordered steps and their report ----
const ack = (action, ok, verified, extra = {}) => ({ action, ok, verified, ...extra })
const steps = (answers) => {
  const sent = []
  return {
    sent,
    deps: {
      colour: async (skin) => { sent.push(skin); const a = answers[skin]; return a === undefined ? null : a },
      slot: async (action) => { sent.push(action); const a = answers[action]; return a === undefined ? null : a },
      colourWaitS: 10, slotWaitS: 30,
    },
  }
}
const both = { headers: true, font: 'plex' }

test('steps: skin, then font, then type, each once; all proven is ok', async () => {
  const s = steps({ dracula: { ok: true, lines: ['Skin dracula applied by the colour helper.', 'sampled colour checks: 4 of 4 passed'] }, 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }), 'type-on': ack('type-on', true, both) })
  const r = await runSetParts(parse('dracula type on font plex'), s.deps)
  assert.deepEqual(s.sent, ['dracula', 'font-plex', 'type-on'], 'font before type whatever the order typed')
  assert.equal(r.failed, false)
  assert.deepEqual(r.final, both)
  assert.deepEqual(r.out, ['skin dracula: Skin dracula applied by the colour helper.', 'sampled colour checks: 4 of 4 passed', 'font plex: done', 'type on: done'])
})

test('steps: a failed skin stops the line; the font and type are not tried', async () => {
  const s = steps({ dracula: { ok: false, lines: ['The helper could not apply it: x', 'sampled colour checks: n/a'] } })
  const r = await runSetParts(parse('dracula font plex type on'), s.deps)
  assert.deepEqual(s.sent, ['dracula'])
  assert.equal(r.failed, true)
  assert.equal(r.final, null)
  assert.match(r.out.join('\n'), /font plex: not tried/)
  assert.match(r.out.join('\n'), /type on: not tried/)
})

test('steps: an unanswered skin switch also stops the line', async () => {
  const s = steps({})
  const r = await runSetParts(parse('dracula type on'), s.deps)
  assert.deepEqual(s.sent, ['dracula'])
  assert.match(r.out[0], /skin dracula: unconfirmed, the colour helper did not answer within 10 s/)
  assert.match(r.out[1], /type on: not tried/)
})

test('steps: an unanswered font change stops the line and nothing is called proven afterwards', async () => {
  const s = steps({ dracula: { ok: true, lines: ['ok', 'checks'] } })
  const r = await runSetParts(parse('dracula font plex type on'), s.deps)
  assert.deepEqual(s.sent, ['dracula', 'font-plex'])
  assert.equal(r.failed, true)
  assert.equal(r.final, null)
  assert.match(r.out.join('\n'), /font plex: unconfirmed, the colour helper did not answer within 30 s/)
  assert.match(r.out.join('\n'), /type on: not tried/)
})

test('steps: a later failure whose cleanup emptied the slot reports the earlier part as taken off again', async () => {
  const s = steps({ 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }), 'type-on': ack('type-on', false, { headers: false, font: null }, { errors: ['apply failed on 1 page'], partial: true }) })
  const r = await runSetParts(parse('font plex type on'), s.deps)
  assert.equal(r.failed, true)
  assert.deepEqual(r.final, { headers: false, font: null }, 'the final pair is the last proven one')
  assert.deepEqual(r.out, ['font plex: done, then taken off again when a later step failed', 'type on: did not complete: apply failed on 1 page. Part of it was undone again.'])
})

test('steps: a later answer with an unproven pair leaves the earlier part not proven', async () => {
  const s = steps({ 'font-off': ack('font-off', true, { headers: true, font: null }), 'type-off': ack('type-off', true, 'unknown') })
  const r = await runSetParts(parse('font off type off'), s.deps)
  assert.equal(r.failed, true)
  assert.equal(r.final, null)
  assert.match(r.out[0], /font off: done, but not proven now: run \/skin check/)
})

test('steps: off parts are sent as such and judged from the final pair', async () => {
  const s = steps({ off: { ok: true, lines: ['Skin off.', 'n/a'] }, 'font-off': ack('font-off', true, { headers: true, font: null }), 'type-off': ack('type-off', true, { headers: false, font: null }) })
  const r = await runSetParts(parse('off font off type off'), s.deps)
  assert.deepEqual(s.sent, ['off', 'font-off', 'type-off'])
  assert.equal(r.failed, false)
  assert.deepEqual(r.out.slice(2), ['font off: done', 'type off: done'])
})

// ---- Through skin-auto, with a private empty state folder (no helper), so nothing reaches Claude ----
const runIn = (dir, args) => {
  const home = mkdtempSync(path.join(tmpdir(), 'reskin-set-home-'))
  try {
    const env = { ...process.env, HOME: home, RESKIN_STATE_DIR: path.join(home, 'state'), SKIN_LOCK_PORT: '47695', RESKIN_LOG: 'off' }
    return spawnSync(process.execPath, [path.join(dir, 'skin-auto.mjs'), ...args], { encoding: 'utf8', timeout: 20_000, env })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('set with no helper: refused before anything is sent, with the words /skin needs to fall back to a tick', () => {
  const r = runIn(tool, ['set', 'dracula', 'font', 'plex', 'type', 'on'])
  assert.equal(r.status, 5, r.stdout + r.stderr)
  assert.match(r.stdout, /No colour helper is running/)
  assert.match(r.stdout, /tick dracula --want-font=plex --want-type=on/)
  const off = runIn(tool, ['set', 'off', 'type', 'on'])
  assert.equal(off.status, 5)
  assert.match(off.stdout, /Turning colours off while setting a font or type needs a running colour helper/)
  const sized = runIn(tool, ['set', 'dracula', 'font', 'plex', '14'])
  assert.equal(sized.status, 5, sized.stdout + sized.stderr)
  assert.match(sized.stdout, /tick dracula --want-font=plex-14/)
  const joined = runIn(tool, ['set', 'dracula', 'font', 'plex-14'])
  assert.equal(joined.status, 5, joined.stdout + joined.stderr)
  assert.match(joined.stdout, /tick dracula --want-font=plex-14/)
  const bad = runIn(tool, ['set', 'dracula', 'font', 'plex', '20'])
  assert.equal(bad.status, 2)
  assert.match(bad.stdout, /Sizes are 12 to 16/)
  const opt = runIn(tool, ['set', 'dracula', 'type', 'on', '--tick'])
  assert.equal(opt.status, 2)
  assert.match(opt.stdout, /set takes no options/)
})

test('tick with font and type parts: malformed or impossible parts are refused before the prompt', () => {
  const cases = [
    [['tick', 'dracula', '--want-font=comic'], /No font called comic/],
    [['tick', 'dracula', '--want-type=maybe'], /--want-type takes on or off/],
    [['tick', 'dracula', '--want-type=on', '--want-type=off'], /--want-type is given twice/],
    [['tick', 'dracula', '--want-size=14'], /Only --want-font=<name\|name-size\|off> and --want-type=on\|off are understood/],
    [['tick', 'dracula', '--want-font=plex-18'], /Sizes are 12 to 16/],
    [['tick', 'dracula', '--want-font=plex-014'], /Sizes are 12 to 16/],
    [['tick', 'dracula', '--want-font=off-14'], /No font called off/],
    [['tick', 'dracula', '--want-font=plex--16'], /Not a font and size/],
    [['tick', 'dracula', '--want-font=plex -16'], /Not a font and size/],
    [['tick', 'remove', '--want-type=on'], /go with a preset/],
    // A tick-only release copy refuses one-click itself, before the parts are read: either refusal is fine.
    [['one-click', 'dracula', '--want-type=on'], /go with a tick only|one-click is not in this release/],
    [['switch', 'dracula', '--want-type=on'], /go with a tick only/],
  ]
  for (const [args, re] of cases) {
    const r = runIn(tool, args)
    assert.notEqual(r.status, 0, args.join(' '))
    assert.match(r.stdout + r.stderr, re, args.join(' '))
    assert.doesNotMatch(r.stdout, /READY_TO_TICK/, `${args.join(' ')} never reaches the prompt`)
  }
})

test('tick with type on in a copy without the type sheet: refused before the prompt (slot-offers)', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'reskin-set-copy-'))
  try {
    for (const f of readdirSync(tool)) if (/\.(mjs|sh|json)$/.test(f) && f !== 'release.json') copyFileSync(path.join(tool, f), path.join(d, f))
    cpSync(path.join(tool, 'presets'), path.join(d, 'presets'), { recursive: true })
    mkdirSync(path.join(d, 'type'))
    const offers = spawnSync(process.execPath, [path.join(d, 'skin.mjs'), 'slot-offers'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(offers.status, 0, offers.stdout)
    assert.equal(JSON.parse(offers.stdout.trim()).headers, false)
    const r = runIn(d, ['tick', 'dracula', '--want-type=on'])
    assert.equal(r.status, 5, r.stdout + r.stderr)
    assert.match(r.stderr, /Type is not available in this copy of Reskin/)
    assert.doesNotMatch(r.stdout, /READY_TO_TICK/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('slot-offers lists the header sheet and every font of this copy', () => {
  const r = spawnSync(process.execPath, [path.join(tool, 'skin.mjs'), 'slot-offers'], { encoding: 'utf8', timeout: 10_000 })
  const o = JSON.parse(r.stdout.trim())
  assert.equal(o.headers, true)
  assert.deepEqual(o.parts, LOOK_PARTS)
  assert.equal(o.fontWhy, null)
})

test('the run limits add up: a combined tick gets two full slot waits', () => {
  assert.equal(TICK.wantMs, 30_000)
  assert.equal(TICK.runLimitWantsMs, TICK.runLimitMs - TICK.restoreMs + 2 * TICK.wantMs)
  assert.equal(TICK.runLimitWantsMs, 210_000)
  assert.ok(TICK.runLimitWantsMs + 10_000 <= 225_000, 'inside the mod\'s 225 s for such a run, with time for cleanup')
})

// ---- After a tick: the line's parts, then the remembered ones, all judged at the end ----
const restore = (o) => {
  const sent = []
  const answers = o.answers ?? {}
  return restoreParts({
    wants: o.wants ?? {}, prefs: o.prefs ?? { last: 'nord', type: false, font: null }, type: o.type ?? false, font: o.font ?? null, fontShipped: true,
    caps: ['check', 'type', 'font'], fonts: ['inter-tight', 'plex', 'lato'], installed: () => 'yes', waits: { want: 30_000, restore: 12_000 },
    send: async (action, waitMs) => { sent.push(`${action}@${waitMs}`); return answers[action] ?? null },
  }).then((r) => ({ ...r, sent }))
}

test('restore: the line\'s parts go first with the full wait, then the remembered ones; all proven is ok', async () => {
  const r = await restore({ wants: { font: 'plex' }, type: true, prefs: { last: 'nord', type: true, font: 'lato' }, answers: { 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }), 'type-on': ack('type-on', true, both) } })
  assert.deepEqual(r.sent, ['font-plex@30000', 'type-on@12000'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines, ['part: font plex: done (no second tick; as the colour helper reports)', 'restore: brought back the project headers (no second tick; as the colour helper reports)'])
  assert.deepEqual(r.save, { headers: true, font: 'plex' }, 'the line\'s font replaces the remembered lato')
})

test('restore: a remembered restore whose cleanup emptied the slot fails the line\'s earlier part (never reported done)', async () => {
  const r = await restore({ wants: { font: 'plex' }, type: true, prefs: { last: 'nord', type: true, font: null }, answers: { 'font-plex': ack('font-plex', true, { headers: false, font: 'plex' }), 'type-on': ack('type-on', false, { headers: false, font: null }, { errors: ['apply failed'] }) } })
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], 'part: font plex: done, then taken off again when a later step failed')
  assert.match(r.lines[1], /^restore: could not bring back the project headers \(apply failed\)/)
  assert.deepEqual(r.save, { headers: true, font: null }, 'the remembered headers stay remembered; the font is what is really on')
})

test('restore: an unanswered remembered restore leaves the line\'s part not proven, and nothing is saved', async () => {
  const r = await restore({ wants: { type: 'off' }, font: 'lato', prefs: { last: 'nord', type: true, font: 'lato' }, answers: { 'type-off': ack('type-off', true, { headers: false, font: null }) } })
  assert.deepEqual(r.sent, ['type-off@30000', 'font-lato@12000'])
  assert.equal(r.ok, false)
  assert.equal(r.lines[0], 'part: type off: done, but not proven now: run /skin check')
  assert.equal(r.save, null)
})

test('restore: a line part that does not complete skips the remembered ones, which stay remembered', async () => {
  const r = await restore({ wants: { font: 'plex' }, type: true, prefs: { last: 'nord', type: true, font: null }, answers: {} })
  assert.deepEqual(r.sent, ['font-plex@30000'])
  assert.equal(r.ok, false)
  assert.match(r.lines.join('\n'), /part: font plex: unconfirmed/)
  assert.match(r.lines.join('\n'), /restore: skipped the project headers \(a part of the line did not complete\); they stay remembered/)
  assert.equal(r.save, null)
})

test('restore: a line part the new helper does not offer is not tried; remembered-only runs keep their old behaviour', async () => {
  const r = await restore({ wants: { font: 'noto' } })
  assert.deepEqual(r.sent, [])
  assert.equal(r.ok, false)
  assert.match(r.lines[0], /part: font and type parts not tried \(the font noto is not available in this colour helper\)/)
  const old = await restore({ type: true, prefs: { last: 'nord', type: true, font: null }, answers: { 'type-on': ack('type-on', true, { headers: true, font: null }) } })
  assert.equal(old.ok, true)
  assert.deepEqual(old.lines, ['restore: brought back the project headers (no second tick; as the colour helper reports)'])
})

// ---- A helper started before Inter Tight may still prove the old Inter ----
test('a proven pair holding the old inter is accepted as what is on, never as a name to ask for', () => {
  assert.equal(slotPairOk({ headers: false, font: 'inter' }), true)
  assert.equal(slotPairOk({ headers: false, font: 'comic' }), false)
  assert.throws(() => parse('font inter-tight-old'), /No font called/)
  assert.match(fontLines({ font: 'inter', sample: { stable: true, pages: [{ fonts: { paragraph: 'Inter', list: 'Inter', bold: 'Inter', composer: 'Inter', sidebarRow: 'Inter' } }] } })[0], /^font: inter set: chat text match/)
})

test('the tool deadline counts from the run\'s own start, so checks before the prompt use the same allowance', () => {
  const src = readFileSync(path.join(tool, 'skin-auto.mjs'), 'utf8')
  assert.match(src, /const RUN_START = Date\.now\(\)\n(?:.*\n){0,2}const argv0 = lockWait\.rest/)
  assert.match(src, /\}, Math\.max\(1_000, RUN_LIMIT_MS - \(Date\.now\(\) - RUN_START\)\)\)/)
})

// ---- Sizes (3 Nov 2026): the key carries the size through the steps, restores and proof ----
test('steps with a size: the sized key is sent and judged; a type-off answer keeping it is proven', async () => {
  const sized = { headers: false, font: 'plex-16' }
  const s = steps({ 'font-plex-16': ack('font-plex-16', true, sized), 'type-off': ack('type-off', true, sized) })
  const r = await runSetParts(parse('font plex 16 type off'), s.deps)
  assert.deepEqual(s.sent, ['font-plex-16', 'type-off'])
  assert.equal(r.failed, false)
  assert.deepEqual(r.final, sized)
  assert.deepEqual(r.out, ['font plex 16px: done', 'type off: done'])
  // The same font without a size is a different key: a final pair still holding the size is not "done" for it.
  const t = steps({ 'font-plex': ack('font-plex', true, sized) })
  const u = await runSetParts(parse('font plex'), t.deps)
  assert.deepEqual(t.sent, ['font-plex'])
  assert.match(u.out[0], /font plex: done, then taken off again/)
  assert.equal(slotPairOk(sized), true)
  for (const bad of ['plex-19', 'inter-16', 'plex-016']) assert.equal(slotPairOk({ headers: false, font: bad }), false, bad)
})

test('restore with sizes: the line\'s sized key goes first; a remembered sized key comes back; one not offered stays remembered', async () => {
  const run = (o) => {
    const sent = []
    return restoreParts({
      wants: o.wants ?? {}, prefs: o.prefs, type: false, font: o.font ?? null, fontShipped: true,
      caps: ['check', 'type', 'font'], fonts: ['plex', 'plex-16', 'lato', 'lato-13'], installed: () => 'yes', waits: { want: 30_000, restore: 12_000 },
      send: async (action, waitMs) => { sent.push(`${action}@${waitMs}`); return (o.answers ?? {})[action] ?? null },
    }).then((r) => ({ ...r, sent }))
  }
  let r = await run({ wants: { font: 'plex-16' }, prefs: { last: 'nord', type: false, font: 'lato' }, answers: { 'font-plex-16': ack('font-plex-16', true, { headers: false, font: 'plex-16' }) } })
  assert.deepEqual(r.sent, ['font-plex-16@30000'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.save, { headers: false, font: 'plex-16' })
  r = await run({ prefs: { last: 'nord', type: false, font: 'lato-13' }, font: 'lato-13', answers: { 'font-lato-13': ack('font-lato-13', true, { headers: false, font: 'lato-13' }) } })
  assert.deepEqual(r.sent, ['font-lato-13@12000'])
  assert.deepEqual(r.save, { headers: false, font: 'lato-13' })
  r = await run({ prefs: { last: 'nord', type: false, font: 'lato-15' }, font: 'lato-15' })
  assert.deepEqual(r.sent, [], 'a remembered key the helper does not offer is not sent')
  assert.match(r.lines.join('\n'), /could not bring back the font lato-15 \(not in this copy\)/)
  r = await run({ wants: { font: 'plex-15' }, prefs: { last: 'nord', type: false, font: null } })
  assert.deepEqual(r.sent, [])
  assert.match(r.lines[0], /the font plex-15 is not available in this colour helper/)
})
