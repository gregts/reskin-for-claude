#!/usr/bin/env node
// Reskin for Claude. Talks to Claude's own "Enable Main Process Debugger"
// port (127.0.0.1:9229) for a few seconds, does one job, then closes the port
// and checks it is really closed. Never patches or restarts Claude.
//
//   node skin.mjs probe            read-only: list Claude's windows and its colour variables
//   node skin.mjs apply <file.css> put a stylesheet on every Claude window (replaces the last one)
//   node skin.mjs remove           take the stylesheet off and unhook it
//   node skin.mjs close            only close the port
//
// Before each run the user ticks Developer > Enable Main Process Debugger in Claude.
// This guards against connecting to the wrong program by accident; it is not a
// wall against hostile software already running as the user (nothing could be).

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_STACKS, FONT_SIZES, SIZE_LEADING, splitFontKey, LOOK_PARTS, LOOK_ORDER, parseLook, slotOf, HELPER_GEN, TICK, claudePidOf, parseListener, socketOwner, tcpProbe, waitForTick } from './skin-lib.mjs'

const PORT = 9229
const HOST = '127.0.0.1'
const APP = '/Applications/Claude.app'
const BINARY = `${APP}/Contents/MacOS/Claude`
const REQUIREMENT = 'identifier "com.anthropic.claudefordesktop" and anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"'
// The whole job, from connecting to closing, must fit in this.
const BUDGET_MS = 18_000
// Claude closes its own port after this, even if this script dies.
const FALLBACK_CLOSE_MS = 22_000
// --patient ("I tick it" mode): extra time for connecting and the identity check, before the job budget starts. On a Mac
// without Chrome, Claude is frozen until the user clicks OK on its "Inspector session is active" message.
export const PATIENT_MS = 20_000
// The colour helper's private folder. RESKIN_STATE_DIR is for tests.
export const STATE_DIR = process.env.RESKIN_STATE_DIR || path.join(homedir(), 'Library', 'Application Support', 'claude-skin')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000 })
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', failed: r.error !== undefined || r.signal !== null }
}

// Who listens on the port: 'none', one { pid, names }, or throws when unsure.
function listener() {
  return parseListener(run('/usr/sbin/lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpn']), PORT)
}

// The same commands without blocking, so the owner check can run while the connection is being made.
function runAsync(cmd, args, ms = 5_000) {
  return new Promise((resolve) => {
    let out = '', err = ''
    let p
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { resolve({ status: null, out, err, failed: true }); return }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, ms)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', () => { clearTimeout(t); resolve({ status: null, out, err, failed: true }) })
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ status: code, out, err, failed: signal !== null }) })
  })
}
// Who listens now, and is it the very Claude process checked before the prompt (same pid, Claude's own binary, this Mac
// only)? Throws on anything else. Its signature was checked before the prompt, so only lsof and ps run here.
async function checkOwnerFast(claudePid) {
  const [l, comm] = await Promise.all([
    runAsync('/usr/sbin/lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpn']).then(r => parseListener(r, PORT)),
    runAsync('/bin/ps', ['-p', String(claudePid), '-o', 'comm=']),
  ])
  if (l === 'none') throw new Error(`Port ${PORT} closed again before I could connect.`)
  if (l.pid !== claudePid) throw new Error(`Port ${PORT} belongs to process ${l.pid}, not the Claude checked before (${claudePid}). Stopping.`)
  if (comm.failed || comm.status !== 0 || comm.out.trim() !== BINARY) throw new Error(`Process ${claudePid} is no longer Claude. Stopping.`)
  for (const n of l.names) if (n !== `${HOST}:${PORT}`) throw new Error(`Port ${PORT} listens on ${n}, not only ${HOST}. Stopping.`)
  return l
}

// The owner check above looks at the port, not at our connection. Once connected, and before anything
// is sent, the kernel must show that the other end of every connection we hold to the port is inside the checked Claude.
// A program that took the port after the owner check holds that end itself and is refused here; it never gets code.
// One retry after 100 ms: a finished HTTP connection that closes between the two snapshots must not fail a
// genuine run; a program holding the other end fails both looks.
async function checkSocket(claudePid) {
  const args = (pid) => ['-nP', '-a', '-p', String(pid), `-iTCP:${PORT}`, '-sTCP:ESTABLISHED', '-Fn']
  let r
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((res) => setTimeout(res, 100))
    const [mine, theirs] = await Promise.all([runAsync('/usr/sbin/lsof', args(process.pid)), runAsync('/usr/sbin/lsof', args(claudePid))])
    r = socketOwner(mine, theirs, PORT)
    if (r.ok) return
  }
  throw new Error(`${r.why} Stopping; nothing was sent.`)
}

function checkSignature() {
  const r = run('/usr/bin/codesign', ['--verify', '--strict', `-R=${REQUIREMENT}`, APP])
  if (r.failed || r.status !== 0) throw new Error(`Claude's signature did not verify: ${r.err.trim()}`)
}

// The port must belong to the real Claude app, and listen on this Mac only.
function checkOwner(l) {
  const r = run('/bin/ps', ['-p', String(l.pid), '-o', 'comm='])
  const path = r.out.trim()
  if (r.failed || r.status !== 0 || path !== BINARY) throw new Error(`Port ${PORT} belongs to "${path}", not Claude. Stopping.`)
  for (const n of l.names) {
    if (n !== `${HOST}:${PORT}`) throw new Error(`Port ${PORT} listens on ${n}, not only ${HOST}. Stopping.`)
  }
  const dyn = run('/usr/bin/codesign', ['--verify', `-R=${REQUIREMENT}`, String(l.pid)])
  if (dyn.failed || dyn.status !== 0) throw new Error(`The running Claude (pid ${l.pid}) did not pass the signing check: ${dyn.err.trim()}`)
}

function withDeadline(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${what}.`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function connect(deadline) {
  const left = () => Math.max(1, (typeof deadline === 'function' ? deadline() : deadline) - Date.now())
  // The request and reading its body share one deadline that really aborts.
  const abort = new AbortController()
  const targets = await withDeadline(
    fetch(`http://${HOST}:${PORT}/json/list`, { redirect: 'error', signal: abort.signal }).then(res => res.json()),
    left(),
    'listing the debugger target',
  ).finally(() => abort.abort())
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0].type !== 'node') {
    throw new Error(`Expected one Node target, found: ${JSON.stringify(targets).slice(0, 300)}`)
  }
  const url = new URL(targets[0].webSocketDebuggerUrl)
  if (url.protocol !== 'ws:' || url.hostname !== HOST || url.port !== String(PORT) || url.username !== '' || url.password !== '') {
    throw new Error(`Unexpected debugger address ${url.href}`)
  }
  const ws = new WebSocket(url)
  try {
    await withDeadline(
      new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('Could not connect to the debugger.'))
      }),
      left(),
      'connecting to the debugger',
    )
  } catch (err) {
    try { ws.close() } catch {}
    throw err
  }
  let id = 0
  const waiting = new Map()
  ws.onmessage = ev => {
    let msg
    try { msg = JSON.parse(String(ev.data)) } catch { return } // not a reply we can read: ignore it
    if (msg === null || typeof msg !== 'object') return
    const w = waiting.get(msg.id)
    if (w !== undefined) {
      waiting.delete(msg.id)
      w.resolve(msg)
    }
  }
  ws.onclose = () => {
    for (const w of waiting.values()) w.reject(new Error('The debugger connection closed.'))
    waiting.clear()
  }
  // Runs an async expression in Claude's main process and returns its JSON value.
  const evaluate = (expression, ms = left()) => {
    const n = ++id
    const p = new Promise((resolve, reject) => {
      waiting.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    }).then(msg => {
      if (msg.error) throw new Error(msg.error.message)
      const r = msg.result
      if (r === undefined || r === null || r.result === undefined) throw new Error('Claude sent back an answer in a shape I do not understand.')
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    })
    return withDeadline(p, ms, 'waiting for Claude').catch(err => {
      waiting.delete(n)
      throw err
    })
  }
  return { ws, evaluate }
}

// Code that runs inside Claude's main process. It reaches Electron through
// Node's own module loader; it makes no network calls.
const ELECTRON = `(() => process.getBuiltinModule('module').createRequire(process.execPath)('electron'))()`

// First thing after connecting, read-only: which process is this?
const IDENTIFY = `({ pid: process.pid, execPath: process.execPath, type: process.type })`

// P9: Claude's "Enable Main Process Debugger" item keeps its tick after the
// debugger is closed from outside, and Claude's click handler opens the debugger whenever it is closed. So a stale tick
// turns the user's "untick" into an open. Every close also clears that tick. It only sets `checked` (what the menu
// shows): it never calls the item's click handler, so it can never reopen the debugger. Best effort, never throws.
// It answers what it did, so the run can warn when the tick could not be cleared ({ found, ticked }: how many
// matching items, and how many still show a tick afterwards; or { error }).
const UNTICK = `(() => { try {
  const menu = process.getBuiltinModule('module').createRequire(process.execPath)('electron').Menu.getApplicationMenu()
  let found = 0, ticked = 0
  const walk = (items) => { for (const it of items) { if (it.label === 'Enable Main Process Debugger' && it.type === 'checkbox') { found++; it.checked = false; if (it.checked) ticked++ } if (it.submenu) walk(it.submenu.items) } }
  if (menu) walk(menu.items)
  return { found, ticked }
} catch (e) { return { error: String(e?.message ?? e).slice(0, 120) } } })()`

// Once it is confirmed: a close that fires inside Claude even if this script dies. A tick-mode apply (--quick) uses the
// short TICK.armMs; everything else (removal with page reloads, batch, probes) keeps FALLBACK_CLOSE_MS.
const arm = (ms) => `(() => {
  const inspector = process.getBuiltinModule('inspector')
  clearTimeout(globalThis.__reskinFallback)
  globalThis.__reskinFallback = setTimeout(() => { ${UNTICK}; try { inspector.close() } catch {} }, ${ms})
  return true
})()`
const ARM = arm(FALLBACK_CLOSE_MS)

// Read-only. The page script runs in an isolated world, so the page's own
// scripts cannot change what it sees or reach it.
const PROBE = `(async () => {
  const { webContents, nativeTheme } = ${ELECTRON}
  const out = [{ nativeTheme: { themeSource: nativeTheme.themeSource, shouldUseDarkColors: nativeTheme.shouldUseDarkColors } }]
  for (const w of webContents.getAllWebContents()) {
    let origin = ''
    try { origin = new URL(w.getURL()).origin } catch {}
    const row = { id: w.id, type: w.getType(), url: w.getURL().slice(0, 120) }
    if (origin === 'https://claude.ai') {
      row.page = await Promise.resolve().then(() => w.executeJavaScriptInIsolatedWorld(4242, [{ code: \`(() => {
        const html = document.documentElement
        const vars = new Set()
        // Which selectors (and inside which @media or @supports) declare the grey ramp, the --df-* overlays and the fonts.
        const declarers = Object.create(null)
        // Accent census: every rule declaration whose value uses Claude's accent or blue tokens (selector, property, value).
        const accentUsers = new Map()
        let skipped = 0
        const walk = (rules, where, depth) => {
          if (depth > 8) return
          for (const rule of rules) {
            try {
              if (rule.styleSheet) { walk(rule.styleSheet.cssRules, where + '@import ', depth + 1); continue }
              const tag = rule.conditionText ? '@' + rule.conditionText + ' ' : rule.name !== undefined && !rule.style ? '@layer ' + rule.name + ' ' : ''
              // Grouping rules (@media, @supports, @layer) and nested rules inside a style rule.
              if (rule.cssRules && rule.cssRules.length > 0) walk(rule.cssRules, where + tag + (rule.selectorText ? rule.selectorText + ' > ' : ''), depth + 1)
              const style = rule.style
              if (!style) continue
              for (let i = 0; i < style.length; i++) {
                const p = style[i]
                if (/^--(bg|text|accent|border|cds-|df-|font-)/.test(p)) vars.add(p)
                const val = String(style.getPropertyValue?.(p) ?? '')
                if (/accent|cds-blue|tint-blue|highlight-blue/.test(val) && accentUsers.size < 400) {
                  const k = (where + (rule.selectorText ?? '')).slice(0, 140) + ' { ' + p + ': ' + val.trim().slice(0, 120) + ' }'
                  accentUsers.set(k, (accentUsers.get(k) ?? 0) + 1)
                }
                const group = /^--cds-gray-/.test(p) ? 'gray' : /^--df-/.test(p) ? 'df' : /^--(cds-)?font-(sans|display|serif|mono|system|voice|ui|body|heading)/.test(p) ? 'font' : ''
                if (group === '') continue
                const key = (where + (rule.selectorText ?? '')).slice(0, 160)
                if (!(key in declarers) && Object.keys(declarers).length >= 200) { skipped++; continue }
                const d = (declarers[key] ??= { gray: 0, df: 0, font: 0 })
                d[group]++
              }
            } catch { skipped++ }
          }
        }
        for (const sheet of document.styleSheets) {
          let rules
          try { rules = sheet.cssRules } catch { continue }
          try { walk(rules, '', 0) } catch { skipped++ }
        }
        const cs = getComputedStyle(html)
        return {
          htmlClass: html.className,
          htmlData: Object.fromEntries(Object.entries(html.dataset)),
          colorScheme: cs.colorScheme,
          declarers, declarersSkipped: skipped,
          accentUsers: [...accentUsers.keys()],
          // Frame variables have values only inside the frame, so read them there; and what selected or current rows paint.
          frame: (() => {
            const root = document.querySelector('.dframe-root')
            if (!root) return null
            const fcs = getComputedStyle(root)
            return [...vars].filter(v => v.startsWith('--df-')).sort().map(v => [v, fcs.getPropertyValue(v).trim()]).filter(([, value]) => value !== '').map(([k, value]) => k + ': ' + value.slice(0, 120))
          })(),
          // Is a skin on while probing? (A probe taken with a skin on reads skinned values.)
          skinMarker: cs.getPropertyValue('--reskin-active').trim(),
          // Every element whose classes use the row colours, inside the sidebar or not.
          dfConsumers: (() => {
            const seen = new Map()
            for (const el of document.querySelectorAll('[class*="--df-hover"], [class*="--df-selected"]')) {
              const cls = String(el.className)
              const uses = (cls.match(/var[(]--df-(hover|selected)/g) ?? []).map(u => u.slice(4)).sort().join(',')
              const key = (el.closest('.dframe-sidebar') ? 'sidebar' : 'outside') + '|' + el.tagName.toLowerCase() + '|' + uses
              const e = seen.get(key) ?? { where: key.split('|')[0], tag: el.tagName.toLowerCase(), uses, n: 0, sample: cls.slice(0, 120) }
              e.n++
              seen.set(key, e)
            }
            return [...seen.values()].slice(0, 30)
          })(),
          selectedRows: (() => {
            const seen = new Map()
            for (const el of document.querySelectorAll('[aria-current]:not([aria-current=false]), [aria-selected=true], [data-selected]:not([data-selected=false]), [data-active]:not([data-active=false]), [data-state=active], [data-state=on]')) {
              const c = getComputedStyle(el)
              const cls = String(el.className)
              const key = el.tagName.toLowerCase() + '|' + c.backgroundColor + '|' + !!el.closest('.dframe-sidebar') + '|' + (cls.match(/var[(]--df-[a-z-]+/g) ?? []).join(',')
              if (seen.has(key)) { seen.get(key).n++; continue }
              const attrs = ['aria-current', 'aria-selected', 'data-selected', 'data-active', 'data-state'].filter(a => el.hasAttribute(a)).map(a => a + '=' + el.getAttribute(a)).join(' ')
              seen.set(key, { n: 1, tag: el.tagName.toLowerCase(), attrs, bg: c.backgroundColor, inSidebar: !!el.closest('.dframe-sidebar'), vars: (cls.match(/var[(][^)]*[)]/g) ?? []).slice(0, 6).join(' '), cls: cls.slice(0, 160) })
            }
            return [...seen.values()].slice(0, 25)
          })(),
          prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
          vars: [...vars].sort().map(v => [v, cs.getPropertyValue(v).trim()]).filter(([, value]) => value !== '').map(([k, value]) => k + ': ' + value),
          frames: ['.dframe-content', '.dframe-sidebar', '.dframe-sidebar-body'].map(s => [s, !!document.querySelector(s)]),
          // Which background colours are really painted, how many elements use each, and one example element.
          paints: (() => {
            const seen = new Map()
            for (const el of document.querySelectorAll('body *')) {
              const bg = getComputedStyle(el).backgroundColor
              if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
              const e = seen.get(bg) ?? { bg, n: 0, sample: '' }
              e.n++
              if (e.sample === '') e.sample = el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 4).join('.')
              seen.set(bg, e)
            }
            return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 15)
          })(),
        }
      })()\` }])).catch(err => ({ error: String(err?.message ?? err).slice(0, 200) }))
    }
    out.push(row)
  }
  return out
})()`

// Health check, the page side (17 Oct 2026). Read-only, in its own isolated world: computed
// styles and querySelector only, no page-wide walks. Each part answers { on, v }: on false = not on screen now, on true with
// v null = on screen but unreadable (never a pass); the session dot may add present: true to on false (dots there, none
// readable: not checked). Only colours in #rrggbb or rgb()/rgba() form leave the page (any other
// form goes through a detached canvas and must come out in that form), so no text, class name or address can ride along.
const HEALTH_PAGE = `(() => {
  const ok = (v) => /^#[0-9a-f]{6}$/i.test(v) || /^rgba?\\([0-9., %/]*\\)$/.test(v)
  const g = new OffscreenCanvas(1, 1).getContext('2d')
  const norm = (raw) => {
    const v = String(raw ?? '').trim()
    if (v === '') return null
    if (ok(v)) return v
    g.fillStyle = '#010203'; g.fillStyle = v
    const o = String(g.fillStyle)
    return o === '#010203' || !ok(o) ? null : o
  }
  const q = (s) => document.querySelector(s)
  const html = document.documentElement
  const part = (el, read) => el ? { on: true, v: norm(read(getComputedStyle(el))) } : { on: false, v: null }
  const bg = (el) => part(el, (c) => c.backgroundColor)
  const fg = (el) => part(el, (c) => c.color)
  const tok = (el, n) => part(el, (c) => c.getPropertyValue(n))
  // The first element with this class and none of the other skinned classes of its kind (two at once: the later rule wins).
  const BG = '.bg-surface-1, .bg-bg-100, .bg-surface-2, .bg-surface-3, .bg-bg-000, .bg-bg-200, .bg-bg-300'
  const TX = '.text-primary, .text-text-100, .text-secondary, .text-text-300, .text-text-400, .text-text-500'
  // One querySelector with the other classes excluded in the selector itself: the browser stops at the first match, so a
  // page with thousands of candidates costs no more than one lookup.
  const only = (sel, all, mine) => { const not = all.split(', ').filter((c) => !mine.includes(c)).map((c) => ':not(' + c + ')').join(''); return q(sel.split(', ').map((s) => s + not).join(', ')) }
  // A dot not drawn as it is styled is unreadable, so the next dot is tried: the browser's own visibility test fails
  // (display none, content-visibility skipping, visibility, opacity 0); less than 2x2 px of its box is left inside the
  // window and every clipping box above it; it or anything above it is faded, filtered, masked, clipped, blended, squashed
  // or flipped into a line by a transform (only flat 2D transforms that keep at least a quarter of the area count), or
  // under content-visibility hidden; or the walk is too deep. Any error: unreadable.
  const flat = (c) => {
    const t = c.transform
    if (t && t !== 'none') {
      const m = /^matrix\\(([^)]*)\\)$/.exec(t)
      if (!m) return false
      const [a, b, cc, d] = m[1].split(',').map(Number)
      if (!(Math.abs(a * d - b * cc) >= 0.25)) return false
    }
    if (c.scale && c.scale !== 'none' && !c.scale.trim().split(/\\s+/).every((n) => Math.abs(parseFloat(n)) >= 0.5)) return false
    return !(c.clip && c.clip !== 'auto')
  }
  const drawnPlain = (el) => {
    try {
      if (typeof el.checkVisibility !== 'function' || !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false
      const r = el.getBoundingClientRect()
      const v = { l: Math.max(r.left, 0), t: Math.max(r.top, 0), r: Math.min(r.right, innerWidth), b: Math.min(r.bottom, innerHeight) }
      const own = getComputedStyle(el)
      if (own.visibility === 'hidden' || own.visibility === 'collapse') return false
      let steps = 0
      for (let e = el; e; e = e.parentElement) {
        if (++steps > 64) return false
        const c = getComputedStyle(e)
        if (Number(c.opacity) !== 1) return false
        if ((c.filter && c.filter !== 'none') || (c.mask && c.mask !== 'none') || (c.clipPath && c.clipPath !== 'none')) return false
        if (c.mixBlendMode && c.mixBlendMode !== 'normal') return false
        if (!flat(c)) return false
        if (e !== el) {
          if (c.contentVisibility === 'hidden') return false // auto on screen is fine; skipped auto fails above
          if ((c.overflowX && c.overflowX !== 'visible') || (c.overflowY && c.overflowY !== 'visible')) {
            const k = e.getBoundingClientRect()
            v.l = Math.max(v.l, k.left); v.t = Math.max(v.t, k.top); v.r = Math.min(v.r, k.right); v.b = Math.min(v.b, k.bottom)
          }
        }
      }
      return v.r - v.l >= 2 && v.b - v.t >= 2
    } catch { return false }
  }
  // What one session dot really paints, or null when its form cannot be read safely: a drawn, filled dot with no image
  // and no inset shadow over it (an outer shadow draws outside the dot and cannot cover its colour), or Claude's hollow
  // ring in its exact form (an inset 1px shadow in the dot colour, then a 0.5px ring in the page colour).
  const paintOne = (el) => {
    if (!drawnPlain(el)) return null
    const c = getComputedStyle(el)
    if (c.backgroundImage && c.backgroundImage !== 'none') return null
    const b = norm(c.backgroundColor)
    const clear = b === null || b === 'transparent' || /^rgba\\([^)]*,\\s*0\\)$/.test(b)
    if (!clear) return !c.boxShadow || c.boxShadow === 'none' || !/inset/.test(c.boxShadow) ? b : null
    const m = /^(rgba?\\([0-9., ]*\\)) 0px 0px 0px 1px inset, rgba?\\([0-9., ]*\\) 0px 0px 0px 0\\.5px$/.exec(c.boxShadow)
    return m ? norm(m[1]) : null
  }
  // The first of the sidebar's dots (at most 50 looked at) whose paint can be read. Dots there but none readable: not
  // checked (present says so, for an honest report), never a pass.
  const paintOf = (side) => {
    const all = side ? [...side.querySelectorAll('[data-cds=Pulse]')].slice(0, 50) : []
    for (const el of all) { const v = paintOne(el); if (v !== null) return { on: true, v } }
    return all.length ? { on: false, v: null, present: true } : { on: false, v: null }
  }
  const side = q('.dframe-sidebar')
  const pulse = side ? side.querySelector('[data-cds=Pulse]') : null
  return {
    ready: document.readyState,
    marker: getComputedStyle(html).getPropertyValue('--reskin-active').trim() === '1',
    typeMarker: getComputedStyle(html).getPropertyValue('--reskin-type').trim() === '1',
    // Type (numbers only): how many project headers the type sheet's header rule and current-project rule find now.
    typeHeaders: side ? side.querySelectorAll('.df-label-inset h3 span.inline-block.whitespace-nowrap').length : 0,
    typeCurrent: (() => { try { return side ? side.querySelectorAll('div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset h3 span.inline-block.whitespace-nowrap').length : 0 } catch { return -1 } })(),
    // Fonts (font names only, never page text): the computed family of the first visible element of each kind, or null.
    fonts: (() => {
      const shown = (el) => { try { return el.getClientRects().length > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) } catch { return false } }
      const fam = (root, sel) => { try { for (const el of [...(root ? root.querySelectorAll(sel) : [])].slice(0, 50)) if (shown(el)) return String(getComputedStyle(el).fontFamily).slice(0, 200); return null } catch { return null } }
      const main = q('.dframe-content') ?? document.body
      return { paragraph: fam(main, 'p'), list: fam(main, 'li'), bold: fam(main, 'strong'), composer: fam(document, '.ProseMirror, [contenteditable=true]'), sidebarRow: fam(side, '[data-row]') }
    })(),
    // Sizes (numbers only, never page text): computed font size and line height in px of the first visible chat
    // paragraph and of the message box, or null (none on screen, or not a plain px number).
    // Only text really on screen counts: visible to the browser, and at least 4x4 px of it inside the window and inside
    // every scrolling or clipping box above it (an off-screen paragraph never stands in for the one shown). Chat text is
    // a reply paragraph (inside Claude's markdown block .prose, not inside an editor); none on screen means not checked.
    sizes: (() => {
      const shown = (el) => {
        try {
          if (el.getClientRects().length === 0 || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return false
          const r = el.getBoundingClientRect()
          let l = Math.max(r.left, 0), t = Math.max(r.top, 0), rr = Math.min(r.right, innerWidth), b = Math.min(r.bottom, innerHeight)
          let n = 0
          for (let a = el.parentElement; a && n < 60; a = a.parentElement, n++) {
            const c = getComputedStyle(a)
            if (c.overflowX === 'visible' && c.overflowY === 'visible') continue
            const ar = a.getBoundingClientRect()
            l = Math.max(l, ar.left); t = Math.max(t, ar.top); rr = Math.min(rr, ar.right); b = Math.min(b, ar.bottom)
          }
          return n < 60 && rr - l >= 4 && b - t >= 4
        } catch { return false }
      }
      const num = (v) => { const m = /^([0-9]+(?:[.][0-9]+)?)px$/.exec(String(v)); return m ? Number(m[1]) : null }
      const one = (root, sel) => {
        try {
          for (const el of [...(root ? root.querySelectorAll(sel) : [])].slice(0, 50)) {
            if (!shown(el)) continue
            const c = getComputedStyle(el), size = num(c.fontSize), line = num(c.lineHeight)
            return size === null || line === null ? null : { size, line }
          }
          return null
        } catch { return null }
      }
      // A reply paragraph: inside Claude's rendered markdown block (.prose), not inside an editor. None = not checked.
      let chat = []
      try { chat = [...document.querySelectorAll('.prose p')].filter((p) => !p.closest('.ProseMirror, [contenteditable]')) } catch {}
      const first = (els) => { try { for (const el of els.slice(0, 50)) if (shown(el)) { const c = getComputedStyle(el), size = num(c.fontSize), line = num(c.lineHeight); return size === null || line === null ? null : { size, line } } return null } catch { return null } }
      return { paragraph: first(chat), composer: one(document, '.ProseMirror, [contenteditable=true]') }
    })(),
    // Font picker (4 Nov 2026): per section, the first shown element of each kind (font names and numbers only, never
    // page text): family, size, line height, weight. Chat: a reply paragraph and the message box (the same selector the
    // chat parts use). Rows: the first text span inside a session row button that is not an icon. Headers: the first
    // header of a project that is neither active nor current (plain), and the first that is (emphasised). Everything
    // else: the first shown button in the chat area. null = none shown.
    look: (() => {
      const shown = (el) => {
        try {
          if (el.getClientRects().length === 0 || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return false
          const r = el.getBoundingClientRect()
          return r.width >= 4 && r.height >= 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
        } catch { return false }
      }
      const num = (v) => { const m = /^([0-9]+(?:[.][0-9]+)?)(px)?$/.exec(String(v)); return m ? Number(m[1]) : null }
      const read = (el) => { const c = getComputedStyle(el); return { family: String(c.fontFamily).slice(0, 200), size: num(c.fontSize), line: num(c.lineHeight), weight: num(c.fontWeight) } }
      const icon = (el) => { try { return !!el.closest('[data-cds=Icon], svg') || /anthropicons/i.test(getComputedStyle(el).fontFamily) } catch { return true } }
      const ownText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim() !== '') return true; return false }
      const firstOf = (list, ok = () => true) => { try { for (const el of list.slice(0, 80)) if (ok(el) && shown(el)) return read(el) } catch {} return null }
      const all = (root, sel) => { try { return root ? [...root.querySelectorAll(sel)] : [] } catch { return [] } }
      let chat = []
      try { chat = [...document.querySelectorAll('.prose p')].filter((p) => !p.closest('.ProseMirror, [contenteditable]')) } catch {}
      const rowText = () => { for (const b of all(side, 'button[data-row], [data-row] button').slice(0, 60)) { for (const el of [b, ...b.querySelectorAll('*')].slice(0, 40)) if (!icon(el) && ownText(el) && shown(el)) return read(el) } return null }
      const H = '.df-label-inset h3 span.inline-block.whitespace-nowrap'
      const hot = (el) => { try { return !!el.closest('div.isolate.rounded-lg:has([data-cds=Pulse]), div.isolate.rounded-lg:has([aria-current=page])') } catch { return true } }
      return {
        paragraph: firstOf(chat), composer: firstOf(all(document, '.ProseMirror[contenteditable=true]')),
        row: rowText(),
        header: firstOf(all(side, H), (el) => !hot(el)), headerEmph: firstOf(all(side, H), hot),
        ui: firstOf(all(q('.dframe-content') ?? document.body, 'button'), (el) => !el.closest('.prose') && !icon(el) && ownText(el)),
      }
    })(),
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    anchors: { root: !!q('.dframe-root'), sidebar: !!side, content: !!q('.dframe-content'), rows: !!(side && side.querySelector('[data-row]')) },
    parts: {
      surface1: tok(html, '--cds-surface-1'), textPrimary: tok(html, '--cds-text-primary'), accentFill: tok(html, '--cds-role-accent-fill'),
      bodyBg: bg(document.body), sidebarBg: bg(side), contentBg: bg(q('.dframe-content')), sidebarBody: bg(q('.dframe-sidebar-body')),
      dfHover: tok(side, '--df-hover'), dfSelected: tok(side, '--df-selected'),
      surface2: bg(only('.bg-surface-2', BG, ['.bg-surface-2'])), bg000: bg(only('.bg-surface-3, .bg-bg-000', BG, ['.bg-surface-3', '.bg-bg-000'])),
      bg200: bg(only('.bg-bg-200, .bg-bg-300', BG, ['.bg-bg-200', '.bg-bg-300'])), textClass: fg(only('.text-primary, .text-text-100', TX, ['.text-primary', '.text-text-100'])),
      pulsePaint: paintOf(side),
      pulseUnread: tok(pulse, '--cds-fill-accent'), pulseWaiting: tok(pulse, '--cds-fill-warning'), pulseError: tok(pulse, '--cds-fill-danger'), pulseRunning: tok(pulse, '--cds-text-muted'),
    },
  }
})()`

