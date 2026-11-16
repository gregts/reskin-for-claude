import { expect, test, mock } from 'claude-code/testing'

import { SKINS } from '../hooks/skins.js'
import { sharedPath, SHARED_FILE } from '../hooks/register.js'
import { check, contrast, definition, fromText, makeReadable, startFrom, toText } from '../hooks/custom.js'

// A store in memory the test can also write, standing for another session writing the shared file.
const ENGINE = (on: any, sets: any[], clears: { n: number }, mem: Record<string, unknown> = {}, owners: any[] = []) => {
  on('command.list', () => ({ value: owners }))
  on('store.get', (_: unknown, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_: unknown, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_: unknown, e: any) => { delete mem[e.key]; return { value: undefined } })
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('theme.set', (_: unknown, e: any) => { sets.push(e); return { value: { isDrawn: true, requestId: 'theme' } } })
  on('theme.clear', () => { clears.n++; return { value: { isDrawn: false, reason: 'cleared' } } })
}

const MOUNT = (surface = 'desktop', bodyColumns = 100) => ({
  plugin: 'reskin-light',
  component: 'AbovePrompt',
  surface,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as any

const run = ($: any, args: string) => $.command.run({ command: 'skin', args } as any) as Promise<any>
const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('every skin is a starting point Claude accepts, and unchanged it is exactly that skin', async () => {
  expect(check(startFrom('claude')).ok).toBe(true)
  for (const [name, s] of Object.entries(SKINS)) {
    const c = startFrom(name)
    expect(check(c).ok).toBe(true)
    const def: any = definition(c)
    for (const mode of ['light', 'dark'] as const) {
      for (const [k, v] of Object.entries(s[mode].anchors)) expect(def[mode].gray.anchors[k]).toBe(v)
    }
  }
})

test('the theme as text reads back the same, and a bare line goes to the mode it looks like', async () => {
  const d = fromText('from dracula; light accent #ff79c6; always dark', startFrom('claude')).custom
  expect(fromText(toText(d), startFrom('claude')).custom).toEqual(d)
  const bright = fromText('bg #FFF fg #030303 accent #ff6363', startFrom('claude')).custom
  expect(bright.light).toEqual({ bg: '#ffffff', fg: '#030303', accent: '#ff6363' })
  const dark = fromText('background: #1e1e2e, text: #cdd6f4, accent: #cba6f7', startFrom('claude')).custom
  expect(dark.dark).toEqual({ bg: '#1e1e2e', fg: '#cdd6f4', accent: '#cba6f7' })
  expect(fromText('bg #12 purple', startFrom('claude')).unread.length > 0).toBe(true)
})

test('faint text is refused with a plain reason, and the fix makes it acceptable', async () => {
  const faint = fromText('dark bg #0d1117 fg #8b949e accent #2f81f7', startFrom('claude')).custom
  const v = check(faint)
  expect(v.ok).toBe(false)
  expect(v.bad).toEqual(['dark'])
  expect(v.refusals[0]).toMatch(/^Dark: some text would be too faint/)
  const fixed = makeReadable(faint)!
  expect(check(fixed).ok).toBe(true)
  expect(fixed.dark.bg).toBe('#0d1117')
  expect(fixed.light).toEqual(faint.light)
})

test('low contrast: Soft grey is accepted, too faint is refused, and the fix lands just past the limit', async () => {
  const soft = startFrom('soft-grey')
  const v = check(soft)
  expect(v.ok).toBe(true)
  expect(v.ratio.light < 4.6).toBe(true)
  const faint = fromText('light bg #d9d9d6 fg #8a8a88', soft).custom
  expect(check(faint).ok).toBe(false)
  const fixed = makeReadable(faint)!
  expect(check(fixed).ok).toBe(true)
  const r = contrast(fixed.light.fg, fixed.light.bg)
  expect(r >= 4 && r < 4.6).toBe(true)
  expect(fixed.dark).toEqual(soft.dark)
})

test('/skin custom with colours paints, keeps them for every session; a refusal paints nothing; fix, copy, off', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'nord' }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await start($)
  expect(sets.length).toBe(1) // nord at start
  const r = await run($, 'custom bg #ffffff fg #030303 accent #ff6363')
  expect(String(r.text)).toMatch(/Claude accepts these colours/)
  expect(sets.length).toBe(2)
  expect(mem.skin).toBe('custom')
  expect((mem.custom as any).light.bg).toBe('#ffffff')
  const bad = await run($, 'custom dark bg #0d1117 fg #8b949e')
  expect(String(bad.text)).toMatch(/too faint.*\/skin custom fix/s)
  expect(sets.length).toBe(2)
  expect((mem.custom as any).dark.bg).not.toBe('#0d1117')
  const fix = await run($, 'custom fix')
  expect(String(fix.text)).toMatch(/Text made stronger/)
  expect(sets.length).toBe(3)
  const copy = await run($, 'custom copy')
  expect(String(copy.text)).toMatch(/light bg #ffffff fg #030303 accent #ff6363; dark bg #0d1117/)
  await run($, 'off')
  expect(clears.n).toBe(1)
  expect(mem.skin).toBe('off')
  // Alone, /skin custom brings the saved colours back and opens the band.
  const back = await run($, 'custom')
  expect(String(back.text)).toMatch(/back on.*band is open/s)
  expect(mem.skin).toBe('custom')
  expect(sets.length).toBe(4)
  // A skin name still switches away from your colours.
  await run($, 'dracula')
  expect(mem.skin).toBe('dracula')
  expect(sets.at(-1).overrideColorScheme).toBe(undefined)
})

test('custom is never a skin name, and never read as one', async ($, on) => {
  expect(Object.hasOwn(SKINS, 'custom')).toBe(false)
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'custom', custom: { bad: true } }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await start($)
  // A broken saved choice falls back to the default skin, as an unknown name does.
  expect(sets.length).toBe(1)
  expect(String(sets[0].colors.label ?? '')).not.toMatch(/Your colours/)
})

