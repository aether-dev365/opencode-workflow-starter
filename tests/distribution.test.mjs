import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const entrypoints = ['README.md', 'ADOPT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']

function files(path) {
  return readdirSync(path, { withFileTypes: true }).filter(e => !['node_modules', '__pycache__', '.state'].includes(e.name)).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])
}
const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(path => path && !path.endsWith('package-lock.json'))

test('public entrypoints and relative documentation links resolve within the deliverable', () => {
  for (const path of [...entrypoints, 'LICENSE', 'examples/adoption-report.md', 'optional/production/mcp-readonly.example.jsonc']) assert.ok(existsSync(path), path)
  for (const path of [...files('template'), ...files('optional'), ...files('examples'), ...entrypoints].filter(p => p.endsWith('.md'))) {
    const text = readFileSync(path, 'utf8')
    for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(link)) continue
      assert.ok(existsSync(resolve(dirname(path), link.split('#')[0])), `${path} → ${link}`)
    }
  }
})

test('tracked text files contain no local home paths or public IPv4 addresses', () => {
  for (const path of tracked()) {
    const text = readFileSync(path, 'utf8')
    for (const pattern of [/\/home\/[a-z_][\w.-]*\//, /\/Users\/[A-Za-z][\w.-]*\//, /[A-Za-z]:\\Users\\[A-Za-z]/]) assert.doesNotMatch(text, pattern, path)
    for (const [address] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) assert.ok(['127.0.0.1', '0.0.0.0'].includes(address), `${path}: ${address}`)
  }
})

test('maintainer-local forbidden patterns stay out of tracked files', () => {
  // 私有名称只写在被忽略的本地文件里，避免禁用词清单本身随仓库公开。
  const list = '.verification/forbidden-patterns.txt'
  if (!existsSync(list)) return
  const patterns = readFileSync(list, 'utf8').split('\n').map(line => line.trim().toLowerCase()).filter(line => line && !line.startsWith('#'))
  for (const path of tracked()) {
    const text = readFileSync(path, 'utf8').toLowerCase()
    assert.ok(!patterns.some(pattern => text.includes(pattern)), `${path} 含本地禁用词`)
  }
})

test('the template carries the suite license', () => {
  const license = readFileSync('LICENSE', 'utf8')
  assert.match(license, /^MIT License\n/)
  assert.equal(readFileSync('template/.opencode/LICENSE', 'utf8'), license)
})
