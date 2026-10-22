import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectConfig, protectionPermissions, validateRouting } from '../config.ts'
import { matchesPattern } from '../patterns.ts'

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-config-'))
  const put = (path: string, value: unknown) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  put('AGENTS.md', '# Project\nRead relevant rules.\n')
  put('.opencode/workflow/scopes.json', [{ paths: ['**'], instruction: 'AGENTS.md' }])
  put('.opencode/workflow/protection.json', { version: 1, rules: [
    { id: 'secret', actions: ['read', 'edit'], paths: ['*.env', '*.env.*'], effect: 'deny', reason: 'Use examples' },
    { id: 'example', actions: ['read', 'edit'], paths: ['*.env.example'], effect: 'allow', reason: 'Public example' },
  ] })
  put('.opencode/workflow/watchdog.json', { stallSeconds: 600, toolSeconds: 1800, checkSeconds: 30 })
  put('.opencode/workflow/review/catalog.json', { core: { group: 'core', checklist: 'core.md' }, tests: { group: 'core', checklist: 'tests.md' } })
  put('.opencode/workflow/review/routing.json', { version: 1, areas: [], units: [{ id: 'core', areas: ['*'] }, { id: 'tests', areas: ['*'] }] })
  put('.opencode/workflow/review/checklists/core.md', '# Correctness\nVerify behavior.\n')
  put('.opencode/workflow/review/checklists/tests.md', '# Tests\nVerify failures.\n')
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('loads portable configuration and generates ordered native secret exceptions', async () => {
  const f = fixture()
  try {
    const c = await loadProjectConfig(f.root)
    assert.deepEqual(c.scopes, [{ paths: ['**'], instruction: 'AGENTS.md' }])
    assert.deepEqual(protectionPermissions(c).slice(-2), [
      { action: 'read', resource: '*.env.example', effect: 'allow' },
      { action: 'edit', resource: '*.env.example', effect: 'allow' },
    ])
  } finally { f.cleanup() }
})

test('rejects missing rule text rather than falling back to a parent project', async () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'AGENTS.md'))
    await assert.rejects(loadProjectConfig(f.root), /AGENTS/)
  } finally { f.cleanup() }
})

test('rejects escaping rule paths, invalid actions and unknown review units', async () => {
  for (const [path, value] of [
    ['scopes.json', [{ paths: ['**'], instruction: '../AGENTS.md' }]],
    ['protection.json', { version: 1, rules: [{ id: 'bad', actions: ['shell'], paths: ['*'], effect: 'deny', reason: 'bad' }] }],
    ['review/routing.json', { version: 1, areas: [], units: [{ id: 'core', areas: ['*'] }, { id: 'tests', areas: ['*'] }, { id: 'absent', areas: ['*'] }] }],
  ] as const) {
    const f = fixture()
    try { f.put('.opencode/workflow/' + path, value); await assert.rejects(loadProjectConfig(f.root)) }
    finally { f.cleanup() }
  }
  assert.throws(() => validateRouting({ version: 1, areas: [], units: [] }), /core|tests/)
})

test('configuration inspection does not rewrite user files', async () => {
  const f = fixture()
  try {
    const path = join(f.root, '.opencode/workflow/scopes.json')
    const before = readFileSync(path)
    await loadProjectConfig(f.root)
    assert.deepEqual(readFileSync(path), before)
  } finally { f.cleanup() }
})

test('generated native permissions preserve the shared protection cases', async () => {
  const f = fixture()
  try {
    f.put('.opencode/workflow/protection.json', readFileSync(new URL('../../../workflow/checks/fixtures/protection.json', import.meta.url), 'utf8'))
    const rules = protectionPermissions(await loadProjectConfig(f.root))
    const cases = JSON.parse(readFileSync(new URL('../../../workflow/checks/fixtures/path-policy.json', import.meta.url), 'utf8'))
    for (const c of cases) {
      const matched = rules.filter(r => r.action === c.action && matchesPattern(c.path, r.resource))
      assert.equal(matched.at(-1)?.effect === 'deny', c.deny, c.path)
    }
  } finally { f.cleanup() }
})

test('JSON configuration rejects comments while native JSONC stays supported', async () => {
  const f = fixture()
  try {
    f.put('.opencode/workflow/watchdog.json', '// invalid JSON\n{"stallSeconds":600,"toolSeconds":1800,"checkSeconds":30}')
    await assert.rejects(loadProjectConfig(f.root))
  } finally { f.cleanup() }
})

test('path patterns with braces are rejected instead of never matching', async () => {
  for (const [path, value] of [
    ['scopes.json', [{ paths: ['src/*.{ts,tsx}'], instruction: 'AGENTS.md' }]],
    ['protection.json', { version: 1, rules: [{ id: 'secret', actions: ['read'], paths: ['*.{env,key}'], effect: 'deny', reason: 'x' }] }],
    ['review/routing.json', { version: 1, areas: [{ id: 'source', paths: ['{src,lib}/*'] }], units: [{ id: 'core', areas: ['*'] }, { id: 'tests', areas: ['*'] }] }],
  ] as const) {
    const f = fixture()
    try { f.put('.opencode/workflow/' + path, value); await assert.rejects(loadProjectConfig(f.root), /花括号/) }
    finally { f.cleanup() }
  }
})

test('native patterns cover dot segments and match literal punctuation and whole paths', () => {
  for (const [path, pattern, expected] of [
    ['.github/workflows/ci.yml', '**', true], ['src/.hidden/file.ts', 'src/*', true],
    ['file[1].ts', 'file[1].ts', true], ['file1.ts', 'file[1].ts', false],
    ['src/a.ts', 'src/?.ts', true], ['src/ab.ts', 'src/?.ts', false],
    ['file\n', 'file', false], ['a\nb', '*', true],
  ] as const) assert.equal(matchesPattern(path, pattern), expected, `${path} / ${pattern}`)
})

test('an invalid optional pipefail configuration fails configuration loading', async () => {
  const f = fixture()
  try {
    f.put('.opencode/workflow/pipefail.json', { version: 1, commandPrefixes: 'invalid' })
    await assert.rejects(loadProjectConfig(f.root), /pipefail\.json/)
    f.put('.opencode/workflow/pipefail.json', { version: 1, commandPrefixes: [['cargo', 'test']] })
    assert.deepEqual((await loadProjectConfig(f.root)).pipefail?.commandPrefixes, [['cargo', 'test']])
  } finally { f.cleanup() }
})