test('with the full flavour owning /skin: /skin custom is answered here and not passed on', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'nord' }
  ENGINE(on, sets, clears, mem, [{ name: 'skin', plugin: 'skin' }])
  let passed = 0
  on('command.run', () => { passed++; return { text: 'full answered' } })
  mock.clock(on)
  await start($)
  const r = await run($, 'custom bg #000000 fg #ffffff accent #0a84ff')
  expect(String(r.text)).toMatch(/Claude accepts these colours.*Reskin full's colours are on/s)
  expect(passed).toBe(0)
  expect(mem.skin).toBe('custom')
})

test('the band: hidden until /skin custom; Light or Dark, a live colour, a bad code, save as a name, close', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'off' }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await start($)
  const hidden = await $.ui.mount(MOUNT())
  expect(await hidden.find({ type: 'Input', key: 'dark-bg' })).toBe(undefined)
  await hidden.unmount()
  await run($, 'custom')
  const ui = await $.ui.mount(MOUNT())
  expect((await ui.find({ type: 'Input', key: 'dark-bg' })) !== undefined).toBe(true)
  // Only the simple parts: no Start from, Mode, Copy, Theme as text or Colours off.
  for (const key of ['base', 'scheme', 'as-text']) expect(await ui.find({ key } as any)).toBe(undefined)
  for (const key of ['copy', 'reset']) expect(await ui.find({ key } as any)).toBe(undefined)

  // A whole code shows while typing; half a code waits.
  await ui.input({ key: 'dark-accent', text: '#ff55', kind: 'change' } as any)
  expect(sets.length).toBe(0)
  await ui.input({ key: 'dark-accent', text: '#ff5555', kind: 'change' } as any)
  expect((mem.custom as any).dark.accent).toBe('#ff5555')
  expect(mem.skin).toBe('custom')
  expect(sets.length).toBe(1)

  // One row of fields; Editing picks the half they change.
  expect(await ui.find({ type: 'Input', key: 'light-bg' })).toBe(undefined)
  await ui.select({ key: 'half', value: 'light' } as any)
  expect(await ui.find({ type: 'Input', key: 'dark-bg' })).toBe(undefined)
  await ui.input({ key: 'light-bg', text: 'pink' } as any)
  expect(await ui.find({ type: 'Text', text: /"pink" is not a colour code/ }) !== undefined).toBe(true)
  await ui.input({ key: 'light-bg', text: '#fdf6e3' } as any)
  expect((mem.custom as any).light.bg).toBe('#fdf6e3')

  // Save as: a bad name is refused, a good one becomes a skin and is on.
  await ui.input({ key: 'save-as', text: 'dracula' } as any)
  expect(await ui.find({ type: 'Text', text: /already a Reskin word or skin/ }) !== undefined).toBe(true)
  expect(mem.mine).toBe(undefined)
  await ui.input({ key: 'save-as', text: 'My Blue' } as any)
  expect((mem.mine as any)['my-blue'].light.bg).toBe('#fdf6e3')
  expect(mem.skin).toBe('my-blue')
  expect(await ui.find({ type: 'Text', text: /Saved "my-blue"/ }) !== undefined).toBe(true)

  await ui.press({ key: 'colours-close' } as any)
  expect(await ui.find({ type: 'Input', key: 'dark-bg' })).toBe(undefined)
  await ui.unmount()
})

