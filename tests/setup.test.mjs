import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { essentialEnv } from './fixtures/env.mjs'
import { findExecutable, pythonCommand } from '../template/.opencode/plugins/workflow/platform.ts'
import { ask } from '../template/scripts/workflow/setup.mjs'

const windows = process.platform === 'win32'
const baseline = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8')).dependencies['@opencode/plugin']
const modules = resolve('template/.opencode/plugins/workflow/node_modules')
// 假 CLI：POSIX 用 sh 脚本，Windows 用 .cmd（与 npm 全局安装的启动器同类）。
const fakeOpencode = `const fs = require('node:fs'), path = require('node:path')
module.exports = (bin, version) => process.platform === 'win32'
  ? fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@echo opencode v' + version + '\\r\\n')
  : fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\\necho "opencode v' + version + '"\\n', { mode: 0o755 })
`
// 假 npm 只记录参数：ci 时复制真实依赖，install -g 时生成对应版本的假 CLI；不访问网络。
const fakeNpm = `const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(' ') + '\\n')
if (args.includes('ci')) fs.cpSync(process.env.FAKE_NPM_MODULES, path.join(args[args.indexOf('--prefix') + 1], 'node_modules'), { recursive: true })
const cli = args.find(arg => arg.startsWith('@opencode/cli@'))
if (args[0] === 'install' && args.includes('-g') && cli) require('./fake-opencode.cjs')(process.env.FAKE_NPM_BIN, cli.split('@')[2])
`

