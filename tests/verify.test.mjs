import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertPythonSuiteComplete } from './fixtures/python-suite.mjs'

const suiteProcess = (source, options = {}) => spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 5000, ...options })

test('standalone suite process failures report errors signals and partial output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-suite-process-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cases = [
    ['exit', suiteProcess("process.stdout.write('partial stdout\\n'); process.stderr.write('partial stderr\\n'); process.exit(2)"), [/status=2/, /partial stdout/, /partial stderr/]],
    ['missing', spawnSync(join(root, 'missing-python'), [], { encoding: 'utf8' }), [/ENOENT/]],
    ['signal', suiteProcess("process.kill(process.pid, 'SIGTERM')"), [/signal=SIGTERM/]],
    ['timeout', suiteProcess('setInterval(() => {}, 1000)', { timeout: 1000 }), [/ETIMEDOUT/, /signal=SIGTERM/]],
  ]
  for (const [name, result, patterns] of cases) await t.test(name, () => {
    assert.throws(() => assertPythonSuiteComplete(result), error => patterns.every(pattern => pattern.test(error.message)))
  })
})

test('standalone suite success requires completed nonempty unskipped tests', () => {
  for (const output of ['', 'Ran 0 tests\nOK\n', 'Ran 2 tests\n', 'Ran 2 tests\nOK (skipped=1)\n', 'Ran 2 tests\nFAILED (failures=1)\n']) {
    const result = suiteProcess(`process.stderr.write(${JSON.stringify(output)})`)
    assert.throws(() => assertPythonSuiteComplete(result), undefined, output)
  }
  const passed = suiteProcess("process.stderr.write('Ran 2 tests\\n\\nOK\\n')")
  assert.doesNotThrow(() => assertPythonSuiteComplete(passed))
})

// 各阶段都换成会通过的桩：npm 与 python3 输出测试计数，关联检查按 SYNC_STUB 输出，tests/ 下放最小的 node 测试。
const pythonStub = `#!/bin/sh
case "$*" in
  *check-sync.py*)
    case "$SYNC_STUB" in
      empty) echo "关联检查：没有登记关联。"; exit 0 ;;
      stale) echo "关联检查：校验了 1 条登记，1 处登记失效。"; exit 2 ;;
      *) echo "[sync] docs：示例"; echo "关联检查：校验了 1 条登记，0 处登记失效。"; exit 0 ;;
    esac ;;
esac
echo "Ran 1 test"
echo "OK"
`
function stageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-stages-'))
  for (const directory of ['scripts', 'bin', 'tests']) mkdirSync(join(root, directory))
  cpSync('scripts/verify.mjs', join(root, 'scripts/verify.mjs'))
  writeFileSync(join(root, 'bin', 'npm'), '#!/bin/sh\necho "Ran 1 test"\necho "OK"\n', { mode: 0o755 })
  writeFileSync(join(root, 'bin', 'python3'), pythonStub, { mode: 0o755 })
  for (const name of ['doctor', 'distribution', 'verify', 'fetch', 'ci', 'adoption', 'setup', 'native', 'onboarding', 'superpowers-fetch', 'onboarding-native', 'sync']) {
    writeFileSync(join(root, 'tests', name + '.test.mjs'), "import {test} from 'node:test'; test('fixture', () => {})\n")
  }
  return root
}
function runStages(root, args = [], extra = {}) {
  const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, ...extra }
  delete env.WORKFLOW_PYTHON
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root, env, encoding: 'utf8' })
  return { result, report: JSON.parse(readFileSync(join(root, '.verification/report.json'), 'utf8')) }
}

test('verification schedules onboarding acceptance and fixed-source checks on the intended platforms', () => {
  const root = stageRoot()
  try {
    for (const args of [[], ['--windows']]) {
      const { result, report } = runStages(root, args)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const stage = id => report.stages.find(entry => entry.id === id)
      assert.ok(stage('adoption').args.includes('tests/onboarding.test.mjs'))
      // 套件关联检查入口的用例可移植，放在 Windows 子集也运行的阶段。
      assert.ok(stage('adoption').args.includes('tests/sync.test.mjs'))
      assert.equal(report.stages.at(-1).id, 'sync')
      if (!args.length) {
        assert.ok(stage('distribution').args.includes('tests/superpowers-fetch.test.mjs'))
        assert.ok(!stage('distribution').args.includes('tests/sync.test.mjs'))
        assert.ok(stage('native').args.includes('tests/onboarding-native.test.mjs'))
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the sync stage only reports but requires a validated registry', () => {
  const root = stageRoot()
  try {
    for (const [mode, status, ok] of [['ok', 0, true], ['empty', 1, false], ['stale', 1, false]]) {
      const { result, report } = runStages(root, [], { SYNC_STUB: mode })
      assert.equal(result.status, status, mode + '\n' + result.stdout + result.stderr)
      assert.deepEqual([report.stages.at(-1).id, report.stages.at(-1).ok], ['sync', ok])
      if (mode === 'empty') assert.match(result.stderr, /^Verification failed: sync \(no registry validated\)$/m)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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
