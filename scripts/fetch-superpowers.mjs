#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, readdirSync, lstatSync, readFileSync, readlinkSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { SUPERPOWERS_REVISION, SUPERPOWERS_SOURCE } from '../template/.opencode/plugins/workflow/onboarding-source.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
export const superpowersDirectory = resolve(import.meta.dirname, '../.verification/runtime/superpowers')

export function verifySuperpowers(directory = superpowersDirectory) {
  const entries = []
  function walk(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), relative = prefix ? prefix + '/' + name : name, info = lstatSync(path)
      if (info.isSymbolicLink()) entries.push([relative, 'link', readlinkSync(path)])
      else if (info.isDirectory()) walk(path, relative)
      else if (info.isFile()) entries.push([relative, 'file', hash(readFileSync(path))])
      else throw new Error('源码缓存包含不支持的文件类型')
    }
  }
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return false
    walk(directory)
    return hash(JSON.stringify(entries)) === SUPERPOWERS_SOURCE.treeSha256
  } catch { return false }
}

export async function prepareSuperpowers({ directory = superpowersDirectory, archive } = {}) {
  if (existsSync(directory)) {
    if (!verifySuperpowers(directory)) throw new Error('Superpowers 源码缓存与固定版本不匹配；未覆盖，请检查缓存改动')
    return directory
  }
  mkdirSync(dirname(directory), { recursive: true })
  const temporary = mkdtempSync(join(dirname(directory), 'superpowers-download-'))
  try {
    const downloaded = join(temporary, 'source.tar.gz')
    let bytes
    if (archive) bytes = readFileSync(archive)
    else {
      const response = await fetch(SUPERPOWERS_SOURCE.archive, { signal: AbortSignal.timeout(120000) })
      if (!response.ok || !response.body) throw new Error(`Superpowers 下载失败：HTTP ${response.status}`)
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) throw new Error('Superpowers 归档超过 32 MiB')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    }
    if (hash(bytes) !== SUPERPOWERS_SOURCE.archiveSha256) throw new Error('Superpowers 归档 SHA-256 不匹配，未解包')
    writeFileSync(downloaded, bytes)
    const prefix = `superpowers-${SUPERPOWERS_REVISION}`
    const names = execFileSync('tar', ['-tzf', downloaded], { encoding: 'utf8', timeout: 60000 }).trim().split('\n')
    if (!names.every(name => (name === prefix || name.startsWith(prefix + '/')) && !name.split('/').includes('..'))) throw new Error('Superpowers 归档路径越界')
    const unpacked = join(temporary, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', downloaded, '-C', unpacked], { encoding: 'utf8', timeout: 60000 })
    const source = join(unpacked, prefix)
    if (!verifySuperpowers(source)) throw new Error('Superpowers 解包内容与固定源码摘要不匹配')
    renameSync(source, directory)
    return directory
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--archive' || !args[1])) throw new Error('用法：node scripts/fetch-superpowers.mjs [--archive 固定源码归档]')
    const directory = await prepareSuperpowers({ archive: args[1] })
    console.log(`已校验 Superpowers ${SUPERPOWERS_SOURCE.version} 原生验收源码：${directory}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
