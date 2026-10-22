import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('runtime fetch rejects a package whose digest differs from the pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-fetch-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    cpSync('scripts/fetch-opencode.mjs', join(root, 'scripts/fetch-opencode.mjs'))
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}
const { mkdirSync, writeFileSync } = require('node:fs')
const dir = process.argv[process.argv.indexOf('--pack-destination') + 1]
mkdirSync(dir, { recursive: true })
writeFileSync(dir + '/opencode-cli-linux-x64-2.1.1.tgz', 'not the pinned package')
`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ['scripts/fetch-opencode.mjs'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /SHA-256/)
    assert.equal(existsSync(join(root, '.verification/runtime/opencode-cli-linux-x64-2.1.1.tgz')), false)
    assert.equal(existsSync(join(root, '.verification/runtime/package')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime fetch reuses an installed matching version without invoking npm', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-fetch-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, '.verification/runtime/package/bin'), { recursive: true })
    cpSync('scripts/fetch-opencode.mjs', join(root, 'scripts/fetch-opencode.mjs'))
    writeFileSync(join(root, '.verification/runtime/package/bin/opencode'), '#!/bin/sh\necho "opencode v2.1.1"\n', { mode: 0o755 })
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const result = spawnSync(process.execPath, ['scripts/fetch-opencode.mjs'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(root, '.verification/runtime/opencode-cli-linux-x64-2.1.1.tgz')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
