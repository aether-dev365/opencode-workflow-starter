import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { pythonCommand } from '../platform.ts'
import { git } from '../review-batches.ts'
import { listFiles } from '../onboarding-existing.ts'

// Windows 的进程创建会先在当前目录或 cwd 中查找不带路径的命令。用 hostname.exe 的副本冒充项目里的 git 和 Python，
// 它只输出主机名；其他平台不查当前目录，这里不做任何事。
test('Windows never runs same-named programs planted in the project directory', async t => {
  if (process.platform !== 'win32') return
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workflow-planted-'))), previous = process.cwd()
  t.after(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  execFileSync('git', ['init', '-q', root])
  const hostname = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe')
  for (const name of ['git.exe', 'py.exe', 'python.exe', 'python3.exe']) copyFileSync(hostname, path.join(root, name))
  process.chdir(root)
  assert.equal(path.resolve(git(root, ['rev-parse', '--show-toplevel'])).toLowerCase(), root.toLowerCase())
  const listing = await listFiles(root)
  assert.equal(listing.status, 0)
  assert.ok(listing.stdout.toString('utf8').split('\0').includes('git.exe'), listing.stdout.toString('utf8'))
  const python = pythonCommand({ probe: c => spawnSync(c.command, [...c.args, '-c', 'print(1)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === '1' })
  assert.equal(path.resolve(python.command).toLowerCase().startsWith(root.toLowerCase()), false, python.command)
})
