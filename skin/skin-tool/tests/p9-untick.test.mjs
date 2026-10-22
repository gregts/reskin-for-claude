// P9: after Reskin closes Claude's debugger, the "Enable Main Process
// Debugger" item still showed a tick, and the user's "untick" click reopened the debugger (Claude's handler opens it whenever
// it is closed). Every close must also clear the tick, without ever calling the item's click handler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function load() {
  const src = readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { ARM, CLOSE, UNTICK }\n'
  const dir = mkdtempSync(path.join(tmpdir(), 'skin-p9-'))
  const file = path.join(dir, 'skin-copy.mjs')
  writeFileSync(file, src)
  const m = await import(file)
  rmSync(dir, { recursive: true, force: true })
  return m
}

// A fake Claude: an app menu shaped like the real one (Developer > Enable Main Process Debugger, checkbox, ticked), a
// click handler that records calls, and an inspector whose close is counted. `brokenMenu` makes getApplicationMenu throw.
function fakeClaude({ brokenMenu = false, checked = true } = {}) {
  const log = { clicks: 0, closes: 0 }
  const item = { label: 'Enable Main Process Debugger', type: 'checkbox', checked, click: () => { log.clicks++ } }
  const other = { label: 'Show Dev Tools', type: 'normal', checked: false, click: () => { log.clicks++ } }
  const menu = { items: [{ label: 'File', submenu: { items: [] } }, { label: 'Developer', submenu: { items: [other, item] } }, { label: 'Help' }] }
  const electron = { Menu: { getApplicationMenu: () => { if (brokenMenu) throw new Error('boom'); return menu } } }
  const timers = []
  const proc = {
    execPath: '/x',
    getBuiltinModule: (n) => n === 'module' ? { createRequire: () => (m) => { assert.equal(m, 'electron'); return electron } }
      : n === 'inspector' ? { close: () => { log.closes++ } } : null,
  }
  const ctx = createContext({ process: proc, globalThis: {}, setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout: () => {} })
  ctx.globalThis = ctx
  return { ctx, item, other, log, timers }
}

test('CLOSE clears the stale tick, closes the debugger, and never clicks the item', async () => {
  const { CLOSE } = await load()
  const c = fakeClaude()
  assert.equal(new Script(CLOSE).runInContext(c.ctx), 'closed')
  assert.equal(c.item.checked, false, 'the tick must be cleared')
  assert.equal(c.log.closes, 1)
  assert.equal(c.log.clicks, 0, 'never call a click handler: it would reopen the debugger')
  assert.equal(c.other.checked, false)
})

test('the in-Claude fallback close (ARM timer) also clears the tick', async () => {
  const { ARM } = await load()
  const c = fakeClaude()
  assert.equal(new Script(ARM).runInContext(c.ctx), true)
  assert.equal(c.item.checked, true, 'arming alone changes nothing')
  assert.equal(c.timers.length, 1)
  c.timers[0]()
  assert.equal(c.item.checked, false)
  assert.equal(c.log.closes, 1)
  assert.equal(c.log.clicks, 0)
})

test('a failing menu read never stops the close', async () => {
  const { CLOSE, ARM } = await load()
  const c = fakeClaude({ brokenMenu: true })
  assert.equal(new Script(CLOSE).runInContext(c.ctx), 'closed')
  assert.equal(c.log.closes, 1)
  const d = fakeClaude({ brokenMenu: true })
  new Script(ARM).runInContext(d.ctx)
  d.timers[0]()
  assert.equal(d.log.closes, 1)
})

test('an item that is already unticked stays unticked', async () => {
  const { CLOSE } = await load()
  const c = fakeClaude({ checked: false })
  new Script(CLOSE).runInContext(c.ctx)
  assert.equal(c.item.checked, false)
  assert.equal(c.log.clicks, 0)
})
