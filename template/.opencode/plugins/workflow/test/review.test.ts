import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, load } from './fixture.ts'
import { git, loadBatch, listBatches } from '../review-batches.ts'
import { runReview, resolveBase, pathBatches, unitDiff } from '../review.ts'

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

test('path batches stay within the byte budget and keep order', () => {
  assert.deepEqual(pathBatches(['aa', 'bbb', 'c'], 7), [['aa', 'bbb'], ['c']])
  assert.deepEqual(pathBatches(['中', '中'], 7), [['中'], ['中']])
  assert.deepEqual(pathBatches(['long-path'], 3), [['long-path']])
  assert.deepEqual(pathBatches([], 7), [])
})

test('unit diffs split into batches match one full diff of the same paths', async () => {
  const f = await baseRepository()
  try {
    const paths = ['a.txt', 'b dir/c.txt', 'br[ack]et.txt', 'tracked.txt']
    for (const path of paths) {
      await mkdir(join(f.root, path, '..'), { recursive: true })
      await writeFile(join(f.root, path), `changed ${path}\n`)
    }
    const whole = (tree: string, selected: string[]) =>
      git(f.root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', f.base, tree, '--', ...selected])
    const batch = await runReview(f.root, { mode: 'branch', base: f.base })
    assert.ok(batch)
    for (const task of batch.tasks) {
      assert.equal(await readFile(join(batch.reviewDir, 'units', task.id.replaceAll(':', '-'), 'diff.patch'), 'utf8'), whole(batch.tree, task.paths))
    }
    assert.equal(unitDiff(f.root, f.base, batch.tree, paths, 1), whole(batch.tree, paths))
    for (const path of paths) assert.ok(whole(batch.tree, paths).includes(`changed ${path}`))
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

test('the remote default branch identifies the fork point', async () => {
  const f = await baseRepository()
  try {
    git(f.root, ['update-ref', 'refs/remotes/origin/develop', f.base])
    git(f.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
    await writeFile(join(f.root, 'tracked.txt'), 'changed on main\n')
    git(f.root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'on main'])
    assert.equal(resolveBase(f.root, undefined, git(f.root, ['rev-parse', 'HEAD'])), f.base)
  } finally { await f.close() }
})

test('reviews start and accept verdicts only while the reviewer definition is loaded', async () => {
  const f = await baseRepository()
  try {
    await (await load())(f.ctx)
    await writeFile(join(f.root, 'tracked.txt'), 'changed\n')
    const run = f.tools.get('workflow_review'), submit = f.tools.get('workflow_review_submit')
    const context = { agent: 'build', sessionID: 's1', signal: new AbortController().signal }
    const refuse = async () => {
      await assert.rejects(run.execute({ action: 'run', mode: 'branch', base: f.base }, context), /reviewer 没有正确加载/)
      await assert.rejects(submit.execute({ batchId: 'any', taskId: 'any', verdict: 'pass' }, { agent: 'reviewer', sessionID: 'r1' }), /reviewer 没有正确加载/)
    }
    await refuse()
    f.agents.set('reviewer', { id: 'reviewer', system: '   ' })
    await refuse()
    const get = (f.ctx as any).agent.get
    ;(f.ctx as any).agent.get = async () => { throw new Error('agent not found') }
    await refuse()
    // 读取代理定义本身出错时，拒绝信息带上原因，原始错误保留在 cause 里。
    await assert.rejects(run.execute({ action: 'run', mode: 'branch', base: f.base }, context),
      (error: Error) => /reviewer 没有正确加载.*agent not found/s.test(error.message) && (error.cause as Error)?.message === 'agent not found')
    // 抛出的不是 Error 时也要显示原因，不能显示 undefined。
    ;(f.ctx as any).agent.get = async () => { throw 'plain failure' }
    await assert.rejects(run.execute({ action: 'run', mode: 'branch', base: f.base }, context), /读取代理定义失败：plain failure/)
    ;(f.ctx as any).agent.get = get
    assert.equal(listBatches(f.root).length, 0)
    f.agents.set('reviewer', { id: 'reviewer', system: '只读审核。' })
    assert.match((await run.execute({ action: 'run', mode: 'branch', base: f.base }, context)).content, /core:/)
  } finally { await f.close() }
})
