import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runtimeBinary, baseline } from './fixtures/native-harness.mjs'
import { essentialEnv } from './fixtures/env.mjs'
import { commandLine, findExecutable, pythonCommand } from '../template/.opencode/plugins/workflow/platform.ts'

const windows = process.platform === 'win32'

// Windows runner 上在临时项目里 npm ci 可能超过 2 分钟。
test('a separately installed copy passes doctor without source checkout configuration', { timeout: 600000 }, () => {
  // GitHub 的 Windows runner 上系统临时目录在较慢的 C 盘，这里的 npm ci 实测 139–189 秒，RUNNER_TEMP（D 盘）约 12 秒。
  const temp = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'workflow-adoption-'))
  const root = join(temp, 'repo')
  const home = join(temp, 'home')
  mkdirSync(home)
  // Git for Windows 把 /dev/null 映射为 nul；Node 的 os.devNull（\\.\nul）它反而打不开。
  const env = { ...essentialEnv(), PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', WORKFLOW_OPENCODE_BIN: runtimeBinary() }
  const scannerPath = join(temp, 'bin') + delimiter + env.PATH
  const run = (cmd, args, extra = {}) => {
    // Windows 上 npm 是 .cmd 启动器，经 commandLine 交给 cmd.exe。
    const invocation = commandLine(findExecutable(cmd) ?? cmd, args)
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 300000, windowsVerbatimArguments: invocation.windowsVerbatimArguments })
    assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stderr}\n${result.stdout}${result.error ? '\n' + result.error.message : ''}`)
    return result.stdout
  }
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    run('git', ['init', '-q'])
    run('npm', ['--prefix', '.opencode/plugins/workflow', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    const python = pythonCommand()
    run(python.command, [...python.args, '.opencode/secret-scan/install.py', '--bin-dir', join(temp, 'bin')])
    const output = run(process.execPath, ['scripts/workflow/doctor.mjs', '--root', '.', '--json'], { PATH: scannerPath })
    const report = JSON.parse(output)
    assert.equal(report.ok, true)
    assert.equal(report.checks.find(c => c.id === 'native-runtime').status, 'unverified')
    const [major, minor, patch] = baseline.split('.').map(Number)
    for (const [version, status, ok] of [[`${major}.${minor}.${patch + 1}`, 'warn', true], [`${major}.${minor + 1}.0`, 'fail', false]]) {
      // Windows 上用 .cmd 假 CLI，同时覆盖 doctor 经 cmd.exe 启动 npm 全局 CLI 的路径。
      const fake = join(temp, `opencode-${version}` + (windows ? '.cmd' : ''))
      writeFileSync(fake, windows ? `@echo opencode v${version}\r\n` : `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 })
      const result = spawnSync(process.execPath, ['scripts/workflow/doctor.mjs', '--root', '.', '--json'],
        { cwd: root, env: { ...env, PATH: scannerPath, WORKFLOW_OPENCODE_BIN: fake }, encoding: 'utf8' })
      const updated = JSON.parse(result.stdout)
      assert.equal(updated.checks.find(c => c.id === 'opencode-version').status, status)
      assert.equal(updated.ok, ok)
      assert.equal(result.status, ok ? 0 : 1)
    }
    // 新项目的第一个提交包含整个模板；没有 HEAD 时扫描照样检查暂存内容。
    const scan = () => spawnSync(python.command, [...python.args, '.opencode/workflow/checks/pre-secret-scan.py'], {
      cwd: root, env: { ...env, PATH: scannerPath }, encoding: 'utf8', timeout: 120000,
      input: JSON.stringify({ version: 1, phase: 'before', directory: root, tool: 'shell', input: { command: 'git commit -m baseline' }, paths: [], sessionId: 'adoption', callId: 'baseline' }),
    })
    run('git', ['add', '-A'])
    const baselineScan = scan()
    assert.equal(baselineScan.status, 0, baselineScan.stderr)
    assert.equal(JSON.parse(baselineScan.stdout).decision, 'allow')
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    writeFileSync(join(root, 'leak.txt'), `access_token = "${secret}"\n`)
    run('git', ['add', 'leak.txt'])
    const leakScan = scan()
    assert.equal(leakScan.status, 2, leakScan.stderr)
    assert.equal(JSON.parse(leakScan.stdout).decision, 'deny')
    assert.ok(!(leakScan.stdout + leakScan.stderr).includes(secret))
    run('npm', ['--prefix', '.opencode/plugins/workflow', 'run', 'typecheck'])
  // Windows 上杀毒软件或索引服务可能短暂占用刚安装的依赖，删除失败时重试。
  } finally { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
