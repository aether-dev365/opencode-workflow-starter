import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

function files(path) {
  return readdirSync(path, { withFileTypes: true }).filter(e => !['node_modules', '__pycache__', '.state'].includes(e.name)).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])
}

test('public entrypoints and relative documentation links resolve within the deliverable', () => {
  for (const path of ['README.md', 'ADOPT.md', 'examples/adoption-report.md', 'optional/production/mcp-readonly.example.jsonc']) assert.ok(existsSync(path), path)
  for (const path of [...files('template'), ...files('optional'), ...files('examples'), 'README.md', 'ADOPT.md'].filter(p => p.endsWith('.md'))) {
    const text = readFileSync(path, 'utf8')
    for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(link)) continue
      assert.ok(existsSync(resolve(dirname(path), link.split('#')[0])), `${path} → ${link}`)
    }
  }
})

test('portable files contain no source product namespace or local home paths', () => {
  const forbidden = /\/home\/(?!example\/)[a-z_][\w.-]*\//
  for (const path of [...files('template'), ...files('optional')]) {
    if (path.endsWith('package-lock.json')) continue
    assert.doesNotMatch(readFileSync(path, 'utf8'), forbidden, path)
  }
})
