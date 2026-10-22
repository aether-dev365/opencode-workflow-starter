import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fixture, load } from './fixture.ts'
import { git, submitVerdict, closeBatch } from '../review-batches.ts'
import { runReview } from '../review.ts'
import { checkRelease, executeRelease, loadReleaseConfig } from '../release.ts'

async function releaseFixture(script = 'import { appendFileSync } from "node:fs"; appendFileSync(".opencode/workflow/.state/deployed", "run\\n")\n') {
  const f = await fixture()
  const commit = (message: string) => {
    git(f.root, ['add', '.'])
    git(f.root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message])
  }
  await writeFile(join(f.root, '.gitignore'), '.opencode/workflow/.state/\n')
  await writeFile(join(f.root, 'deploy.mjs'), script)
  await writeFile(join(f.root, '.opencode/workflow/release.json'), JSON.stringify({ version: 1, enabled: true, tagPattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$', scope: { include: ['**'], exclude: [] }, entries: [{ id: 'demo', argv: [process.execPath, 'deploy.mjs'], artifacts: ['.opencode/workflow/.state/artifact.zip'] }] }))
  await writeFile(join(f.root, 'product.txt'), 'first\n')
  commit('base')
  const base = git(f.root, ['rev-parse', 'HEAD'])
  await writeFile(join(f.root, 'product.txt'), 'candidate\n')
  commit('candidate')
  const tree = git(f.root, ['rev-parse', 'HEAD^{tree}'])
  await mkdir(join(f.root, '.opencode/workflow/.state'), { recursive: true })
  await writeFile(join(f.root, '.opencode/workflow/.state/artifact.zip'), 'synthetic artifact')
  await writeFile(join(f.root, '.opencode/workflow/.state/test.log'), 'one focused scenario ran, exit 0\n')
  const evidence = '.opencode/workflow/.state/evidence.json'
  await writeFile(join(f.root, evidence), JSON.stringify({ version: 1, base, tree, entries: [{ id: 'verification', units: ['core', 'tests'], kind: 'build', command: 'local fixture build', cwd: '.', exit: 0,
    inputs: { 'sha256:.opencode/workflow/.state/artifact.zip': createHash('sha256').update('synthetic artifact').digest('hex') }, files: ['.opencode/workflow/.state/test.log', '.opencode/workflow/.state/artifact.zip'], companion: ['.opencode/workflow/.state/test.log'] }] }))
  return { ...f, base, tree, evidence }
}
async function approve(f: Awaited<ReturnType<typeof releaseFixture>>) {
  const batch = await runReview(f.root, { mode: 'release', base: f.base, evidence: f.evidence })
  assert.ok(batch)
  for (const task of batch.tasks) submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: task.id, verdict: 'pass' })
  closeBatch(f.root, batch.batchId)
  return batch
}

test('release is disabled without configuration and preflight never grants permission', async () => {
  const plain = await fixture()
  try { await assert.rejects(runReview(plain.root, { mode: 'release', base: 'HEAD', evidence: 'evidence.json' }), /禁用|配置/) }
  finally { await plain.close() }
  const f = await releaseFixture()
  try {
    await assert.rejects(runReview(f.root, { mode: 'release', evidence: f.evidence }), /基线/)
    const batch = await runReview(f.root, { mode: 'preflight', base: f.base })
    assert.ok(batch)
    assert.throws(() => submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: batch.tasks[0].id, verdict: 'incomplete', gaps: [{ unitId: batch.tasks[0].unitId, reason: 'missing' }] }), /预审/)
    for (const task of batch.tasks) submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: task.id, verdict: 'pass' })
    closeBatch(f.root, batch.batchId)
    assert.equal(checkRelease(f.root, 'demo').allow, false)
  } finally { await f.close() }
})

