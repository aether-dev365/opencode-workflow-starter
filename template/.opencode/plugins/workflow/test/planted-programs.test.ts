import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { commandLine, pythonCommand } from '../platform.ts'
import { git } from '../review-batches.ts'
import { listFiles } from '../onboarding-existing.ts'

// 进程创建会在当前目录里查找不带路径的命令：Windows 总是先查，macOS 和 Linux 在 PATH 有空项时也查。
// 在项目根放冒充 git、Python、node 的程序：Windows 上是只输出主机名的 hostname.exe 副本，其他平台是只输出 planted 的脚本。
test('same-named programs planted in the project directory are never run', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workflow-planted-'))), previous = { cwd: process.cwd(), PATH: process.env.PATH }
  t.after(() => {
    process.chdir(previous.cwd); process.env.PATH = previous.PATH
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  execFileSync('git', ['init', '-q', root])
  const windows = process.platform === 'win32'
  const names = windows ? ['git.exe', 'py.exe', 'python.exe', 'python3.exe', 'node.exe']
    : ['git', 'node', 'python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10']
  for (const name of names) {
    const file = path.join(root, name)
    if (windows) copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), file)
    else { writeFileSync(file, '#!/bin/sh\necho planted\n'); chmodSync(file, 0o755) }
  }
  // PATH 开头的空项指向当前目录，常见于 PATH=$X:$PATH 而 X 为空。
  if (!windows) process.env.PATH = path.delimiter + previous.PATH
  process.chdir(root)
  assert.equal(path.resolve(git(root, ['rev-parse', '--show-toplevel'])).toLowerCase(), root.toLowerCase())
  const listing = await listFiles(root)
  assert.equal(listing.status, 0)
  assert.ok(listing.stdout.toString('utf8').split('\0').includes(names[0]), listing.stdout.toString('utf8'))
  const python = pythonCommand({ probe: c => spawnSync(c.command, [...c.args, '-c', 'print(1)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === '1' })
  assert.equal(path.resolve(python.command).toLowerCase().startsWith(root.toLowerCase()), false, python.command)
  if (windows) {
    // npm 的 .cmd 启动器旁边没有 node.exe 时按名字启动 node，由 cmd.exe 查找。
    mkdirSync(path.join(root, 'bin'))
    writeFileSync(path.join(root, 'bin', 'tool.cmd'), '@echo off\r\nnode -e "console.log(42)"\r\n')
    const invocation = commandLine(path.join(root, 'bin', 'tool.cmd'), [])
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments, env: { ...process.env, ...invocation.env } })
    assert.equal(result.stdout.trim(), '42', result.stderr)
  }
})
