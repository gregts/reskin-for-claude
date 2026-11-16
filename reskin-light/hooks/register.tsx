import type { EngineInterface, Register, ThemeSetArgs } from 'claude-code'
import { makeColors } from './make-colors.js'
import { SKINS, ALIASES, type Half } from './skins.js'
import { atom, read, update } from 'claude-code'
import type { Custom, ModeName, Note, Three } from '../types'
import { EXTRA, check, fromText, hex, makeReadable, startFrom, toText } from './custom.js'

// ---- the "your colours" band (/skin custom) ----------------------------------------------------------
// the owner's rule (15 Nov): dead simple. Pick Light or Dark, type three colour codes (they show as you type), type a name
// and save: it is a skin, /skin <name> puts it back on. The colour work is in custom.ts.

// Room for a whole 7-character code and its apply word beside a field's label, in cells. The band shows one half at a
// time (an Editing choice: Light or Dark) so the three fields sit spread out on one row (the owner, 15 Nov).
const FIELD_CELLS = 18
// Room for a whole saved name beside "Save as" and its save word.
const NAME_CELLS = 'Save as'.length + 24 + 8

// This session's copy of what the band shows; paint() keeps it in step with the shared choice.
export const draft = atom({ plugin: 'reskin-light', key: 'draft' } as const, startFrom('claude'), { shape: 'draft-1' })
export const note = atom({ plugin: 'reskin-light', key: 'note' } as const, null as Note | null)
// Whether this session shows the colours band above the message box.
export const bandOpen = atom({ plugin: 'reskin-light', key: 'bandOpen' } as const, false)
// Which half (Light or Dark) the band's three fields edit: one row of fields, the half a choice (the owner, 15 Nov).
export const editing = atom({ plugin: 'reskin-light', key: 'editing' } as const, 'dark' as ModeName)

const MODES: { mode: ModeName; title: string }[] = [
  { mode: 'light', title: 'Light' },
  { mode: 'dark', title: 'Dark' },
]
const FIELDS: { key: keyof Three; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'fg', label: 'Text' },
  { key: 'accent', label: 'Accent' },
]
export const SKIN_OPTIONS = [
  { value: 'claude', label: "Claude's own" },
  ...Object.entries(EXTRA).map(([value, x]) => ({ value, label: x.label })),
  ...Object.entries(SKINS).map(([value, s]) => ({ value, label: s.label })),
]

/** What the band shows for a skin a person already uses, so they can change one colour of it. */
export function draftFrom(name: string): Custom {
  return startFrom(Object.hasOwn(SKINS, name) ? name : 'claude')
}

// ---- your saved skins: a name for a set of your colours ----------------------------------------------
// Kept in the shared store under MINE_KEY as { name: Custom }. /skin <name> puts one on, like a built-in skin.
export const MINE_KEY = 'mine'
export const NAME_MAX = 24
// Words a saved name may never be: the skins (and their short names), the starting points, and every command word
// of both flavours, so /skin <name> always means one thing.
const NOT_NAMES = new Set(['claude', 'custom', 'on', 'tick', 'forget', 'delete', 'help', 'save', 'mine'])

/** The name a person typed, as it is kept: lower case, spaces become hyphens. */
export function savedName(typed: string): string {
  return simple(typed)
}

/** Why a name cannot be used, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (name === '') return 'Type a name first, like my-blue.'
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return `"${name}" cannot be a name: use letters, numbers and single hyphens, like my-blue.`
  if (name.length > NAME_MAX) return `That name is too long: ${NAME_MAX} characters at most.`
  if (Object.hasOwn(SKINS, name) || Object.hasOwn(ALIASES, name) || Object.hasOwn(EXTRA, name) || NOT_NAMES.has(name) || FULL_WORDS.includes(name)) {
    return `"${name}" is already a Reskin word or skin. Pick another name.`
  }
  return undefined
}

// Reskin full reads your saved names from one small file both flavours can find: <Claude's config folder>/reskin/
// saved-skins.json, next to the plugins folder both are installed in. It lists names only (no colours), so its Skins
// menu can offer them; picking one there runs /skin <name>, answered here.
export const SHARED_FILE = 'reskin/saved-skins.json'
export function sharedPath(root: string): string | undefined {
  const i = root.indexOf('/plugins/cache/')
  return i > 0 ? `${root.slice(0, i)}/${SHARED_FILE}` : undefined
}
export async function writeShared($: Dollar): Promise<void> {
  const path = sharedPath($.plugin.root)
  if (path === undefined) return
  try {
    await $.fs.write(path, JSON.stringify({ names: Object.keys(await mine($)).sort() }) + '\n')
  } catch {
    // Only Reskin full's menu misses the names; /skin <name> still works.
  }
}

/** Your saved skins, only the well-formed ones Claude would paint. */
export async function mine($: Dollar): Promise<Record<string, Custom>> {
  const m = await $.store.get(MINE_KEY)
  const out: Record<string, Custom> = {}
  if (m === null || typeof m !== 'object') return out
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (nameProblem(k) === undefined && isCustom(v) && check(v).ok) out[k] = v
  }
  return out
}


