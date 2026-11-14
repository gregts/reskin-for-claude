import { expect, test, mock } from 'claude-code/testing'

import { makeColors } from '../hooks/make-colors.js'
import { SKINS } from '../hooks/skins.js'
import { look, skinName, commandSkin, DEFAULT_SKIN, SHORT, FULL_WORDS } from '../hooks/register.js'

// A store in memory the test can also write, standing for another session writing the shared file.
const ENGINE = (on: any, sets: unknown[], clears: { n: number }, mem: Record<string, unknown> = {}, owners: any[] = [], reg = { n: 0 }) => {
  on('command.list', () => ({ value: owners }))
  on('store.get', (_: unknown, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_: unknown, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_: unknown, e: any) => { delete mem[e.key]; return { value: undefined } })
  on('command.register', () => { reg.n++; return { value: { command: 'skin' } } })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('theme.set', (_: unknown, e: any) => { sets.push(e); return { value: { isDrawn: true, requestId: 'theme' } } })
  on('theme.clear', () => { clears.n++; return { value: { isDrawn: false, reason: 'cleared' } } })
}

test('every skin is one Desktop agrees to paint, in Light and Dark', async () => {
  expect(Object.keys(SKINS).length).toBe(16)
  for (const name of Object.keys(SKINS)) {
    const { refused, args } = look(name)
    expect(refused).toBe(undefined)
    const inputs = (args.colors as any).inputs
    expect(Object.keys(inputs.light).length > 90).toBe(true)
    expect(Object.keys(inputs.dark).length > 90).toBe(true)
  }
})

test('the shipped make-colors still accepts every skin half alone', async () => {
  for (const [name, s] of Object.entries(SKINS)) {
    for (const mode of ['light', 'dark'] as const) {
      const { problems } = makeColors({ label: name, only: mode, [mode]: { gray: { anchors: s[mode].anchors }, roles: s[mode].roles } } as any)
      expect(problems.filter((p: string) => p.startsWith("Desktop won't paint")).length).toBe(0)
    }
  }
})

test('typed names are forgiving', async () => {
  expect(skinName('Rosé Pine')).toBe('rose-pine')
  expect(skinName(' tokyo night ')).toBe('tokyo-night')
  expect(skinName('OFF')).toBe('off')
  expect(skinName('verc')).toBe(undefined)
  expect(skinName('dra')).toBe('dracula')
  expect(skinName('ros')).toBe('rose-pine')
  expect(skinName('tokyo-night-day')).toBe('tokyo-night')
  expect(skinName('owl')).toBe('night-owl')
  expect(skinName('Rose Pine Dawn')).toBe('rose-pine')
  expect(skinName('one')).toBe('one')
  expect(skinName('vs')).toBe('vs')
  expect(skinName('no')).toBe(undefined)
  expect(skinName('drac')).toBe(undefined) // same table as the full flavour: no guessing from starts
})

test('every skin has a unique 3-letter short name, and none is a full-flavour word', async () => {
  const shorts = Object.values(SHORT)
  expect(new Set(shorts).size).toBe(16)
  for (const [name, short] of Object.entries(SHORT)) expect(skinName(short)).toBe(name)
  for (const w of FULL_WORDS) expect(w === 'off' ? skinName(w) : skinName(w)).toBe(w === 'off' ? 'off' : undefined)
})

test('with the full flavour owning /skin: listens, sets colours, and lets the full flavour answer', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'nord' }
  const reg = { n: 0 }
  ENGINE(on, sets, clears, mem, [{ name: 'skin', description: 'full', source: 'plugin', plugin: 'skin' }], reg)
  // The full flavour, beneath this mod: answers everything itself.
  on('command.run', { command: 'skin' }, (_: unknown, e: any) => ({ text: 'FULL: ' + e.args }))
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(reg.n).toBe(0)
  const r: any = await $.command.run({ command: 'skin', args: 'dra --tick' } as any)
  expect(r.text).toBe('FULL: dra --tick\nCode tab colours (Reskin light): Dracula.')
  expect(mem.skin).toBe('dracula')
  // A one-line command is the full flavour's alone: it answers and these colours stay.
  const one: any = await $.command.run({ command: 'skin', args: 'nor font plex' } as any)
  expect(one.text).toBe('FULL: nor font plex')
  expect(mem.skin).toBe('dracula')
  const c: any = await $.command.run({ command: 'skin', args: 'check' } as any)
  expect(c.text).toBe('FULL: check')
  expect(mem.skin).toBe('dracula')
})