test('a saved skin: /skin <name> puts it on, list shows it, other sessions follow, forget removes it', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }
  const blue = fromText('bg #ffffff fg #030303 accent #0a84ff', startFrom('nord')).custom
  const mem: Record<string, unknown> = { skin: 'nord', mine: { 'my-blue': blue, 'bad one': blue, broken: { x: 1 } } }
  ENGINE(on, sets, clears, mem)
  const clock = mock.clock(on)
  await start($)
  expect(sets.length).toBe(1)
  const list = await run($, 'list')
  expect(String(list.text)).toMatch(/Yours: my-blue\./)
  expect(String(list.text)).not.toMatch(/broken|bad one/)
  const r = await run($, 'My-Blue')
  expect(String(r.text)).toMatch(/^Reskin light: your skin "my-blue" on/)
  expect(mem.skin).toBe('my-blue')
  expect(sets.length).toBe(2)
  // Nothing new to paint on the next tick; a change by another session is followed.
  await clock.advance(2000)
  expect(sets.length).toBe(2)
  mem.skin = 'nord'
  await clock.advance(2000)
  expect(sets.length).toBe(3)
  mem.skin = 'my-blue'
  await clock.advance(2000)
  expect(sets.length).toBe(4)
  // /skin custom while wearing it: the band starts from it.
  expect(String((await run($, 'custom')).text)).toMatch(/Your skin "my-blue" is on/)
  expect(mem.skin).toBe('my-blue')
  const gone = await run($, 'custom forget my-blue')
  expect(String(gone.text)).toMatch(/forgot your skin "my-blue".*Claude's own colours are back/s)
  expect(Object.hasOwn(mem.mine as any, 'my-blue')).toBe(false)
  expect(mem.skin).toBe('off')
  expect(String((await run($, 'my-blue')).text)).toMatch(/no skin called "my-blue"/)
})

test('with the full flavour owning /skin: a saved skin is painted here and passed on, so full turns its colours off', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }
  const mem: Record<string, unknown> = { skin: 'nord', mine: { 'my-blue': startFrom('kanagawa') } }
  ENGINE(on, sets, clears, mem, [{ name: 'skin', plugin: 'skin' }])
  let passed = 0
  on('command.run', (_: unknown, e: any) => { passed++; return { text: e.args.trim() === 'list' ? 'full list' : 'full answered' } })
  mock.clock(on)
  await start($)
  const r = await run($, 'my-blue')
  expect(String(r.text)).toBe('Reskin light: your skin "my-blue" on. Other sessions follow within about 2 seconds.\nfull answered')
  expect(passed).toBe(1)
  expect(mem.skin).toBe('my-blue')
  // A spelling the full flavour refuses is never a saved skin here either.
  mem.skin = 'nord'
  await run($, 'my_blue')
  expect(mem.skin).toBe('nord')
  // The full flavour's list gets your saved skins added.
  const list = await run($, 'list')
  expect(String(list.text)).toMatch(/^full list\nYour skins \(Code tab, Reskin light\): my-blue\./)
})