// Reskin light: Reskin's 17 skins through Claude's official mod colours ($.theme.set).
// Paints the desktop app's Code tab (chat, sidebar, panels, Settings), both Light and Dark. Or your own colours:
// /skin custom opens a band above the message box where three colours per mode become a whole theme (custom.ts).
// It cannot reach the Chat tab, fonts, text sizes or sidebar header sizes: that is Reskin's full flavour.
//
// One choice for every session: the choice lives in $.store (one JSON file shared by all sessions),
// and each session's copy of this mod checks it every 2 seconds and repaints when it changes.

// The command is /skin, the same word as Reskin's full flavour. When the full flavour is loaded it owns /skin
// and this mod only listens (see the session.start hook and report.md, "One /skin for both flavours").
export const COMMAND = 'skin'
export const DEFAULT_SKIN = 'dracula'
export const SYNC_MS = 2000
const NAMES = Object.keys(SKINS)

// Words the full flavour's /skin uses: never read as skin names, never answered here when the full flavour is in.
export const FULL_WORDS = ['off', 'remove', 'status', 'check', 'list', 'log', 'about', 'font', 'fonts', 'type', 'band']
// This mod's own word, never a skin name: /skin custom (your own colours). Both flavours leave it to this mod.
export const CUSTOM_WORD = 'custom'

const simple = (t: string) => t.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_]+/g, '-')

// Turns what a person types into a skin name. Short and old names come from the full flavour's table (ALIASES in
// skins.ts, generated), so dra, nor, tok, owl and tokyo-night-day mean the same in both. Capitals, accents and
// underscores are forgiven ("Rosé", "rose_pine"); a /skin line takes one word, so "rose pine" does not work.
export function skinName(typed: string): string | undefined {
  const k = simple(typed)
  if (k === 'off' || Object.hasOwn(SKINS, k)) return k
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : undefined
}

// The 3-letter short name of each skin (for lists and the full flavour's copy of this table).
export const SHORT: Record<string, string> = Object.fromEntries(NAMES.map(n => [n, Object.keys(ALIASES).find(a => a.length === 3 && ALIASES[a] === n) ?? n]))

type Def = Parameters<typeof makeColors>[0]

function half(h: Half): { gray: { anchors: Record<string, string> }; roles: Record<string, unknown> } {
  return { gray: { anchors: h.anchors }, roles: h.roles }
}

// The whole look for one skin, and the line that would stop Desktop painting it (none for a shipped skin:
// the tests hold every skin to that).
export function look(name: string): { args: ThemeSetArgs; refused: string | undefined } {
  const s = SKINS[name]!
  const def = { label: 'Reskin ' + s.label, light: half(s.light), dark: half(s.dark) } as unknown as Def
  return fromDef(def)
}

function fromDef(def: Def): { args: ThemeSetArgs; refused: string | undefined } {
  const { theme, problems } = makeColors(def)
  return { args: { colors: theme }, refused: problems.find(p => p.startsWith("Desktop won't paint")) }
}

type Dollar = EngineInterface

