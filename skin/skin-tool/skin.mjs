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
import { HELPER_GEN, TICK, claudePidOf, parseListener, socketOwner, tcpProbe, waitForTick } from './skin-lib.mjs'

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
    const watch = w => {
      if (st.hooks.watched.has(w.id)) return
      const onLoad = () => { st.work = (st.work ?? 0) + 1; void st.put(w) }
      const onGone = () => { st.keys.delete(w.id); st.queues.delete(w.id); st.hooks?.watched.delete(w.id) }
      w.on('did-finish-load', onLoad)
      w.once('destroyed', onGone)
      st.hooks.watched.set(w.id, { w, onLoad, onGone })
    }
    if (st.css !== null && st.hooks === null) {
      st.hooks = { watched: new Map(), onCreated: (_e, w) => watch(w) }
      app.on('web-contents-created', st.hooks.onCreated)
    }
    if (st.hooks !== null) for (const w of webContents.getAllWebContents()) watch(w)
    st.errors = errors
    const teardownHooks = () => {
      if (st.css === null && st.hooks !== null) {
        app.removeListener('web-contents-created', st.hooks.onCreated)
        for (const { w, onLoad, onGone } of st.hooks.watched.values()) {
          if (!w.isDestroyed()) { w.removeListener('did-finish-load', onLoad); w.removeListener('destroyed', onGone) }
        }
        st.hooks = null
      }
    }
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
    const look = () => { const ws = webContents.getAllWebContents().filter(isClaude); return { gen: st.gen ?? 0, work: st.work ?? 0, css: st.css, queued: st.queues.size, ids: ws.map(w => w.id + ' ' + w.getURL()).sort().join(','), loading: ws.some(loading) } }
    const before = look()
    const pages = await Promise.all(webContents.getAllWebContents().filter(isClaude).map(w => within(w.executeJavaScriptInIsolatedWorld(4247, [{ code: ${JSON.stringify(HEALTH_PAGE)} }]), 1500).catch(() => ({ error: 'unreadable' }))))
    const after = look()
    const stable = !before.loading && !after.loading && before.queued === 0 && after.queued === 0 && before.gen === after.gen && before.work === after.work && before.css === after.css && before.ids === after.ids && pages.every(p => p.error || p.ready === 'complete')
    return { stable, pages }
  }`

function setCode(css, reset = false, batch = false, quick = false) {
  return `(async () => {
  ${CORE}
  return st.apply(${JSON.stringify(css)}, ${reset}, ${batch}, ${quick})
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
  const h = { session: o.randomUUID(), last: 0, requests: 0, ignored: 0, running: false, again: false, stopped: false, watcher: null, timer: null, ino: d0.ino, badKey: null, startedAt: o.now() }
  const sessionInfo = () => ({ v: 1, session: h.session, pid: o.pid, boot: o.boot, version: o.version, startedAt: h.startedAt, caps: ['check'], gen: o.gen })
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
    if (typeof j.action !== 'string' || !(j.action === 'off' || j.action === 'remove' || j.action === 'check' || Object.hasOwn(presets, j.action))) return bad('not a preset name, off, remove or check')
    return { req: j }
  }
  const ack = (r) => {
    try { writeFile('ack.json', { v: 1, session: h.session, pid: o.pid, version: o.version, requests: h.requests, ignored: h.ignored, ...r }) } catch {}
  }
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => o.setTimeout(() => rej(new Error('timed out after ' + ms + ' ms')), ms))])
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
      ack({ nonce: j.nonce, action: 'check', phase: 'done', ok: sample !== null, errors, current: name, digest, dark, sample })
      return
    }
    if (j.action === 'remove') {
      // Ack first (accepted, not yet proof of removal), then take everything down. Status proves the result afterwards.
      ack({ nonce: j.nonce, action: 'remove', phase: 'accepted', ok: true, errors: [] })
      stop(true)
      let res
      const off = st.apply(null)
      const gen = st.gen // this removal's own run: st.apply numbers each run before its first wait
      try { res = await within(off, 12_000) } catch (e) { res = { errors: [String(e)] } }
      const errors = (res?.errors ?? []).slice(0, 5).map(String)
      // The state goes only if nothing newer has started since (a newer apply may not have installed its helper yet).
      // The debugger's own close timer (__reskinFallback) belongs to debugger runs and is never touched here.
      if (errors.length === 0 && st.gen === gen && !st.helper && globalThis.__reskin === st) delete globalThis.__reskin
      // The final answer: removal done, or what went wrong (the client reports success only on this). Not when a newer
      // helper took over meanwhile: its acks are the only ones that count now.
      if (st.helper && st.helper !== h) return
      ack({ nonce: j.nonce, action: 'remove', phase: 'done', ok: errors.length === 0, errors })
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
function helperCode(presets, dir) {
  return `(async () => {
  ${CORE}
  const o = {
    fs: process.getBuiltinModule('fs'), dir: ${JSON.stringify(dir)},
    presets: Object.freeze(Object.assign(Object.create(null), ${JSON.stringify(presets)})),
    uid: process.getuid(), pid: process.pid, boot: Math.round(Date.now() - process.uptime() * 1000), version: app.getVersion(), gen: ${HELPER_GEN},
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

// Every reviewed preset, each passing checkCss, for the helper (fixed at injection; release 1 has no custom colours).
export function helperPresets(dir = path.join(here, 'presets')) {
  const map = {}
  const skipped = []
  // Dot census test sheets (dotcheck-*) are for batch runs only: never offered to a helper, where they would stay until Claude quits.
  for (const f of readdirSync(dir).filter(f => /^[a-z0-9]+(?:-[a-z0-9]+)*\.css$/.test(f) && !f.startsWith('dotcheck-') && !['off.css', 'remove.css', 'check.css'].includes(f)).sort()) {
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
  const withHelper = mode === 'apply' && !flags.includes('--no-helper')
  // --wait-open starts this step BEFORE the prompt and waits here for the port (P2), probing it
  // fast (P1); --quick keeps only what must happen with the debugger open and leaves the colour checks to the helper (P3).
  const waitOpen = flags.includes('--wait-open')
  const quick = flags.includes('--quick')
  const dots = flags.includes('--dot-census')
  const unknownFlag = flags.find(f => !['--patient', '--no-helper', '--wait-open', '--quick', '--dot-census'].includes(f))
  if (unknownFlag) { console.log(`Unknown option: ${unknownFlag}`); return 2 }
  if (dots && mode !== 'batch') { console.log('--dot-census works with batch only.'); return 2 }
  if (waitOpen && !['apply', 'remove'].includes(mode)) { console.log('--wait-open works with apply or remove only.'); return 2 }
  if (quick && !(waitOpen && withHelper)) { console.log('--quick needs apply with the colour helper and --wait-open.'); return 2 }
  if (!['probe', 'menu-probe', 'state', 'selftest', 'reset', 'apply', 'remove', 'close', 'check-css', 'verify', 'batch', 'batch-check'].includes(mode ?? '')) {
    console.log('Usage: node skin.mjs probe | menu-probe | state | selftest | reset | apply <file.css> [--no-helper] | remove | close | check-css <file.css> | verify | batch previous|off <preset.css>... | batch-check previous|off <preset.css>...')
    return 2
  }
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
      try { helper = await conn.evaluate(helperCode(presets.map, STATE_DIR), 3_000) } catch (e) { helper = { helper: 'none', why: e.message } }
    }
    if (mode === 'remove' || mode === 'reset') try { await conn.evaluate(STOP_HELPER, 1_500) } catch {}
    if (mode === 'remove') result = await conn.evaluate(setCode(null), 14_000)
    if (mode === 'reset') result = await conn.evaluate(setCode(null, true), 14_000)
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
  if (mode === 'apply' && result !== undefined) {
    if (quick) console.log('DEFERRED_CHECKS') // skin-auto asks the helper for them, with the debugger closed
    else console.log(`SAMPLES: ${JSON.stringify({ mode: claudeMode, version: claudeVersion, samples: result.samples ?? [] })}`)
    if (withHelper) console.log(helper?.helper === 'active' ? `HELPER: active ${helper.session}` : `HELPER: none ${helper?.why ?? 'the apply did not fully succeed'}`)
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
    if (['check-css', 'verify', 'batch-check'].includes(process.argv[2])) process.exit(1) // offline modes: never touch or inspect the port
    try {
      if (listener() !== 'none') console.log(`Port ${PORT} is open: untick Developer > Enable Main Process Debugger in Claude.`)
    } catch {
      console.log(`Could not check port ${PORT}: untick Developer > Enable Main Process Debugger in Claude to be sure.`)
    }
    process.exit(1)
  })