// The apply logic, kept inside Claude as `st.apply(css, reset, batch)`: one stylesheet per window, changed one step at a
// time per window, with the hooks that re-apply it after a reload or on a new window. `css` null = Off, which also
// removes the hooks. `batch` true marks the sheet as a batch test skin (set at once, so even an interrupted batch leaves
// the mark); false clears the mark, but only when this run fully succeeded. Each injection installs the newest version;
// the colour helper (installHelper) calls the same function later, without the debugger.
const CORE = `const { app, webContents } = ${ELECTRON}
  const st = globalThis.__reskin ?? (globalThis.__reskin = { css: null, keys: new Map(), queues: new Map(), hooks: null, errors: [] })
  // Type slot (2 Nov 2026): a second, separate sheet (sidebar header type), with its own keys, run number and marker
  // (--reskin-type). Colour Off leaves it alone; remove and reset clear it. A state left by older code gets it here.
  st.type ??= { css: null, keys: new Map(), orphans: new Map(), gen: 0 }
  // dirty: a type sheet may still be on some page (set by every type change, cleared only once a type off is proven on every
  // page), so a later removal never skips the type cleanup on the strength of empty bookkeeping.
  const typeDirty = () => st.type.css !== null || st.type.keys.size > 0 || st.type.orphans.size > 0 || st.type.dirty === true
  st.typeDirty = typeDirty
  const isClaudePage = w => { try { return !w.isDestroyed() && new URL(w.getURL()).origin === 'https://claude.ai' } catch { return false } }
  // Reload and new-window hooks, shared by both slots: they stay while either sheet is on. Hooks made by older code
  // (no v) only put the colours back, so they are replaced.
  const HOOKS_V = 3
  st.watch = w => {
    if (st.hooks.watched.has(w.id)) return
    const onLoad = () => { st.work = (st.work ?? 0) + 1; if (st.css !== null) void st.put?.(w); if (st.type.css !== null) void st.putType(w) }
    const onGone = () => { st.keys.delete(w.id); st.queues.delete(w.id); st.type.keys.delete(w.id); st.type.orphans.delete(w.id); st.hooks?.watched.delete(w.id) }
    w.on('did-finish-load', onLoad)
    w.once('destroyed', onGone)
    st.hooks.watched.set(w.id, { w, onLoad, onGone })
  }
  st.hookDown = (force = false) => {
    if (st.hooks !== null && (force || (st.css === null && st.type.css === null))) {
      app.removeListener('web-contents-created', st.hooks.onCreated)
      for (const { w, onLoad, onGone } of st.hooks.watched.values()) {
        if (!w.isDestroyed()) { w.removeListener('did-finish-load', onLoad); w.removeListener('destroyed', onGone) }
      }
      st.hooks = null
    }
  }
  st.hookUp = () => {
    if (st.hooks !== null && st.hooks.v !== HOOKS_V) st.hookDown(true)
    if ((st.css !== null || st.type.css !== null) && st.hooks === null) {
      st.hooks = { v: HOOKS_V, watched: new Map(), onCreated: (_e, w) => st.watch(w) }
      app.on('web-contents-created', st.hooks.onCreated)
    }
    if (st.hooks !== null) for (const w of webContents.getAllWebContents()) st.watch(w)
  }
  // One type change at a time per window, in the same per-window queue as the colours, so the two never interleave.
  st.putType = (w, errors = st.type.errors ?? []) => {
    const id = w.id
    const T = st.type
    const gen = T.gen
    st.work = (st.work ?? 0) + 1
    const prev = st.queues.get(id) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (w.isDestroyed()) { T.keys.delete(id); return }
      if (T.css !== null && !isClaudePage(w)) return // only the Claude page, like the colours
      const old = T.keys.get(id)
      if (T.css === null) {
        if (old !== undefined) { await w.removeInsertedCSS(old); T.keys.delete(id) }
        const left = []
        for (const k of T.orphans.get(id) ?? []) {
          try { await w.removeInsertedCSS(k) } catch (e) { left.push(k); errors.push('could not remove an old type sheet: ' + String(e)) }
        }
        if (left.length > 0) T.orphans.set(id, left); else T.orphans.delete(id)
        return
      }
      // An insert in flight keeps the slot marked as maybe on, and any insert that lands marks it again: nothing may
      // declare the type sheet gone while one could still arrive (a late insert whose removal silently fails).
      T.pending = (T.pending ?? 0) + 1
      T.seq = (T.seq ?? 0) + 1 // every insert ever started: a proof counts only if none started while it ran
      T.dirty = true
      let key
      try { key = await w.insertCSS(T.css + ' html { --reskin-type: 1 !important; }', { cssOrigin: 'author' }) } finally { T.pending-- }
      T.dirty = true
      if (w.isDestroyed()) return
      if (T.gen !== gen) { try { await w.removeInsertedCSS(key) } catch { T.orphans.set(id, [...(T.orphans.get(id) ?? []), key]) } return }
      T.keys.set(id, key)
      if (old !== undefined) {
        try { await w.removeInsertedCSS(old) } catch (e) { T.orphans.set(id, [...(T.orphans.get(id) ?? []), old]); throw e }
      }
    }).catch(err => { if (errors.length < 20) errors.push(String(err)) }) // reload re-puts land in the last run's list: keep it small
      .finally(() => { if (st.queues.get(id) === next) st.queues.delete(id) })
    st.queues.set(id, next)
    return next
  }
  // st.applyType(css): css null = type off. Proven like the colours: on = the type marker on every Claude page; off =
  // the marker gone, or that page reloaded (a reload drops every inserted sheet; the hooks put the colours back).
  st.applyType = async (css) => {
    const T = st.type
    T.css = css
    T.dirty = true
    const gen = T.gen = T.gen + 1
    const errors = T.errors = []
    const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))])
    st.hookUp()
    await within(Promise.all(webContents.getAllWebContents().map(w => st.putType(w, errors))), 3000, 'changing the type sheet').catch(e => errors.push(String(e)))
    st.hookDown()
    const marker = w => within(w.executeJavaScriptInIsolatedWorld(4248, [{ code: 'getComputedStyle(document.documentElement).getPropertyValue(' + JSON.stringify('--reskin-type') + ').trim()' }]), 1500, 'reading the type marker')
    const safeMarker = async w => { for (let i = 0; i < 2; i++) { try { return await marker(w) } catch { if (i === 0) await new Promise(r => setTimeout(r, 300)) } } return 'unknown' }
    const pages = webContents.getAllWebContents().filter(isClaudePage)
    let applied = 0, reloaded = 0, leftover = 0, unverified = 0
    if (css === null) {
      const quiet = () => ({ pending: T.pending ?? 0, seq: T.seq ?? 0 })
      const q0 = quiet()
      await Promise.all(pages.map(async w => {
        const m = await safeMarker(w)
        if (m === '1' || m === 'unknown') {
          if (w.isDestroyed() || !isClaudePage(w) || T.gen !== gen) return
          await new Promise(resolve => {
            const done = () => { w.removeListener('did-finish-load', done); resolve() }
            w.once('did-finish-load', done)
            setTimeout(done, 3000)
            w.reload()
          })
          reloaded++
        }
        const after = await safeMarker(w)
        if (after === '1') leftover++
        else if (after !== '') unverified++
        else if (T.gen === gen) { T.keys.delete(w.id); T.orphans.delete(w.id) } // proven gone: the old keys mean nothing now
      }))
      if (leftover > 0) errors.push('the type marker is still on ' + leftover + ' page(s) even after a reload: press Cmd-R in the Claude window')
      if (unverified > 0) errors.push('could not confirm the type sheet is gone from ' + unverified + ' page(s): press Cmd-R in the Claude window')
      const q1 = quiet()
      if (leftover === 0 && unverified === 0 && T.gen === gen && errors.length === 0 && q0.pending === 0 && q1.pending === 0 && q0.seq === q1.seq) T.dirty = false
      // Cleared (fonts, 3 Nov 2026): the full proof above passed for this very run, so no older sheet can come back.
      // A font change that drops a part waits for this before it puts the rest on.
      return { eligible: pages.length, applied, reloaded, leftover, unverified, errors, cleared: T.dirty === false && T.gen === gen && T.css === null }
    } else {
      // No Claude window: nothing to show it on, so the request is not kept armed for a later window.
      if (pages.length === 0) { errors.push('no Claude window is open'); if (T.gen === gen) { T.css = null; st.hookDown() } }
      await Promise.all(pages.map(async w => { if ((await safeMarker(w)) === '1') applied++ }))
      if (pages.length > 0 && applied < pages.length) errors.push('the type sheet did not show up on ' + (pages.length - applied) + ' of ' + pages.length + ' Claude page(s)')
    }
    return { eligible: pages.length, applied, reloaded, leftover, unverified, errors }
  }
  st.apply = async (css, reset = false, batch = false, quick = false) => {
    st.css = css
    if (batch) { st.batch = true; st.batchActive = Date.now() } // the colour helper waits while a batch owns the colours
    const errors = [] // this run's own list: a late failure from an older run must not land in a newer run's answer
    const offRun = css === null // this run's own purpose; st.css may be changed by a newer run meanwhile
    const gen = st.gen = (st.gen ?? 0) + 1 // a newer run makes any late finish of this one clean up after itself
    const isClaude = w => { try { return new URL(w.getURL()).origin === 'https://claude.ai' } catch { return false } }
    // Nothing in here may wait forever: a stuck page must not hold up the close of the port.
    const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))])
    // One change at a time per window; a window closed mid-change keeps no key.
    const put = w => {
      const id = w.id
      st.work = (st.work ?? 0) + 1 // every stylesheet change, reload re-apply included: the health check rejects a look that spans one
      const prev = st.queues.get(id) ?? Promise.resolve()
      const next = prev.then(async () => {
        if (w.isDestroyed()) { st.keys.delete(id); return }
        if (st.css !== null && !isClaude(w)) return // skins only go into the Claude page, never a popup or another window
        const old = st.keys.get(id)
        if (st.css === null) {
          if (old !== undefined) { await w.removeInsertedCSS(old); st.keys.delete(id) }
          const left = []
          for (const k of st.orphans?.get(id) ?? []) {
            try { await w.removeInsertedCSS(k) } catch (e) { left.push(k); errors.push('could not remove an old stylesheet: ' + String(e)) }
          }
          if (left.length > 0) st.orphans.set(id, left); else st.orphans?.delete(id)
          return
        }
        // Insert the new sheet BEFORE removing the old one, so a failed insert leaves the old skin in place.
        const key = await w.insertCSS(st.css + ' html { --reskin-active: 1 !important; }', { cssOrigin: 'author' })
        if (w.isDestroyed()) return
        if (st.gen !== gen) { try { await w.removeInsertedCSS(key) } catch { st.orphans ??= new Map(); st.orphans.set(id, [...(st.orphans.get(id) ?? []), key]) } return } // a newer run took over while this insert was in flight
        st.keys.set(id, key)
        if (old !== undefined) {
          try { await w.removeInsertedCSS(old) } catch (e) {
            // Keep the old key so a later Off can still remove it.
            st.orphans ??= new Map()
            st.orphans.set(id, [...(st.orphans.get(id) ?? []), old])
            throw e
          }
        }
      }).catch(err => { errors.push(String(err)) })
        .finally(() => { if (st.queues.get(id) === next) st.queues.delete(id) })
      st.queues.set(id, next)
      return next
    }
    st.put = put
    st.hookUp()
    st.errors = errors
    const teardownHooks = () => st.hookDown() // kept while the type sheet is on, so a reload puts it back
    // A reset must not wait behind a stuck insert: hooks go first, and the queues are not awaited.
    if (reset) teardownHooks()
    else { await within(Promise.all(webContents.getAllWebContents().map(put)), 3000, 'changing the stylesheets').catch(e => errors.push(String(e))); teardownHooks() }
    // Off must be proven, not assumed: Electron once accepted a removal and left the colours in place. If the marker
    // is still on a Claude page (or this is a reset), reload that page, which drops every inserted stylesheet.
    const marker = w => within(w.executeJavaScriptInIsolatedWorld(4244, [{ code: \`getComputedStyle(document.documentElement).getPropertyValue('--reskin-active').trim()\` }]), 1500, 'reading the marker')
    // '1' = skin present, '' = skin absent, 'unknown' = could not read (never counted as absent). One retry for a page still loading.
    const safeMarker = async w => { for (let i = 0; i < 2; i++) { try { return await marker(w) } catch { if (i === 0) await new Promise(r => setTimeout(r, 300)) } } return 'unknown' }
    const claudePages = webContents.getAllWebContents().filter(isClaude)
    let reloaded = 0, leftover = 0, unverified = 0, applied = 0
    if (offRun) {
      await Promise.all(claudePages.map(async w => {
        const m = await safeMarker(w)
        if (reset || m === '1' || m === 'unknown') {
          // Look again right before reloading: the page may have navigated or closed while we were reading.
          // ...or a newer run (a newer skin) took over meanwhile: an older Off must never reload it away.
          if (w.isDestroyed() || !isClaude(w) || st.gen !== gen) return
          await new Promise(resolve => {
            const done = () => { w.removeListener('did-finish-load', done); resolve() }
            w.once('did-finish-load', done)
            setTimeout(done, 3000)
            w.reload()
          })
          reloaded++
          if (st.gen === gen) { st.keys.delete(w.id); st.orphans?.delete(w.id) } // a reload drops every inserted sheet, so the old keys mean nothing now (unless a newer run already set new ones)
        }
        const after = await safeMarker(w)
        if (after === '1') leftover++
        else if (after !== '') unverified++
      }))
      if (leftover > 0) errors.push('the skin marker is still on ' + leftover + ' page(s) even after a reload: press Cmd-R in the Claude window')
      if (unverified > 0) errors.push('could not confirm the skin is gone from ' + unverified + ' page(s): press Cmd-R in the Claude window')
    } else if (!quick) {
      // Apply must be proven too (a quick apply is proven afterwards, by the helper putting the same preset on again): the marker has to be visible on every Claude page, and there has to be at least one.
      if (claudePages.length === 0) errors.push('no Claude page was found to skin')
      await Promise.all(claudePages.map(async w => { if ((await safeMarker(w)) === '1') applied++ }))
      if (claudePages.length > 0 && applied < claudePages.length) errors.push('the skin did not show up on ' + (claudePages.length - applied) + ' of ' + claudePages.length + ' Claude page(s)')
    }
    // Only the newest run may clear the batch mark, and only after a full success (a late batch apply must not re-mark).
    if (st.gen === gen && !batch && errors.length === 0) st.batch = false
    // Sampled colours, read-only, on every Claude page after an apply: judged outside Claude (sampled colour checks).
    const samples = offRun || quick ? [] : await Promise.all(claudePages.map(w => within(w.executeJavaScriptInIsolatedWorld(4245, [{ code: \`(() => {
      const cs = getComputedStyle(document.documentElement)
      const v = n => cs.getPropertyValue(n).trim()
      const sb = document.querySelector('.dframe-sidebar')
      return { surface1: v('--cds-surface-1'), textPrimary: v('--cds-text-primary'), accentFill: v('--cds-role-accent-fill'), bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null, sidebarBg: sb ? getComputedStyle(sb).backgroundColor : null }
    })()\` }]), 1500, 'sampling colours').catch(e => ({ error: String(e) }))))
    return { windows: webContents.getAllWebContents().length, styled: st.keys.size, hooked: st.hooks !== null, eligible: claudePages.length, applied, reloaded, leftover, unverified, errors, samples }
  }
  // Health check (17 Oct 2026): a read-only look at every Claude page, judged outside Claude. Changes nothing. The snapshot
  // counts only when nothing moved while it was taken (same run number, same sheet, no change queued, same pages).
  st.sample = async () => {
    const isClaude = w => { try { return !w.isDestroyed() && new URL(w.getURL()).origin === 'https://claude.ai' } catch { return false } }
    const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))])
    // A page that is loading (or cannot say) makes the look unstable; its address is part of the look, so a navigation that
    // starts during the read is caught after it.
    const loading = w => { try { return typeof w.isLoading !== 'function' || w.isLoading() } catch { return true } }
    const look = () => { const ws = webContents.getAllWebContents().filter(isClaude); return { gen: st.gen ?? 0, work: st.work ?? 0, css: st.css, type: st.type?.css ?? null, queued: st.queues.size, ids: ws.map(w => w.id + ' ' + w.getURL()).sort().join(','), loading: ws.some(loading) } }
    const before = look()
    const pages = await Promise.all(webContents.getAllWebContents().filter(isClaude).map(w => within(w.executeJavaScriptInIsolatedWorld(4247, [{ code: ${JSON.stringify(HEALTH_PAGE)} }]), 1500).catch(() => ({ error: 'unreadable' }))))
    const after = look()
    const stable = !before.loading && !after.loading && before.queued === 0 && after.queued === 0 && before.gen === after.gen && before.work === after.work && before.css === after.css && before.type === after.type && before.ids === after.ids && pages.every(p => p.error || p.ready === 'complete')
    return { stable, pages }
  }`

// `all` (remove and reset only): the type sheet goes too. A batch's final Off, like the helper's Off, leaves it alone.
function setCode(css, reset = false, batch = false, quick = false, all = false) {
  if (!all) return `(async () => {
  ${CORE}
  return st.apply(${JSON.stringify(css)}, ${reset}, ${batch}, ${quick})
})()`
  return `(async () => {
  ${CORE}
  const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))])
  const T = st.type
  if (${reset}) {
    // The reset reloads every Claude page; afterwards the type marker must be gone too, page by page.
    T.css = null; T.dirty = true
    const tgen = ++T.gen
    const res = await st.apply(${JSON.stringify(css)}, true, ${batch}, ${quick})
    const read = w => within(w.executeJavaScriptInIsolatedWorld(4248, [{ code: 'getComputedStyle(document.documentElement).getPropertyValue(' + JSON.stringify('--reskin-type') + ').trim()' }]), 1500, 'reading the type marker').catch(() => 'unknown')
    let left = 0
    const clean = []
    const p0 = T.pending ?? 0, s0 = T.seq ?? 0 // the proof counts only if no insert is in flight or starts while it runs
    for (const w of webContents.getAllWebContents().filter(isClaudePage)) { if ((await read(w)) === '') clean.push(w.id); else left++ }
    if (T.gen !== tgen) return res // a newer type change took over meanwhile: its own proof counts, and its keys stay
    for (const id of clean) { T.keys.delete(id); T.orphans.delete(id) }
    if (left === 0 && p0 === 0 && (T.pending ?? 0) === 0 && (T.seq ?? 0) === s0) T.dirty = false
    if (left > 0) res.errors = [...res.errors, 'could not confirm the type sheet is gone from ' + left + ' page(s): press Cmd-R in the Claude window']
    return res
  }
  // Both slots are claimed before the first wait (each run numbers itself at once), so a newer apply that starts
  // meanwhile is the one that counts, and this removal never undoes it.
  const typeOff = typeDirty() ? within(st.applyType(null), 6000, 'type off').then(r => r.errors, e => [String(e)]) : Promise.resolve([])
  const res = await st.apply(${JSON.stringify(css)}, false, ${batch}, ${quick})
  const typeErrors = await typeOff
  if (typeErrors.length > 0) res.errors = [...typeErrors, ...res.errors]
  return res
})()`
}

