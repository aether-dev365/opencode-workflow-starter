import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runtimeBinary, baseline } from './fixtures/native-harness.mjs'

test('a separately installed copy passes doctor without source checkout configuration', { timeout: 180000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'workflow-adoption-'))
  const root = join(temp, 'repo')
  const home = join(temp, 'home')
  mkdirSync(home)
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', WORKFLOW_OPENCODE_BIN: runtimeBinary() }
  const run = (cmd, args, extra = {}) => {
    const result = spawnSync(cmd, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
    return result.stdout
  }
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    run('git', ['init', '-q'])
    run('npm', ['--prefix', '.opencode/plugins/workflow', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    run('python3', ['.opencode/secret-scan/install.py', '--bin-dir', join(temp, 'bin')])
    const output = run(process.execPath, ['scripts/workflow/doctor.mjs', '--root', '.', '--json'], { PATH: join(temp, 'bin') + ':' + env.PATH })
    const report = JSON.parse(output)
    assert.equal(report.ok, true)
    assert.equal(report.checks.find(c => c.id === 'native-runtime').status, 'unverified')
    const [major, minor, patch] = baseline.split('.').map(Number)
    for (const [version, status, ok] of [[`${major}.${minor}.${patch + 1}`, 'warn', true], [`${major}.${minor + 1}.0`, 'fail', false]]) {
      const fake = join(temp, `opencode-${version}`)
      writeFileSync(fake, `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 })
      const result = spawnSync(process.execPath, ['scripts/workflow/doctor.mjs', '--root', '.', '--json'],
        { cwd: root, env: { ...env, PATH: join(temp, 'bin') + ':' + env.PATH, WORKFLOW_OPENCODE_BIN: fake }, encoding: 'utf8' })
      const updated = JSON.parse(result.stdout)
      assert.equal(updated.checks.find(c => c.id === 'opencode-version').status, status)
      assert.equal(updated.ok, ok)
      assert.equal(result.status, ok ? 0 : 1)
    }
    run('npm', ['--prefix', '.opencode/plugins/workflow', 'run', 'typecheck'])
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
