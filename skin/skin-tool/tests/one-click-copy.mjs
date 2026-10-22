// The package ships release.json {"oneClick": false}, which refuses one-click runs (B1, 18 Oct 2026). The one-click code
// is still shipped and still tested: tests that start skin-auto use a temporary copy of the tool without that file.
// Where there is no release.json they use the tool itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let copy = null
export function autoPath() {
  if (!fs.existsSync(path.join(tool, 'release.json'))) return path.join(tool, 'skin-auto.mjs')
  if (copy === null) {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), 'reskin-oneclick-'))
    for (const f of fs.readdirSync(tool)) if (/\.(mjs|sh|json)$/.test(f) && f !== 'release.json') fs.copyFileSync(path.join(tool, f), path.join(copy, f))
    for (const d of ['presets', 'raycast']) fs.cpSync(path.join(tool, d), path.join(copy, d), { recursive: true })
    process.on('exit', () => fs.rmSync(copy, { recursive: true, force: true }))
  }
  return path.join(copy, 'skin-auto.mjs')
}