// ---- The colour helper ----
// Runs INSIDE Claude, sent as source text (`String(installHelper)`), so it may use nothing from this file: everything
// comes in through `o`. After an apply it stays until Claude quits and does one thing: switch between the reviewed presets
// it was given at injection, or Off, or remove itself, when asked through a file in a private folder. The debugger is
// closed by then; this needs no port, no Chrome, no alert. It never runs code, loads CSS from a file, or touches the
// network. Its file checks catch accidents and stale files; any program running as the user could still ask it to switch.
export function installHelper(st, o) {
  const { fs, dir, presets } = o
  // Checked type slot texts (fixed at injection): 'headers' (the header sheet) and the look parts by id (font picker,
  // 4 Nov 2026). A look key is a font key (`plex`, `plex-16`) or part ids joined by `~` in LOOK_ORDER, one per slot
  // (skin-lib parseLook and lookKey; the same rules here, as this runs inside Claude and imports nothing).
  const typeSheets = o.typeSheets ?? {}
  const ORDER = Array.isArray(o.lookOrder) ? o.lookOrder : []
  const partIds = Object.keys(typeSheets).filter((k) => k !== 'headers')
  const has = (id) => id !== 'headers' && Object.hasOwn(typeSheets, id)
  const slotOf = (id) => id.split('.').slice(0, 2).join('.')
  const keyOf = (ids) => ids.length === 0 ? null
    : ids.length === 1 && slotOf(ids[0]) === 'ui.font' ? ids[0].split('.')[2]
    : ids.length === 2 && slotOf(ids[0]) === 'ui.font' && slotOf(ids[1]) === 'chat.size' ? ids[0].split('.')[2] + '-' + ids[1].split('.')[2]
    : ids.join('~')
  // A look key -> its part ids, or null when it is not exactly a canonical key of parts this helper was given.
  const parseKey = (key) => {
    if (typeof key !== 'string' || key === '' || key.length > 600) return null
    if (!key.includes('.')) {
      if (has('ui.font.' + key)) return ['ui.font.' + key]
      const m = /^(.+)-([0-9]{2})$/.exec(key)
      return m && has('ui.font.' + m[1]) && has('chat.size.' + m[2]) ? ['ui.font.' + m[1], 'chat.size.' + m[2]] : null
    }
    const ids = key.split('~')
    let at = -1
    for (const id of ids) { if (!has(id)) return null; const k = ORDER.indexOf(slotOf(id)); if (k <= at) return null; at = k }
    return keyOf(ids) === key ? ids : null
  }
  // The exact slot text for a pair { headers, font: look key or null }: null = nothing in the slot, undefined = not
  // something this helper was given. The tool composes the same way (composeType).
  const compose = (p) => {
    const ids = p.font === null ? [] : parseKey(p.font)
    if (ids === null || (p.headers && !Object.hasOwn(typeSheets, 'headers'))) return undefined
    if (!p.headers && ids.length === 0) return null
    // The header sheet alone is its own text exactly; with parts, a newline between (as the sheets always were).
    return (p.headers ? typeSheets.headers + (ids.length ? '\n' : '') : '') + ids.map((id) => typeSheets[id]).join('')
  }
  // What the slot holds, decided from its exact text: an empty slot is the empty pair; otherwise only the pair this
  // helper (or an earlier one of this generation) last PROVED, and only while recomposing it gives exactly that text
  // (st.type.want: null while a change runs or after one that could not prove its end). null = unknown.
  const decode = (css) => {
    // Empty only when proven empty: a cleanup that could not prove itself leaves the slot marked dirty.
    if (css === null) return typeof st.typeDirty === 'function' && st.typeDirty() ? null : { headers: false, font: null }
    const w = st.type?.want
    if (!w || typeof w !== 'object' || typeof w.headers !== 'boolean') return null
    return compose(w) === css ? { headers: w.headers, font: w.font } : null
  }
  const sheetOf = compose
  const isTypeAction = (a) => a === 'type-off' || a === 'font-off' || (a === 'type-on' && Object.hasOwn(typeSheets, 'headers')) || (a.startsWith('font-') && parseKey(a.slice(5)) !== null)
  const C = fs.constants
  const at = (n) => dir + '/' + n
  const MAX = 4096
  if (st.helper) { try { st.helper.stop(false) } catch {} } // one helper per Claude process: a new apply replaces it
  // The folder must be a real folder of this user, private (700). Created if missing; a wrong mode on our own real folder
  // is repaired; anything else (a link, another owner) means no helper.
  const checkDir = () => {
    try {
      const s = fs.lstatSync(dir)
      return s.isDirectory() && !s.isSymbolicLink() && s.uid === o.uid && (s.mode & 0o777) === 0o700 ? s : null
    } catch { return null }
  }
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}
  try { const s = fs.lstatSync(dir); if (s.isDirectory() && !s.isSymbolicLink() && s.uid === o.uid && (s.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700) } catch {}
  const d0 = checkDir()
  if (d0 === null) return { helper: 'none', why: 'the folder ' + dir + ' is not a private folder of yours (owned by you, mode 700, not a link)' }
  // Whole files only: written to a fresh private temp file, then renamed into place.
  const writeFile = (name, value) => {
    const tmp = at('.' + name + '.' + o.randomUUID())
    const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600)
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(value)) } finally { fs.closeSync(fd) } // 600 whatever the umask
    try { fs.renameSync(tmp, at(name)) } catch (e) { try { fs.unlinkSync(tmp) } catch {} throw e }
  }
  const h = { session: o.randomUUID(), last: 0, requests: 0, ignored: 0, running: false, again: false, stopped: false, watcher: null, timer: null, ino: d0.ino, badKey: null, startedAt: o.now(), tid: 0, inner: new Set() }
  const caps = ['check', ...(Object.hasOwn(typeSheets, 'headers') ? ['type'] : []), ...(partIds.length > 0 ? ['font', 'look'] : [])]
  const sessionInfo = () => ({ v: 1, session: h.session, pid: o.pid, boot: o.boot, version: o.version, startedAt: h.startedAt, caps, parts: partIds, gen: o.gen })
  const watch = () => {
    try { h.watcher?.close() } catch {}
    h.watcher = null
    try { h.watcher = fs.watch(dir, { persistent: false }, () => kick()); h.watcher.on?.('error', () => {}) } catch {} // the poll covers a failed watch
  }
  // One request file, read once, all-or-nothing. Answers { req }, { none } (nothing new) or { bad: reason }.
  const read = () => {
    let s
    try { s = fs.lstatSync(at('request.json')) } catch { return { none: true } }
    const key = s.ino + ':' + s.size + ':' + s.mtimeMs
    if (key === h.badKey) return { none: true } // the same bad file is counted once, not every second
    const bad = (why) => { h.badKey = key; return { bad: why } }
    if (!s.isFile()) return bad('not a regular file')
    if (s.uid !== o.uid) return bad('not owned by you')
    if ((s.mode & 0o777) !== 0o600) return bad('not private (mode must be 600)')
    if (s.size > MAX) return bad('larger than 4 KB')
    let fd
    try { fd = fs.openSync(at('request.json'), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK) } catch { return bad('could not be opened') }
    let text
    try {
      const f = fs.fstatSync(fd)
      if (!f.isFile() || f.ino !== s.ino || f.dev !== s.dev || f.uid !== o.uid || (f.mode & 0o777) !== 0o600 || f.size > MAX) return bad('changed while being read')
      const buf = new Uint8Array(MAX + 1)
      const n = fs.readSync(fd, buf, 0, MAX + 1, 0)
      if (n !== f.size || n > MAX) return bad('changed size while being read')
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n))
    } catch { return bad('could not be read') } finally { try { fs.closeSync(fd) } catch {} }
    let j
    try { j = JSON.parse(text) } catch { return bad('not JSON') }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return bad('not a JSON object')
    if (Object.keys(j).sort().join(',') !== 'action,nonce,session,v') return bad('fields must be exactly v, session, nonce, action')
    if (j.v !== 1) return bad('unknown version')
    if (j.session !== h.session) return bad('for another helper session')
    if (!Number.isSafeInteger(j.nonce) || j.nonce < 1) return bad('nonce is not a positive whole number')
    if (j.nonce === h.last) return { none: true } // already handled
    if (j.nonce < h.last) return bad('an old request')
    // type-off and font-off are always accepted: they only take parts away.
    if (typeof j.action !== 'string' || !(j.action === 'off' || j.action === 'remove' || j.action === 'check' || isTypeAction(j.action) || Object.hasOwn(presets, j.action))) return bad('not a preset name, off, remove, check, type-on, type-off, font-<name> or font-off')
    return { req: j }
  }
  const ack = (r) => {
    try { writeFile('ack.json', { v: 1, session: h.session, pid: o.pid, version: o.version, requests: h.requests, ignored: h.ignored, ...r }) } catch {}
  }
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => o.setTimeout(() => rej(new Error('timed out after ' + ms + ' ms')), ms))])
  // Every type slot step is tracked until it really ends, so a timed-out change never overlaps the next one.
  const track = (p) => { h.inner.add(p); p.then(() => h.inner.delete(p), () => h.inner.delete(p)); return p }
  const step = (css) => within(track(st.applyType(css)), 8_000).catch((e) => ({ errors: [String(e)] }))
  // One type slot change. The helper composes the wanted pair from what
  // is really in the slot (never from saved preferences). A change that drops a part first clears the slot and needs
  // the full proof that it is empty (cleared) before it puts the rest on. A failed apply is cleaned up and counts as
  // empty only once that cleanup is proven too. verified is the pair proven on the pages, or 'unknown'.
  const EMPTY = { headers: false, font: null }
  const typeChange = async (action, alive) => {
    if (typeof st.applyType !== 'function') return { errors: ['this Claude has no type slot yet'], selected: null, verified: 'unknown' }
    const T = st.type
    const cur = decode(T.css)
    const want = { ...(cur ?? EMPTY) }
    if (action === 'type-on') want.headers = true
    else if (action === 'type-off') want.headers = false
    else if (action === 'font-off') want.font = null
    else want.font = action.slice(5)
    const css = sheetOf(want)
    if (css === undefined) return { errors: ['that combination is not available in this copy of Reskin'], selected: want, verified: cur ?? 'unknown' }
    const drops = cur === null || T.css === null || (cur.headers && !want.headers) || (cur.font !== null && cur.font !== want.font)
    // While the change runs nothing is proven (a check or a later request reads unknown until it ends well).
    T.want = null
    let reloaded = 0
    // A step starts only if it can finish before the request's deadline (alive(ms)), so nothing lands after the answer.
    const late = { errors: ['cancelled: not enough time left before the deadline'], selected: want, verified: 'unknown', reloaded }
    // Time is reserved up front: a clear, then an apply, then a cleanup if the apply fails (8 s each).
    if (drops && st.typeDirty()) {
      if (!alive(24_000)) return late
      const r = await step(null)
      reloaded += r.reloaded ?? 0
      if (r.cleared !== true) return { errors: ['could not prove the old type sheet is gone, so nothing new was put on' + ((r.errors ?? []).length ? ': ' + r.errors[0] : '')], selected: want, verified: 'unknown', reloaded }
    }
    if (css === null) { if (T.css !== null || st.typeDirty()) return { errors: ['could not prove the type slot is empty'], selected: want, verified: 'unknown', reloaded }; T.want = { ...EMPTY }; return { errors: [], selected: want, verified: EMPTY, reloaded } }
    if (!alive(16_000)) return { ...late, reloaded }
    const r2 = await step(css)
    reloaded += r2.reloaded ?? 0
    if ((r2.errors ?? []).length === 0 && r2.eligible > 0 && r2.applied === r2.eligible) {
      // The reviewed success rule stays; the proof is separate: only the exact composed text in the slot
      // proves the pair (something newer, such as a reset, may have replaced it meanwhile).
      const proven = T.css === css
      if (proven) T.want = { headers: want.headers, font: want.font }
      return { errors: [], selected: want, verified: proven ? want : 'unknown', applied: r2.applied, eligible: r2.eligible, reloaded }
    }
    // Failed (on any page): take the sheet out again, so the reload hooks stop putting the failed one back.
    let verified = 'unknown'
    if (alive(8_000)) { const r3 = await step(null); reloaded += r3.reloaded ?? 0; if (r3.cleared === true && T.css === null && !st.typeDirty()) { verified = EMPTY; T.want = { ...EMPTY } } }
    else if (T.css === css) {
      // No time left to prove a cleanup: still stop the failed sheet at once. The reload hooks stop putting it back, and
      // a new run number makes any insert still in flight take itself out when it lands. The slot stays marked (dirty).
      T.css = null; T.dirty = true; T.gen++
    }
    return { errors: (r2.errors ?? []).length ? r2.errors : ['the sheet did not show up on every Claude page'], selected: want, verified, partial: true, applied: r2.applied ?? 0, eligible: r2.eligible ?? 0, reloaded }
  }
  const stop = (removeSession) => {
    h.stopped = true
    try { h.watcher?.close() } catch {}
    h.watcher = null
    o.clearInterval(h.timer)
    try { o.app?.removeListener?.('will-quit', h.onQuit) } catch {}
    if (removeSession) { try { fs.unlinkSync(at('session.json')) } catch {} }
    if (st.helper === h) st.helper = null
  }
  const once = async () => {
    const d = checkDir()
    if (d === null) return // folder gone or unsafe: change nothing
    if (d.ino !== h.ino) { h.ino = d.ino; watch(); try { writeFile('session.json', sessionInfo()) } catch {} } // folder re-created
    const busy = Number.isFinite(st.batchActive) && o.now() - st.batchActive < 30_000 // a batch run owns the colours
    const r = read()
    if (r.none) return
    if (r.bad) { h.ignored++; return }
    const j = r.req
    if (busy && j.action !== 'check') return // a switch waits for the batch; the poll retries (the request stays where it is)
    h.last = j.nonce
    h.requests++
    if (j.action === 'check') {
      // Read-only: never st.apply, never a stylesheet change. What is on now, as a name and a digest of the very text.
      if (busy) { ack({ nonce: j.nonce, action: 'check', phase: 'done', ok: false, busy: true, errors: [] }); return }
      const name = st.css === null ? 'off' : Object.keys(presets).find((k) => presets[k] === st.css) ?? 'unknown'
      let sample = null, errors = []
      try { sample = typeof st.sample === 'function' ? await within(st.sample(), 5_000) : null } catch (e) { errors = [String(e)] }
      if (h.stopped) return
      let dark = null, digest = null
      try { dark = o.dark() } catch {}
      try { digest = st.css === null ? null : o.digest(st.css) } catch {}
      const now = decode(st.type?.css ?? null)
      const type = now === null ? 'unknown' : now.headers ? 'on' : 'off'
      const font = now === null ? 'unknown' : now.font
      ack({ nonce: j.nonce, action: 'check', phase: 'done', ok: sample !== null, errors, current: name, digest, dark, sample, type, font })
      return
    }
    if (j.action === 'remove') {
      // Ack first (accepted, not yet proof of removal), then take everything down. Status proves the result afterwards.
      ack({ nonce: j.nonce, action: 'remove', phase: 'accepted', ok: true, errors: [] })
      stop(true)
      let res
      // Both sheets go (a removal leaves nothing of Reskin behind). Both runs number themselves before their first wait,
      // so a newer apply that starts meanwhile is never undone by this removal.
      const typeOn = typeof st.applyType === 'function' && typeof st.typeDirty === 'function' && st.typeDirty() // never used, or proven off: nothing to take off
      const typeOff = typeOn ? within(st.applyType(null), 6_000).then((r) => r.errors, (e) => [String(e)]) : Promise.resolve([])
      const typeGen = st.type?.gen
      const off = st.apply(null)
      const gen = st.gen // this removal's own run: st.apply numbers each run before its first wait
      try { res = await within(off, 12_000) } catch (e) { res = { errors: [String(e)] } }
      const typeErrors = await typeOff
      const errors = [...typeErrors, ...(res?.errors ?? [])].slice(0, 5).map(String)
      // The state goes only if nothing newer has started since (a newer apply may not have installed its helper yet).
      // The debugger's own close timer (__reskinFallback) belongs to debugger runs and is never touched here.
      if (errors.length === 0 && st.gen === gen && st.type?.gen === typeGen && !st.helper && globalThis.__reskin === st) delete globalThis.__reskin
      // The final answer: removal done, or what went wrong (the client reports success only on this). Not when a newer
      // helper took over meanwhile: its acks are the only ones that count now.
      if (st.helper && st.helper !== h) return
      ack({ nonce: j.nonce, action: 'remove', phase: 'done', ok: errors.length === 0, errors })
      return
    }
    if (isTypeAction(j.action)) {
      // The type slot only (headers and font): the colours are not touched. No samples (they belong to colour changes).
      // Work left running by an earlier change that timed out must settle first: its later steps are cancelled, but a
      // sheet it is still putting in has to land or fail before the slot is read again.
      // A sheet insert still in flight inside a page (pending) counts too, though the step that started it has given up.
      const inserts = async () => { for (let i = 0; i < 200 && (st.type?.pending ?? 0) > 0; i++) await new Promise((r) => o.setTimeout(r, 100)); if ((st.type?.pending ?? 0) > 0) throw new Error('busy') }
      // One deadline for the whole request, settling included (the client waits 30 s): once it passes, no later step runs.
      let expired = false
      const endAt = o.now() + 26_000
      const deadline = new Promise((_, rej) => o.setTimeout(() => { expired = true; rej(new Error('timed out after 26000 ms')) }, 26_000))
      deadline.catch(() => {})
      if (h.inner.size > 0 || (st.type?.pending ?? 0) > 0) {
        try { await Promise.race([Promise.allSettled([...h.inner]).then(inserts), deadline]) } catch {
          ack({ nonce: j.nonce, action: j.action, phase: 'done', ok: false, errors: ['an earlier type or font change is still running: try again in a moment'], selected: null, verified: 'unknown' })
          return
        }
      }
      const tid = ++h.tid
      const alive = (needMs = 0) => tid === h.tid && !h.stopped && !expired && o.now() + needMs <= endAt
      const res = await Promise.race([track(typeChange(j.action, alive)), deadline]).catch((e) => { if (tid === h.tid) h.tid++; return { errors: [String(e)], selected: null, verified: 'unknown' } }) // the deadline cancels the change's later steps
      if (h.stopped) return
      ack({ nonce: j.nonce, action: j.action, phase: 'done', ok: (res.errors ?? []).length === 0, errors: (res.errors ?? []).slice(0, 5).map(String), selected: res.selected ?? null, verified: res.verified ?? 'unknown', partial: res.partial === true, applied: res.applied ?? 0, eligible: res.eligible ?? 0, reloaded: res.reloaded ?? 0 })
      return
    }
    let res
    try { res = await within(st.apply(j.action === 'off' ? null : presets[j.action]), 8_000) } catch (e) { res = { errors: [String(e)], samples: [] } }
    if (h.stopped) return // replaced or removed meanwhile: a late answer must not overwrite the new helper's ack
    let dark = null
    try { dark = o.dark() } catch {}
    ack({ nonce: j.nonce, action: j.action, phase: 'done', ok: (res?.errors ?? []).length === 0, errors: (res?.errors ?? []).slice(0, 5).map(String), samples: res?.samples ?? [], dark })
  }
  // Serial: one request at a time; events that arrive meanwhile collapse into one more look afterwards.
  const kick = () => {
    if (h.stopped) return
    if (h.running) { h.again = true; return }
    h.running = true
    void (async () => {
      try { do { h.again = false; await once() } while (h.again && !h.stopped) } catch {} finally { h.running = false }
    })()
  }
  h.stop = stop
  h.kick = kick
  h.onQuit = () => { try { fs.unlinkSync(at('session.json')) } catch {} }
  try { writeFile('session.json', sessionInfo()) } catch (e) { return { helper: 'none', why: 'could not write session.json: ' + String(e?.message ?? e) } }
  try { fs.unlinkSync(at('request.json')) } catch {} // a request left from an older session must not linger
  try { o.app?.once?.('will-quit', h.onQuit) } catch {}
  watch()
  h.timer = o.setInterval(kick, 1_000)
  h.timer?.unref?.()
  st.helper = h
  return { helper: 'active', session: h.session }
}

// The helper's injection: Claude's own fs, ids and clock. `presets` (name -> checked CSS) and `dir` are fixed here.
// Claude's start time (23 Oct 2026): process.uptime() stops while the Mac sleeps, so "now minus uptime" came out late
// by the sleep time and a later status took the live helper for a restarted Claude. Electron's own process creation
// time is wall-clock and matches ps; the old reading stays only as a fallback.
function helperCode(presets, dir, typeSheets = {}) {
  return `(async () => {
  ${CORE}
  const bootMs = () => {
    try { const t = app.getAppMetrics().find((m) => m.type === 'Browser')?.creationTime; if (Number.isFinite(t) && t > 0) return Math.round(t) } catch {}
    return Math.round(Date.now() - process.uptime() * 1000)
  }
  const o = {
    fs: process.getBuiltinModule('fs'), dir: ${JSON.stringify(dir)},
    presets: Object.freeze(Object.assign(Object.create(null), ${JSON.stringify(presets)})),
    typeSheets: Object.freeze(Object.assign(Object.create(null), ${JSON.stringify(typeSheets)})),
    lookOrder: Object.freeze(${JSON.stringify(LOOK_ORDER)}),
    uid: process.getuid(), pid: process.pid, boot: bootMs(), version: app.getVersion(), gen: ${HELPER_GEN},
    randomUUID: () => process.getBuiltinModule('crypto').randomUUID(), now: Date.now, app,
    digest: (s) => process.getBuiltinModule('crypto').createHash('sha256').update(s).digest('hex'),
    dark: () => ${ELECTRON}.nativeTheme.shouldUseDarkColors,
    setTimeout, setInterval, clearInterval,
  }
  return (${String(installHelper)})(st, o)
})()`
}

// Off or reset also ends the helper (and its session file), so nothing is left listening.
const STOP_HELPER = `(() => { const st = globalThis.__reskin; if (st?.helper) { try { st.helper.stop(true) } catch {} } return true })()`

// Read-only: what does the skin code remember in this Claude process, and what does each page show?
const STATE = `(async () => {
  const { webContents } = ${ELECTRON}
  const st = globalThis.__reskin
  const h = st?.helper
  const out = { hasState: st !== undefined, keys: st ? [...st.keys.entries()] : [], hooked: st ? st.hooks !== null : null, orphans: st?.orphans ? [...st.orphans.entries()] : [], helper: h ? { session: h.session, requests: h.requests, ignored: h.ignored, watching: h.watcher !== null, stopped: h.stopped } : null, pages: [] }
  for (const w of webContents.getAllWebContents()) {
    let origin = ''
    try { origin = new URL(w.getURL()).origin } catch {}
    const row = { id: w.id, type: w.getType(), origin }
    if (origin === 'https://claude.ai') {
      row.page = await w.executeJavaScriptInIsolatedWorld(4242, [{ code: \`(() => {
        const cs = getComputedStyle(document.documentElement)
        const c = document.querySelector('.dframe-content')
        return { marker: cs.getPropertyValue('--reskin-active').trim(), bodyBg: getComputedStyle(document.body).backgroundColor, surface1: cs.getPropertyValue('--cds-surface-1').trim(), frameBg: c ? getComputedStyle(c).backgroundColor : null }
      })()\` }])
    }
    out.pages.push(row)
  }
  return out
})()`

// Harmless self-test: does Electron really remove a stylesheet it inserted (author priority)? On the
// Claude page only, with a throwaway variable nobody uses. Leaves nothing behind.
const SELFTEST = `(async () => {
  const { webContents } = ${ELECTRON}
  const w = webContents.getAllWebContents().find(x => { try { return new URL(x.getURL()).origin === 'https://claude.ai' } catch { return false } })
  if (!w) return { error: 'no claude.ai page' }
  const read = () => w.executeJavaScriptInIsolatedWorld(4243, [{ code: \`getComputedStyle(document.documentElement).getPropertyValue('--reskin-selftest-author').trim()\` }])
  const out = { before: await read() }
  let key = null
  try {
    key = await w.insertCSS('html { --reskin-selftest-author: author !important; }', { cssOrigin: 'author' })
    const during = await read()
    let removeError = null
    try { await w.removeInsertedCSS(key); key = null } catch (e) { removeError = String(e) }
    out.author = { key: 'inserted', during, after: await read(), removeError }
    out.ok = during === 'author' && out.author.after === '' && removeError === null
  } finally {
    if (key !== null) { try { await w.removeInsertedCSS(key) } catch {} } // never leave the test sheet behind
  }
  return out
})()`

