// Scan row 1 (15 Oct 2026): the run report names the Claude version the skin was applied to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { helperActiveLine } from '../skin-lib.mjs'

test('the helper line names a plain Claude version', () => {
  assert.equal(helperActiveLine('2.37337.1'), 'helper: active until Claude quits (Claude 2.37337.1)')
})

test('no version, or a strange one, leaves the line as it was', () => {
  for (const v of [undefined, null, '', 'abc', '2', '2.1; rm -rf', 42, '1.2.3.4.5']) {
    assert.equal(helperActiveLine(v), 'helper: active until Claude quits')
  }
})

test('both report paths (tick run and helper switch) use it', () => {
  const src = readFileSync(new URL('../skin-auto.mjs', import.meta.url), 'utf8')
  assert.match(src, /helperActiveLine\(sample\?\.version\)/)
  assert.match(src, /helperActiveLine\(live\.session\.version\)/)
  assert.doesNotMatch(src, /'helper: active until Claude quits'/)
})