test('a starting point that is only an inherited name is never used, and nothing malformed is kept', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }, mem: Record<string, unknown> = { skin: 'nord' }
  ENGINE(on, sets, clears, mem)
  mock.clock(on)
  await start($)
  for (const bad of ['constructor', 'toString', '__proto__']) {
    expect(startFrom(bad).base).toBe('claude')
    expect(fromText(`from ${bad}`, startFrom('nord')).unread.length).toBe(1)
  }
  await run($, 'custom from constructor')
  expect(mem.custom === undefined || (mem.custom as any).light.bg !== undefined).toBe(true)
})

test('another session choosing your colours is followed within one tick, once; a saved choice returns at start', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }
  const mem: Record<string, unknown> = { skin: 'nord', custom: startFrom('kanagawa') }
  ENGINE(on, sets, clears, mem)
  const clock = mock.clock(on)
  await start($)
  expect(sets.length).toBe(1)
  mem.skin = 'custom'
  await clock.advance(2000)
  expect(sets.length).toBe(2)
  await clock.advance(6000)
  expect(sets.length).toBe(2)
  mem.custom = fromText('bg #000000 fg #ffffff accent #0a84ff', startFrom('claude')).custom
  await clock.advance(2000)
  expect(sets.length).toBe(3)
})

test('the band draws on every surface that has it, wide and narrow', async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }
  ENGINE(on, sets, clears, { skin: 'off' })
  mock.clock(on)
  await start($)
  await run($, 'custom')
  for (const [surface, cols] of [['terminal', 100], ['desktop', 140], ['desktop', 50], ['mobile', 40]] as const) {
    const ui = await $.ui.mount(MOUNT(surface, cols))
    expect((await ui.find({ type: 'Text', text: /Your colours/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('the shared file of saved names sits next to the plugins folder, the same place Reskin full looks', () => {
  expect(SHARED_FILE).toBe('reskin/saved-skins.json')
  expect(sharedPath('/Users/x/.claude/plugins/cache/reskin-for-claude/reskin-light/2.3.0')).toBe('/Users/x/.claude/reskin/saved-skins.json')
  expect(sharedPath('/Users/x/dev/reskin-light')).toBe(undefined)
})

test("Reskin full's Custom tab open: the fields draw with no /skin custom, under what is beneath", async ($, on) => {
  const sets: any[] = [], clears = { n: 0 }
  ENGINE(on, sets, clears, { skin: 'off' })
  let fullCustom = true, version = 1
  on('state.get', (next: any, e: any) => (e.plugin === 'skin' && e.key === 'customOpen' ? { value: { value: fullCustom, version } } : next(e)))
  mock.clock(on)
  await start($)
  const ui = await $.ui.mount(MOUNT())
  expect((await ui.find({ type: 'Input', key: 'dark-bg' })) !== undefined).toBe(true)
  await ui.input({ key: 'dark-bg', text: 'pink' } as any)
  expect(await ui.find({ type: 'Text', text: /"pink" is not a colour code/ }) !== undefined).toBe(true)
  await ui.unmount()
  // Closed and opened again: the band opens clean, without the last opening's note.
  version += 2
  const again = await $.ui.mount(MOUNT())
  expect(await again.find({ type: 'Text', text: /"pink" is not a colour code/ })).toBe(undefined)
  await again.unmount()
  fullCustom = false
  const shut = await $.ui.mount(MOUNT())
  expect(await shut.find({ type: 'Input', key: 'dark-bg' })).toBe(undefined)
  await shut.unmount()
})