const THEME = `(() => ${ELECTRON}.nativeTheme.shouldUseDarkColors)()`
const VERSION = `(() => ${ELECTRON}.app.getVersion())()`
// Read-only text census of the sidebar (fonts and sizes, 2 Nov 2026): which sidebar elements draw text, at what size,
// weight and font, and how the rows are built, so a later type sheet can name exact selectors. Privacy: built so that
// names the user chose stay out (only a name made entirely of the fixed interface words below could pass). No text (only its length), no URL, no inline style text; attribute names and values,
// class names, token names and font names only from fixed lists or fixed shapes, everything else masked as '?'.
// Bounded: at most 4000 sidebar elements, 30000 style rules and 400 ms of work per window; it says when it stopped early.
// Its output is privacy-reduced, not anonymous: text lengths, positions, row counts, which project is open and the
// selected row's path remain. Read it before sharing it, and use made-up sessions for anything public. Developer copy
// only: a release copy refuses this mode.
// The page code below passes through two template strings, so it uses no backslashes at all.
const TYPE_PROBE = `(async () => {
  const { webContents } = ${ELECTRON}
  const all = webContents.getAllWebContents()
  const out = []
  for (const w of all.slice(0, 6)) {
    let origin = ''
    try { origin = new URL(w.getURL()).origin } catch {}
    const row = { id: w.id, type: w.getType() }
    if (origin === 'https://claude.ai') {
      row.page = await Promise.resolve().then(() => w.executeJavaScriptInIsolatedWorld(4243, [{ code: \`(() => {
        const t0 = performance.now()
        const late = () => performance.now() - t0 > 400
        const truncated = new Set()
        const only = (s, ok) => { for (const ch of s) if (!ok.includes(ch)) return false; return true }
        const LOW = 'abcdefghijklmnopqrstuvwxyz'
        const DIG = '0123456789'
        const ROLES = ['button', 'link', 'treeitem', 'tree', 'group', 'list', 'listitem', 'heading', 'navigation', 'menu', 'menuitem', 'region', 'tab', 'tablist', 'separator', 'img', 'presentation', 'none', 'status', 'tooltip', 'option', 'listbox', 'complementary']
        const ENUM = ['true', 'false', 'open', 'closed', 'on', 'off', 'page', 'active', 'inactive', 'checked', 'unchecked', 'mixed', 'horizontal', 'vertical', '']
        const NAMES = ['role', 'aria-expanded', 'aria-selected', 'aria-current', 'aria-level', 'aria-hidden', 'aria-disabled', 'aria-orientation', 'aria-label', 'aria-labelledby', 'aria-controls', 'aria-haspopup', 'aria-describedby', 'data-state', 'data-orientation', 'data-side', 'data-disabled', 'data-selected', 'data-active', 'data-font', 'data-cds', 'data-row', 'data-slot', 'data-variant', 'data-size', 'data-kind', 'data-section', 'data-group', 'data-collapsed', 'data-expanded', 'data-highlighted', 'data-testid', 'data-index', 'data-level', 'data-depth', 'data-type', 'data-theme', 'data-mode']
        const CDS = ['Icon', 'Pulse', 'Text', 'Button', 'IconButton', 'Row', 'Stack', 'Box', 'Tooltip', 'Spinner', 'Badge', 'Chevron', 'Disclosure', 'Heading', 'Label', 'Avatar', 'Menu', 'MenuItem', 'Collapsible', 'Link', 'Kbd', 'Divider', 'Separator', 'Popover', 'Truncate', 'ListItem', 'List', 'Section', 'Group', 'Header', 'Title']
        const VALUED = ['data-variant', 'data-size', 'data-kind', 'data-type', 'data-level', 'data-depth', 'data-index', 'aria-level', 'data-slot', 'data-section', 'data-group']
        const attrsOf = (el) => [...el.attributes].filter(a => a.name === 'role' || a.name.startsWith('aria-') || a.name.startsWith('data-')).slice(0, 14).map(a => {
          if (!NAMES.includes(a.name)) return a.name.startsWith('aria-') ? 'aria-?' : 'data-?'
          const v = a.value
          if (a.name === 'role') return ROLES.includes(v) ? 'role=' + v : 'role=?'
          if (a.name === 'data-cds') return CDS.includes(v) ? 'data-cds=' + v : 'data-cds=?'
          if (a.name === 'data-font') return ['system', 'sans', 'serif', 'dyslexic', 'mono'].includes(v) ? 'data-font=' + v : 'data-font=?'
          if (ENUM.includes(v)) return a.name + '=' + v
          if (VALUED.includes(a.name) && v.length <= 2 && only(v, DIG)) return a.name + '=' + v
          return a.name + '=#' + v.length
        }).join(' ')
        // Class names, token names and tag names: kept only when every part is a known word, a number or a checked
        // [value]; anything else is masked as '?'.
        const SUF = ('xs sm md lg xl 2xl 3xl 4xl base full auto none px screen min max fit center start end between around evenly stretch baseline x y t b l r s e w h col row wrap nowrap reverse hidden visible scroll clip ellipsis medium semibold bold normal light thin extralight extrabold black tight snug relaxed loose wide wider widest tighter primary secondary tertiary quaternary muted subtle inverse accent danger warning success info always transparent current inherit white solid dashed dotted double colors opacity shadow all default pointer text grab move not allowed help inset sans serif mono italic underline through offset events spacing cols rows span pre line break words keep anywhere balance pretty clamp size flex grow shrink basis items self content justify place sidebar root body group header label title item leading tail mark slot section frame list icon chevron pane panel nav main inner outer wrapper container area heading toggle button link badge dot status gray grey neutral red blue green amber yellow orange purple pink fg bg border ring out in linear middle top bottom left right inside outside both fixed local hover selected active disabled focus pressed surface fill stroke raised sunken overlay elevated canvas page strong weak faint pt pb pl pr indent gap font tracking decoration lh inline block grid table contents flow only sr italic case lowercase uppercase capitalize events select resize touch manipulation pan antialiased subpixel tabular nums proportional slashed ordinal z transform gpu will change contain layout paint strict isolate isolation object cover fill scale rotate translate skew origin cursor ease duration delay animate spin ping pulse bounce blur backdrop filter radius rounded outline appearance list disc decimal float clear box border-box aspect video square snap scrollbar overscroll overflow whitespace hyphens indent align vertical sub super divide space order truncate line letter webkit moz pill control hub rail new circle card composition view slider dot status forced chip tag menu popover tooltip dialog sheet drawer close open expand collapse caret arrow count meta subtitle caption hint').split(' ')
        const FIRST = ['text', 'font', 'flex', 'inline', 'block', 'grid', 'hidden', 'items', 'justify', 'self', 'place', 'content', 'gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me', 'w', 'h', 'min', 'max', 'size', 'rounded', 'border', 'bg', 'leading', 'tracking', 'truncate', 'overflow', 'shrink', 'grow', 'basis', 'relative', 'absolute', 'sticky', 'fixed', 'static', 'top', 'left', 'right', 'bottom', 'inset', 'z', 'opacity', 'select', 'cursor', 'group', 'peer', 'transition', 'duration', 'ease', 'delay', 'whitespace', 'uppercase', 'lowercase', 'capitalize', 'normal', 'italic', 'not', 'underline', 'no', 'decoration', 'tabular', 'line', 'translate', 'origin', 'pointer', 'outline', 'ring', 'shadow', 'space', 'divide', 'order', 'col', 'row', 'transform', 'will', 'contain', 'isolate', 'antialiased', 'subpixel', 'break', 'sr', 'visible', 'invisible', 'dframe', 'df', 'cds', 'fill', 'stroke', 'aspect', 'object', 'scroll', 'snap', 'touch', 'appearance', 'list', 'align', 'float', 'clear', 'box', 'filter', 'backdrop', 'blur', 'animate', 'rotate', 'scale', 'contents', 'flow', 'container', 'caret', 'accent', 'placeholder', 'resize', 'hyphens', 'indent', 'clip', 'mask', 'table', 'shrink', 'overscroll', 'vertical', 'tw', 'status', 'composition', 'slider', 'forced']
        const VARS = ['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'disabled', 'enabled', 'visited', 'checked', 'first', 'last', 'odd', 'even', 'only', 'empty', 'placeholder', 'before', 'after', 'selection', 'marker', 'dark', 'light', 'sm', 'md', 'lg', 'xl', '2xl', 'rtl', 'ltr', 'motion-safe', 'motion-reduce', 'print', 'open', 'group-hover', 'group-focus', 'group-focus-within', 'group-focus-visible', 'group-active', 'peer-hover', 'peer-focus', 'peer-checked', 'aria-expanded', 'aria-selected', 'aria-current', 'aria-disabled', 'aria-checked', 'not-first', 'not-last']
        const KEYS = ['state', 'selected', 'active', 'highlighted', 'disabled', 'side', 'orientation', 'expanded', 'collapsed', 'current', 'open']
        const numOk = (p) => p !== '' && only(p, DIG + './')
        const partsOk = (parts) => parts.every(p => numOk(p) || SUF.includes(p))
        // A token name: a known family start and every later part a known word or number (no free names).
        const varOk = (n) => n.length <= 48 && n.startsWith('--') && only(n, LOW + DIG + '-') && (() => { const p = n.slice(2).split('-'); return ['df', 'cds', 'tw', 'spacing', 'text', 'font', 'radius', 'leading', 'tracking'].includes(p[0]) && partsOk(p.slice(1).filter(x => x !== '')) })()
        const BR = LOW + DIG + '-.%(),:+*/ '
        // Numbers with a complete unit (or none), operators, parentheses and calc/min/max/clamp: nothing else.
        const UNITS = ['px', 'rem', 'em', '%', 'vh', 'vw', 'dvh', 'svh', 'ch', 'fr', 'ms', 's', 'deg']
        const numExpr = (x) => {
          let i = 0
          let any = false
          while (i < x.length) {
            const ch = x[i]
            if (' (),+*/-'.includes(ch)) { i++; continue }
            if ((DIG + '.').includes(ch)) {
              let j = i
              while (j < x.length && (DIG + '.').includes(x[j])) j++
              const n = x.slice(i, j)
              if (n === '.' || n.split('.').length > 2) return false
              let k = j
              while (k < x.length && (LOW + '%').includes(x[k])) k++
              if (k > j && !UNITS.includes(x.slice(j, k))) return false
              any = true
              i = k
              continue
            }
            if (LOW.includes(ch)) {
              let j = i
              while (j < x.length && LOW.includes(x[j])) j++
              if (!['calc', 'min', 'max', 'clamp'].includes(x.slice(i, j)) || x[j] !== '(') return false
              i = j
              continue
            }
            return false
          }
          return any
        }
        // Inside [ ]: an optional length: or color: hint, then only numbers, units, calc/min/max/clamp and var() of a
        // checked token name. No other letters, so no name can ride along.
        const bracketOk = (b) => {
          let x = b.startsWith('length:') ? b.slice(7) : b.startsWith('color:') ? b.slice(6) : b
          if (!only(x, BR)) return false
          for (const v of x.split('var(').slice(1)) { const n = v.split(')')[0].split(',')[0]; if (!varOk(n)) return false; x = x.replace('var(' + n, '(0') }
          for (const f of ['calc', 'min', 'max', 'clamp']) x = x.split(f + '(').join('(')
          return numExpr(x)
        }
        // Split on ':' outside [ ] only (text-[length:var(--x)] is one utility).
        const splitTop = (c) => { const out = []; let cur = ''; let depth = 0; for (const ch of c) { if (ch === '[') depth++; if (ch === ']') depth--; if (ch === ':' && depth === 0) { out.push(cur); cur = '' } else cur += ch } out.push(cur); return out }
        const variantOk = (v) => {
          if (VARS.includes(v)) return true
          const i = v.indexOf('[')
          if (i < 0 || !v.endsWith(']') || !['data-', 'group-data-', 'peer-data-', 'aria-', 'group-aria-'].includes(v.slice(0, i))) return false
          const kv = v.slice(i + 1, -1).split('=')
          return kv.length <= 2 && KEYS.includes(kv[0]) && (kv.length === 1 || ENUM.includes(kv[1]))
        }
        const utilOk = (u) => {
          let x = u.startsWith('!') ? u.slice(1) : u
          if (x.startsWith('-')) x = x.slice(1)
          let br = null
          const i = x.indexOf('[')
          if (i >= 0) { if (!x.endsWith(']') || x[i - 1] !== '-') return false; br = x.slice(i + 1, -1); x = x.slice(0, i - 1) }
          if (br !== null && !bracketOk(br)) return false
          const parts = x.split('-')
          return FIRST.includes(parts[0]) && partsOk(parts.slice(1))
        }
        const classOk = (c) => {
          if (c.length > 90 || !only(c, LOW + DIG + '-_:./%[]()&>*!@=+,#')) return false
          const seg = splitTop(c)
          return seg.slice(0, -1).every(variantOk) && utilOk(seg[seg.length - 1])
        }
        const clsOf = (el) => String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').filter(Boolean).slice(0, 30).map(c => classOk(c) ? c : '?').join(' ')
        const FAMS = ['system-ui', '-apple-system', 'BlinkMacSystemFont', '.SF NS', 'SF Pro', 'SF Pro Text', 'SF Pro Display', 'SF Mono', 'Anthropic Sans', 'Anthropic Serif', 'Anthropic Mono', 'Anthropicons-Variable', 'Copernicus', 'Styrene B', 'Tiempos Text', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'sans-serif', 'serif', 'monospace', 'Menlo', 'Monaco', 'Consolas', 'Inter', 'Helvetica Neue', 'Helvetica', 'Arial', 'Segoe UI', 'Roboto', 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'OpenDyslexic', 'emoji']
        // Font and size tokens looked for, by exact name only; other --df-* names are only counted.
        const TOKS = ['--df-group-font', '--df-group-pt', '--df-group-pb', '--df-group-h', '--df-group-weight', '--df-group-px', '--df-group-gap', '--df-row-font', '--df-row-h', '--df-row-px', '--df-row-gap', '--df-row-indent', '--df-row-weight', '--df-section-font', '--df-header-font', '--df-label-font', '--df-title-font', '--df-font', '--cds-font-sans', '--cds-font-serif', '--cds-font-mono', '--cds-font-ui', '--cds-font-system', '--cds-font-display', '--font-sans', '--font-serif', '--font-mono', '--font-ui', '--font-system', '--font-display', '--font-heading', '--font-body', '--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xs--line-height', '--text-sm--line-height', '--text-base--line-height', '--font-weight-normal', '--font-weight-medium', '--font-weight-semibold', '--font-weight-bold']
        const tokOk = (n) => TOKS.includes(n)
        const TAGS = ['div', 'span', 'a', 'button', 'p', 'li', 'ul', 'ol', 'nav', 'aside', 'section', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'input', 'textarea', 'svg', 'path', 'g', 'small', 'strong', 'b', 'em', 'i', 'img', 'details', 'summary', 'time', 'kbd', 'code', 'pre', 'form', 'select', 'option', 'hr', 'abbr', 'mark', 'figure', 'table', 'tr', 'td', 'th', 'tbody', 'thead', 'dl', 'dt', 'dd', 'use', 'circle', 'rect', 'line', 'polyline', 'polygon']
        const tagOf = (el) => pick(el.tagName.toLowerCase(), TAGS)
        const famOf = (f) => f.split(',').slice(0, 12).map(x => x.trim().replace(/^["']|["']$/g, '')).map(x => FAMS.includes(x) ? x : x.startsWith('var(') && x.endsWith(')') && varOk(x.slice(4, -1)) ? x : '?').join(', ')
        const pxOk = (v) => v.endsWith('px') && v.length <= 12 && only(v.slice(0, -2), DIG + '.-')
        const px = (v) => pxOk(v) || ['', 'auto', 'normal', 'none'].includes(v) ? v : '?'
        const num = (v) => v.length <= 8 && only(v, DIG + '.') ? v : '?'
        const pick = (v, list) => list.includes(v) ? v : '?'
        const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } }
        const geo = (el) => { const c = getComputedStyle(el); const tf = el.style.transform; return { pos: pick(c.position, ['static', 'relative', 'absolute', 'fixed', 'sticky']), height: px(c.height), minH: px(c.minHeight), maxH: px(c.maxHeight), line: px(c.lineHeight), overflowY: pick(c.overflowY, ['visible', 'hidden', 'clip', 'scroll', 'auto']), inlineH: px(el.style.height), inlineTop: px(el.style.top), inlineTransform: tf === '' ? '' : tf.startsWith('translateY(') && tf.endsWith('px)') && only(tf.slice(11, -3), DIG + '.-') ? tf : '?' } }
        const desc = (el) => { const a = attrsOf(el); return tagOf(el) + (a ? '[' + a + ']' : '') + '.' + clsOf(el) }
        const side = document.querySelector('.dframe-sidebar')
        if (!side) return { code: 'no-sidebar' }
        const ownLen = (el) => { let n = 0; for (const x of el.childNodes) if (x.nodeType === 3) n += x.textContent.trim().length; return n }
        const groups = new Map()
        let visited = 0
        const rowsSeen = new Set()
        let expanded = 0
        const walker = document.createTreeWalker(side, 1)
        for (let el = walker.nextNode(); el; el = walker.nextNode()) {
          if (++visited > 4000) { truncated.add('elements'); break }
          if (late()) { truncated.add('time'); break }
          if (el.getAttribute('aria-expanded') === 'true') expanded++
          const len = ownLen(el)
          if (len === 0) continue
          const c = getComputedStyle(el)
          if (c.display === 'none' || c.visibility === 'hidden' || el.getClientRects().length === 0) continue
          // A session row: visible text inside a [data-row] element.
          if (el.closest('[data-row]')) rowsSeen.add(el.closest('[data-row]'))
          const key = [el.tagName, c.fontSize, c.fontWeight, famOf(c.fontFamily), clsOf(el), attrsOf(el)].join('|')
          const g = groups.get(key)
          if (g) { g.n++; if (g.lens.length < 40) g.lens.push(len); continue }
          if (groups.size >= 120) { truncated.add('groups'); continue }
          const anc = []
          for (let e = el.parentElement, i = 0; e && e !== side && i < 7; e = e.parentElement, i++) anc.push({ el: desc(e), box: box(e), geo: geo(e) })
          groups.set(key, {
            n: 1, lens: [len], el: desc(el),
            font: { size: px(c.fontSize), weight: num(c.fontWeight), family: famOf(c.fontFamily), line: px(c.lineHeight), spacing: px(c.letterSpacing), transform: pick(c.textTransform, ['none', 'uppercase', 'lowercase', 'capitalize']), style: pick(c.fontStyle, ['normal', 'italic', 'oblique']) },
            opacity: num(c.opacity), clip: pick(c.textOverflow, ['clip', 'ellipsis']), wrap: pick(c.whiteSpace, ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']),
            box: box(el), geo: geo(el), hasIcon: !!(el.parentElement && el.parentElement.querySelector('svg, [data-cds=Icon]')), anc,
          })
        }
        // Token names come from Claude's stylesheets (fixed families only); values are read inside the sidebar.
        const names = new Set(['--df-group-font', '--df-group-pt', '--df-row-font', '--df-row-h', '--df-row-px', '--df-row-gap', '--df-row-indent'])
        let rules = 0
        const dfOther = new Set()
        const walk = (list, d) => {
          if (d > 8) return
          for (const r of list) {
            if (++rules > 30000) { truncated.add('rules'); return }
            if (late()) { truncated.add('time'); return }
            try { if (r.cssRules) walk(r.cssRules, d + 1); const s = r.style; if (!s) continue; for (let i = 0; i < s.length && i < 400; i++) { if (late()) { truncated.add('time'); return } if (tokOk(s[i])) names.add(s[i]); else if (s[i].startsWith('--df-')) dfOther.add(s[i]) } } catch {}
          }
        }
        for (const sh of document.styleSheets) { if (truncated.has('rules') || truncated.has('time')) break; try { walk(sh.cssRules, 0) } catch {} }
        const sideCs = getComputedStyle(side)
        const val = (v) => { const x = v.trim(); if (x === '') return x; if (x.startsWith('var(') && x.endsWith(')') && varOk(x.slice(4, -1))) return x; if (x.length <= 120 && bracketOk(x)) return x; if (x.includes(',') || FAMS.includes(x)) return famOf(x); return '?' }
        const tokens = [...names].sort().map(v => [v, val(sideCs.getPropertyValue(v))]).filter(([, x]) => x !== '').slice(0, 150).map(([k, x]) => k + ': ' + x)
        const sample = (sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return { size: px(c.fontSize), weight: num(c.fontWeight), family: famOf(c.fontFamily) } }
        const route = location.pathname.split('/')[1] || ''
        // Selection (2 Nov 2026): which fixed candidate rule picks out exactly the header of the project that holds the
        // open chat. Numbers only: match counts, enum attribute value counts, true/false checks and masked paths. It runs
        // only when the whole sidebar fitted inside the 4000-element walk above (so every query is over a bounded tree),
        // checks the time budget before and after every query and step, and marks 'selection' in truncated when it stops.
        const H = '.df-label-inset h3 span.inline-block.whitespace-nowrap'
        const SELS = ['[data-selected=open]', '[aria-current=page]', '[aria-current=true]', '[aria-selected=true]', '[data-active=true]', '[data-state=active]']
        const q = (sel) => { try { return side.querySelectorAll(sel) } catch { return null } }
        let cut = false
        const stop = () => { if (cut || late()) { cut = true; truncated.add('selection') } return cut }
        const idxOf = (e) => { let n = 0; for (let x = e.previousElementSibling; x && n < 200; x = x.previousElementSibling) n++; return n }
        const selection = { headers: null, markers: {} }
        if (truncated.has('elements')) truncated.add('selection')
        else if (!stop()) {
          const hs = q(H)
          selection.headers = hs ? hs.length : -1
          for (const sx of SELS) {
            if (stop()) break
            const els = q(sx)
            if (stop()) break
            if (els === null) { selection.markers[sx] = { error: true }; continue }
            const m = { count: els.length, sampled: Math.min(els.length, 50), rows: 0, values: {} } // rows and values cover the first 'sampled' matches only
            const name = sx.slice(1, sx.indexOf('='))
            for (let k = 0; k < els.length && k < 50; k++) { if (els[k].hasAttribute('data-row')) m.rows++; const v = pick(els[k].getAttribute(name), ENUM); m.values[v] = (m.values[v] || 0) + 1 }
            let first = els[0] || null
            for (let k = 0; k < els.length && k < 50; k++) if (els[k].hasAttribute('data-row')) { first = els[k]; break }
            // The owning header: walk up from the first marked row (or element) to the first ancestor holding a header.
            let top = null
            m.up = []
            for (let e = first; e && e !== side && m.up.length < 12; e = e.parentElement) {
              if (stop()) break
              const inside = e.querySelectorAll('.df-label-inset').length
              if (stop()) break
              const headerChild = !!e.querySelector(':scope > .df-label-inset')
              if (stop()) break
              m.up.push({ el: desc(e), idx: idxOf(e), sibs: e.parentElement ? e.parentElement.childElementCount : 0, headerChild, headersInside: inside })
              if (inside > 0) { top = e; break }
            }
            if (stop()) { selection.markers[sx] = m; break }
            const owners = top ? top.querySelectorAll(H) : []
            if (stop()) { selection.markers[sx] = m; break }
            const expected = owners.length === 1 ? owners[0] : null
            m.ownerHeaders = owners.length
            m.down = []
            if (top) { const hdr = top.querySelector('.df-label-inset'); for (let e = hdr; e && e !== top && m.down.length < 8; e = e.parentElement) m.down.unshift(desc(e)) }
            m.cands = {}
            const paths = ['', 'div > ', 'div > div > ', 'div > div > div > ']
            for (let d = 0; d < paths.length; d++) {
              if (stop()) break
              const got = q('div:has(> ' + paths[d] + '.df-label-inset):has(' + sx + ') > ' + paths[d] + H)
              if (stop()) break
              m.cands['d' + d] = got === null ? { n: -1 } : { n: got.length, exact: expected !== null && got.length === 1 && got[0] === expected }
            }
            selection.markers[sx] = m
          }
          stop() // a query that ran past the budget still marks the section incomplete
        }
        // Activity (3 Nov 2026): which session marks each project box holds, so a later rule can tell "this project has
        // a running session" apart. Numbers, booleans and fixed words only, per box in sidebar order: whether it is open,
        // session rows (all and visible), each mark's paint and size, which status token its background or shadow names
        // (from a fixed list, never the style text), whether it animates, anything drawn inside the header besides the
        // name, controls outside rows and header, and how many boxes each candidate rule matches. Every cap is reported
        // ('activity-sample' in truncated plus sampled counts); a query that fails or runs past the budget marks the
        // section incomplete instead of looking empty; any error inside it is caught here and reported as a fixed word,
        // so earlier results survive. These are observations: the tooltip labels give the true state of each mark.
        const PROJ = 'div.isolate.rounded-lg'
        const HDR = ':scope > div > div > .df-label-inset'
        const NAME = 'span.inline-block.whitespace-nowrap'
        const STATUS = ['fill-warning', 'fill-accent', 'text-muted', 'fill-danger', 'text-danger', 'fill-success', 'text-accent']
        const CANDS = ['[data-cds=Pulse]', '.df-tail-mark [data-cds=Pulse]', '[data-cds=Pulse][style*=fill-warning]', '[data-cds=Pulse][style*=fill-accent]', '[data-cds=Pulse][style*=text-muted]']
        let cutA = false
        const stopA = () => { if (cutA || late()) { cutA = true; truncated.add('activity') } return cutA }
        const qa = (root, sel) => { try { return root.querySelectorAll(sel) } catch { cutA = true; truncated.add('activity'); return null } }
        const capped = () => truncated.add('activity-sample')
        const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }
        // The status token named in one inline declaration, by property: only var(--cds-NAME followed by ')', ',' or a space.
        const tokIn = (v) => { const hits = STATUS.filter(t => { const i = v.indexOf('var(--cds-' + t); if (i < 0) return false; const nx = v[i + 10 + t.length]; return nx === ')' || nx === ',' || nx === ' ' }); return hits.length === 1 ? hits[0] : hits.length === 0 ? 'other' : 'several' }
        const decls = (s) => { const o = { bg: 'none', shadow: 'none' }; const ds = s.split(';'); if (ds.length > 30) { capped(); o.bg = o.shadow = 'unread' } for (const d of ds.slice(0, 30)) { const i = d.indexOf(':'); if (i < 0) continue; const k = d.slice(0, i).trim().toLowerCase(); const v = d.slice(i + 1); if (k === 'background' || k === 'background-color') o.bg = tokIn(v); else if (k === 'box-shadow') o.shadow = tokIn(v) } return o }
        const shown = (e, c) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden' && c.opacity !== '0' }
        const markOf = (p) => {
          const c = getComputedStyle(p)
          const d = decls(p.getAttribute('style') || '')
          const filled = c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent' && c.backgroundImage === 'none'
          const ring = c.boxShadow !== 'none'
          const r = p.getBoundingClientRect()
          return { paint: filled && !ring ? 'fill' : ring && !filled ? 'ring' : filled ? 'both' : 'neither', bg: d.bg, shadow: d.shadow, shown: shown(p, c), w: Math.round(r.width), h: Math.round(r.height), anim: c.animationName !== 'none', animRunning: c.animationName !== 'none' && c.animationPlayState === 'running', opacity: num(c.opacity), inRow: !!p.closest('[data-row]'), inTail: !!p.closest('.df-tail-mark') }
        }
        // Every loop checks the budget on each step; every count below says how many items were actually looked at.
        const activity = { reducedMotion: 'unknown', projects: null, boxes: [], candidates: {}, sidebarPulses: null, pulsesOutsideRows: null, pulsesLooked: 0, error: '' }
        try {
          activity.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
          if (truncated.has('elements')) truncated.add('activity')
          else if (!stopA()) {
            const boxesAll = qa(side, PROJ)
            if (boxesAll !== null && !stopA()) {
              const projects = []
              let looked = 0
              for (let k = 0; k < boxesAll.length && k < 200; k++) { if (stopA()) break; looked++; if (boxesAll[k].querySelector(HDR)) projects.push(boxesAll[k]) }
              if (boxesAll.length > 200) capped()
              activity.boxesMatchingProj = boxesAll.length
              activity.boxesLooked = looked
              activity.projects = projects.length
              if (projects.length > 60) capped()
              for (const b of projects.slice(0, 60)) {
                if (stopA()) break
                const r = { error: '' }
                activity.boxes.push(r)
                try {
                  const hdr = b.querySelector(HDR)
                  if (stopA()) break
                  const btn = hdr.querySelector('h3 button[aria-expanded]')
                  r.expanded = btn ? pick(btn.getAttribute('aria-expanded'), ENUM) : 'none'
                  if (stopA()) break
                  r.current = !!b.querySelector('[aria-current=page]')
                  if (stopA()) break
                  const rows = qa(b, '[data-row]')
                  if (rows === null || stopA()) break
                  r.rows = rows.length
                  r.rowsVisible = 0
                  r.rowsLooked = 0
                  for (let k = 0; k < rows.length && k < 300; k++) { if (stopA()) break; r.rowsLooked++; if (shown(rows[k], getComputedStyle(rows[k]))) r.rowsVisible++ }
                  if (rows.length > 300) capped()
                  if (stopA()) break
                  const marks = qa(b, '[data-cds=Pulse]')
                  if (marks === null || stopA()) break
                  r.marks = marks.length
                  r.marksLooked = 0
                  r.bgTokens = {}
                  r.shadowTokens = {}
                  r.paints = {}
                  r.detail = []
                  for (let k = 0; k < marks.length && k < 40; k++) { if (stopA()) break; const m = markOf(marks[k]); r.marksLooked++; bump(r.bgTokens, m.bg); bump(r.shadowTokens, m.shadow); bump(r.paints, m.paint); if (r.detail.length < 12) r.detail.push(m) }
                  if (marks.length > 40 || r.marksLooked > 12) capped()
                  if (stopA()) break
                  // Anything the header draws besides the name: marks, inline-painted elements, badges, digit-only text
                  // outside the name span (a count badge would show here; a name made of digits does not).
                  let digits = 0
                  let textLooked = 0
                  const tw = document.createTreeWalker(hdr, 4)
                  for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (stopA()) break; if (textLooked >= 50) { capped(); break } textLooked++; const t = n.textContent.trim(); if (t !== '' && only(t, DIG) && !(n.parentElement && n.parentElement.closest(NAME))) digits++ }
                  if (stopA()) break
                  const hs = qa(hdr, '*')
                  if (hs === null || stopA()) break
                  let painted = 0
                  let hsLooked = 0
                  for (let k = 0; k < hs.length && k < 80; k++) { if (stopA()) break; hsLooked++; const s = hs[k].getAttribute('style') || ''; if (s.includes('background') || s.includes('shadow')) painted++ }
                  if (hs.length > 80) capped()
                  if (stopA()) break
                  const hm = qa(hdr, '[data-cds=Pulse]')
                  if (hm === null || stopA()) break
                  const hb = qa(hdr, '[data-cds=Badge]')
                  if (hb === null || stopA()) break
                  r.header = { marks: hm.length, badges: hb.length, painted, digitsOutsideName: digits, textLooked, elements: hs.length, elementsLooked: hsLooked, button: btn ? attrsOf(btn) : '' }
                  // Controls in the box that are neither a session row nor the header ("show more", for example): counts only.
                  const ctl = qa(b, 'button, [role=button], a')
                  if (ctl === null || stopA()) break
                  let extra = 0
                  let extraShown = 0
                  let ctlLooked = 0
                  for (let k = 0; k < ctl.length && k < 200; k++) { if (stopA()) break; ctlLooked++; if (!ctl[k].closest('[data-row]') && !hdr.contains(ctl[k])) { extra++; if (shown(ctl[k], getComputedStyle(ctl[k]))) extraShown++ } }
                  if (ctl.length > 200) capped()
                  r.extraControls = extra
                  r.extraControlsShown = extraShown
                  r.controlsLooked = ctlLooked
                } catch { r.error = 'box-failed'; truncated.add('activity') }
              }
              // Each candidate rule over the whole sidebar: how many boxes it matches; of those, how many have no project
              // header at all (false hits), how many are projects past the 60 listed, and the listed projects by position.
              for (const cs of CANDS) {
                if (stopA()) break
                const got = qa(side, PROJ + ':has(' + cs + ')')
                if (got === null || stopA()) break
                const c = { boxes: got.length, looked: 0, notProject: 0, projectBeyondList: 0, projectPositions: [] }
                for (let k = 0; k < got.length && k < 200; k++) {
                  if (stopA()) break
                  c.looked++
                  const i = projects.indexOf(got[k])
                  if (i >= 0 && i < 60) { if (c.projectPositions.length < 60) c.projectPositions.push(i + 1) }
                  else if (got[k].querySelector(HDR)) c.projectBeyondList++
                  else c.notProject++
                }
                if (got.length > 200) capped()
                activity.candidates[cs] = c
              }
              if (!stopA()) {
                const sp = qa(side, '[data-cds=Pulse]')
                if (sp !== null && !stopA()) {
                  activity.sidebarPulses = sp.length
                  let o = 0
                  for (let k = 0; k < sp.length && k < 400; k++) { if (stopA()) break; activity.pulsesLooked++; if (!sp[k].closest('[data-row]')) o++ }
                  if (sp.length > 400) capped()
                  activity.pulsesOutsideRows = o
                }
                stopA()
              }
            }
          }
        } catch { activity.error = 'section-failed'; truncated.add('activity') }
        return {
          code: 'ok', ms: Math.round(performance.now() - t0), truncated: [...truncated], visited, dataRows: rowsSeen.size, expanded, otherDfTokens: dfOther.size, selection, activity,
          route: pick(route, ['code', 'chat', 'new', 'project', 'projects', 'settings', 'recents', '']),
          skinMarker: getComputedStyle(document.documentElement).getPropertyValue('--reskin-active').trim() === '1',
          html: attrsOf(document.documentElement), sidebar: desc(side), sidebarBox: box(side),
          tokens, samples: { body: sample('body'), sidebar: sample('.dframe-sidebar'), icon: sample('[data-cds=Icon]'), code: sample('pre, code'), input: sample('textarea, [contenteditable=true]') },
          texts: [...groups.values()].sort((a, b) => a.box.y - b.box.y),
        }
      })()\` }])).catch(() => ({ code: 'error' }))
    }
    out.push(row)
  }
  const pages = out.filter(r => r.page)
  // Every window's outcome is listed; a run that learned nothing fails rather than printing an empty success.
  const partial = pages.filter(r => r.page.code !== 'ok').map(r => 'window ' + r.id + ': ' + r.page.code)
  if (all.length > 6) partial.push('only the first 6 of ' + all.length + ' windows were read')
  const good = pages.some(r => r.page.code === 'ok' && r.page.texts.length > 0 && r.page.dataRows >= 2)
  return { errors: good ? [] : ['no window had a readable sidebar with at least two visible session rows (' + (pages.map(r => r.page.code).join(', ') || 'no Claude page') + ')'], partial, windows: out }
})()`
// P9, read-only: Claude's "Enable Main Process Debugger" menu item as it stands now (checked or not), and the
// start of its click handler's source, so the agreed checkmark fix can be chosen. Clicks nothing, changes nothing.
const MENU_PROBE = `(() => {
  const { Menu } = ${ELECTRON}
  const menu = Menu.getApplicationMenu()
  if (!menu) return { found: false, why: 'no application menu' }
  const hits = []
  const walk = (items, trail) => { for (const it of items) { const here = [...trail, it.label]; if (it.label === 'Enable Main Process Debugger') hits.push({ it, here }); if (it.submenu) walk(it.submenu.items, here) } }
  walk(menu.items, [])
  if (hits.length !== 1) return { found: false, why: hits.length + ' matching items' }
  const { it, here } = hits[0]
  return { found: true, path: here, type: it.type, checked: it.checked, enabled: it.enabled, visible: it.visible, handler: typeof it.click === 'function' ? String(it.click).slice(0, 3000) : null }
})()`

