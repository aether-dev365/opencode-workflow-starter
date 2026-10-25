import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { makeRepo } from './fixtures/ci-fixture.mjs'

const entry = resolve('scripts/check-sync.py')
const setup = (t, related = 'docs/guide.md') => {
  const r = makeRepo(t)
  r.write('scripts/quality/quality.json', JSON.stringify({ version: 1, sync: [{ id: 'docs', paths: ['src/*'], related: [related], message: '源码变化要同步说明' }] }))
  r.write('src/a.ts', '1\n'); r.write('docs/guide.md', '# 说明\n')
  r.commit()
  return r
}
const advance = r => { r.git('update-ref', 'refs/remotes/origin/main', 'HEAD'); r.write('src/a.ts', '2\n'); r.commit() }

test('without an upstream the suite entry only validates the registry', t => {
  const result = setup(t).py(entry)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /关联检查：校验了 1 条登记，0 处登记失效。/)
  assert.match(result.stdout, /没有上游分支，只校验了登记。/)
})

test('unpushed changes against origin/main are reported without failing', t => {
  const r = setup(t); advance(r)
  const result = r.py(entry)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /\[sync\] docs：源码变化要同步说明（改动：src\/a\.ts；未改动：docs\/guide\.md）/)
})

test('the configured upstream wins and a gone upstream falls back to origin/main', t => {
  const r = setup(t); advance(r)
  r.git('config', 'remote.origin.url', r.temp); r.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  r.git('config', 'branch.main.remote', 'origin'); r.git('config', 'branch.main.merge', 'refs/heads/feature')
  r.git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
  assert.match(r.py(entry).stdout, /0 条需要确认同步/)
  r.git('update-ref', '-d', 'refs/remotes/origin/feature')
  const result = r.py(entry)
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /1 条需要确认同步/)
})

test('a stale registry fails the suite entry', t => {
  const result = setup(t, 'docs/missing.md').py(entry)
  assert.equal(result.status, 2); assert.match(result.stdout, /\[sync-stale\] docs/)
})
