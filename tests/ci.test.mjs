import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { makeRepo, scope } from './fixtures/ci-fixture.mjs'

const files = ['resolve-scope.py']
const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } })
const push = (before, after, branch = 'main') => ({ before, after, deleted: false, repository: { default_branch: branch } })
const success = (result, expected) => {
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), expected)
  assert.equal(readFileSync(result.output, 'utf8'), `mode=${expected.mode}\nbase=${expected.base}\nhead=${expected.head}\n`)
}

test('scope: PR uses event head rather than merge SHA', t => {
  const r = makeRepo(t, { ciFiles: files }); r.write('a.ts', 'base\n'); const start = r.commit()
  r.git('checkout', '-qb', 'feature'); r.write('a.ts', 'head\n'); const head = r.commit()
  r.git('checkout', '-q', 'main'); r.write('b.ts', 'base advance\n'); const base = r.commit()
  r.git('merge', '--no-ff', '-qm', 'merge', 'feature'); const merge = r.git('rev-parse', 'HEAD')
  r.git('checkout', '-q', head)
  success(scope(r, 'pull_request', pr(base, head), merge), { mode: 'range', base, head })
  assert.equal(r.git('merge-base', base, head), start)
  assert.equal(r.git('show', 'HEAD:a.ts'), 'head')
})

test('scope: push spans all commits and merge changes', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('one.ts', 'one'); r.commit(); r.git('checkout', '-qb', 'side')
  r.write('two.ts', 'two'); r.commit(); r.git('checkout', '-q', 'main')
  r.git('merge', '--no-ff', '-qm', 'merge', 'side'); const head = r.git('rev-parse', 'HEAD')
  success(scope(r, 'push', push(base, head, "trunk'branch"), head, "refs/heads/trunk'branch"), { mode: 'range', base, head })
  assert.equal(r.git('diff', '--name-only', base, head), 'one.ts\ntwo.ts')
})

test('scope: first push and dispatch use all', t => {
  const r = makeRepo(t, { ciFiles: files }); const head = r.commit()
  for (const result of [scope(r, 'push', push('0'.repeat(40), head)), scope(r, 'workflow_dispatch', {}, head)]) {
    success(result, { mode: 'all', base: '', head })
    assert.ok(result.stderr.trim())
  }
})

test('scope: unavailable old tip and nonancestor tip use all', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('a.ts', 'a'); const old = r.commit(); r.git('checkout', '-q', base)
  r.write('b.ts', 'b'); const head = r.commit()
  for (const before of [old, 'f'.repeat(40)]) success(scope(r, 'push', push(before, head)), { mode: 'all', base: '', head })
})

test('scope: invalid metadata never becomes an empty range', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('a.ts', 'a'); const head = r.commit()
  const blob = r.git('rev-parse', 'HEAD:a.ts'); r.git('tag', '-a', 'annotated', '-m', 'tag')
  const tag = r.git('rev-parse', 'annotated')
  for (const [event, data, sha, ref] of [
    ['push', { after: head }], ['push', push('bad\nmode=all', head)], ['push', push(base.slice(0, 7), head)],
    ['push', push(base, head), '', 'refs/heads/other'], ['push', { ...push(base, head), deleted: true }],
    ['pull_request', pr(blob, head)], ['pull_request', pr(tag, head)], ['pull_request', pr(base, 'e'.repeat(40))],
    ['pull_request', pr(base, base)], ['pull_request', {}], ['workflow_dispatch', {}, tag],
    ['push', '{'], ['push', []], ['other', {}],
  ]) {
    const result = scope(r, event, data, sha, ref)
    assert.equal(result.status, 2, JSON.stringify(data) + result.stdout)
    assert.equal(readFileSync(result.output, 'utf8'), '')
  }
  writeFileSync(join(r.root, '.git/shallow'), base + '\n')
  assert.equal(scope(r, 'pull_request', pr(base, head)).status, 2)
})

test('scope: unrelated PR histories fail but gitfile roots work', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.git('checkout', '--orphan', 'other'); r.write('other.ts', 'unrelated'); const head = r.commit()
  assert.notEqual(base, head, '两个根提交必须不同')
  assert.equal(scope(r, 'pull_request', pr(base, head)).status, 2)
  r.git('checkout', '-q', 'main')
  const linked = join(r.temp, 'linked'); r.git('worktree', 'add', '--detach', linked, base)
  const eventFile = join(r.temp, 'manual.json'); writeFileSync(eventFile, '{}')
  const result = r.py(join(linked, 'scripts/ci/resolve-scope.py'), [], { cwd: linked, env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: base, GITHUB_EVENT_PATH: eventFile } })
  assert.equal(result.status, 0, result.stderr)
})

test('scope: Git errors are not missing objects and old queries work', t => {
  const r = makeRepo(t, { ciFiles: files }); const head = r.commit()
  const realGit = r.run('sh', ['-c', 'command -v git']).stdout.trim()
  const bin = join(r.temp, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst a=process.argv.slice(2);\nif(a.includes('--is-shallow-repository'))process.exit(90);\nif(a.includes('cat-file')&&process.env.FAIL_GIT){if(process.env.FAIL_GIT==='bad'){console.log('invalid');process.exit(0)}process.exit(91)}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??92);\n`, { mode: 0o755 })
  r.env.PATH = bin + delimiter + r.env.PATH
  success(scope(r, 'push', push('f'.repeat(40), head)), { mode: 'all', base: '', head })
  for (const fail of ['error', 'bad']) { r.env.FAIL_GIT = fail; assert.equal(scope(r, 'push', push('f'.repeat(40), head)).status, 2) }
})