const CLOSE = `(() => { clearTimeout(globalThis.__reskinFallback); ${UNTICK}; process.getBuiltinModule('inspector').close(); return 'closed' })()`

// ---- Batch mode: try several presets in one connection, screenshot each, then restore. ----
// Hard time plan (ms after connecting). Every step has a cap; a step that hits its cap ends the loop. The final restore
// and the close must end before Claude's own fallback close (FALLBACK_CLOSE_MS), so a restore is never cut off by it.
// armLimit: a batch only starts if connecting took at most this long. signalCap: the restore tried on Ctrl-C or SIGTERM.
export const BATCH = { maxItems: 6, armLimit: 3_000, applyCap: 2_500, shotCap: 2_500, loopEnd: 10_000, finalCap: 7_000, closeCap: 1_500, signalCap: 3_000 }

// Read-only: Claude's mode and what the skin code has on now (to restore it afterwards).
const BATCH_STATE = `(() => {
  const { nativeTheme } = ${ELECTRON}
  const st = globalThis.__reskin
  return { dark: nativeTheme.shouldUseDarkColors, source: nativeTheme.themeSource, css: st?.css ?? null, batch: st?.batch === true }
})()`

// Read-only: one screenshot of the Claude page plus the colours that matter. Writes nothing, inserts nothing.
const SHOT = `(async () => {
  const { webContents, BrowserWindow } = ${ELECTRON}
  const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))])
  const pages = webContents.getAllWebContents().filter(w => { try { return !w.isDestroyed() && new URL(w.getURL()).origin === 'https://claude.ai' } catch { return false } })
  if (pages.length !== 1) return { error: pages.length === 0 ? 'no Claude page' : 'more than one Claude page (' + pages.length + '), screenshot skipped' }
  const w = pages[0]
  const bw = BrowserWindow.fromWebContents(w)
  const out = { visible: bw ? bw.isVisible() : null, minimized: bw ? bw.isMinimized() : null, zoom: w.getZoomFactor() }
  try {
    // Two frames so the new sheet is painted, but never more than 150 ms: a covered window may not run frames at all.
    out.page = await within(w.executeJavaScriptInIsolatedWorld(4245, [{ code: \`new Promise(resolve => {
      let done = false
      const read = () => {
        if (done) return
        done = true
        const cs = el => el ? getComputedStyle(el) : null
        const side = document.querySelector('.dframe-sidebar')
        const row = document.querySelector('.dframe-sidebar [data-selected]:not([data-selected=false])')
        const r = side ? side.getBoundingClientRect() : null
        resolve({
          marker: getComputedStyle(document.documentElement).getPropertyValue('--reskin-active').trim(),
          bodyBg: cs(document.body).backgroundColor,
          sidebarBg: side ? cs(side).backgroundColor : null,
          row: row ? { bg: cs(row).backgroundColor, color: cs(row).color } : null,
          rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
          innerWidth: window.innerWidth,
        })
      }
      setTimeout(read, 150)
      requestAnimationFrame(() => requestAnimationFrame(read))
    })\` }]), 700, 'reading the page')
  } catch (e) { out.pageError = String(e?.message ?? e).slice(0, 200) }
  try {
    const img = await within(w.capturePage(), 1000, 'taking the screenshot')
    if (img.isEmpty()) { out.windowError = 'empty screenshot (window hidden or minimised?)'; return out }
    const size = img.getSize()
    // The whole window as a JPEG at most 1600 px wide (colours are measured from styles, not from these pixels).
    const small = size.width > 1600 ? img.resize({ width: 1600, quality: 'good' }) : img
    const jpg = small.toJPEG(85).toString('base64')
    if (jpg.length > 3_000_000) out.windowError = 'screenshot too large, dropped'
    else out.window = jpg
    // The sidebar, cut from the same image. The page is innerWidth CSS px wide and the image is size.width pixels wide,
    // so one factor converts both ways whatever Claude's zoom or the display scale. Rounded outward, clamped.
    const p = out.page
    if (p && p.rect && p.innerWidth > 0) {
      const k = size.width / p.innerWidth
      const x = Math.max(0, Math.floor(p.rect.x * k)), y = Math.max(0, Math.floor(p.rect.y * k))
      const width = Math.min(size.width - x, Math.ceil((p.rect.x + p.rect.width) * k) - x)
      const height = Math.min(size.height - y, Math.ceil((p.rect.y + p.rect.height) * k) - y)
      if (width > 0 && height > 0) {
        const png = img.crop({ x, y, width, height }).toPNG().toString('base64')
        if (png.length > 3_000_000) out.sidebarError = 'sidebar image too large, dropped'
        else out.sidebar = png
      } else out.sidebarError = 'sidebar outside the window'
    }
  } catch (e) { out.windowError = String(e?.message ?? e).slice(0, 200) }
  // Last, and in its own call with its own limits, so a slow page can never cost the main read or the picture:
  // Claude's own accent blues still painted (an observation; named blues are meant to stay), and the unread dots.
  try {
    out.census = await within(w.executeJavaScriptInIsolatedWorld(4246, [{ code: \`(() => {
      const t0 = performance.now()
      const blues = new Set(['rgb(42, 120, 214)', 'rgb(57, 135, 229)', 'rgb(205, 226, 251)', 'rgb(3, 32, 66)', 'rgb(24, 79, 149)', 'rgb(109, 167, 236)', 'rgb(134, 182, 239)', 'rgb(13, 54, 107)'])
      const blueLeft = { n: 0, samples: [], truncated: false }
      let seen = 0
      for (const el of document.querySelectorAll('body *')) {
        if (++seen > 5000 || performance.now() - t0 > 250) { blueLeft.truncated = true; break }
        const c = getComputedStyle(el)
        const hit = ['backgroundColor', 'color', 'borderTopColor', 'outlineColor', 'fill'].find(k => blues.has(c[k]))
        if (!hit) continue
        blueLeft.n++
        if (blueLeft.samples.length < 6) blueLeft.samples.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 5).join('.') + ' ' + hit + ' ' + c[hit])
      }
      const dots = [...document.querySelectorAll('.status-dot')].slice(0, 3).map(d => ({ bg: getComputedStyle(d).backgroundColor, cls: String(d.className).slice(0, 160), style: (d.getAttribute('style') ?? '').slice(0, 120) }))
      return { blueLeft, dots }
    })()\` }]), 400, 'counting leftover blue')
  } catch (e) { out.censusError = String(e?.message ?? e).slice(0, 200) }
  return out
})()`

// ---- Dot census (17 Oct 2026): the session-status marks in the sidebar. ----
// Read-only and screenshot-free. Rows and slots follow Claude's own sidebar code: every row is a [data-row] element, its
// status mark sits in .df-leading-slot / [data-leading-slot]. Nothing written in the page. No text leaves the page: kinds,
// states and icon names are fixed words, colours are colours, and a row is named only by a salted hash of its href (the
// salt is random per run and never stored), so rows can be matched across the reads of one run and never identified.
// itemCap: the census after each apply (in place of the screenshot). baselineCap: once before the first apply.
export const DOT = { itemCap: 1_000, baselineCap: 600, pageCap: 700, maxRows: 200, maxPaints: 8, pageMs: 300 }
const DOT_TOKENS = ['--cds-fill-accent', '--cds-fill-warning', '--cds-fill-danger', '--cds-text-muted', '--cds-text-warning']
export const DOT_ICONS = ['hand', 'help', 'question', 'globe', 'warning', 'gauge', 'cloud', 'info', 'archive']

const dotPage = (salt) => `(() => {
  const SALT = ${JSON.stringify(salt)}
  const TOKENS = ${JSON.stringify(DOT_TOKENS)}
  const ICONS = ${JSON.stringify(DOT_ICONS)}
  const t0 = performance.now()
  const clear = (c) => !c || c === 'transparent' || /^rgba\\(.*,\\s*0\\)$/.test(c) || /\\/\\s*0\\)$/.test(c)
  // Only numeric colour forms ever leave the page: no letters inside the brackets, so no text can ride along.
  const NUM = /^(#[0-9a-fA-F]{3,8}|rgba?\\([0-9., %/]*\\)|color\\(srgb [0-9., %/]*\\))$/
  const strict = (v) => NUM.test(v) ? v : null
  // Anything else (a named colour, color-mix, a var expression) goes through a detached 2D canvas, which serialises
  // colours itself (writes nothing to the page); its answer must pass the same numeric check. Unparsed = null.
  const g = new OffscreenCanvas(1, 1).getContext('2d')
  const norm = (v) => { if (!v) return null; if (strict(v)) return v; g.fillStyle = '#010203'; g.fillStyle = v; const o = String(g.fillStyle); return o === '#010203' ? null : strict(o) }
  const tokenOf = (v) => v === '' ? '' : norm(v) ?? 'other'
  let late = false
  const tooLate = () => (late ||= performance.now() - t0 > ${DOT.pageMs})
  const hash = (s) => { let h = 0x811c9dc5; for (const ch of SALT + s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }
  const enumOf = (v, allowed) => v === null ? null : allowed.includes(v) ? v : 'other'
  const out = { v: 1, marker: getComputedStyle(document.documentElement).getPropertyValue('--reskin-active').trim() === '1',
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    rows: [], truncated: false, warningInSidebar: 0 }
  const side = document.querySelector('.dframe-sidebar')
  if (!side) return { ...out, error: 'no sidebar' }
  const scs = getComputedStyle(side)
  out.dfHover = norm(scs.getPropertyValue('--df-hover').trim())
  out.dfSelected = norm(scs.getPropertyValue('--df-selected').trim())
  out.warningInSidebar = side.querySelectorAll('.text-warning').length
  // Every non-clear background from the page root down to el (bottom first). More than 64 steps, more than 12 layers or an
  // unreadable colour = null (unknown).
  const bgsTo = (el, stop) => {
    const a = []
    let steps = 0
    for (let e = el; e && e !== stop; e = e.parentElement) {
      if (++steps > 64 || tooLate()) return null
      const c = getComputedStyle(e).backgroundColor
      if (clear(c)) continue
      const k = strict(c)
      if (k === null) return null
      a.push(k)
    }
    return a.length > 12 ? null : a.reverse()
  }
  // Opacity of el and every element above it, up to and including stop (or up to stop's child when exclusive).
  const opacityTo = (el, stop, inclusive = true) => { let o = 1, steps = 0; for (let e = el; e; e = e.parentElement) { if (e === stop && !inclusive) break; if (++steps > 64 || tooLate()) return null; o *= Number(getComputedStyle(e).opacity) || 0; if (e === stop) break } return +o.toFixed(3) }
  const hidden = (c) => (c.mask && c.mask !== 'none') || (c.filter && c.filter !== 'none') || (c.clipPath && c.clipPath !== 'none')
  // A mask, filter, clip or blend on anything above the row changes what the dot looks like in ways the census cannot
  // model: true (unknown), or null when the walk was too long.
  const fxAbove = (row) => { let steps = 0; for (let e = row.parentElement; e; e = e.parentElement) { if (++steps > 200 || tooLate()) return null; const c = getComputedStyle(e); if (hidden(c) || (c.mixBlendMode && c.mixBlendMode !== 'normal')) return true } return false }
  const iconName = (el) => {
    const words = [el.getAttribute('data-icon') ?? '', String(el.getAttribute('class') ?? '')].join(' ').toLowerCase()
    return ICONS.find(n => words.includes(n)) ?? 'other'
  }
  // A mark that is not drawn at all (display:none on it or anything above it, or visibility hidden) has no paint:
  // unknown, never a pass.
  // The walk goes all the way to the page root (a hidden list above the row hides it too) and must pass through the row.
  const drawnUpTo = (el, row) => {
    if (['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) return false
    let steps = 0, viaRow = false
    for (let e = el; e; e = e.parentElement) { if (++steps > 200 || tooLate()) return false; if (getComputedStyle(e).display === 'none') return false; if (e === row) viaRow = true }
    return viaRow
  }
  const paintsOf = (el, row) => {
    const cs = getComputedStyle(el)
    if (hidden(cs) || !drawnUpTo(el, row)) return null
    const one = (c) => { const k = strict(c); return k === null ? null : [{ c: k, a: 1 }] }
    if (el.matches('.status-dot')) return cs.backgroundImage && cs.backgroundImage !== 'none' ? null : one(cs.backgroundColor)
    if (el.tagName.toLowerCase() === 'img') return null
    // A hollow Pulse (Claude's ring) draws its colour as an inset 1px box-shadow followed by a 0.5px page-coloured ring; the
    // whole list must be exactly that, any other shadow form = unknown.
    if (el.matches('[data-cds=Pulse]') && clear(cs.backgroundColor)) { const m = /^(rgba?\\([0-9., ]*\\)) 0px 0px 0px 1px inset, rgba?\\([0-9., ]*\\) 0px 0px 0px 0\\.5px$/.exec(cs.boxShadow); return m ? one(m[1]) : null }
    if (el.tagName.toLowerCase() !== 'svg' && !el.querySelector('svg')) return clear(cs.backgroundColor) ? one(cs.borderTopColor) : one(cs.backgroundColor)
    const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg')
    // Only drawn shapes paint (an svg or g fill is inherited, never drawn itself). Each shape's opacity counts every group
    // between it and the mark; a mask, filter or clip anywhere on that chain, or too much to read, = unknown.
    // Content drawn elsewhere (use, text, images, foreign content) is not read: unknown. Shapes inside definitions (defs,
    // symbol, clipPath, mask, pattern, marker) or under a display:none group are never drawn, so they are skipped.
    if (svg.querySelector('use, text, image, foreignObject')) return null
    const shapes = [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')]
    if (shapes.length === 0 || shapes.length > 200) return null
    const NOT_DRAWN = ['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient']
    const seen = new Map()
    for (const p of shapes) {
      if (tooLate()) return null
      const c = getComputedStyle(p)
      if (c.visibility === 'hidden' || c.visibility === 'collapse') continue
      let drawn = true, steps = 0
      for (let e = p; e && e !== el; e = e.parentElement) {
        if (++steps > 64 || tooLate()) return null
        const ec = getComputedStyle(e)
        if (NOT_DRAWN.includes(e.tagName.toLowerCase()) || ec.display === 'none') { drawn = false; break }
        if (hidden(ec)) return null
      }
      if (!drawn) continue
      const o = opacityTo(p, el, false)
      if (o === null) return null
      for (const [paint, po] of [[c.fill, c.fillOpacity], [c.stroke, c.strokeOpacity]]) {
        if (!paint || paint === 'none' || clear(paint)) continue
        const k = strict(paint)
        if (k === null) return null // a gradient, a pattern, a url(): unknown
        const a = +(o * (Number(po) || 0)).toFixed(3)
        if (!seen.has(k + '|' + a)) seen.set(k + '|' + a, { c: k, a })
        if (seen.size > ${DOT.maxPaints}) return null
      }
    }
    return seen.size && !late ? [...seen.values()] : null
  }
  let n = 0
  for (const row of side.querySelectorAll('[data-row]')) {
    if (tooLate() || out.rows.length >= ${DOT.maxRows}) { out.truncated = true; break }
    n++
    if (row.closest('.df-placeholder-rows')) continue
    // Where the mark sits: in a session row the status mark is at the
    // row's end, in .df-tail-mark / [data-row-decoration]; other rows keep theirs in the leading slot.
    const inSessions = !!row.closest('.df-session-list')
    const owned = (list) => [...list].filter(x => x.closest('[data-row]') === row)
    const roots = inSessions ? owned(row.querySelectorAll('.df-tail-mark, [data-row-decoration]')) : owned(row.querySelectorAll('.df-leading-slot, [data-leading-slot]')).slice(0, 1)
    if (roots.length === 0) continue
    const find = (sel) => { for (const r of roots) { const x = r.matches(sel) ? r : r.querySelector(sel); if (x) return x } return null }
    let mark = null, kind = 'unknown', icon = null
    const dot = find('.status-dot'), pulse = find('[data-cds=Pulse]'), fresh = find('.df-new-circle'), ic = find('svg, img, [data-cds=Icon]')
    const ring = roots.flatMap(r => [...r.querySelectorAll('span')]).slice(0, 50).find(s => /(^|\\s)rounded-full(\\s|$)/.test(s.className) && /(^|\\s)border(\\s|$)/.test(s.className) && clear(getComputedStyle(s).backgroundColor))
    if (dot) { mark = dot; const k = dot.getAttribute('data-kind'); kind = 'dot-' + enumOf(k, ['ready', 'awaiting', 'running', 'error', 'clay']) }
    else if (pulse) { mark = pulse; kind = 'pulse' }
    else if (fresh) { mark = fresh; kind = 'new-circle' }
    else if (ic) { mark = ic; kind = ic.tagName.toLowerCase() === 'img' ? 'picture' : 'icon'; icon = kind === 'icon' ? iconName(ic) : null }
    else if (ring) { mark = ring; kind = 'ring' }
    else { mark = roots[0].firstElementChild; kind = 'unknown' }
    if (!mark) continue
    const ds = row.getAttribute('data-selected')
    const ac = row.getAttribute('aria-current'), as = row.getAttribute('aria-selected'), da = row.getAttribute('data-active'), st = row.getAttribute('data-state')
    // Claude marks the open session on the row's main link (aria-current=page) as well as data-selected on the row.
    const ml = owned(row.querySelectorAll('[data-row-main-button][aria-current]'))[0]
    const lc = ml ? ml.getAttribute('aria-current') : null
    const selected = (lc !== null && lc !== 'false') || (ds !== null && ds !== 'false') || (ac !== null && ac !== 'false') || as === 'true' || (da !== null && da !== 'false') || st === 'active' || st === 'on'
    // A session row is a div; its address sits on its own main link inside.
    const link = row.getAttribute('href') !== null ? row : owned(row.querySelectorAll('[data-row-main-button][href], a[href]'))[0]
    const href = link ? link.getAttribute('href') : null
    const mcs = getComputedStyle(mark)
    const own = getComputedStyle(row).backgroundColor
    const entry = {
      n, id: href ? hash(href) : null, inSessions, tag: enumOf(row.tagName.toLowerCase(), ['a', 'button', 'div', 'li']),
      kind, icon, selectedAs: enumOf(ds, ['true', 'focused', 'false']), selected, hovered: row.matches(':hover'),
      bgs: bgsTo(row.parentElement, null), own: clear(own) ? null : strict(own) ?? 'other', inner: bgsTo(mark.parentElement, row),
      paints: kind === 'unknown' ? null : paintsOf(mark, row), opacity: opacityTo(mark, row),
      above: row.parentElement ? opacityTo(row.parentElement, null) : 1, aboveFx: fxAbove(row),
      anim: mcs.animationName === 'none' ? 'none' : 'running', tokens: Object.fromEntries(TOKENS.map(t => [t, tokenOf(mcs.getPropertyValue(t).trim())])),
    }
    // A row finished past the deadline is dropped, not half-reported, and the whole read counts as stopped early.
    if (tooLate()) { out.truncated = true; break }
    out.rows.push(entry)
  }
  if (tooLate()) out.truncated = true
  return out
})()`

// Main-process side: the one Claude page, then the page script in its own world and time cap.
const dotCensus = (salt, cap) => `(async () => {
  const { webContents } = ${ELECTRON}
  const pages = webContents.getAllWebContents().filter(w => { try { return !w.isDestroyed() && new URL(w.getURL()).origin === 'https://claude.ai' } catch { return false } })
  if (pages.length !== 1) return { error: pages.length === 0 ? 'no Claude page' : 'more than one Claude page (' + pages.length + ')' }
  return await Promise.race([pages[0].executeJavaScriptInIsolatedWorld(4247, [{ code: ${JSON.stringify(dotPage(salt))} }]),
    new Promise((_, rej) => setTimeout(() => rej(new Error('dot census timed out')), ${cap}))]).catch(e => ({ error: String(e?.message ?? e).slice(0, 200) }))
})()`

