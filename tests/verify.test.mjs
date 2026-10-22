import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('verification receipts stay incomplete until all stages finish and empty tests fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-receipt-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    cpSync('scripts/verify.mjs', join(root, 'scripts/verify.mjs'))
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('typecheck')) process.exit(0)
fs.copyFileSync('.verification/report.json', '.verification/observed.json')
console.log('tests 0\\npass 0\\nfail 0')
`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    const observed = JSON.parse(readFileSync(join(root, '.verification/observed.json'), 'utf8'))
    assert.equal(observed.complete, false)
    assert.equal(observed.ok, false)
    const report = JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8'))
    assert.equal(report.stages.at(-1).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