// A saved custom choice is used only if it is well formed and Claude would paint it.
export function isCustom(v: unknown): v is Custom {
  const ok3 = (t: unknown) =>
    t !== null && typeof t === 'object' && ['bg', 'fg', 'accent'].every(k => typeof (t as Record<string, unknown>)[k] === 'string' && hex((t as Record<string, string>)[k]!) !== undefined)
  if (v === null || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.base === 'string' && ok3(c.light) && ok3(c.dark) && ['system', 'light', 'dark'].includes(c.scheme as string)
}

type Wanted = { key: string; name: string; custom?: Custom }

async function savedCustom($: Dollar): Promise<Custom | undefined> {
  const c = await $.store.get('custom')
  return isCustom(c) && check(c).ok ? c : undefined
}

// What the shared store asks for: one skin name (or off, or custom, or a saved name) for every session.
export async function wanted($: Dollar): Promise<Wanted> {
  const v = await $.store.get('skin')
  if (v === CUSTOM_WORD) {
    const c = await savedCustom($)
    if (c !== undefined) return { key: CUSTOM_WORD + ':' + JSON.stringify(c), name: CUSTOM_WORD, custom: c }
  } else if (typeof v === 'string' && nameProblem(v) === undefined) {
    const m = await mine($)
    if (Object.hasOwn(m, v)) return { key: savedKey(v, m[v]!), name: v, custom: m[v] }
  }
  const name = typeof v === 'string' ? skinName(v) ?? DEFAULT_SKIN : DEFAULT_SKIN
  return { key: name, name }
}

// Per session copy: what this copy last painted, and its timer. A reload starts the module over and the
// engine ends the old copy's timers itself.
let painted: string | undefined
let timer: { cancel: () => void } | undefined
let busy = false
// Whether this copy registered /skin (no other mod owns it). False: the full flavour answers and this mod listens.
let ownsCommand = true
export const OWN_NAME = 'reskin-light'

async function paint($: Dollar, w: Wanted, atStart = false): Promise<string> {
  painted = w.key
  if (w.custom !== undefined) {
    const v = check(w.custom)
    if (!v.ok || v.theme === undefined) return 'not made'
    const args: ThemeSetArgs = w.custom.scheme === 'system' ? { colors: v.theme } : { colors: v.theme, overrideColorScheme: w.custom.scheme }
    await update($, draft, () => w.custom!)
    const set = await $.theme.set(args)
    return set.isDrawn ? 'drawn' : 'waiting: ' + set.reason
  }
  if (w.name === 'off') {
    // Clear only on a person's ask (here or in another session), never at session start: a clear there
    // would wipe another mod's theme every time.
    if (!atStart) await $.theme.clear()
    return 'off'
  }
  let made
  try {
    made = look(w.name)
  } catch (err) {
    $.ui.toast('Reskin light: that look could not be made: ' + String(err).slice(0, 120))
    return 'not made'
  }
  if (made.refused !== undefined) $.ui.toast('Reskin light: ' + made.refused)
  const set = await $.theme.set(made.args)
  return set.isDrawn ? 'drawn' : 'waiting: ' + set.reason
}

export async function syncOnce($: Dollar, atStart = false): Promise<void> {
  if (busy) return
  busy = true
  try {
    const w = await wanted($)
    if (w.key !== painted) await paint($, w, atStart)
  } finally {
    busy = false
  }
}

function label(name: string): string {
  return name === 'off' ? 'off' : name === CUSTOM_WORD ? 'your own colours' : (Object.hasOwn(SKINS, name) ? SKINS[name]!.label : undefined) ?? `your skin "${name}"`
}

const customKey = (c: Custom) => CUSTOM_WORD + ':' + JSON.stringify(c)
const savedKey = (name: string, c: Custom) => 'mine:' + name + ':' + JSON.stringify(c)

// Reskin full looks for this start to know Reskin light put on a saved skin (it then turns its own colours off).
export const SAVED_START = 'Reskin light: your skin "'
// Reskin full's Custom tab (beside Sidebar in its band): while it is open these fields draw under its tabs, and the ✕
// here (key colours-close) closes it there too. Read only; Reskin full owns it.
const FULL_CUSTOM = { plugin: 'skin', key: 'customOpen' } as const
// Which opening of Reskin full's Custom tab is showing: its version counts every open and close.
async function fullTab($: Dollar): Promise<{ open: boolean; version: number }> {
  const r = await $.state.get(FULL_CUSTOM).catch(() => ({ value: false, version: 0 }))
  return { open: r.value === true, version: r.version }
}
// A note belongs to the opening it was written in, so the band always opens clean (the owner, 16 Nov: an old "Saved" line
// showed on opening).
async function setNote($: Dollar, n: Note | null): Promise<void> {
  const stamp = (await fullTab($)).version
  await update($, note, () => (n === null ? null : { ...n, stamp }))
}
export const FULL_COVERS = "If Reskin full's colours are on, they cover these"

/** Save the band's colours under a name, and put them on in every Code tab session. */
export async function saveAs($: Dollar, typed: string): Promise<Note> {
  const name = savedName(typed)
  const problem = nameProblem(name)
  const c = await read($, draft)
  const v = check(c)
  let n: Note
  if (problem !== undefined) n = { tone: 'bad', text: problem }
  else if (!v.ok) n = { tone: 'bad', text: v.refusals.join(' ') + ' Fix that, then save.' }
  else {
    const m = await mine($)
    const had = Object.hasOwn(m, name)
    await $.store.set(MINE_KEY, { ...m, [name]: c })
    await $.store.set('skin', name)
    await paint($, { key: savedKey(name, c), name, custom: c })
    await writeShared($)
    n = { tone: 'ok', text: `${had ? 'Updated' : 'Saved'} "${name}". It is a skin now: pick it in the Skins menu, or type /skin ${name}.` }
  }
  await setNote($, n)
  return n
}

/** Put a saved skin on in every Code tab session. */
async function useSaved($: Dollar, name: string, c: Custom, fullIn: boolean): Promise<{ text: string }> {
  await $.store.set('skin', name)
  const r = await paint($, { key: savedKey(name, c), name, custom: c })
  await update($, draft, () => c)
  const shown = r === 'drawn' ? '' : ' (it shows once this session is the one in view)'
  const full = fullIn ? `\n${FULL_COVERS}: type /skin off, then /skin ${name}.` : ''
  return { text: `${SAVED_START}${name}" on${shown}. Other sessions follow within about 2 seconds.${full}` }
}

// The band's actions, and the /skin custom lines, go through here: one place saves and paints.
export async function applyCustom($: Dollar, c: Custom, done?: string): Promise<Note> {
  // Never keep a malformed choice, not even as the band's draft.
  if (!isCustom(c)) {
    const bad: Note = { tone: 'bad', text: 'Those colours could not be read. Nothing was changed.' }
    await setNote($, bad)
    return bad
  }
  await update($, draft, () => c)
  const v = check(c)
  let n: Note
  if (v.ok) {
    await $.store.set('custom', c)
    await $.store.set('skin', CUSTOM_WORD)
    await paint($, { key: customKey(c), name: CUSTOM_WORD, custom: c })
    n = { tone: 'ok', text: (done ? done + ' ' : '') + `Claude accepts these colours. Text contrast: light ${v.ratio.light.toFixed(1)}:1, dark ${v.ratio.dark.toFixed(1)}:1.` }
  } else {
    n = { tone: 'bad', text: v.refusals.join(' ') + ' Your last good colours stay on until this is fixed.' }
  }
  await setNote($, n)
  return n
}

export async function coloursOff($: Dollar): Promise<Note> {
  await $.store.set('skin', 'off')
  await paint($, { key: 'off', name: 'off' })
  const n: Note = { tone: 'info', text: "Colours off in every Code tab session: Claude's own look is back. Type in a field to start again." }
  await setNote($, n)
  return n
}

// /skin custom [line]. Alone: your saved colours back on (if any) and the colours band opens. With a line: those colours.
export async function customCommand($: Dollar, rest: string, fullIn: boolean): Promise<{ text: string }> {
  const word = rest.trim().toLowerCase()
  const fullLine = fullIn ? "\nIf Reskin full's colours are on, they cover these: type /skin off, then /skin custom." : ''
  const how = ' Pick Light or Dark, type three colour codes (they show as you type), then type a name in "Save as" and press Enter. It becomes a skin: /skin <name> puts it back on.'
  if (word === '' || word === 'band' || word === 'panel') {
    const saved = await savedCustom($)
    const w = await wanted($)
    let first: string
    if (w.custom !== undefined && w.name !== CUSTOM_WORD) {
      // Wearing one of your saved skins: the band starts from it, so saving under the same name updates it.
      await update($, draft, () => w.custom!)
      first = `Your skin "${w.name}" is on.`
    } else if (saved !== undefined) {
      if ((await $.store.get('skin')) !== CUSTOM_WORD) {
        await $.store.set('skin', CUSTOM_WORD)
        await paint($, { key: customKey(saved), name: CUSTOM_WORD, custom: saved })
        first = 'Your colours are back on in every Code tab session.'
      } else first = 'Your colours are on.'
    } else {
      // Nothing saved yet: the band starts from the skin in use, so one colour of it can be changed.
      await update($, draft, () => draftFrom((painted ?? '').split(':')[0]!))
      first = 'Your colours start from the skin you had on.'
    }
    await setNote($, null)
    await update($, bandOpen, () => true)
    return { text: 'Reskin light: ' + first + ' The colours band is open above the message box (✕ closes it).' + how + ' It paints the Code tab in every session; fonts and the Chat tab need Reskin full.' + fullLine }
  }
  if (word === 'forget' || word.startsWith('forget ') || word === 'delete' || word.startsWith('delete ')) {
    const name = savedName(word.replace(/^(forget|delete)\s*/, ''))
    const m = await mine($)
    if (!Object.hasOwn(m, name)) {
      const yours = Object.keys(m)
      return { text: `Reskin light: no saved skin called "${name}". ` + (yours.length > 0 ? `Yours: ${yours.join(', ')}.` : 'You have none saved yet.') }
    }
    const { [name]: _gone, ...rest } = m
    await $.store.set(MINE_KEY, rest)
    await writeShared($)
    let after = ''
    if ((await $.store.get('skin')) === name) {
      await $.store.set('skin', 'off')
      await paint($, { key: 'off', name: 'off' })
      after = " It was on, so Claude's own colours are back."
    }
    return { text: `Reskin light: forgot your skin "${name}".${after}` }
  }
  if (word === 'copy') return { text: 'Reskin light, your colours (paste this line after /skin custom to use it again):\n' + toText(await read($, draft)) }
  if (word === 'fix') {
    const fixed = makeReadable(await read($, draft))
    if (fixed === undefined) return { text: 'Reskin light: no text colour is readable on that background. Pick a background further from the text.' }
    return { text: 'Reskin light: ' + (await applyCustom($, fixed, 'Text made stronger.')).text + fullLine }
  }
  const { custom, unread } = fromText(rest, await read($, draft))
  const n = await applyCustom($, custom)
  const skipped = unread.length > 0 ? ` (I could not read: ${unread.join(' ')}. Colours look like #1e1e2e.)` : ''
  const fixHint = n.tone === 'bad' ? ' Type /skin custom fix to strengthen the text for you.' : fullLine
  return { text: 'Reskin light: ' + n.text + skipped + fixHint + '\nAs one line: ' + toText(custom) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Every mod loaded after this one starts inside next(e); those loaded before have started already. So
    // after it, the command list shows whether Reskin's full flavour (or anyone) owns /skin. Taking it only
    // when free means the full flavour is never refused, whichever loads first (tested 14 Nov, report.md).
    const r = await next(e)
    const owner = (await $.command.list()).find(c => c.name === COMMAND)
    ownsCommand = owner === undefined || owner.plugin === OWN_NAME
    if (ownsCommand) {
      try {
        await $.command.register({ name: COMMAND, description: 'Code tab colours: /skin <skin>, /skin custom (make and save your own skins), /skin off, /skin list', argumentHint: '<skin> | custom | off | list' })
      } catch {
        ownsCommand = false
      }
    }
    painted = undefined
    await syncOnce($, true)
    await writeShared($)
    timer?.cancel()
    // Always watch: the desktop app's Code tab starts its sessions as non-interactive (live round, 14 Nov:
    // a check on isInteractive left every Code tab session without the sync). A -p run ends soon anyway.
    timer = $.clock.every(SYNC_MS, () => void syncOnce($))
    if ((await $.store.get('skin')) === undefined && (await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(`Reskin light: ${label(DEFAULT_SKIN)} colours are on. Type /skin to pick another skin or turn them off.`, { timeoutMs: 8000 })
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // The colours band above the message box (/skin custom opens it in this session, ✕ closes it). Wide and short:
  // each field keeps its width and whole fields wrap to the next line in a narrow window (the owner's live look, 15 Nov: the
  // first version, a side pane, squeezed the fields until the codes were cut off).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const tab = await fullTab($)
    const fromFull = tab.open
    if (!fromFull && !(await read($, bandOpen))) return next(e)
    // Claude Code's own placeholder ({ type: 'engine' }) is never nested (as in the full flavour's band).
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn !== null && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { Box, Text, Input, Select, Button } = $.ui.resolve(e)
    const c = await read($, draft)
    const kept = await read($, note)
    const n = kept !== null && (kept.stamp ?? -1) === tab.version ? kept : null
    const v = check(c)
    const half = await read($, editing)

    // Handlers read the current choice afresh (never `c`, which is what was drawn).
    const now = () => read($, draft)
    const setField = (mode: ModeName, key: keyof Three) => async (typedValue: string) => {
      const cur = await now()
      const value = hex(typedValue)
      if (value === undefined) {
        await setNote($, { tone: 'bad', text: `"${typedValue}" is not a colour code. Use 6 characters like #1e1e2e (or 3, like #fff).` })
        return
      }
      await applyCustom($, { ...cur, [mode]: { ...cur[mode], [key]: value } })
    }
    // Live: a whole 6-digit code shows at once, while typing. Shorter or unfinished text waits for Enter, so the field
    // is never redrawn under the person's fingers (a 3-digit #fff would turn into #ffffff mid-word).
    const liveField = (mode: ModeName, key: keyof Three) => async (typedValue: string) => {
      if (!/^#?[0-9a-f]{6}$/i.test(typedValue.trim())) return
      const cur = await now()
      const value = hex(typedValue)!
      if (cur[mode][key] !== value) await applyCustom($, { ...cur, [mode]: { ...cur[mode], [key]: value } })
    }

    return (
      <Box flexDirection="column">
        {/* Under whatever is drawn beneath (Reskin full's tabs), so its Custom tab sits right above these fields. */}
        {below as any}
        <Box key="colours-band" flexDirection="column" gap={1} paddingX={1}>
          <Box key="colours-top" flexDirection="row" alignItems="center">
            <Box key="colours-fields" flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1} alignItems="center" flexShrink={1} minWidth={0}>
              <Text key="colours-title" bold color={c[half].accent}>Your colours</Text>
              <Box key="colours-half-box" flexShrink={0}>
                <Select key="half" label="Editing" options={MODES.map(m => ({ value: m.mode, label: m.title + (v.bad.includes(m.mode) ? ' ✗' : '') }))}
                  value={half} onSelect={h => void update($, editing, () => h as ModeName)} />
              </Box>
              {FIELDS.map(f => (
                <Box key={`colours-${half}-${f.key}-box`} flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                  <Text color={c[half][f.key]}>●</Text>
                  <Box width={f.label.length + FIELD_CELLS} flexShrink={0}>
                    <Input key={`${half}-${f.key}`} label={f.label} value={c[half][f.key]} submitLabel="apply" onInput={liveField(half, f.key)} onSubmit={setField(half, f.key)} />
                  </Box>
                </Box>
              ))}
            </Box>
            <Box flexGrow={1} />
            <Box key="colours-close-cell" flexShrink={0}>
              <Button key="colours-close" label="✕" plain dimColor onPress={async () => { await update($, bandOpen, () => false); await setNote($, null) }} />
            </Box>
          </Box>
          <Box key="colours-save-row" flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1} alignItems="center">
            <Box key="colours-save-box" width={NAME_CELLS} flexShrink={0}>
              <Input key="save-as" label="Save as" placeholder="my-blue" submitLabel="save" onSubmit={typed => void saveAs($, typed)} />
            </Box>
            {n !== null && (
              <Box key="colours-note" flexShrink={1} minWidth={0}>
                <Text wrap="wrap" color={n.tone === 'bad' ? 'error' : n.tone === 'ok' ? 'success' : undefined} dimColor={n.tone === 'info'}>
                  {n.tone === 'ok' ? '✓ ' : n.tone === 'bad' ? '✗ ' : ''}{n.text}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    // /skin custom is this mod's alone: answered here, never passed on (the full flavour shows this answer).
    if (words[0]?.toLowerCase() === CUSTOM_WORD) {
      try {
        return await customCommand($, e.args.trim().slice(CUSTOM_WORD.length), !ownsCommand)
      } catch (err) {
        return { text: 'Reskin light: something went wrong with your colours (' + String(err).slice(0, 160) + '). Nothing was changed.' }
      }
    }
    // One of your saved skins, alone on the line: painted here. Reskin full turns its own colours off for it in either
    // load order: above this mod it reads SAVED_START in this answer; beneath it, it finds the name in the shared file and
    // answers, and its answer is added here.
    if (words.length === 1) {
      const m = await mine($)
      const own = savedName(words[0]!)
      // Only the name as saved (any case): a spelling the full flavour would refuse ("my_blue") is never one.
      if (Object.hasOwn(m, own) && words[0]!.toLowerCase() === own) {
        const mineAnswer = await useSaved($, own, m[own]!, !ownsCommand)
        if (ownsCommand) return mineAnswer
        const beneath = await next(e)
        if (isUnanswered(beneath) || typeof beneath?.text !== 'string') return mineAnswer
        const kept = mineAnswer.text.split('\n').filter(l => !l.startsWith(FULL_COVERS)).join('\n')
        return { ...beneath, text: `${kept}\n${beneath.text}` }
      }
    }
    const name = commandSkin(words, !ownsCommand)
    // 1. A skin name (or off) as the first word sets the colours, whoever answers the command.
    let result: string | undefined
    if (name !== undefined) {
      await $.store.set('skin', name)
      result = await paint($, { key: name, name })
    }
    // 2. With the full flavour in, it answers (fonts, headers, check, its own tick). Only add one line about these colours.
    if (!ownsCommand) {
      const beneath = await next(e)
      if (isUnanswered(beneath)) return ownAnswer(words, name, result, await nowName($), Object.keys(await mine($)))
      if (name === undefined) {
        // The full flavour's list leaves out your saved skins: add them.
        const yours = Object.keys(await mine($))
        const listing = words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === 'list')
        return listing && yours.length > 0 && typeof beneath?.text === 'string' && !beneath.text.includes('Your skins (Code tab')
          ? { ...beneath, text: `${beneath.text}\nYour skins (Code tab, Reskin light): ${yours.join(', ')}. /skin <name> puts one on.` }
          : beneath
      }
      const line = name === 'off' ? 'Code tab colours (Reskin light): off.' : `Code tab colours (Reskin light): ${label(name)}.`
      return { ...beneath, text: `${beneath.text}\n${line}` }
    }
    return ownAnswer(words, name, result, await nowName($), Object.keys(await mine($)))
  })
}

// The skin a /skin line asks for, or undefined. Only the plain forms count: a skin name or off, alone, with at most
// one --tick (the full flavour lower-cases the line, so case does not matter). The full flavour's one-line commands
// (font, type parts) and every other option change nothing here, so this mod never changes colours on a line the full
// flavour would refuse. Its own whole-app colours cover the Code tab anyway.
// strict (the full flavour is in): the name must also be one the full flavour takes, letters, digits and single
// hyphens only, so a spelling it refuses ("rose_pine", "drá") never changes these colours either.
export function commandSkin(words: string[], strict = false): string | undefined {
  const low = words.map(w => w.toLowerCase())
  const flags = low.filter(w => w.startsWith('-'))
  const rest = low.filter(w => !w.startsWith('-'))
  if (flags.length > 1 || (flags.length === 1 && flags[0] !== '--tick') || rest.length !== 1) return undefined
  if (strict && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rest[0]!)) return undefined
  return skinName(rest[0]!)
}

// What the engine answers when no hook took a command: the full flavour is not beneath this mod.
function isUnanswered(r: { text?: string }): boolean {
  return typeof r?.text === 'string' && /no command\.run hook answered/.test(r.text)
}

async function nowName($: Dollar): Promise<string> {
  return (await wanted($)).name
}

function ownAnswer(words: string[], name: string | undefined, result: string | undefined, now: string, yours: string[] = []): { text: string } {
  const typed = words.join(' ')
  const list = NAMES.map(n => (SHORT[n] !== n ? `${n} (${SHORT[n]})` : n)).join(', ') + (yours.length > 0 ? `. Yours: ${yours.join(', ')}` : '')
  if (name === undefined) {
    if (words.some(w => /^(font|fonts|type|band)$/i.test(w))) {
      return { text: "Reskin light: fonts, project headers and the band need Reskin's full flavour. To change these colours, type /skin <skin> on its own." }
    }
    if (typed === '' || typed.toLowerCase() === 'list') {
      return { text: `Reskin light: now ${label(now)}. Skins: ${list}. Type /skin <skin> (the short name works too), /skin custom for your own colours, or /skin off for Claude's own colours.` }
    }
    return { text: `Reskin light: no skin called "${words[0]}". Skins: ${list}, or off.` }
  }
  if (name === 'off') return { text: "Reskin light: colours off in every Code tab session. Claude's own look is back. /skin <skin> turns them on again." }
  const shown = result === 'drawn' ? '' : ' (it shows once this session is the one in view)'
  return { text: `Reskin light: ${label(name)} on${shown}. Other sessions follow within about 2 seconds.` }
}