// Colours as Claude reports them: rgb(), rgba() or color(srgb r g b / a). Anything else is null ("unknown", never a pass).
export function parseColor(s) {
  const t = String(s ?? '').trim()
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t)
  if (m) return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: alpha(m[4]) }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(t)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alpha(m[4]) }
  return null
}
const alpha = (v) => v === undefined ? 1 : v.endsWith('%') ? +v.slice(0, -1) / 100 : +v
const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
const lin = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
const oklab = (c) => {
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
export const deltaE = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

// The selected sidebar row: does it stand out from the sidebar (OKLab 0.045, as the generator requires) and is its text
// readable (4.5:1)? See-through colours are laid over what is under them; an unreadable or see-through page = unknown.
export function judgeRow(page) {
  if (!page || !page.row) return { verdict: 'unknown', why: page ? 'no selected row in the sidebar (select a chat first)' : 'page not read' }
  const body = parseColor(page.bodyBg)
  const side0 = parseColor(page.sidebarBg)
  const row0 = parseColor(page.row.bg)
  const text0 = parseColor(page.row.color)
  if (!body || body.a < 1 || !side0 || !row0 || !text0) return { verdict: 'unknown', why: 'a colour could not be read' }
  const side = over(side0, body)
  const row = over(row0, side)
  const text = over(text0, row)
  const dE = deltaE(row, side)
  const ratio = contrast(text, row)
  const ok = dE >= 0.045 && ratio >= 4.5
  return { verdict: ok ? 'ok' : 'check', dE: +dE.toFixed(3), contrast: +ratio.toFixed(2), why: ok ? '' : [dE < 0.045 ? 'selected row barely differs from the sidebar' : '', ratio < 4.5 ? 'selected row text below 4.5:1' : ''].filter(Boolean).join('; ') }
}

// ---- Dot census judgements (offline, in this process; the page only measured). ----
// A colour as the page reported it: rgb(), rgba(), color(srgb) or a canvas #rrggbb. Anything else is null (unknown).
export function colourOf(s) {
  const t = String(s ?? '').trim()
  const h = /^#([0-9a-fA-F]{6})$/.exec(t)
  if (h) { const v = parseInt(h[1], 16); return { r: (v >> 16) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 } }
  return parseColor(t)
}
// Layers bottom first; the bottom one must be opaque, or the result is unknown (null).
const stackOf = (list) => {
  const cs = list.map(colourOf)
  if (cs.length === 0 || cs.some((c) => c === null) || cs[0].a < 1) return null
  return cs.slice(1).reduce((under, top) => over(top, under), cs[0])
}
// The most visible part of a mark on background bg (each paint laid over bg at its real opacity). null = unknown.
const markContrast = (r, bg) => {
  if (!bg || !Array.isArray(r.paints) || r.paints.length === 0) return null
  let best = 0
  for (const p of r.paints) {
    const c = colourOf(p.c)
    // Opacity or effects above the row (a fading list, a filter) are not modelled: unknown, never a pass.
    if (r.above !== 1 || r.aboveFx !== false) return null
    if (c === null || typeof p.a !== 'number' || typeof r.opacity !== 'number') return null
    const painted = over({ ...c, a: c.a * p.a * r.opacity }, bg)
    best = Math.max(best, contrast(painted, bg))
  }
  return +best.toFixed(2)
}
export const DOT_MIN = 3 // WCAG 1.4.11, non-text marks

// Each session-row mark: contrast on the row as seen (OBSERVED, in the state it was in) and on the other two states,
// PREDICTED from --df-hover / --df-selected laid over the row's plain background. Under 3:1 is flagged; unknown is never a pass.
export function judgeDots(c) {
  if (!c || c.error) return { error: c?.error ?? 'not read', marks: [] }
  const hover = colourOf(c.dfHover), sel = colourOf(c.dfSelected)
  const marks = []
  for (const r of c.rows ?? []) {
    if (!r.inSessions) continue
    const base = stackOf(r.bgs ?? [])
    const own = r.own === null || r.own === undefined ? null : colourOf(r.own)
    const inner = Array.isArray(r.inner) ? r.inner.map(colourOf) : null
    const top = (bg) => bg === null || inner === null || inner.some((x) => x === null) ? null : inner.reduce((under, t) => over(t, under), bg)
    const state = r.selected ? 'selected' : r.hovered ? 'hovered' : 'plain'
    const observed = base === null || (r.own != null && own === null) ? null : top(own ? over(own, base) : base)
    // Claude's rows are clear until hovered or selected, which lay --df-hover / --df-selected over them. A row seen plain
    // with a background of its own breaks that rule, so its other states cannot be worked out: unknown.
    const odd = state === 'plain' && r.own != null
    const predicted = { plain: top(base), hovered: !odd && base && hover ? top(over(hover, base)) : null, selected: !odd && base && sel ? top(over(sel, base)) : null }
    // Claude hides a session mark while its row is hovered: that observed state shows nothing to
    // read, so it is 'hidden', not a failure. Only on a hovered row; an unhovered invisible mark still fails. The mark's
    // opacity when shown is not known, so its other states are unknown, never predicted at a guessed opacity.
    // r.hovered, not state: a selected row that is also hovered hides its mark too.
    const hoverHidden = r.opacity === 0 && r.hovered === true
    const cell = (s) => s === state ? (hoverHidden ? { contrast: null, source: 'hidden' } : { contrast: markContrast(r, observed), source: 'observed' }) : { contrast: hoverHidden ? null : markContrast(r, predicted[s]), source: 'predicted' }
    const m = { n: r.n, id: r.id, kind: r.kind, icon: r.icon, state, anim: r.anim, plain: cell('plain'), hovered: cell('hovered'), selected: cell('selected') }
    m.low = ['plain', 'hovered', 'selected'].filter((s) => m[s].contrast !== null && m[s].contrast < DOT_MIN)
    m.unknown = ['plain', 'hovered', 'selected'].filter((s) => m[s].contrast === null && m[s].source !== 'hidden')
    marks.push(m)
  }
  return { scheme: c.scheme, reduceMotion: c.reduceMotion, marker: c.marker, truncated: c.truncated, warningInSidebar: c.warningInSidebar, marks }
}

// Which colour Claude uses for "waiting for you": read only from the selected session row, which the user opened because
// it was waiting (and confirms so in chat). Every read must show exactly one selected session, the same one, same mark.
export function needsYou(reads) {
  const picks = []
  if (reads.length < 3) return { answer: 'unverified', why: 'needs the before, at least one item and the after read' }
  for (const c of reads) {
    if (!c || c.error) return { answer: 'unverified', why: 'a read failed or is missing' }
    if (c.truncated) return { answer: 'unverified', why: 'a read stopped early, so another selected session could be missed' }
    const sel = (c.rows ?? []).filter((r) => r.inSessions && r.selected)
    if (sel.length !== 1) return { answer: 'unverified', why: `${sel.length} selected session rows in one read` }
    picks.push(sel[0])
  }
  if (picks.length === 0) return { answer: 'unverified', why: 'nothing read' }
  const [p] = picks
  if (p.id === null || picks.some((q) => q.id !== p.id || q.kind !== p.kind || q.icon !== p.icon)) return { answer: 'unverified', why: 'the selected session or its mark changed between reads, or it has no address' }
  // A Pulse carries no kind of its own: its paint is matched against the warning and accent tokens it carries, in every
  // read, and every read must give the same answer.
  const sameAs = (a, b) => { const x = colourOf(a), y = colourOf(b); return x !== null && y !== null && ['r', 'g', 'b'].every((k) => Math.abs(x[k] - y[k]) < 0.002) }
  const classify = (q) => {
    const pulse = q.kind === 'pulse' && Array.isArray(q.paints) && q.paints.length === 1 ? q.paints[0].c : null
    const pulseIs = (t) => pulse !== null && sameAs(pulse, q.tokens?.[t])
    return q.kind === 'dot-ready' || (pulseIs('--cds-fill-accent') && !pulseIs('--cds-fill-warning')) ? 'blue' : q.kind === 'dot-awaiting' || (pulseIs('--cds-fill-warning') && !pulseIs('--cds-fill-accent')) || (q.kind === 'icon' && ['hand', 'help', 'question'].includes(q.icon)) ? 'amber' : 'unknown'
  }
  const answers = new Set(picks.map(classify))
  if (answers.size !== 1) return { answer: 'unverified', why: 'the selected session\'s mark changed colour between reads' }
  const [answer] = answers
  return { answer, kind: p.kind, icon: p.icon, why: 'valid only if the user confirms the selected session was waiting for them, after opening it' }
}

// Removal: the final read against the baseline, row by row (matched by hashed address), tokens and paints.
// It proves something only if the test colours were first seen on the dots (diagnostic: overrideSeen 'seen'), and only
// rows whose every value is a real colour (or unset) are compared: 'other' tokens or unknown paints are left out.
const supported = (r) => Array.isArray(r.paints) && r.paints.length > 0 && Object.values(r.tokens ?? {}).every((v) => v !== 'other')
export function removalProof(before, after, diagnostic) {
  if (diagnostic?.verdict !== 'seen') return { verdict: 'unverified', why: 'the test colours were never seen on the dots, so their removal proves nothing' }
  if (!before || before.error || before.truncated) return { verdict: 'unverified', why: 'no complete baseline read' }
  if (!after || after.error || after.truncated) return { verdict: 'unverified', why: 'no complete final read' }
  const unique = (c) => { const m = new Map(), dup = new Set(); for (const r of c.rows ?? []) { if (!r.inSessions || r.id === null) continue; if (m.has(r.id)) dup.add(r.id); m.set(r.id, r) } for (const d of dup) m.delete(d); return m }
  const a = unique(before), b = unique(after)
  const differ = [], changed = []
  let compared = 0
  for (const [id, r] of a) {
    const s = b.get(id)
    if (!s) continue
    if (s.kind !== r.kind || s.icon !== r.icon || s.selected !== r.selected || s.hovered !== r.hovered) { changed.push(r.n); continue }
    if (!supported(r) || !supported(s)) continue
    compared++
    if (JSON.stringify(s.tokens) !== JSON.stringify(r.tokens) || JSON.stringify(s.paints) !== JSON.stringify(r.paints)) differ.push(r.n)
  }
  if (compared === 0) return { verdict: 'unverified', why: 'no row could be compared (none with an address in both reads, or all changed state)', changed }
  return { verdict: differ.length === 0 ? 'proved' : 'differs', compared, differ, changed }
}

// What a stylesheet's half for `mode` sets on the marks, in source order: [{ sel, token, value }] for the rules on
// .status-dot (dots only), [data-cds=Pulse] (Pulse marks only) and .dframe-sidebar * (every mark in the sidebar).
export function declaredDotTokens(css, mode) {
  const head = new RegExp(`@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*${mode}\\s*\\)\\s*\\{`, 'i').exec(css)
  if (!head) return {}
  let depth = 1, i = head.index + head[0].length
  const start = i
  for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
  const block = css.slice(start, i - 1)
  const out = []
  for (const [, sel, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '))
    const scopes = sels.includes('.dframe-sidebar *') ? ['sidebar'] : [sels.includes('.status-dot') && 'dot', sels.includes('[data-cds=Pulse]') && 'pulse'].filter(Boolean)
    for (const scope of scopes) for (const [, k, v] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;!]+?)\s*(?:!\s*important)?\s*(?:;|$)/gi)) if (DOT_TOKENS.includes(k)) out.push({ scope, token: k, value: v.trim().toLowerCase() })
  }
  return out
}
// The tokens a mark should carry: the later of equal-strength rules wins; .status-dot rules reach dots only, Pulse rules Pulses only.
const expectedFor = (declared, kind) => {
  const e = {}
  for (const d of declared) if (d.scope === 'sidebar' || (d.scope === 'dot' && kind.startsWith('dot-')) || (d.scope === 'pulse' && kind === 'pulse')) e[d.token] = d.value
  return e
}

// Did the stylesheet's dot tokens reach the marks? Every session-row mark must carry each declared token.
export function overrideSeen(c, declared) {
  if (declared.length === 0) return { verdict: 'none declared' }
  if (!c || c.error) return { verdict: 'unknown', why: 'not read' }
  if (c.truncated) return { verdict: 'unknown', why: 'the read stopped early' } // never "seen" from part of the sidebar
  const rows = (c.rows ?? []).filter((r) => r.inSessions && Object.keys(expectedFor(declared, r.kind)).length > 0)
  if (rows.length === 0) return { verdict: 'unknown', why: 'no session rows the test colours apply to' }
  const same = (a, b) => { const x = colourOf(a), y = colourOf(b); return x !== null && y !== null && ['r', 'g', 'b', 'a'].every((k) => Math.abs(x[k] - y[k]) < 0.002) }
  const misses = rows.filter((r) => Object.entries(expectedFor(declared, r.kind)).some(([k, v]) => !same(r.tokens?.[k], v))).map((r) => r.n)
  return { verdict: misses.length === 0 ? 'seen' : 'not seen', checked: rows.length, misses }
}

// Plain lines for the terminal (and the log): every read, what failed 3:1, and the three verdicts.
const markName = (m) => m.kind === 'icon' ? `icon-${m.icon}` : m.kind
const cellText = (c) => c.source === 'hidden' ? 'hidden by Claude' : c.contrast === null ? 'unknown' : `${c.contrast}:1${c.source === 'predicted' ? ' (predicted)' : ''}`
export function dotLines(d) {
  if (!d) return []
  const read = (label, j) => {
    if (j.error) return [`DOTS ${label}: not read (${j.error})`]
    const kinds = [...new Set(j.marks.map(markName))].join(', ') || 'none'
    const low = j.marks.flatMap((m) => m.low.map((s) => `#${m.n} ${markName(m)} ${s} ${cellText(m[s])}`))
    const unknown = j.marks.reduce((a, m) => a + m.unknown.length, 0), hidden = j.marks.filter((m) => m[m.state]?.source === 'hidden').length
    return [`DOTS ${label} (${j.scheme}${j.reduceMotion ? ', reduce motion' : ''}): ${j.marks.length} marks [${kinds}]${j.truncated ? ' (stopped early)' : ''}; under ${DOT_MIN}:1: ${low.length ? low.join('; ') : 'none'}; unknown cells: ${unknown}; hidden by Claude on hover: ${hidden}`]
  }
  return [
    ...read('before', d.baseline),
    ...d.items.flatMap((i) => [...read(i.name, i.judged), `DOTS ${i.name} override: ${i.override?.verdict ?? 'unknown'}${i.override?.misses?.length ? ` (missing on rows ${i.override.misses.join(', ')})` : ''}`]),
    ...read('after', d.after),
    `DOTS removal: ${d.removal.verdict}${d.removal.why ? ` (${d.removal.why})` : ''}${d.removal.differ?.length ? ` (rows ${d.removal.differ.join(', ')} differ)` : ''}${d.removal.compared ? `, ${d.removal.compared} rows compared` : ''}`,
    `DOTS waiting-for-you colour: ${d.needsYou.answer} (${d.needsYou.why})`,
  ]
}

const dotTable = (label, j) => {
  if (j.error) return `<h3>${esc(label)}</h3><p>not read: ${esc(j.error)}</p>`
  const rows = j.marks.map((m) => `<tr><td>${esc(m.n)}</td><td>${esc(markName(m))}</td><td>${esc(m.state)}</td><td>${esc(m.anim)}</td>${['plain', 'hovered', 'selected'].map((s) => `<td${m.low.includes(s) ? ' class="n"' : ''}>${esc(cellText(m[s]))}</td>`).join('')}</tr>`).join('')
  return `<h3>${esc(label)} <small>${esc(j.scheme)}${j.reduceMotion ? ', reduce motion' : ''}</small></h3><table><tr><th>row</th><th>mark</th><th>state</th><th>blink</th><th>plain</th><th>hovered</th><th>selected</th></tr>${rows}</table>`
}

// Which half of a preset Claude can show now: one-mode presets in the other mode are skipped, not applied.
export const fitsMode = (modes, mode) => modes.includes(mode)

// Start one more item only if its worst case still ends by the loop end (a dot census reads instead of screenshotting).
export const roomForItem = (elapsed, dots = false) => elapsed + BATCH.applyCap + (dots ? DOT.itemCap : BATCH.shotCap) <= BATCH.loopEnd

export const batchFolderName = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `batch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// A local contact sheet: no scripts, no links out, every string from Claude escaped. The pictures are embedded
// (data: URIs from `images`, name -> bytes), so the page works on its own in any viewer, not only next to its files.
export function contactSheet(report, images = new Map()) {
  const src = (name) => {
    const buf = images.get(name)
    return buf ? `data:${name.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${buf.toString('base64')}` : esc(name)
  }
  const rows = report.items.map((it) => {
    const pics = it.files ? `<img src="${src(it.files.window)}" alt="" class="w">${it.files.sidebar ? `<img src="${src(it.files.sidebar)}" alt="" class="s">` : ''}` : ''
    const j = it.row ? `selected row: ${esc(it.row.verdict)}${it.row.dE !== undefined ? `, difference ${it.row.dE}, text ${it.row.contrast}:1` : ''}${it.row.why ? ` (${esc(it.row.why)})` : ''}` : ''
    return `<section><h2>${esc(it.name)} <small>${esc(it.status)}${it.mode ? `, ${esc(it.mode)}` : ''}</small></h2><p>${j}</p>${it.notes?.length ? `<p class="n">${it.notes.map(esc).join('<br>')}</p>` : ''}<div class="p">${pics}</div></section>`
  }).join('\n')
  return `<!doctype html><meta charset="utf-8"><title>${esc(report.folder)}</title>
<style>body{font:14px system-ui;margin:16px;background:#f4f4f4;color:#111}section{background:#fff;margin:0 0 16px;padding:12px;border-radius:8px}.p{display:flex;gap:12px;align-items:flex-start}.w{max-width:70%}.s{max-width:28%}img{border:1px solid #ccc}small{color:#555;font-weight:normal}.n{color:#a33}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:2px 6px;text-align:left}</style>
<h1>Reskin batch ${esc(report.folder)}</h1>
<p>Claude was showing ${esc(report.claudeMode)} (Appearance: ${esc(report.themeSource)}). Final step: ${esc(report.final)}, ${report.finalOk ? 'completed' : '<b>NOT confirmed</b> (a test skin may still be on)'}.</p>
<p>By eye, for each skin: hover a sidebar row, then select another (both visible, selected stronger, labels readable); main area, a pop-up menu and Settings keep Claude's faint hover wash, no solid block. Priority: Catppuccin Latte, GitHub Light, One Light, Rose Pine Dawn.</p>
${rows}
${report.dots ? `<section><h2>Session dots</h2><p>Contrast of each mark on its row (3:1 needed). "predicted" = worked out from the hover or selected colour, not seen. Rows are numbered, never named.</p>${dotTable('before', report.dots.baseline)}${report.dots.items.map((i) => dotTable(i.name, i.judged)).join('')}${dotTable('after', report.dots.after)}<p>${dotLines(report.dots).slice(-2).map(esc).join('<br>')}</p></section>` : ''}
`
}

// The CSS must be one dark-mode or light-mode block, or one of each (a pair: Claude shows whichever
// matches its own Appearance), and must fetch nothing. Escapes are refused outright, since they could
// spell url( in disguise.
const CSS_MAX = 16_384 // the largest preset is under 5 KB
function checkCss(raw) {
  // Plain ASCII only: JavaScript counts some Unicode spaces as whitespace and CSS does not, so a no-break
  // space could pass the checks below and still break the block structure or swallow the appended marker.
  if (/[^\x20-\x7e\t\n\r\f]/.test(raw)) throw new Error('The stylesheet may contain only plain ASCII characters, spaces, tabs and line breaks.')
  // No strings at all: then a comment can only be a comment, never hide inside one.
  if (/["'\\]/.test(raw)) throw new Error('The stylesheet may not contain quotes or backslashes (font names work unquoted).')
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').trim()
  if (css.includes('/*') || css.includes('*/')) throw new Error('The stylesheet has an unclosed comment.')
  if (/url|@import|image-set|image\s*\(|src\s*\(|\/\/|@font-face|@namespace|expression\s*\(/i.test(css)) {
    throw new Error('The stylesheet may not load anything (no url, @import, image(), @font-face or links).')
  }
  // A colour skin may only change colours. Without this, a stylesheet that passes could hide, move, cover or
  // relabel parts of Claude (a button, a warning) and the helper would keep it on through every reload. So, as the
  // generated presets are written: every selector is a plain class (optionally with " *"), html, body, :root or *;
  // every declaration sets one of Claude's colour tokens (--cds-*, --df-*, --accent-*) or a colour property, and every
  // value is a colour (opaque #hex for colour properties; opaque #hex, rgb()/rgba() not nearly see-through, or for --accent-<n>
  // the bare "H S% L%" form, for the tokens). Layout, visibility, content and pointer properties are refused.
  if (raw.length > CSS_MAX) throw new Error(`The stylesheet is larger than ${CSS_MAX / 1024} KB.`)
  // One exact attribute selector besides: [data-cds=Pulse], the mark Claude draws session status dots with. It still sets colour tokens only, like every other rule.
  const SELECTOR = /^(\*|\*::(before|after)|html|body|:root|\.[A-Za-z0-9_-]+(\s+\*)?|\[data-cds=Pulse\])$/
  const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
  const TOKEN_VALUE = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0?\.\d+|1(\.0+)?)\s*)?\))$/
  const notClear = (v) => { const a = /,\s*(0?\.\d+|1(\.0+)?)\s*\)$/.exec(v); return a === null || Number(a[1]) >= 0.05 } // a nearly see-through colour could hide text
  let seg = ''
  for (const c of css) {
    if (c === '{') {
      const pre = seg.trim().replace(/\s+/g, ' ')
      seg = ''
      if (pre.startsWith('@')) {
        if (!/^@media \( ?prefers-color-scheme ?: ?(dark|light) ?\)$/i.test(pre)) throw new Error(`Only the colour-scheme @media blocks are allowed, not: ${pre.slice(0, 60)}`)
        continue
      }
      for (const sel of pre.split(',')) if (!SELECTOR.test(sel.trim())) throw new Error(`Only plain class, html, body, * or [data-cds=Pulse] selectors are allowed, not: ${sel.trim().slice(0, 60)}`)
    } else if (c === ';' || c === '}') {
      const d = seg.trim()
      seg = ''
      if (d === '') continue
      const m = /^(--[A-Za-z0-9_-]+|[A-Za-z-]+)\s*:\s*([\s\S]*?)\s*(!\s*important)?$/i.exec(d)
      const name = m?.[1].toLowerCase() ?? ''
      const value = m?.[2] ?? ''
      if (m === null) throw new Error(`Not a declaration I understand: ${d.slice(0, 60)}`)
      if (name.startsWith('--')) {
        if (!/^--(cds|df|accent)-[a-z0-9-]+$/.test(name)) throw new Error(`Only Claude's colour tokens (--cds-*, --df-*, --accent-*) may be set, not ${name.slice(0, 40)}.`)
        const ok = (TOKEN_VALUE.test(value) && notClear(value)) || (/^--accent-\d+$/.test(name) && /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(value))
        if (!ok) throw new Error(`${name.slice(0, 40)} must be set to a colour, not: ${value.slice(0, 40)}`)
      } else {
        if (!/^(color|background-color|border(-(top|right|bottom|left))?-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)$/.test(name)) throw new Error(`Only colours may be set: ${name.slice(0, 40) || d.slice(0, 40)} is not a colour property.`)
        if (!HEX.test(value)) throw new Error(`${name} must be an opaque #hex colour, not: ${value.slice(0, 40)}`)
      }
    } else seg += c
  }
  // Walk the top-level blocks: each must be a colour-scheme block, and nothing may sit between or after them.
  const modes = []
  let at = 0
  while (at < css.length) {
    const head = /^\s*@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{/i.exec(css.slice(at))
    if (head === null) {
      throw new Error(modes.length === 0
        ? 'The stylesheet must start with @media (prefers-color-scheme: dark) { or (prefers-color-scheme: light) {'
        : 'Nothing may follow the colour-scheme blocks except one more colour-scheme block.')
    }
    modes.push(head[1].toLowerCase())
    // One ordered stack for braces, parentheses and square brackets: every closer must match the latest opener,
    // so nothing (such as an unfinished parenthesis) can stay open and swallow the marker appended after the sheet.
    const stack = []
    const pairs = { '}': '{', ')': '(', ']': '[' }
    let i = at + head[0].length - 1
    for (; i < css.length; i++) {
      const c = css[i]
      if (c === '{' || c === '(' || c === '[') stack.push(c)
      else if (c in pairs) {
        if (stack.pop() !== pairs[c]) throw new Error('The stylesheet has mismatched or misordered brackets.')
        if (stack.length === 0) break
      }
    }
    if (stack.length !== 0) throw new Error('The stylesheet has unbalanced braces or brackets.')
    at = i + 1
    while (at < css.length && /\s/.test(css[at])) at++
  }
  if (modes.length === 0) throw new Error('The stylesheet is empty.')
  // Tools read the mode by counting colour-scheme queries, so none may hide inside a block.
  if ([...css.matchAll(/prefers-color-scheme/gi)].length !== modes.length) throw new Error('A colour-scheme query may appear only at the start of a block, not inside one.')
  if (modes.length > 2 || (modes.length === 2 && modes[0] === modes[1])) {
    throw new Error('A stylesheet has one colour-scheme block, or two: one dark and one light.')
  }
  return modes
}

const here = path.dirname(fileURLToPath(import.meta.url))

