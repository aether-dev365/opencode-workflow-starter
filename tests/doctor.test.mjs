import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseline = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8')).dependencies['@opencode/plugin']

test('doctor reports missing configuration as structured failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, false)
    assert.ok(report.checks.some(c => c.id === 'config' && c.status === 'fail'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports missing plugin dependencies instead of crashing', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const result = spawnSync(process.execPath, [join(root, 'scripts/workflow/doctor.mjs'), '--root', root, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    const checks = Object.fromEntries(JSON.parse(result.stdout).checks.map(c => [c.id, c]))
    assert.equal(checks.dependencies.status, 'fail')
    assert.match(checks.dependencies.message, /npm --prefix \.opencode\/plugins\/workflow ci --ignore-scripts/)
    assert.equal(checks.config.status, 'fail')
    assert.match(checks.config.message, /依赖/)
    assert.equal(checks['native-runtime'].status, 'unverified')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor detects active placeholders without rewriting commented config or uncommitted work', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc')
    const original = '// retain this comment\n' + readFileSync(config, 'utf8').replace('"worktree":', '"model": "REPLACE_ME_MODEL", "worktree":')
    writeFileSync(config, original)
    writeFileSync(join(root, 'uncommitted.txt'), 'user work\n')
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    const report = JSON.parse(result.stdout)
    assert.equal(report.checks.find(c => c.id === 'placeholders')?.status, 'fail')
    assert.equal(readFileSync(config, 'utf8'), original)
    assert.equal(readFileSync(join(root, 'uncommitted.txt'), 'utf8'), 'user work\n')
    assert.equal(report.checks.find(c => c.id === 'native-runtime')?.status, 'unverified')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor warns about tracked files hidden by credential rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/app.env.ts'), 'export const mode = "dev"\n')
    spawnSync('git', ['-C', root, 'add', 'src/app.env.ts'])
    const report = JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout)
    const check = report.checks.find(c => c.id === 'tracked-protected')
    assert.equal(check?.status, 'warn')
    assert.match(check.message, /src\/app\.env\.ts/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor gives actionable OpenCode installation guidance for unavailable or non-V2 executables', async t => {
  for (const [name, script, reason] of [
    ['missing executable', null, /未找到/],
    ['V1 executable', 'echo "opencode v1.18.31"', /需要 OpenCode V2.*1\.18\.31/],
    ['failed version command', 'exit 7', /无法执行.*--version/],
    ['unrecognized version', 'echo "unknown-version"', /无法识别.*unknown-version/],
  ]) {
    await t.test(name, () => {
      const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
      try {
        const binary = join(root, 'opencode-test')
        if (script) writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'],
          { env: { ...process.env, WORKFLOW_OPENCODE_BIN: binary }, encoding: 'utf8' })
        assert.equal(result.status, 1)
        const check = JSON.parse(result.stdout).checks.find(c => c.id === 'opencode-version')
        assert.equal(check.status, 'fail')
        assert.match(check.message, reason)
        assert.ok(check.message.includes(`npm install -g @opencode/cli@${baseline}`), check.message)
        assert.match(check.message, /https:\/\/opencode\.ai\/v2\/docs\//)
        assert.match(check.message, /docs\/workflow\/opencode-install\.md/)
        assert.match(check.message, /WORKFLOW_OPENCODE_BIN/)
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
})

test('policy CLI returns denied paths and rejects invalid requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-policy-'))
  try {
    mkdirSync(join(root, '.opencode/workflow'), { recursive: true })
    cpSync('template/.opencode/workflow/checks/fixtures/protection.json', join(root, '.opencode/workflow/protection.json'))
    const run = input => spawnSync('python3', ['template/.opencode/workflow/checks/policy.py'], { input: JSON.stringify(input), encoding: 'utf8' })
    const result = run({ root, action: 'read', paths: ['src/app.env.ts', 'README.md', '.env.example'] })
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout), { denied: ['src/app.env.ts'] })
    for (const input of [{ root: 'relative', action: 'read', paths: [] }, { root, action: 'shell', paths: [] }, { root, action: 'read', paths: [42] }]) {
      const invalid = run(input)
      assert.equal(invalid.status, 2)
      assert.ok(JSON.parse(invalid.stdout).error)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
