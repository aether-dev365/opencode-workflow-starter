import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const manifest = 'template/.opencode/plugins/workflow/package.json'
const version = JSON.parse(readFileSync(manifest, 'utf8')).dependencies['@opencode/plugin']

function suite() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-fetch-'))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'template/.opencode/plugins/workflow'), { recursive: true })
  cpSync('scripts/fetch-opencode.mjs', join(root, 'scripts/fetch-opencode.mjs'))
  cpSync(manifest, join(root, manifest))
  return root
}
const fetch = root => spawnSync(process.execPath, ['scripts/fetch-opencode.mjs'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' })

test('runtime fetch rejects a package whose digest differs from the pin', () => {
  const root = suite()
  try {
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}
const { mkdirSync, writeFileSync } = require('node:fs')
const dir = process.argv[process.argv.indexOf('--pack-destination') + 1]
mkdirSync(dir, { recursive: true })
writeFileSync(dir + '/opencode-cli-linux-x64-${version}.tgz', 'not the pinned package')
`, { mode: 0o755 })
    const result = fetch(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /SHA-256/)
    assert.equal(existsSync(join(root, `.verification/runtime/opencode-cli-linux-x64-${version}.tgz`)), false)
    assert.equal(existsSync(join(root, '.verification/runtime/package')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime fetch reuses an installed matching version without invoking npm', () => {
  const root = suite()
  try {
    mkdirSync(join(root, '.verification/runtime/package/bin'), { recursive: true })
    writeFileSync(join(root, '.verification/runtime/package/bin/opencode'), `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 })
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const result = fetch(root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(root, `.verification/runtime/opencode-cli-linux-x64-${version}.tgz`)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime fetch refuses a baseline that has no pinned digest', () => {
  const root = suite()
  try {
    const path = join(root, manifest)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...value, dependencies: { ...value.dependencies, '@opencode/plugin': '9.9.9' } }))
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const result = fetch(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /9\.9\.9.*校验值/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
