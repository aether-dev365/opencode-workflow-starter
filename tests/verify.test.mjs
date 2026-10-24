import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('full verification actually schedules the adopter CI tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-ci-stage-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    cpSync('scripts/verify.mjs', join(root, 'scripts/verify.mjs'))
    for (const name of ['npm', 'python3']) writeFileSync(join(root, 'bin', name), '#!/bin/sh\necho "tests 1"\n', { mode: 0o755 })
    const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }
    delete env.WORKFLOW_PYTHON
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    const distribution = JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8')).stages.find(s => s.id === 'distribution')
    assert.ok(distribution.args.includes('tests/ci.test.mjs'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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

test('the Windows subset runs only portable stages and accepts only the known POSIX-only skips', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-subset-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    cpSync('scripts/verify.mjs', join(root, 'scripts/verify.mjs'))
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\necho "tests 1"\n', { mode: 0o755 })
    // 质量扩展阶段以 -v 运行，逐条输出跳过原因；守卫阶段只输出汇总。
    // 非 UTF-8 代码页下 Python 会把中文原因写成转义序列；verify 须让质量扩展阶段以 UTF-8 输出。
    writeFileSync(join(root, 'bin/python3'), '#!/bin/sh\ncase "$*" in\n  *optional/quality*) [ "$PYTHONIOENCODING" = utf-8 ] || { SKIP_A=escaped; SKIP_B=escaped; }; echo "test_a (m.C.test_a) ... skipped \'$SKIP_A\'"; echo "test_b (m.C.test_b) ... skipped \'$SKIP_B\'" ;;\nesac\necho "Ran 3 tests"\necho "OK (skipped=2)"\n', { mode: 0o755 })
    const symlink = '需要创建符号链接的权限'
    const stages = (args, skips = [symlink, symlink]) => {
      const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, SKIP_A: skips[0], SKIP_B: skips[1] }
      delete env.PYTHONIOENCODING
      const result = spawnSync(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root, env, encoding: 'utf8' })
      const report = JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8'))
      return { status: result.status, mode: report.mode, stages: report.stages.map(s => [s.id, s.ok]) }
    }
    // 临时根目录里没有 tests/，adoption 阶段必然失败；这里只看选中了哪些阶段、跳过是否放行。
    assert.deepEqual(stages(['--windows']), { status: 1, mode: 'windows', stages: [['typecheck', true], ['plugin', true], ['guards', true], ['quality', true], ['adoption', false]] })
    // 质量扩展只接受缺少符号链接权限这一种跳过，其他原因照常判失败。
    assert.deepEqual(stages(['--windows'], [symlink, '需要网络']).stages.at(-1), ['quality', false])
    assert.deepEqual(stages([]), { status: 1, mode: 'full', stages: [['typecheck', true], ['plugin', true], ['guards', false]] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the guard and quality stages use WORKFLOW_PYTHON like the plugin does', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-python-'))
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
    cpSync('scripts/verify.mjs', join(root, 'scripts/verify.mjs'))
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\necho "tests 1"\n', { mode: 0o755 })
    const python = join(root, 'chosen-python')
    writeFileSync(python, '#!/bin/sh\necho "Ran 1 test"\n', { mode: 0o755 })
    spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: root, env: { ...process.env, WORKFLOW_PYTHON: python, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' })
    const guards = JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8')).stages.find(s => s.id === 'guards')
    assert.deepEqual([guards.command, guards.ok], [python, true])
    const quality = JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8')).stages.find(s => s.id === 'quality')
    assert.deepEqual([quality.command, quality.args, quality.ok], [python, ['-m', 'unittest', 'discover', '-v', '-s', 'optional/quality', '-t', 'optional/quality', '-p', 'test_*.py'], true])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
