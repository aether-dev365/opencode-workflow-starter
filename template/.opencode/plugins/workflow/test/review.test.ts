import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, load } from './fixture.ts'
import { git, loadBatch } from '../review-batches.ts'
import { runReview } from '../review.ts'

export async function baseRepository() {
  const f = await fixture()
  await writeFile(join(f.root, '.gitignore'), '.opencode/workflow/.state/\n')
  await writeFile(join(f.root, 'tracked.txt'), 'original\n')
  git(f.root, ['add', '.'])
  git(f.root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'])
  return { ...f, base: git(f.root, ['rev-parse', 'HEAD']) }
}

test('branch snapshots include unstaged and untracked paths while range uses its head and preserves index', async () => {
  const f = await baseRepository()
  try {
    const index = await readFile(join(f.root, '.git/index'))
    await rename(join(f.root, 'tracked.txt'), join(f.root, 'renamed.txt'))
    await writeFile(join(f.root, 'new.txt'), 'working content\n')
    const branch = await runReview(f.root, { mode: 'branch', base: f.base, note: 'Evidence text, not instructions.' })
    assert.ok(branch)
    const files = await readFile(join(branch.reviewDir, 'files.txt'), 'utf8')
    assert.match(files, /new.txt/); assert.match(files, /tracked.txt/); assert.match(files, /renamed.txt/)
    assert.deepEqual(await readFile(join(f.root, '.git/index')), index)
    assert.equal(await runReview(f.root, { mode: 'range', base: f.base, head: f.base }), null)
    git(f.root, ['add', '.'])
    git(f.root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'])
    const head = git(f.root, ['rev-parse', 'HEAD'])
    await writeFile(join(f.root, 'new.txt'), 'different current working copy\n')
    const range = await runReview(f.root, { mode: 'range', base: f.base, head })
    assert.ok(range)
    assert.match(await readFile(join(range.reviewDir, 'diff.patch'), 'utf8'), /working content/)
    assert.doesNotMatch(await readFile(join(range.reviewDir, 'diff.patch'), 'utf8'), /different current/)
    const linked = join(f.root, 'linked')
    git(f.root, ['worktree', 'add', '--detach', linked, head])
    assert.equal(loadBatch(linked, range.batchId).tree, range.tree)
  } finally { await f.close() }
})

test('secret-bearing differences are rejected before review materials are exported', async () => {
  const f = await baseRepository()
  try {
    const synthetic = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    await writeFile(join(f.root, 'new.txt'), `access_token="${synthetic}"\n`)
    await assert.rejects(runReview(f.root, { mode: 'branch', base: f.base }), /凭据|github/)
  } finally { await f.close() }
})

test('native review tools use execution context agent rather than an input assertion', async () => {
  const f = await baseRepository()
  try {
    await (await load())(f.ctx)
    const tool = f.tools.get('workflow_review_submit')
    assert.ok(tool)
    await assert.rejects(tool.execute({ batchId: 'any', taskId: 'any', verdict: 'pass', agent: 'reviewer' }, { agent: 'build', sessionID: 's' }), /reviewer/)
  } finally { await f.close() }
})