test('only an approved unchanged candidate can execute the fixed entry', async () => {
  const f = await releaseFixture()
  try {
    await assert.rejects(executeRelease(f.root, 'demo'))
    await assert.rejects(access(join(f.root, '.opencode/workflow/.state/deployed')))
    await approve(f)
    assert.equal(checkRelease(f.root, 'demo').allow, true)
    await executeRelease(f.root, 'demo')
    assert.equal(await readFile(join(f.root, '.opencode/workflow/.state/deployed'), 'utf8'), 'run\n')
    await assert.rejects(executeRelease(f.root, 'unknown'))
    await writeFile(join(f.root, 'product.txt'), 'dirty')
    assert.equal(checkRelease(f.root, 'demo').allow, false)
    git(f.root, ['restore', 'product.txt'])
    await writeFile(join(f.root, '.opencode/workflow/.state/test.log'), 'changed evidence')
    assert.equal(checkRelease(f.root, 'demo').allow, false)
  } finally { await f.close() }
})

test('artifact mutation and a newer pending release invalidate an older approval', async () => {
  const f = await releaseFixture()
  try {
    await approve(f)
    await writeFile(join(f.root, '.opencode/workflow/.state/artifact.zip'), 'other bytes')
    assert.equal(checkRelease(f.root, 'demo').allow, false)
    await writeFile(join(f.root, '.opencode/workflow/.state/artifact.zip'), 'synthetic artifact')
    assert.equal(checkRelease(f.root, 'demo').allow, true)
    await runReview(f.root, { mode: 'release', base: f.base, evidence: f.evidence })
    assert.equal(checkRelease(f.root, 'demo').allow, false)
  } finally { await f.close() }
})

test('fixed entries preserve nonzero exits and cancellation', async () => {
  const failed = await releaseFixture('process.exit(9)')
  try { await approve(failed); await assert.rejects(executeRelease(failed.root, 'demo'), /退出码 9/) }
  finally { await failed.close() }
  const slow = await releaseFixture('setInterval(() => {}, 1000)')
  try {
    await approve(slow)
    const controller = new AbortController()
    const result = executeRelease(slow.root, 'demo', controller.signal)
    const timer = setTimeout(() => controller.abort(), 50)
    try { await assert.rejects(result, /取消/) } finally { clearTimeout(timer) }
  } finally { await slow.close() }
})

test('configuration changed during permission confirmation is not executed', async () => {
  const f = await releaseFixture()
  try {
    await approve(f)
    await (await load())(f.ctx)
    const tool = f.tools.get('workflow_release')
    assert.ok(tool)
    f.onPermission(async () => { await writeFile(join(f.root, '.opencode/workflow/release.json'), '{"version":1,"enabled":false}') })
    await assert.rejects(tool.execute({ entry: 'demo' }, { sessionID: 's', agent: 'build', messageID: 'm', id: 'c' }), /审批期间/)
    await assert.rejects(access(join(f.root, '.opencode/workflow/.state/deployed')))
  } finally { await f.close() }
})

test('release scope includes CI and workflow configuration in dot directories', async () => {
  const f = await releaseFixture()
  try {
    await mkdir(join(f.root, '.github/workflows'), { recursive: true })
    await writeFile(join(f.root, '.github/workflows/deploy.yml'), 'on: push\n')
    await writeFile(join(f.root, '.opencode/workflow/review/checklists/core.md'), 'Check core behavior, evidence and CI.\n')
    const batch = await runReview(f.root, { mode: 'preflight', base: f.base })
    assert.ok(batch)
    const paths = batch.tasks.flatMap(t => t.paths)
    for (const path of ['.github/workflows/deploy.yml', '.opencode/workflow/review/checklists/core.md']) assert.ok(paths.includes(path), path)
    assert.doesNotMatch(await readFile(join(batch.reviewDir, 'files.txt'), 'utf8'), /不纳入发布范围/)
  } finally { await f.close() }
})

test('release include and exclude reject unsupported brace patterns', async () => {
  const f = await releaseFixture()
  try {
    const path = join(f.root, '.opencode/workflow/release.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    for (const key of ['include', 'exclude']) {
      await writeFile(path, JSON.stringify({ ...original, scope: { ...original.scope, [key]: ['{src,lib}/*'] } }))
      assert.throws(() => loadReleaseConfig(f.root), /花括号/)
    }
  } finally { await f.close() }
})
