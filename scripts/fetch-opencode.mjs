#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const directory = join(root, '.verification/runtime')
const binary = join(directory, 'package/bin/opencode')
const archive = join(directory, 'opencode-cli-linux-x64-2.1.1.tgz')
const pinned = '64591057ea593e9a11374d4630c2249930d8f33598af0b3e02137493860ab17b'
const versionMatches = () => /\bv?2\.1\.1$/.test(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim())

try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('获取脚本仅支持 linux-x64；请使用 WORKFLOW_OPENCODE_BIN 指定固定版本 CLI')
  if (existsSync(binary)) {
    let matches = false
    try { matches = versionMatches() } catch {}
    if (matches) { console.log(`已存在 OpenCode 2.1.1：${binary}`); process.exit(0) }
  }
  mkdirSync(directory, { recursive: true })
  execFileSync('npm', ['pack', '@opencode/cli-linux-x64@2.1.1', '--pack-destination', directory], { cwd: root, stdio: 'inherit', timeout: 120000 })
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== pinned) {
    rmSync(archive)
    throw new Error('CLI 发布包 SHA-256 不匹配，已删除且未解包')
  }
  execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit', timeout: 60000 })
  if (!versionMatches()) throw new Error('解包后的 OpenCode 版本不是 2.1.1')
  console.log(`已获取并校验 OpenCode 2.1.1：${binary}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