// scanner：path 放在 PATH 上；fallback 只放在 ~/.local/bin；shadowed 时 PATH 上是另一个版本，固定版本在 ~/.local/bin。
function fixture({ opencode, deps = true, scanner: placement = 'path' } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'workflow-setup-'))
  const root = join(temp, 'repo'), bin = join(temp, 'bin'), home = join(temp, 'home')
  for (const path of [bin, home]) mkdirSync(path)
  cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
  if (deps) cpSync(modules, join(root, '.opencode/plugins/workflow/node_modules'), { recursive: true })
  execFileSync('git', ['init', '-q', root])
  const scanner = findExecutable('gitleaks')
  assert.ok(scanner, '需要已安装的固定版 Gitleaks')
  const local = join(home, '.local', 'bin')
  mkdirSync(local, { recursive: true })
  if (placement === 'path') copyFileSync(scanner, join(bin, basename(scanner)))
  else copyFileSync(scanner, join(local, basename(scanner)))
  if (placement === 'shadowed') writeFileSync(join(bin, basename(scanner)), 'not the pinned scanner\n', { mode: 0o755 })
  writeFileSync(join(temp, 'fake-opencode.cjs'), fakeOpencode)
  writeFileSync(join(temp, 'fake-npm.cjs'), fakeNpm)
  if (windows) writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${join(temp, 'fake-npm.cjs')}" %*\r\n`)
  else writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nrequire(${JSON.stringify(join(temp, 'fake-npm.cjs'))})\n`, { mode: 0o755 })
  if (opencode) execFileSync(process.execPath, ['-e', `require(${JSON.stringify(join(temp, 'fake-opencode.cjs'))})(${JSON.stringify(bin)}, ${JSON.stringify(opencode)})`])
  const python = pythonCommand()
  const interpreter = findExecutable(python.command)
  assert.ok(interpreter, `找不到 ${python.command}`)
  // 不放 Node 的目录：npm 全局安装的 opencode 常和 node 在同一目录（如 CI 的 macOS），会让“缺少 CLI”的场景失真。
  // Windows 上 .cmd 经 cmd.exe 启动，libuv 只按子进程 PATH 查找它，所以保留 System32。
  const path = [bin, dirname(findExecutable('git')), dirname(interpreter), ...(windows ? [join(process.env.SystemRoot, 'System32')] : [])]
  const env = { ...essentialEnv(), PATH: path.join(delimiter), HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    FAKE_NPM_LOG: join(temp, 'npm.log'), FAKE_NPM_MODULES: modules, FAKE_NPM_BIN: bin }
  if (!opencode) assert.equal(findExecutable('opencode', { env }), undefined, 'Git 或 Python 所在目录里有 opencode，无法模拟“缺少 CLI”')
  const setup = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/workflow/setup.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 120000 })
    return { status: result.status, output: result.stdout + result.stderr, npm: existsSync(env.FAKE_NPM_LOG) ? readFileSync(env.FAKE_NPM_LOG, 'utf8') : '' }
  }
  // Windows 上杀毒软件或索引服务可能短暂占用刚复制的文件，删除失败时重试。
  return { setup, home, cleanup: () => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
}

test('a ready checkout installs nothing and ends with a passing doctor', { timeout: 120000 }, () => {
  const f = fixture({ opencode: baseline })
  try {
    const { status, output, npm } = f.setup()
    assert.equal(status, 0, output)
    assert.equal(npm, '')
    assert.match(output, /pass opencode-version/)
    assert.match(output, /^基础依赖准备完成。.*\/workflow-setup/m)
    // 从空目录开始的新项目由 /workflow-new 分阶段进行，它会在需要时调用 /workflow-setup。
    assert.match(output, /^基础依赖准备完成。.*\/workflow-new/m)
    assert.match(output, /Gitleaks .*checksum OK/)
  } finally { f.cleanup() }
})

test('a pinned scanner in ~/.local/bin is used without reinstalling or restart advice', { timeout: 120000 }, () => {
  const f = fixture({ opencode: baseline, scanner: 'fallback' })
  try {
    const { status, output } = f.setup()
    assert.equal(status, 0, output)
    assert.match(output, /checksum OK/)
    assert.doesNotMatch(output, /service restart/)
  } finally { f.cleanup() }
})

test('another Gitleaks earlier on PATH is reported with the pinned copy it shadows', { timeout: 120000 }, () => {
  const f = fixture({ opencode: baseline, scanner: 'shadowed' })
  try {
    const { status, output } = f.setup()
    assert.equal(status, 1)
    const local = join(f.home, '.local', 'bin')
    assert.ok(output.includes(`checksum OK: ${local}`), output)
    assert.ok(output.includes(`把 ${local} 放到 PATH 中`), output)
  } finally { f.cleanup() }
})

test('missing plugin dependencies are installed with npm ci', { timeout: 120000 }, () => {
  const f = fixture({ opencode: baseline, deps: false })
  try {
    const { status, output, npm } = f.setup()
    assert.equal(status, 0, output)
    assert.equal(npm, '--prefix .opencode/plugins/workflow ci --ignore-scripts --no-audit --no-fund\n')
  } finally { f.cleanup() }
})

test('a missing CLI is only reported when no choice was made', { timeout: 120000 }, () => {
  const f = fixture()
  try {
    const { status, output, npm } = f.setup()
    assert.equal(status, 1)
    assert.equal(npm, '')
    assert.ok(output.includes(`npm install -g @opencode/cli@${baseline}`), output)
    assert.match(output, /--opencode cli/)
  } finally { f.cleanup() }
})

test('choosing the CLI installs the accepted version through npm', { timeout: 120000 }, () => {
  const f = fixture()
  try {
    const { status, output, npm } = f.setup('--opencode', 'cli')
    assert.equal(status, 0, output)
    assert.equal(npm, `install -g @opencode/cli@${baseline} --no-audit --no-fund\n`)
    assert.match(output, /pass opencode-version/)
  } finally { f.cleanup() }
})

test('choosing Desktop points to the official download and keeps the CLI requirement', { timeout: 120000 }, () => {
  const f = fixture()
  try {
    const { status, output, npm } = f.setup('--opencode', 'desktop')
    assert.equal(status, 1)
    assert.equal(npm, '')
    assert.ok(output.includes('https://opencode.ai/v2/docs/'), output)
    assert.match(output, /未验收/)
    assert.match(output, /终端/)
  } finally { f.cleanup() }
})

test('an existing install of another version is never replaced', { timeout: 120000 }, () => {
  const [major, minor] = baseline.split('.')
  for (const [version, guidance] of [[`${major}.${Number(minor) + 1}.0`, `npm install -g @opencode/cli@${baseline}`], ['1.4.0', 'https://opencode.ai/v2/docs/migrate-v1/']]) {
    const f = fixture({ opencode: version })
    try {
      const { status, output, npm } = f.setup('--opencode', 'cli')
      assert.equal(status, 1, version)
      assert.equal(npm, '', version)
      assert.ok(output.includes(version) && output.includes(guidance), output)
    } finally { f.cleanup() }
  }
})

test('the interactive prompt maps answers to an install choice', async () => {
  const answer = async text => {
    const input = new PassThrough(), output = new PassThrough()
    output.resume()
    const choice = ask(input, output)
    input.end(text)
    return choice
  }
  assert.equal(await answer('1\n'), 'cli')
  assert.equal(await answer('2\n'), 'desktop')
  assert.equal(await answer('\n'), 'skip')
  assert.equal(await answer('x\n'), 'skip')
  assert.equal(await answer(''), 'skip')
})
