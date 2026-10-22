// The bounded stdout flush, and the PROBE consumer census run on a fake page.
// Run with: node --test 'tests/*.test.mjs'   (no Claude, no Chrome)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.resolve(here, '..')

// skin.mjs without its main(), in a temp folder, so its own writeAll and PROBE can be used.
const copyDir = mkdtempSync(path.join(tmpdir(), 'skin-left-'))
writeFileSync(path.join(copyDir, 'm.mjs'), readFileSync(path.join(tool, 'skin.mjs'), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '\n').replace("'./skin-lib.mjs'", JSON.stringify(new URL('../skin-lib.mjs', import.meta.url).href)) + '\nexport { PROBE }\n')
const skinCopy = pathToFileURL(path.join(copyDir, 'm.mjs')).href
const lib = pathToFileURL(path.join(tool, 'skin-lib.mjs')).href
const { PROBE } = await import(skinCopy)
process.on('exit', () => rmSync(copyDir, { recursive: true, force: true }))

// A child that writes `size` bytes with writeAll from `from`, then exits at once (as the real scripts do).
function writer(from, size, read) {
  const code = `import { writeAll } from ${JSON.stringify(from)}; await writeAll('x'.repeat(${size}) + '\\n'); process.exit(0)`
  return new Promise((resolve) => {
    const t0 = Date.now()
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
    let got = 0
    if (read) c.stdout.on('data', (d) => (got += d.length))
    else c.stdout.pause() // a reader that never reads: the pipe fills and the write never completes
    c.on('exit', (status) => resolve({ status, got, ms: Date.now() - t0 }))
  })
}

for (const [name, from] of [['skin-lib.mjs', lib], ['skin.mjs', skinCopy]]) {
  test(`${name} writeAll: a large report through a pipe arrives whole before the exit`, async () => {
    const r = await writer(from, 300_000, true)
    assert.equal(r.status, 0)
    assert.equal(r.got, 300_001, 'nothing cut off at 64 KB')
  })
  test(`${name} writeAll: a reader that never reads cannot hang a finished run (gives up after 5 s)`, async () => {
    const r = await writer(from, 300_000, false)
    assert.equal(r.status, 0)
    assert.ok(r.ms >= 4_500 && r.ms < 8_000, `took ${r.ms} ms`)
  })
}

test('skin.mjs and skin-auto.mjs end with writeAll, not a bare process.stdout.write before exit', () => {
  for (const f of ['skin.mjs', 'skin-auto.mjs']) {
    const src = readFileSync(path.join(tool, f), 'utf8')
    assert.ok(/await writeAll\(/.test(src), f)
    assert.ok(!/setTimeout\(r, 5_000\); process\.stdout\.write/.test(src), `${f} still has its own copy of the flush`)
  }
})

// ---- PROBE on a fake page ----
function fakePage() {
  const el = (tag, cls, { inSidebar = false, attrs = {}, bg = 'rgba(0, 0, 0, 0)' } = {}) => ({
    tagName: tag.toUpperCase(), className: cls, attrs, bg, inSidebar,
    closest: (s) => (s === '.dframe-sidebar' && inSidebar ? {} : null),
    hasAttribute: (a) => a in attrs, getAttribute: (a) => attrs[a],
  })
  const all = [
    el('div', 'group hover:bg-[var(--df-hover)] data-[selected]:bg-[var(--df-selected)]', { inSidebar: true, attrs: { 'data-selected': 'focused' }, bg: 'color(srgb 1 1 1 / 0.15)' }),
    el('div', 'group hover:bg-[var(--df-hover)]', { inSidebar: true }),
    el('div', 'group hover:bg-[var(--df-hover)]', { inSidebar: true }),
    el('button', 'p-2 hover:bg-[var(--df-hover)]', { bg: 'rgb(30, 30, 30)' }), // outside the sidebar
    el('span', 'plain', { bg: 'rgb(30, 30, 30)' }),
  ]
  const rule = (selectorText, props, values = {}) => ({ selectorText, style: Object.assign([...props], { getPropertyValue: (p) => values[p] ?? '' }) })
  const badRule = { get style() { throw new Error('unreadable rule') }, get styleSheet() { return undefined }, get cssRules() { return undefined } }
  const sheets = [
    { cssRules: [rule(':root', ['--cds-gray-100', '--df-hover', '--font-sans']), rule('.bg-accent', ['background-color'], { 'background-color': 'var(--cds-fill-accent)' }), rule('.plain', ['color'], { color: 'red' }), badRule, { conditionText: '(prefers-color-scheme: dark)', cssRules: [rule(':root', ['--df-selected'])] }] },
    { get cssRules() { throw new Error('cross-origin sheet') } },
  ]
  const html = { className: 'cds-root', dataset: { mode: 'dark' } }
  const document = {
    documentElement: html, styleSheets: sheets,
    querySelector: (s) => (s === '.dframe-root' ? html : s === '.dframe-sidebar' ? {} : null),
    querySelectorAll: (s) => {
      if (s.includes('[class*="--df-hover"]')) return all.filter((e) => /--df-(hover|selected)/.test(e.className))
      if (s.includes('[aria-current]')) return all.filter((e) => 'data-selected' in e.attrs)
      if (s === 'body *') return all
      return []
    },
  }
  const getComputedStyle = (e) => ({ backgroundColor: e.bg ?? 'rgba(0, 0, 0, 0)', colorScheme: 'dark', getPropertyValue: (v) => (v === '--reskin-active' ? '' : v.startsWith('--') ? '#123' : '') })
  return { document, getComputedStyle, matchMedia: () => ({ matches: true }) }
}

test('PROBE census on a fake page: counts row-colour users inside and outside the sidebar, finds the selected row, survives unreadable rules and sheets', async () => {
  const dom = fakePage()
  const calls = []
  const page = {
    id: 1, getType: () => 'window', getURL: () => 'https://claude.ai/chat',
    executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => runInContext(code, createContext({ ...dom })),
    insertCSS: () => calls.push('insertCSS'), removeInsertedCSS: () => calls.push('removeInsertedCSS'), reload: () => calls.push('reload'),
  }
  const electron = { nativeTheme: { themeSource: 'system', shouldUseDarkColors: true }, webContents: { getAllWebContents: () => [page] } }
  const ctx = createContext({ process: { execPath: '/x', getBuiltinModule: () => ({ createRequire: () => () => electron }) }, URL, Promise })
  const out = JSON.parse(JSON.stringify(await runInContext(PROBE, ctx)))
  const p = out[1].page
  assert.equal(p.error, undefined, JSON.stringify(p))
  assert.equal(p.skinMarker, '', 'no skin on')
  const census = Object.fromEntries(p.dfConsumers.map((c) => [`${c.where}|${c.tag}|${c.uses}`, c.n]))
  assert.deepEqual(census, { 'sidebar|div|--df-hover,--df-selected': 1, 'sidebar|div|--df-hover': 2, 'outside|button|--df-hover': 1 })
  assert.equal(p.selectedRows.length, 1)
  assert.equal(p.selectedRows[0].inSidebar, true)
  assert.equal(p.selectedRows[0].attrs, 'data-selected=focused')
  assert.ok(p.declarersSkipped >= 1, 'the unreadable rule is counted as skipped, not fatal')
  assert.ok(Object.values(p.declarers).some((d) => d.df > 0 && d.gray > 0 && d.font > 0))
  assert.deepEqual(p.accentUsers, ['.bg-accent { background-color: var(--cds-fill-accent) }'], 'accent census lists only rules that use accent tokens')
  assert.deepEqual(calls, [], 'read-only')
})
