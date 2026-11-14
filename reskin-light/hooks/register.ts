import type { EngineInterface, Register, ThemeSetArgs } from 'claude-code'
import { makeColors } from './make-colors.js'
import { SKINS, ALIASES, type Half } from './skins.js'

// Reskin light: Reskin's 16 skins through Claude's official mod colours ($.theme.set).
// Paints the desktop app's Code tab (chat, sidebar, panels, Settings), both Light and Dark.
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

// What the shared store asks for: one skin name (or off) for every session.
export async function wanted($: Dollar): Promise<{ key: string; name: string }> {
  const v = await $.store.get('skin')
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

async function paint($: Dollar, w: Awaited<ReturnType<typeof wanted>>, atStart = false): Promise<string> {
  painted = w.key
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
  return name === 'off' ? 'off' : SKINS[name]?.label ?? name
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
        await $.command.register({ name: COMMAND, description: 'Code tab colours: /skin <skin>, /skin off, /skin list', argumentHint: '<skin> | off | list' })
      } catch {
        ownsCommand = false
      }
    }
    painted = undefined
    await syncOnce($, true)
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

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
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
      if (name === undefined || isUnanswered(beneath)) return isUnanswered(beneath) ? ownAnswer(words, name, result, await nowName($)) : beneath
      const line = name === 'off' ? 'Code tab colours (Reskin light): off.' : `Code tab colours (Reskin light): ${label(name)}.`
      return { ...beneath, text: `${beneath.text}\n${line}` }
    }
    return ownAnswer(words, name, result, await nowName($))
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

function ownAnswer(words: string[], name: string | undefined, result: string | undefined, now: string): { text: string } {
  const typed = words.join(' ')
  const list = NAMES.map(n => (SHORT[n] !== n ? `${n} (${SHORT[n]})` : n)).join(', ')
  if (name === undefined) {
    if (words.some(w => /^(font|fonts|type|band)$/i.test(w))) {
      return { text: "Reskin light: fonts, project headers and the band need Reskin's full flavour. To change these colours, type /skin <skin> on its own." }
    }
    if (typed === '' || typed.toLowerCase() === 'list') {
      return { text: `Reskin light: now ${label(now)}. Skins: ${list}. Type /skin <skin> (the short name works too), or /skin off for Claude's own colours.` }
    }
    return { text: `Reskin light: no skin called "${words[0]}". Skins: ${list}, or off.` }
  }
  if (name === 'off') return { text: "Reskin light: colours off in every Code tab session. Claude's own look is back. /skin <skin> turns them on again." }
  const shown = result === 'drawn' ? '' : ' (it shows once this session is the one in view)'
  return { text: `Reskin light: ${label(name)} on${shown}. Other sessions follow within about 2 seconds.` }
}
