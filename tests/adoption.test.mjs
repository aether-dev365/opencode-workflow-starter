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

test('a separately installed copy passes doctor without source checkout configuration', { timeout: 180000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'workflow-adoption-'))
  const root = join(temp, 'repo')
  const home = join(temp, 'home')
  mkdirSync(home)
  // Git for Windows 把 /dev/null 映射为 nul；Node 的 os.devNull（\\.\nul）它反而打不开。
  const env = { ...essentialEnv(), PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', WORKFLOW_OPENCODE_BIN: runtimeBinary() }
  const scannerPath = join(temp, 'bin') + delimiter + env.PATH
  const run = (cmd, args, extra = {}) => {
    // Windows 上 npm 是 .cmd 启动器，经 commandLine 交给 cmd.exe。
    const invocation = commandLine(findExecutable(cmd) ?? cmd, args)
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, windowsVerbatimArguments: invocation.windowsVerbatimArguments })
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
    run('npm', ['--prefix', '.opencode/plugins/workflow', 'run', 'typecheck'])
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