test('alone: owns /skin and answers a list with short names', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = {}
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r: any = await $.command.run({ command: 'skin', args: '' } as any)
  expect(String(r.text)).toMatch(/now Dracula/)
  expect(String(r.text)).toMatch(/tokyo-night \(tok\)/)
  const k: any = await $.command.run({ command: 'skin', args: 'kan' } as any)
  expect(String(k.text)).toMatch(/Kanagawa on/)
})

test('a fresh install paints the default skin at session start and says so once', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = {}
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(sets.length).toBe(1)
  expect(sets[0].colors.label).toBe('Reskin ' + SKINS[DEFAULT_SKIN]!.label)
  expect(mem.welcomed).toBe(true)
  expect(mem.skin).toBe(undefined)
})

test('a switch is saved for every session, and off clears only on the ask', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'off' }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(sets.length).toBe(0)
  expect(clears.n).toBe(0)
  const r: any = await $.command.run({ command: 'skin', args: 'nord' } as any)
  expect(String(r.text)).toMatch(/Nord on/)
  expect(mem.skin).toBe('nord')
  expect(sets.at(-1).colors.label).toBe('Reskin Nord')
  await $.command.run({ command: 'skin', args: 'off' } as any)
  expect(clears.n).toBe(1)
})

test('another session switching is followed within one sync tick, once', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'dracula' }
  ENGINE(on, sets, clears, mem)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(sets.length).toBe(1)
  mem.skin = 'kanagawa'
  await clock.advance(2000)
  expect(sets.length).toBe(2)
  expect(sets[1].colors.label).toBe('Reskin Kanagawa')
  await clock.advance(6000)
  expect(sets.length).toBe(2)
})

test('the sync also runs in a session started as non-interactive (how the Code tab starts them)', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'dracula' }
  ENGINE(on, sets, clears, mem)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  mem.skin = 'nord'
  await clock.advance(2000)
  expect(sets.at(-1).colors.label).toBe('Reskin Nord')
})

test('an unknown saved name falls back to the default, and a bad name is refused politely', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'verc' }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(sets[0].colors.label).toBe('Reskin ' + SKINS[DEFAULT_SKIN]!.label)
  const r: any = await $.command.run({ command: 'skin', args: 'purple' } as any)
  expect(String(r.text)).toMatch(/no skin called "purple"/)
  expect(mem.skin).toBe('verc')
})

test('only a plain /skin line changes colours; inherited names are never skins', async () => {
  const w = (t: string) => commandSkin(t.split(' ').filter(Boolean))
  expect(w('dra')).toBe('dracula')
  expect(w('--tick kan')).toBe('kanagawa')
  expect(w('KAN --TICK')).toBe('kanagawa')
  expect(w('off')).toBe('off')
  expect(w('off --tick')).toBe('off')
  for (const bad of ['dra nonsense', 'nor font plex', 'nor font plex type on', 'kan --tick --one-click', 'kan --one-click', 'kan type on --one-click', 'off type on --tick', 'kan font /nope', 'kan font list', 'kan font plex 99', 'dra --force', 'dra --tick --tick', 'font plex', 'check', 'constructor', 'toString', '__proto__']) expect(w(bad)).toBeUndefined()
  for (const bad of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) expect(skinName(bad)).toBeUndefined()
  // With the full flavour in, only names it also takes: no underscores or accents.
  const strict = (t: string) => commandSkin(t.split(' ').filter(Boolean), true)
  for (const bad of ['rose_pine', 'drá', 'Rosé', 'tokyo--night']) expect(strict(bad)).toBeUndefined()
  expect(strict('rose-pine')).toBe('rose-pine')
  expect(strict('DRA')).toBe('dracula')
  // Alone, light stays forgiving.
  expect(w('rose_pine')).toBe('rose-pine')
})
