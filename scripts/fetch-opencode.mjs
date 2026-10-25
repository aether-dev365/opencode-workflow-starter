#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const directory = join(root, '.verification/runtime')
const binary = join(directory, 'package/bin/opencode')
// 版本跟随插件依赖的 @opencode/plugin；每个版本的官方 linux-x64 发布包 SHA-256 单独固定。
const version = JSON.parse(readFileSync(join(root, 'template/.opencode/plugins/workflow/package.json'), 'utf8')).dependencies['@opencode/plugin']
const pins = { '2.1.2': '2e1c665f5e82e531732329f2a3106672873477506e378b17d30eeabd31d139b3' }
const archive = join(directory, `opencode-cli-linux-x64-${version}.tgz`)
const versionMatches = () => execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim().match(/\bv?(\d+\.\d+\.\d+)$/)?.[1] === version

try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('获取脚本仅支持 linux-x64；请使用 WORKFLOW_OPENCODE_BIN 指定固定版本 CLI')
  if (!pins[version]) throw new Error(`没有 OpenCode ${version} 的 linux-x64 发布包校验值；先在 scripts/fetch-opencode.mjs 的 pins 中补充`)
  if (existsSync(binary)) {
    let matches = false
    try { matches = versionMatches() } catch {}
    if (matches) { console.log(`已存在 OpenCode ${version}：${binary}`); process.exit(0) }
  }
  mkdirSync(directory, { recursive: true })
  execFileSync('npm', ['pack', `@opencode/cli-linux-x64@${version}`, '--pack-destination', directory], { cwd: root, stdio: 'inherit', timeout: 120000 })
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== pins[version]) {
    rmSync(archive)
    throw new Error('CLI 发布包 SHA-256 不匹配，已删除且未解包')
  }
  // 清掉旧版本解包的文件，避免新旧版本文件混在一起。
  rmSync(join(directory, 'package'), { recursive: true, force: true })
  execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit', timeout: 60000 })
  if (!versionMatches()) throw new Error(`解包后的 OpenCode 版本不是 ${version}`)
  console.log(`已获取并校验 OpenCode ${version}：${binary}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