// Type sheets (2 Nov 2026) get their own checker, so the colour checker stays exactly as reviewed. Same outer guards
// (plain ASCII, no quotes or backslashes, no comments left open, loads nothing). Then: top-level rules only (no @-rules),
// each selector one of TYPE_RULES exactly (found by the live probe; never icons, code or warnings), and on each only the
// declarations listed for it: font-size (whole px, 11 to 16), font-weight (400, 500, 600 or 700), the sidebar row text
// size token --df-row-font (whole px, 11 to 16, on the sidebar only; session names, and some top controls and footer
// text), on the current project's header row only one exact accent stripe (box-shadow, see TYPE_STRIPE), and colour
// only as one of the skin's own text tokens (accent or primary): the one deliberate exception to "colours only through
// checkCss", since it can only point at a colour the skin or Claude already sets, never bring one of its own. Optionally
// !important. No other var(), calc(), brackets or relative units.
const TYPE_HEADER = '.dframe-sidebar .df-label-inset h3 span.inline-block.whitespace-nowrap'
// The same header text, but only while its project is open (Claude marks the header button aria-expanded=true).
const TYPE_HEADER_OPEN = '.dframe-sidebar .df-label-inset h3 button[aria-expanded=true] span.inline-block.whitespace-nowrap'
// The header of the project that holds the open chat: Claude marks that chat's row button aria-current=page, and each
// project sits in its own isolate rounded-lg box with its header two levels down (live probe, 2 Nov 2026).
const TYPE_HEADER_CURRENT = '.dframe-sidebar div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset h3 span.inline-block.whitespace-nowrap'
// The header of an active project: one holding any session status mark (running, waiting for you or unread). Claude keeps
// a folded project's session rows in the page, hidden, with their marks, so this holds folded or not (live activity probe,
// 3 Nov 2026). It names the mark only, never its inline colour text. Same specificity as TYPE_HEADER_CURRENT; today both
// set the same colour and weight, so the order matters only if they ever differ.
const TYPE_HEADER_ACTIVE = '.dframe-sidebar div.isolate.rounded-lg:has([data-cds=Pulse]) > div > div > .df-label-inset h3 span.inline-block.whitespace-nowrap'
// The header ROW of the project holding the open chat, for the "you are here" stripe (3 Nov 2026). Marks on the name
// were clipped (dotted underline) or too quiet (italic): the name sits in a span with overflow hidden, but this 32px row
// does not clip (live probe chain). Only box-shadow, and only the one value TYPE_STRIPE: an inset 3px bar in the skin
// accent at the row's left edge. Inset, so it stays inside the row and needs no room at the scroll list's edge.
const TYPE_ROW_CURRENT = '.dframe-sidebar div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset'
const TYPE_STRIPE = 'inset 3px 0 0 0 var(--cds-text-accent)'
export const TYPE_RULES = new Map([
  ['.dframe-sidebar', new Set(['--df-row-font'])],
  [TYPE_HEADER, new Set(['font-size', 'font-weight', 'color'])],
  [TYPE_HEADER_OPEN, new Set(['color'])],
  [TYPE_HEADER_ACTIVE, new Set(['color', 'font-weight'])],
  [TYPE_HEADER_CURRENT, new Set(['color', 'font-weight'])],
  [TYPE_ROW_CURRENT, new Set(['box-shadow'])],
])
export const TYPE_SELECTORS = new Set(TYPE_RULES.keys())
// Fonts (3 Nov 2026, master tool only until release.json says "font": true): one rule on the page root and Claude's own
// font roots (.cds-root, where Claude's font menu sets its token) points five of Claude's font tokens at one stack from
// FONT_STACKS (skin-lib.mjs). Names only from there, none needing quotes. Live probes 2 Nov: body, replies, message box, buttons and
// sidebar read these tokens; code, icons and the serif display headings read others and stay Claude's.
export const FONT_SELECTOR = ':root, .cds-root'
export const FONT_PROPS = Object.freeze(['--cds-font-sans', '--font-sans', '--default-font-family', '--font-claude-response', '--font-user-message'])
const FONT_VALUES = new Set(Object.values(FONT_STACKS))
const fontValue = (v) => v.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim()
// The font part of a type sheet, exactly as the checker expects it.
// A sized key (`plex-16`) adds the size rules (names probe 7, 3 Nov 2026): reply text inherits its size from Claude's
// markdown block .prose, whose own rule reads a value Claude writes inline under an unstable name, so the block itself
// gets the size (important beats Claude's normal rule; .prose is Claude's rendered markdown wherever it appears). The
// message box reads --cmp-font-size (through Claude's text-entry floor) and --cmp-leading; code, kbd and some other
// chat text read --chat-body and --chat-leading (Claude's Transcript switch). Those four tokens on every element,
// important. Sidebar, buttons and menus read other tokens and keep Claude's sizes.
export const SIZE_SELECTOR = '*'
export const SIZE_PROPS = Object.freeze(['--chat-body', '--chat-leading', '--cmp-font-size', '--cmp-leading'])
const SIZE_IS_LEADING = new Set(['--chat-leading', '--cmp-leading', 'line-height'])
export const PROSE_SELECTOR = '.prose'
export const PROSE_PROPS = Object.freeze(['font-size', 'line-height'])
export const sizeCss = (size) => `${SIZE_SELECTOR} { --chat-body: ${size}px !important; --chat-leading: ${SIZE_LEADING[size]}px !important; --cmp-font-size: ${size}px !important; --cmp-leading: ${SIZE_LEADING[size]}px !important; }\n${PROSE_SELECTOR} { font-size: ${size}px !important; line-height: ${SIZE_LEADING[size]}px !important; }\n`
// A today's font key (`plex`, `plex-16`) -> its sheet: exactly the look parts it means, joined (unchanged text).
export function fontCss(key) {
  if (splitFontKey(key) === null) throw new Error(`Not a Reskin font: ${String(key).slice(0, 40)}`)
  return parseLook(key).map(lookPartCss).join('')
}
// Font picker parts (4 Nov 2026): each section's font, size and weight as one small rule set on
// its own exact selectors (scopes probes 8 and 9). A section font sets the five font tokens AND font-family on the scope
// root (Claude redeclares the tokens on .cds-root levels, and a family resolved above is inherited as a value). Header
// parts and the rows size use different spellings of the type sheet's selectors (class order swapped; aside.), so they
// never collide with the type sheet's own rules in the checker; the swapped header selectors keep the type sheet's
// specificity and come later, so they win; aside.dframe-sidebar is more specific than the type sheet's .dframe-sidebar.
export const LOOK_SEL = Object.freeze({
  chatFont: '.prose, .prose :is(h1, h2, h3, h4, h5, h6), .ProseMirror[contenteditable=true]',
  chatWeight: '.prose, .ProseMirror[contenteditable=true]',
  rows: '.dframe-sidebar [data-row]',
  rowsSize: 'aside.dframe-sidebar',
  rowsWeight: '.dframe-sidebar [data-row] button, .dframe-sidebar button[data-row]',
  header: '.dframe-sidebar .df-label-inset h3 span.whitespace-nowrap.inline-block',
  headerActive: '.dframe-sidebar div.isolate.rounded-lg:has([data-cds=Pulse]) > div > div > .df-label-inset h3 span.whitespace-nowrap.inline-block',
  headerCurrent: '.dframe-sidebar div.isolate.rounded-lg:has([aria-current=page]) > div > div > .df-label-inset h3 span.whitespace-nowrap.inline-block',
})
const fontBlock = (sel, name, family) => `${sel} {\n${FONT_PROPS.map((p) => `  ${p}: ${FONT_STACKS[name]} !important;`).join('\n')}${family ? `\n  font-family: ${FONT_STACKS[name]} !important;` : ''}\n}\n`
// One part id -> its exact CSS. Throws on anything that is not a part.
export function lookPartCss(id) {
  if (!LOOK_PARTS.includes(id)) throw new Error(`Not a look part: ${String(id).slice(0, 40)}`)
  const [sec, kind, v] = id.split('.')
  if (sec === 'ui') return fontBlock(FONT_SELECTOR, v, false)
  if (sec === 'chat') return kind === 'font' ? fontBlock(LOOK_SEL.chatFont, v, true) : kind === 'size' ? sizeCss(Number(v)) : `${LOOK_SEL.chatWeight} { font-weight: ${v} !important; }\n`
  if (sec === 'rows') return kind === 'font' ? fontBlock(LOOK_SEL.rows, v, true) : kind === 'size' ? `${LOOK_SEL.rowsSize} { --df-row-font: ${v}px !important; }\n` : `${LOOK_SEL.rowsWeight} { font-weight: ${v} !important; }\n`
  // headers: at 500 or more the active and current headers take the chosen weight too (owner decision, 4 Nov 2026); under 500
  // the type sheet's emphasis (500) stays.
  if (kind === 'font') return fontBlock(LOOK_SEL.header, v, true)
  if (kind === 'size') return `${LOOK_SEL.header} { font-size: ${v}px !important; }\n`
  return `${Number(v) >= 500 ? `${LOOK_SEL.header}, ${LOOK_SEL.headerActive}, ${LOOK_SEL.headerCurrent}` : LOOK_SEL.header} { font-weight: ${v} !important; }\n`
}
// The type slot's whole sheet: the header sheet (type on) and then the parts in LOOK_ORDER. The helper composes exactly
// the same way (installHelper's compose; a test asserts equal text).
export function composeType(parts, headers, ids) {
  return (headers ? parts.headers + (ids.length ? '\n' : '') : '') + ids.map((id) => parts[id]).join('')
}
// Every part rule (not ui.font, not the chat size pair, which have their own checks): normalized "selector{body}" -> slot.
const normRule = (sel, body) => `${sel.trim().replace(/\s+/g, ' ')}{${body.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).join(';')}}`
let PART_RULES = null
const partRules = () => {
  if (PART_RULES !== null) return PART_RULES
  const m = new Map()
  for (const id of LOOK_PARTS) {
    if (id.startsWith('ui.font.') || id.startsWith('chat.size.')) continue
    const css = lookPartCss(id)
    const open = css.indexOf('{'), close = css.lastIndexOf('}')
    if (open === -1 || css.indexOf('}') !== close) throw new Error(`A part must be one rule: ${id}`)
    m.set(normRule(css.slice(0, open), css.slice(open + 1, close)), slotOf(id))
  }
  return (PART_RULES = m)
}
// Is the font feature in this copy? The development copy (no release.json) has it; a release only with "font": true.
export function fontShipped(dir = here) {
  const f = path.join(dir, 'release.json')
  try { lstatSync(f) } catch (e) { return e.code === 'ENOENT' }
  try { return JSON.parse(readFileSync(f, 'utf8'))?.font === true } catch { return false }
}
const TYPE_ACCENT = 'var(--cds-text-accent)'
// Colour only as one of the skin's own text tokens (Claude's own with no skin): never a colour of the sheet's own.
const TYPE_COLOURS = new Set([TYPE_ACCENT, 'var(--cds-text-primary)'])
// The only bracketed text a type sheet may hold: those tokens, the attribute in TYPE_HEADER_OPEN and the :has() in
// TYPE_HEADER_CURRENT and TYPE_HEADER_ACTIVE.
// Font picker parts add exactly three (4 Nov 2026): the reply headings, the editable message box and the session row mark.
const TYPE_BRACKETED = [...TYPE_COLOURS, '[aria-expanded=true]', ':has([aria-current=page])', ':has([data-cds=Pulse])', ':is(h1, h2, h3, h4, h5, h6)', '[contenteditable=true]', '[data-row]']
// The largest sheet the slot can hold: the header sheet with the longest part of every slot (measured by a test, which
// fails if this is too small or more than 512 bytes larger than needed).
export const TYPE_MAX = 4608
// `font` false: the sheet may not hold the font rule (the header sheet file); `headers` false: it may hold nothing else (a
// font sheet). A combined sheet allows both.
export function checkTypeCss(raw, { font = true, headers = true } = {}) {
  if (typeof raw !== 'string') throw new Error('The type sheet is not text.')
  if (/[^\x20-\x7e\t\n\r\f]/.test(raw)) throw new Error('The type sheet may contain only plain ASCII characters, spaces, tabs and line breaks.')
  if (/["'\\]/.test(raw)) throw new Error('The type sheet may not contain quotes or backslashes.')
  if (raw.length > TYPE_MAX) throw new Error(`The type sheet is larger than ${TYPE_MAX / 1024} KB.`)
  // Comments only between complete rules: CSS drops a comment without leaving a space, so one inside a selector
  // (.a/**/.b) would make a different selector from the one checked here.
  let css = '', depth = 0, pending = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw.startsWith('/*', i)) {
      if (depth !== 0 || pending.trim() !== '') throw new Error('Comments are allowed only between rules, not inside a selector or a rule.')
      const end = raw.indexOf('*/', i + 2)
      if (end === -1) throw new Error('The type sheet has an unclosed comment.')
      i = end + 1
      css += ' '
      continue
    }
    const c = raw[i]
    if (c === '{') { depth++; pending = '' } else if (c === '}') { depth--; pending = '' } else if (depth === 0) pending += c
    css += c
  }
  css = css.trim()
  if (css.includes('*/')) throw new Error('The type sheet has a stray comment end.')
  if (/url|@|image-set|image\s*\(|src\s*\(|\/\/|expression\s*\(/i.test(css)) throw new Error('The type sheet may not load anything or use @-rules.')
  // Only the entries in TYPE_BRACKETED may hold brackets or parentheses; any other is refused.
  if (/[()\[\]]/.test(TYPE_BRACKETED.reduce((t, b) => t.split(b).join(' '), css))) throw new Error('The type sheet may not use brackets or parentheses (no var() but the skin text tokens, no calc(), no attribute selectors but the open-project one).')
  let rules = 0, at = 0, fontRules = 0, sizeRules = 0, proseRules = 0
  const sizeRows = []
  // Look parts: each slot at most once, slots in LOOK_ORDER, all after the header sheet's own rules (the composition order).
  let slotAt = -1, proseFirst = false
  const slotSeen = (slot) => {
    const k = LOOK_ORDER.indexOf(slot)
    if (k <= slotAt) throw new Error(`The ${slot} part is out of order or given twice.`)
    slotAt = k
  }
  while (at < css.length) {
    const open = css.indexOf('{', at)
    if (open === -1) throw new Error('Nothing may follow the last rule.')
    const close = css.indexOf('}', open)
    if (close === -1) throw new Error('The type sheet has an unclosed rule.')
    const sel = css.slice(at, open).trim().replace(/\s+/g, ' ')
    if (sel.includes('}')) throw new Error('The type sheet has a stray closing brace.')
    const body = css.slice(open + 1, close)
    if (body.includes('{')) throw new Error('Rules may not be nested.')
    if (sel === FONT_SELECTOR) {
      // The font rule: once per sheet, exactly the five font tokens, each once, all set to the same stack from FONT_STACKS.
      if (!font) throw new Error('This sheet may not hold a font rule.')
      if (++fontRules > 1) throw new Error('A type sheet may hold one font rule only.')
      const decls = body.split(';').map((d) => d.trim()).filter(Boolean)
      const seen = new Set()
      let stack = null
      for (const d of decls) {
        const m = /^(--[a-z-]+)\s*:\s*([A-Za-z][A-Za-z0-9 ,-]*?)\s*(!\s*important)?$/.exec(d)
        if (m === null) throw new Error(`Not a font declaration I understand: ${d.slice(0, 60)}`)
        const [, name, raw] = m
        if (!FONT_PROPS.includes(name)) throw new Error(`${name.slice(0, 40)} may not be set on ${FONT_SELECTOR}.`)
        if (seen.has(name)) throw new Error(`${name} is set twice in the font rule.`)
        seen.add(name)
        const v = fontValue(raw)
        if (!FONT_VALUES.has(v)) throw new Error(`Not one of the reviewed font stacks: ${v.slice(0, 60)}`)
        if (stack !== null && v !== stack) throw new Error('The font rule must set every token to the same font.')
        stack = v
      }
      if (seen.size !== FONT_PROPS.length) throw new Error(`The font rule must set all of ${FONT_PROPS.join(', ')}.`)
      slotSeen('ui.font')
      rules++
      at = close + 1
      while (at < css.length && /\s/.test(css[at])) at++
      continue
    }
    if (sel === SIZE_SELECTOR || sel === PROSE_SELECTOR) {
      // The size rules: each once, only beside a font rule, exactly their own properties, each once and important, whole
      // px; sizes equal, line heights equal, and the pair one FONT_SIZES row (12px with 18px .. 16px with 22px). The
      // two rules must come together and agree (checked after the last rule).
      if (!font) throw new Error('This sheet may not hold a size rule.')
      const prose = sel === PROSE_SELECTOR
      if (prose ? ++proseRules > 1 : ++sizeRules > 1) throw new Error(`A type sheet may hold one ${prose ? '.prose' : '*'} size rule only.`)
      const props = prose ? PROSE_PROPS : SIZE_PROPS
      const got = {}
      for (const d of body.split(';').map((x) => x.trim()).filter(Boolean)) {
        const m = /^(--[a-z-]+|[a-z-]+)\s*:\s*([1-9][0-9])px\s*!\s*important$/.exec(d)
        if (m === null) throw new Error(`Not a size declaration I understand (a whole px number, important): ${d.slice(0, 60)}`)
        if (!props.includes(m[1])) throw new Error(`${m[1].slice(0, 40)} may not be set on ${sel}.`)
        if (Object.hasOwn(got, m[1])) throw new Error(`${m[1]} is set twice in the size rule.`)
        got[m[1]] = Number(m[2])
      }
      if (Object.keys(got).length !== props.length) throw new Error(`The ${sel} size rule must set ${props.join(', ')}.`)
      const sizes = new Set(props.filter((p) => !SIZE_IS_LEADING.has(p)).map((p) => got[p]))
      const leads = new Set(props.filter((p) => SIZE_IS_LEADING.has(p)).map((p) => got[p]))
      const [size] = sizes, [lead] = leads
      if (sizes.size !== 1 || leads.size !== 1 || !FONT_SIZES.includes(size) || SIZE_LEADING[size] !== lead) throw new Error(`Not one of the reviewed sizes: ${[...sizes].join('/')}px with ${[...leads].join('/')}px lines.`)
      // The * rule opens the chat.size slot; the .prose rule must follow it at once (checked by the pair count and order).
      if (!prose) slotSeen('chat.size')
      else if (sizeRules === 0) proseFirst = true
      else if (LOOK_ORDER[slotAt] !== 'chat.size') throw new Error('The .prose size rule must follow the * size rule.')
      sizeRows.push(size)
      rules++
      at = close + 1
      while (at < css.length && /\s/.test(css[at])) at++
      continue
    }
    const part = partRules().get(normRule(sel, body))
    if (part !== undefined) {
      // A look part: exactly one of the reviewed part rules, text for text.
      if (!font) throw new Error('This sheet may not hold a font, size or weight part.')
      slotSeen(part)
      rules++
      at = close + 1
      while (at < css.length && /\s/.test(css[at])) at++
      continue
    }
    if (!headers) throw new Error('A font sheet may hold the font and size rules only.')
    const allowed = TYPE_RULES.get(sel)
    if (allowed === undefined) throw new Error(`Not one of the allowed type selectors (one per rule): ${sel.slice(0, 80)}`)
    if (slotAt !== -1) throw new Error('The header sheet\'s rules come before every font, size or weight part.')
    const decls = body.split(';').map((d) => d.trim()).filter(Boolean)
    if (decls.length === 0) throw new Error('A rule sets nothing.')
    for (const d of decls) {
      // The stripe: box-shadow with exactly TYPE_STRIPE (single spaces), nothing of shadow syntax beyond it.
      const shadow = /^box-shadow\s*:\s*(.*?)\s*(!\s*important)?$/.exec(d)
      if (shadow !== null) {
        if (!allowed.has('box-shadow')) throw new Error(`box-shadow may not be set on ${sel.slice(0, 60)}.`)
        if (shadow[1] !== TYPE_STRIPE) throw new Error(`box-shadow must be exactly ${TYPE_STRIPE}, not: ${shadow[1].slice(0, 60)}`)
        continue
      }
      const m = /^(--df-row-font|[a-z-]+)\s*:\s*([0-9a-z]+|var\(--cds-text-(?:accent|primary)\))\s*(!\s*important)?$/.exec(d)
      if (m === null) throw new Error(`Not a declaration I understand: ${d.slice(0, 60)}`)
      const [, name, value] = m
      if (!allowed.has(name)) throw new Error(`${name.slice(0, 40)} may not be set on ${sel.slice(0, 60)}.`)
      const px = () => { const v = /^(\d{2})px$/.exec(value); if (!v || Number(v[1]) < 11 || Number(v[1]) > 16) throw new Error(`${name} must be a whole px size from 11px to 16px, not: ${value}`) }
      if (name === 'font-size' || name === '--df-row-font') px()
      else if (name === 'font-weight') { if (!/^(400|500|600|700)$/.test(value)) throw new Error(`font-weight must be 400, 500, 600 or 700, not: ${value}`) }
      else if (name === 'color') { if (!TYPE_COLOURS.has(value)) throw new Error(`${name} may only be one of the skin text tokens (${[...TYPE_COLOURS].join(', ')}), not: ${value}`) }
    }
    rules++
    at = close + 1
    while (at < css.length && /\s/.test(css[at])) at++
  }
  if (rules === 0) throw new Error('The type sheet is empty.')
  // A chat size no longer needs a font (font picker, 4 Nov 2026): Claude's font at a Reskin size.
  if (sizeRules !== proseRules) throw new Error('The * and .prose size rules go together.')
  if (proseFirst) throw new Error('The .prose size rule must follow the * size rule.')
  if (sizeRows.length === 2 && sizeRows[0] !== sizeRows[1]) throw new Error('The two size rules must set the same size.')
  return rules
}

// The reviewed type slot texts for the helper (fixed at injection): 'headers' (the sidebar header sheet, checked) and,
// where fonts ship, every look part (font picker, 4 Nov 2026), keyed by part id. The helper composes a sheet from these
// (composeType) and inserts nothing else.
export function helperTypeSheets(dir = path.join(here, 'type'), opts) {
  return typeSheetsWhy(dir, opts).sheets
}
// The same, with the reason when the header sheet is not offered (missing, unreadable or refused by checkTypeCss), for
// the tick report. Parts come only where fontShipped() says so. Every part must pass alone, after the header sheet, and
// in the largest composition (the header sheet with the longest part of every slot), or no part is offered at all
// (never a silent gap).
export function typeSheetsWhy(dir = path.join(here, 'type'), { fonts = fontShipped() } = {}) {
  const sheets = {}
  let headers = null, why = null, fontWhy = null
  try { headers = readFileSync(path.join(dir, 'sidebar-headers.css'), 'utf8') } catch (e) { why = e.code === 'ENOENT' ? 'no type sheet in this copy' : 'the type sheet could not be read' }
  if (headers !== null) { try { checkTypeCss(headers, { font: false }); sheets.headers = headers } catch (e) { headers = null; why = 'the type sheet did not pass its check: ' + String(e.message).slice(0, 120) } }
  if (fonts) {
    const got = {}
    try {
      for (const id of LOOK_PARTS) {
        const css = lookPartCss(id)
        checkTypeCss(css, { headers: false })
        if (headers !== null) checkTypeCss(headers + '\n' + css)
        got[id] = css
      }
      const longest = LOOK_ORDER.map((slot) => LOOK_PARTS.filter((id) => slotOf(id) === slot).reduce((a, b) => (got[b].length > got[a].length ? b : a)))
      checkTypeCss(composeType({ ...got, headers: headers ?? '' }, headers !== null, longest))
      Object.assign(sheets, got)
    } catch (e) { fontWhy = 'a font part did not pass its check, so no fonts are offered: ' + String(e.message).slice(0, 120) }
  }
  return { sheets, why, fontWhy }
}

// Every reviewed preset, each passing checkCss, for the helper (fixed at injection; release 1 has no custom colours).
export function helperPresets(dir = path.join(here, 'presets')) {
  const map = {}
  const skipped = []
  // Dot census test sheets (dotcheck-*) are for batch runs only: never offered to a helper, where they would stay until Claude quits.
  for (const f of readdirSync(dir).filter(f => /^[a-z0-9]+(?:-[a-z0-9]+)*\.css$/.test(f) && !f.startsWith('dotcheck-') && !f.startsWith('type-') && !['off.css', 'remove.css', 'check.css'].includes(f)).sort()) {
    const name = f.slice(0, -4)
    try { const css = readFileSync(path.join(dir, f), 'utf8'); checkCss(css); map[name] = css } catch { skipped.push(name) }
  }
  if (Object.keys(map).length === 0) throw new Error(`No usable presets in ${dir}.`)
  return { map, skipped }
}

// Same as skin-lib's writeAll (skin.mjs stays a single file): wait for the output, at most `ms`.
export const writeAll = (text, stream = process.stdout, ms = 5_000) => new Promise((r) => {
  const t = setTimeout(r, ms)
  try { stream.write(text, () => { clearTimeout(t); r() }) } catch { clearTimeout(t); r() }
})

// Offline: the batch list. Final step 'previous' or 'off', then 1 to BATCH.maxItems preset files, each a real file inside
// presets/, named with plain lowercase letters, digits and dashes, listed once, and passing the stylesheet check.
export function prepareBatch(args, presetsDir = path.join(here, 'presets')) {
  const [final, ...files] = args
  if (final !== 'previous' && final !== 'off') throw new Error('The batch final step must be previous or off.')
  if (files.length < 1 || files.length > BATCH.maxItems) throw new Error(`A batch takes 1 to ${BATCH.maxItems} presets.`)
  const root = realpathSync(presetsDir)
  const seen = new Set()
  const items = files.map((f) => {
    const real = realpathSync(f)
    const name = path.basename(real, '.css')
    if (path.dirname(real) !== root || !real.endsWith('.css') || !/^[a-z0-9-]+$/.test(name)) throw new Error(`Not a preset: ${f}`)
    if (seen.has(name)) throw new Error(`Listed twice: ${name}`)
    seen.add(name)
    const css = readFileSync(real, 'utf8')
    return { name, file: real, css, modes: checkCss(css) }
  })
  return { final, items }
}

// Inside one connection: note what is on, try each preset (screenshot and numbers), then ALWAYS run the final step.
// Every call has a hard cap, and a cap that is hit ends the loop (see BATCH).
// Set while a batch runs: what a signal handler should do before closing the port (restore, briefly).
let onBatchSignal = null

async function runBatch(conn, opened, b) {
  const elapsed = () => Date.now() - opened
  // A slow start leaves no room for a safe restore later: then change nothing at all.
  if (elapsed() > BATCH.armLimit) throw new Error(`connecting took ${(elapsed() / 1000).toFixed(1)} s, so the batch did not start. Nothing was changed.`)
  const st = await conn.evaluate(BATCH_STATE, 1_500)
  const mode = st?.dark === true ? 'dark' : 'light'
  const report = { claudeMode: mode, themeSource: String(st?.source), final: 'off', finalOk: false, items: [], notes: [] }
  let restore = null
  if (b.final === 'previous' && typeof st?.css === 'string') {
    if (st.batch) report.notes.push('the skin on before was a leftover batch test skin, so the final step is Off')
    else {
      try { checkCss(st.css); restore = st.css } catch (e) { report.notes.push(`the skin on before did not pass the stylesheet check, so the final step is Off (${e.message})`) }
    }
  }
  report.final = restore === null ? 'off' : 'previous skin re-applied'
  // Dot census: one read before anything is applied (Claude as it was), within its own cap; a failed read is "unknown".
  const readDots = async (cap) => { try { return await conn.evaluate(dotCensus(b.salt, cap - 100), cap) } catch (e) { return { error: String(e?.message ?? e).slice(0, 200) } } }
  if (b.dots) { report.dotCensus = true; report.baseline = await readDots(DOT.baselineCap) }
  let stopped = null
  let touched = false // nothing to restore until the first apply was sent
  let finalStarted = false
  onBatchSignal = async () => {
    if (!touched || finalStarted) return
    finalStarted = true
    try {
      const r = await conn.evaluate(setCode(restore, false, false), BATCH.signalCap)
      if (Array.isArray(r?.errors) && r.errors.length === 0) console.log('FINAL: ok') // only a proven restore counts
    } catch {}
  }
  try {
    for (const [i, p] of b.items.entries()) {
      const it = { n: i + 1, name: p.name, modes: p.modes, status: '', notes: [] }
      report.items.push(it)
      if (finalStarted) stopped ??= 'stopped by a signal' // a signal's restore has run: never apply another test skin
      if (stopped !== null) { it.status = `not reached (${stopped})`; continue }
      if (!fitsMode(p.modes, mode)) { it.status = `skipped: needs Claude in ${p.modes.join(' or ')}`; continue }
      if (!roomForItem(elapsed(), b.dots)) { stopped = 'time'; it.status = 'not reached (time)'; continue }
      if (finalStarted) { stopped = 'stopped by a signal'; it.status = `not reached (${stopped})`; continue }
      it.mode = mode
      console.log(`LAST_APPLIED: ${p.name}`) // read by skin-auto if this run is cut off
      touched = true
      try {
        const r = await conn.evaluate(setCode(p.css, false, true), BATCH.applyCap)
        if (!Array.isArray(r?.errors) || r.errors.length > 0) { it.status = 'apply failed'; it.notes.push(...(r?.errors ?? ['no answer'])) } else it.status = 'applied'
      } catch (e) { it.status = 'apply failed'; it.notes.push(e.message); stopped = 'an earlier step failed'; continue }
      if (b.dots) {
        // Screenshot-free: the dots instead of a picture (no chat titles or contents are read).
        it.census = await readDots(DOT.itemCap)
        if (it.census.error) { it.notes.push(`dot census: ${it.census.error}`); if (/timed out/.test(it.census.error)) stopped = 'an earlier step failed' }
        else if (!it.census.marker) it.notes.push('the skin marker was not visible when the dots were read')
        it.override = overrideSeen(it.census, declaredDotTokens(p.css, mode))
        continue
      }
      try {
        const shot = await conn.evaluate(SHOT, BATCH.shotCap)
        it.shot = shot
        for (const k of ['error', 'pageError', 'windowError', 'sidebarError']) if (shot?.[k]) it.notes.push(String(shot[k]))
        if (shot?.page && shot.page.marker !== '1') it.notes.push('the skin marker was not visible when the screenshot was taken')
        if (shot?.visible === false || shot?.minimized === true) it.notes.push('the Claude window was hidden or minimised')
        // An observation, not a failure: named blues (charts, tags) are meant to stay blue.
        if (shot?.census?.blueLeft?.n > 0) it.notes.push(`observation: Claude blue still painted on ${shot.census.blueLeft.n} element(s)${shot.census.blueLeft.truncated ? ' (count stopped early)' : ''}: ${shot.census.blueLeft.samples.join(' | ')}`)
        it.blueLeft = shot?.census?.blueLeft ?? null
        it.dots = shot?.census?.dots ?? []
        if (shot?.censusError) it.notes.push(`observation: ${shot.censusError}`)
        it.row = judgeRow(shot?.page)
      } catch (e) { it.notes.push(`screenshot: ${e.message}`); stopped = 'an earlier step failed' }
    }
  } finally {
    // The final step runs whatever happened above, unless nothing was ever applied (then nothing changed).
    if (!touched) { report.finalOk = true; report.final = 'nothing applied, nothing changed' }
    else if (!finalStarted) try {
      finalStarted = true
      const finalT0 = Date.now()
      const r = await conn.evaluate(setCode(restore, false, false), BATCH.finalCap)
      report.finalOk = Array.isArray(r?.errors) && r.errors.length === 0
      if (!report.finalOk) report.notes.push(`final step: ${(r?.errors ?? ['no answer']).join('; ')}`)
      if (r?.reloaded > 0) report.notes.push('the Claude page was reloaded to take the test skin off')
      // The last read shares the final step's own time: only if enough of it is left.
      const left = BATCH.finalCap - (Date.now() - finalT0)
      if (b.dots && report.finalOk && left >= 300) report.after = await readDots(Math.min(DOT.itemCap, left))
    } catch (e) { report.notes.push(`final step: ${e.message}`) }
    onBatchSignal = null
    if (report.finalOk) console.log('FINAL: ok')
  }
  if (b.dots) {
    const reads = [report.baseline, ...report.items.filter((i) => i.census).map((i) => i.census), report.after]
    report.dots = {
      baseline: judgeDots(report.baseline), after: report.after ? judgeDots(report.after) : { error: 'no final read', marks: [] },
      items: report.items.filter((i) => i.census).map((i) => ({ n: i.n, name: i.name, judged: judgeDots(i.census), override: i.override })),
      removal: removalProof(report.baseline, report.after, report.items.find((i) => i.override && i.override.verdict !== 'none declared')?.override),
      needsYou: needsYou(reads),
    }
  }
  return report
}

// After the port is confirmed closed: save the pictures, report.json (first) and the contact sheet.
// The screenshots show whatever chat is open, so they go to a private folder outside the project (never
// synced or published with it): <state folder>/previews, folders 700 and files 600, never through a link.
export function writeBatch(report, root = path.join(STATE_DIR, 'previews'), now = new Date()) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const st = lstatSync(root)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error(`${root} is not a private folder of yours`)
  chmodSync(root, 0o700)
  report.folder = batchFolderName(now)
  const folder = path.join(root, report.folder)
  mkdirSync(folder, { mode: 0o700 }) // never reuse a folder
  const pics = []
  for (const it of report.items) {
    const shot = it.shot
    delete it.shot
    if (!shot?.window) continue
    const base = `${String(it.n).padStart(2, '0')}-${it.name}-${it.mode}`
    const jpg = Buffer.from(shot.window, 'base64')
    if (!(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[2] === 0xff)) { it.notes.push('the screenshot was not a JPEG, not saved'); continue }
    it.files = { window: `${base}.jpg` }
    pics.push([it.files.window, jpg])
    if (shot.sidebar) {
      const png = Buffer.from(shot.sidebar, 'base64')
      if (png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) { it.files.sidebar = `${base}-sidebar.png`; pics.push([it.files.sidebar, png]) } else it.notes.push('the sidebar image was not a PNG, not saved')
    }
  }
  const put = (name, data) => writeFileSync(path.join(folder, name), data, { mode: 0o600, flag: 'wx' })
  put('report.json', JSON.stringify(report, null, 2) + '\n')
  for (const [name, buf] of pics) put(name, buf)
  put('index.html', contactSheet(report, new Map(pics)))
  return folder
}

// A reader that goes away (Raycast closed, a hook stopped) must never crash the run before its cleanup.
process.stdout.on('error', () => {})
async function main() {
  const flags = process.argv.slice(2).filter(a => a.startsWith('--'))
  const [mode, file] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const patient = flags.includes('--patient')
  // `start` (no-skin tick, 4 Nov 2026): only the colour helper is installed inside the debugger window, no stylesheet is
  // applied there; skin-auto then asks that helper to take any skin off and to check it, with the debugger closed.
  const startOnly = mode === 'start'
  const withHelper = (mode === 'apply' || startOnly) && !flags.includes('--no-helper')
  // --wait-open starts this step BEFORE the prompt and waits here for the port (P2), probing it
  // fast (P1); --quick keeps only what must happen with the debugger open and leaves the colour checks to the helper (P3).
  const waitOpen = flags.includes('--wait-open')
  const quick = flags.includes('--quick')
  const dots = flags.includes('--dot-census')
  const unknownFlag = flags.find(f => !['--patient', '--no-helper', '--wait-open', '--quick', '--dot-census'].includes(f))
  if (unknownFlag) { console.log(`Unknown option: ${unknownFlag}`); return 2 }
  if (dots && mode !== 'batch') { console.log('--dot-census works with batch only.'); return 2 }
  if (waitOpen && !['apply', 'start', 'remove', 'type-probe'].includes(mode)) { console.log('--wait-open works with apply, start, remove or type-probe only.'); return 2 }
  if (quick && !(waitOpen && withHelper)) { console.log('--quick needs apply or start with the colour helper and --wait-open.'); return 2 }
  if (startOnly && !(waitOpen && quick && withHelper)) { console.log('start runs only with --wait-open --quick (from skin-auto.mjs tick off).'); return 2 }
  if (startOnly && file !== undefined) { console.log('start takes no stylesheet.'); return 2 }
  if (!['probe', 'type-probe', 'menu-probe', 'state', 'selftest', 'reset', 'apply', 'start', 'remove', 'close', 'check-css', 'slot-offers', 'verify', 'batch', 'batch-check'].includes(mode ?? '')) {
    console.log('Usage: node skin.mjs probe | type-probe [--wait-open] | menu-probe | state | selftest | reset | apply <file.css> [--no-helper] | start --wait-open --quick | remove | close | check-css <file.css> | slot-offers | verify | batch previous|off <preset.css>... | batch-check previous|off <preset.css>...')
    return 2
  }
  // The public release (release.json beside this file, not saying "oneClick": true) runs only what the tick path needs;
  // the developer modes stay in the development copy (no release.json), here as in skin-auto.mjs.
  const release = (() => {
    const f = path.join(here, 'release.json')
    try { lstatSync(f) } catch (e) { return e.code !== 'ENOENT' }
    try { return JSON.parse(readFileSync(f, 'utf8'))?.oneClick !== true } catch { return true }
  })()
  if (release && ['probe', 'type-probe', 'menu-probe', 'state', 'selftest', 'reset', 'batch'].includes(mode)) { console.log(`${mode} is a developer mode and is not in this release.`); return 2 }
  // Offline: would this batch list be accepted? Never touches Claude or any port.
  if (mode === 'batch-check') {
    const b = prepareBatch(process.argv.slice(3).filter(a => !a.startsWith('--')))
    console.log(`Batch OK: ${b.items.map(i => `${i.name} (${i.modes.join('+')})`).join(', ')}`)
    return 0
  }
  // Offline: is Claude.app the genuine, Anthropic-signed app? (so a later close would be able to work)
  if (mode === 'verify') {
    checkSignature()
    console.log('Claude signature OK')
    return 0
  }
  // Offline: which type sheets a new helper would be given (the same checked map a tick hands it), as one JSON line, so a
  // combined tick line can refuse a part this copy cannot do before the prompt. Never touches Claude or any port.
  if (mode === 'slot-offers') {
    const offer = typeSheetsWhy()
    const keys = Object.keys(offer.sheets)
    console.log(JSON.stringify({ headers: keys.includes('headers'), parts: keys.filter((k) => k !== 'headers'), fontWhy: offer.fontWhy }))
    return 0
  }
  // Offline check for tests and CI: validates a stylesheet and never touches Claude or any port.
  if (mode === 'check-css') {
    checkCss(readFileSync(file, 'utf8'))
    console.log('Stylesheet OK')
    return 0
  }
  // Everything that can fail without the port is checked first.
  let css = null
  let sheetModes = []
  if (mode === 'apply') {
    css = readFileSync(file, 'utf8')
    sheetModes = checkCss(css)
  }
  // A dot census run gets a fresh random salt for the row hashes: rows match across this run's reads, never across runs.
  const batch = mode === 'batch' ? { ...prepareBatch(process.argv.slice(3).filter(a => !a.startsWith('--'))), dots, salt: randomBytes(16).toString('hex') } : null
  const presets = withHelper ? helperPresets() : null
  const typeOffer = withHelper ? typeSheetsWhy() : { sheets: {}, why: null }
  const typeSheets = typeOffer.sheets
  checkSignature()

  let first = null
  let claudePid = null
  let seenAt = null
  if (waitOpen) {
    // Everything slow happens now, before the user is asked to tick: which Claude, and is that running Claude genuine.
    claudePid = claudePidOf(run('/bin/ps', ['-ax', '-o', 'pid=,comm=']))
    const dyn = run('/usr/bin/codesign', ['--verify', `-R=${REQUIREMENT}`, String(claudePid)])
    if (dyn.failed || dyn.status !== 0) throw new Error(`The running Claude (pid ${claudePid}) did not pass the signing check: ${dyn.err.trim()}`)
    if (listener() !== 'none') throw new Error(`Port ${PORT} is already open, so I did not wait for a tick.`)
    // Bound to the run that started me: if it goes away before the port opens, I stop waiting (and touch nothing).
    let parentGone = false
    process.stdin.on('end', () => { parentGone = true })
    process.stdin.on('close', () => { parentGone = true })
    process.stdin.on('error', () => { parentGone = true })
    process.stdin.resume()
    console.log('CHILD_READY')
    // The Claude checked above must still be running: a restart while waiting would make the tick open a Claude whose
    // signature was not checked: stop instead, touching nothing.
    const claudeGone = () => { try { process.kill(claudePid, 0); return false } catch (e) { return e.code === 'ESRCH' } }
    const waited = await waitForTick({
      portNow: () => tcpProbe({ port: PORT, host: HOST }), sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      stopped: () => parentGone || claudeGone(), windowMs: TICK.windowMs, pollMs: TICK.probeMs, hintsAtMs: [],
    })
    process.stdin.pause()
    if (waited.result === 'stopped' && !parentGone) { console.log('Stopped waiting: Claude quit or restarted. Nothing was touched. Run the command again.'); return 7 }
    if (waited.result === 'stopped') { console.log('Stopped waiting: the run that started me has ended. Nothing was touched.'); return 130 }
    if (waited.result === 'timeout') { console.log('WINDOW_ENDED'); return 5 }
    seenAt = Date.now()
    console.log('PORT_SEEN')
  } else {
    first = listener()
    if (first === 'none') {
      console.log('Port 9229 is closed. In Claude, tick Developer > Enable Main Process Debugger, then run this again.')
      return 1
    }
    checkOwner(first)
  }

  const opened = seenAt ?? Date.now()
  // Patient: connecting and the identity check may take PATIENT_MS; the job's own budget starts after them.
  let deadline = opened + (patient ? PATIENT_MS : BUDGET_MS)
  let conn = null
  let verified = false
  let result
  let failure = null
  let claudeMode = null
  let claudeVersion = null
  let helper = null
  let untickWarning // set when the menu tick could not be confirmed cleared
  const untickLine = () => untickWarning === undefined ? null : `WARNING: the menu item Developer > Enable Main Process Debugger may still show a tick (${untickWarning === null ? 'no answer' : untickWarning.error ?? `${untickWarning.found} matching items, ${untickWarning.ticked} still ticked`}). Do not click it: clicking it would open the debugger again. Quit and reopen Claude to clear it.`
  // Only a process confirmed to be Claude is told to close; anything else is
  // just disconnected from.
  const stop = async () => {
    if (conn === null) return
    if (verified) {
      // The tick is cleared (and checked) in its own call first: the close's own answer never arrives, because the close
      // ends this connection. CLOSE clears it again, in case this call failed.
      let untick = null
      try { untick = await conn.evaluate(UNTICK, 1_000) } catch {}
      if (!(untick?.found === 1 && untick?.ticked === 0)) untickWarning = untick
      try { await conn.evaluate(CLOSE, 1_500) } catch {}
    }
    try { conn.ws.close() } catch {}
    conn = null
  }
  // A batch cut off by a signal first tries a short restore (bounded), then closes the port as always.
  // One shared shutdown: a Ctrl-C can arrive twice (SIGINT from the terminal, SIGTERM from skin-auto), and the second
  // must not end the process while the first is still closing, printing or closing the port.
  let shutdown = null
  // The untick warning is printed on this path too, before the exit.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { shutdown ??= Promise.resolve(onBatchSignal?.()).catch(() => {}).finally(() => stop()).finally(() => { const w = untickLine(); if (w) console.log(w) }).finally(() => process.exit(130)) })

  try {
    if (waitOpen) {
      // The owner check runs while the connection is made; nothing is sent until it has passed, and a failed check stops
      // at once (a stand-in that never answers must not hold us until the deadline). A late connection is just closed.
      const owner = checkOwnerFast(claudePid)
      const connecting = connect(() => deadline)
      connecting.catch(() => {})
      try { [first, conn] = await Promise.all([owner, connecting]) } catch (e) {
        connecting.then((c) => { try { c.ws.close() } catch {} }, () => {}) // whichever finished first, the connection is closed
        throw e
      }
    } else conn = await connect(() => deadline)
    await withDeadline(checkSocket(first.pid), Math.max(1, deadline - Date.now()), 'checking who holds the debugger connection')
    const who = await conn.evaluate(IDENTIFY)
    if (patient) deadline = Date.now() + BUDGET_MS
    if (who.pid !== first.pid || who.execPath !== BINARY || who.type !== 'browser') {
      throw new Error(`Connected to the wrong process: ${JSON.stringify(who)}`)
    }
    verified = true
    await conn.evaluate(arm(quick ? TICK.armMs : FALLBACK_CLOSE_MS))
    if (mode === 'probe') result = await conn.evaluate(PROBE)
    if (mode === 'type-probe') result = await conn.evaluate(TYPE_PROBE)
    if (mode === 'menu-probe') result = await conn.evaluate(MENU_PROBE, 2_000)
    if (mode === 'selftest') result = await conn.evaluate(SELFTEST)
    if (mode === 'state') result = await conn.evaluate(STATE)
    if (mode === 'apply') result = await conn.evaluate(setCode(css, false, false, quick))
    // Which mode Claude itself is showing (its own Appearance, or the Mac's when that is System): read-only. With --quick
    // the helper answers this after the close, with the sampled colours.
    if (mode === 'apply' && !quick) try { claudeMode = (await conn.evaluate(THEME, 1_500)) === true ? 'dark' : 'light' } catch {}
    if (mode === 'apply' && !quick) try { claudeVersion = String(await conn.evaluate(VERSION, 1_500)) } catch {}
    // The helper only after a clean apply; it never decides whether the apply itself worked.
    if (withHelper && result?.errors?.length === 0) {
      try { helper = await conn.evaluate(helperCode(presets.map, STATE_DIR, typeSheets), 3_000) } catch (e) { helper = { helper: 'none', why: e.message } }
    }
    // start: the helper only. It carries CORE and loads and checks every offered preset, type and font sheet, as on any
    // tick; no selected colour stylesheet is applied, so no marker reads or page reloads happen with the debugger open.
    if (startOnly) {
      try { helper = await conn.evaluate(helperCode(presets.map, STATE_DIR, typeSheets), 3_000) } catch (e) { helper = { helper: 'none', why: e.message } }
      if (helper?.helper !== 'active') failure = new Error(`the colour helper did not start: ${helper?.why ?? 'no reason given'}`)
    }
    if (mode === 'remove' || mode === 'reset') try { await conn.evaluate(STOP_HELPER, 1_500) } catch {}
    if (mode === 'remove') result = await conn.evaluate(setCode(null, false, false, false, true), 14_000)
    if (mode === 'reset') result = await conn.evaluate(setCode(null, true, false, false, true), 14_000)
    if (mode === 'batch') {
      result = await runBatch(conn, opened, batch)
      const bad = result.items.filter(i => i.status === 'apply failed').map(i => i.name)
      if (!result.finalOk) failure = new Error(`the final step did not complete (${result.notes.join('; ')}). A test skin may still be on: put yours back with /skin <your skin>, or take all off with: node skin-auto.mjs remove`)
      else if (bad.length > 0) failure = new Error(`these presets did not apply: ${bad.join(', ')}`)
    }
    if (mode === 'selftest' && result?.ok !== true) failure = new Error('the self-test did not pass: ' + JSON.stringify(result))
    if (result?.errors?.length > 0) failure = new Error(`Claude refused part of it: ${result.errors.join('; ')}`)
  } catch (err) {
    failure = err
  } finally {
    await stop()
  }

  // Success only once nothing listens on the port any more.
  let after
  let closedAt = null
  for (let i = 0; i < 20; i++) {
    try { after = listener() } catch (err) { after = err }
    if (after === 'none') { closedAt = Date.now(); break }
    await new Promise(r => setTimeout(r, 150))
  }
  const seconds = ((Date.now() - opened) / 1000).toFixed(1)
  if (after !== 'none') {
    if (failure !== null) console.log(`But the job failed: ${failure.message}${verified ? '' : ' Nothing was sent to that program.'}`)
    console.log(after instanceof Error
      ? `WARNING: could not confirm port ${PORT} closed (${after.message}). Untick Developer > Enable Main Process Debugger to be sure.`
      : `WARNING: port ${PORT} is STILL OPEN. Untick Developer > Enable Main Process Debugger now, or quit Claude.`)
    return 3
  }
  if (seenAt !== null) {
    // P5: from the moment the port was seen open to the moment nothing listened any more (machine line for skin-auto).
    console.log(`Port ${PORT} closed and confirmed.`)
    console.log(`DOOR_MS: ${closedAt - seenAt}`)
  } else console.log(`Port ${PORT} closed and confirmed (connected for ${seconds} s; the time since you ticked the menu item is extra).`)
  // A tick left showing turns the user's next click on that item into an open (P9), so say so plainly.
  const w = untickLine()
  if (w) console.log(w)
  // Batch pictures are saved only now, with the port closed, and also when the job failed (they still help).
  if (mode === 'batch' && result !== undefined) {
    try {
      const folder = writeBatch(result)
      for (const it of result.items) console.log(`${String(it.n).padStart(2, ' ')}. ${it.name}: ${it.status}${it.row ? `, selected row ${it.row.verdict}${it.row.dE !== undefined ? ` (difference ${it.row.dE}, text ${it.row.contrast}:1)` : ''}` : ''}${it.notes.length ? ` [${it.notes.join('; ')}]` : ''}`)
      for (const n of result.notes) console.log(`NOTE: ${n}`)
      for (const l of dotLines(result.dots)) console.log(l)
      console.log(`Saved: ${path.join(folder, 'index.html')}`)
    } catch (e) { console.log(`Could not save the batch pictures: ${e.message}`) }
    result = undefined // the report is in report.json; never print image data
  }
  // Machine lines for skin-auto (it judges the samples and prints the three-line report).
  if (startOnly) {
    // Machine lines for skin-auto: the off and the check come from the helper, after the close.
    if (helper?.helper === 'active') console.log('DEFERRED_CHECKS')
    console.log(helper?.helper === 'active' ? `HELPER: active ${helper.session}` : `HELPER: none ${helper?.why ?? 'the colour helper did not start'}`)
    if (helper?.helper === 'active') console.log(typeOffer.why === null ? 'type switch: available (/skin type on)' : `type switch: not available (${typeOffer.why})`)
    if (helper?.helper === 'active' && typeOffer.fontWhy) console.log(`fonts: not available (${typeOffer.fontWhy})`)
    if (presets?.skipped.length) console.log(`NOTE: presets left out of the helper (failed the check): ${presets.skipped.join(', ')}`)
  }
  if (mode === 'apply' && result !== undefined) {
    if (quick) console.log('DEFERRED_CHECKS') // skin-auto asks the helper for them, with the debugger closed
    else console.log(`SAMPLES: ${JSON.stringify({ mode: claudeMode, version: claudeVersion, samples: result.samples ?? [] })}`)
    if (withHelper) console.log(helper?.helper === 'active' ? `HELPER: active ${helper.session}` : `HELPER: none ${helper?.why ?? 'the apply did not fully succeed'}`)
    if (withHelper && helper?.helper === 'active') console.log(typeOffer.why === null ? 'type switch: available (/skin type on)' : `type switch: not available (${typeOffer.why})`)
    if (withHelper && helper?.helper === 'active' && typeOffer.fontWhy) console.log(`fonts: not available (${typeOffer.fontWhy})`)
    if (presets?.skipped.length) console.log(`NOTE: presets left out of the helper (failed the check): ${presets.skipped.join(', ')}`)
  }
  if (failure !== null) {
    console.log(`But the job failed: ${failure.message}`)
    return 4
  }
  // Claude's own mode decides which half shows; warn when the skin has no half for it (the Mac's mode is no guide).
  if (claudeMode !== null && !sheetModes.includes(claudeMode)) {
    console.log(`NOTE: Claude is showing ${claudeMode} right now and this skin has only a ${sheetModes.join(' and ')} version, so you will not see it until Claude looks ${sheetModes.join(' or ')} (Settings > Appearance). A -auto skin covers both.`)
  }
  // Wait until the whole report is written: process.exit would cut a large one off at 64 KB on a pipe.
  // At most 5 s, and a broken pipe is ignored: the port is already closed, so a stuck reader must not hang the run.
  // A quick apply's raw answer has no proof or samples in it yet (they come from the helper), so it is not printed:
  // its "applied: 0" would look like a failure.
  if (result !== undefined && !quick) {
    await writeAll(JSON.stringify(result, null, 2) + '\n')
  }
  return 0
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.log(`Stopped: ${err.message}`)
    if (['check-css', 'slot-offers', 'verify', 'batch-check'].includes(process.argv[2])) process.exit(1) // offline modes: never touch or inspect the port
    try {
      if (listener() !== 'none') console.log(`Port ${PORT} is open: untick Developer > Enable Main Process Debugger in Claude.`)
    } catch {
      console.log(`Could not check port ${PORT}: untick Developer > Enable Main Process Debugger in Claude to be sure.`)
    }
    process.exit(1)
  })
