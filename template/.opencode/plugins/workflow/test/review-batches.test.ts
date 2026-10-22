import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTasks, createBatch, loadBatch, submitVerdict, closeBatch, git } from '../review-batches.ts'
import { fixture } from './fixture.ts'
import { loadProjectConfig } from '../config.ts'

test('unknown paths retain core and tests coverage without unrelated specialist reviews', async () => {
  const f = await fixture()
  try {
    const { routing } = await loadProjectConfig(f.root)
    assert.deepEqual(planTasks(['unknown/new.txt'], routing), [
      { id: 'core:common', unitId: 'core', paths: ['unknown/new.txt'] },
      { id: 'tests:common', unitId: 'tests', paths: ['unknown/new.txt'] },
    ])
  } finally { await f.close() }
})

test('only the actual reviewer submits and an unfinished batch cannot close', async () => {
  const f = await fixture()
  try {
    const batch = createBatch(f.root, { mode: 'range', base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), reviewDir: f.root,
      tasks: [{ id: 'core:common', unitId: 'core', paths: ['a'], checklist: 'core.md', verdict: null, findings: [], gaps: [], note: '' }] })
    assert.throws(() => closeBatch(f.root, batch.batchId), /未完成/)
    assert.throws(() => submitVerdict(f.root, 'build', { batchId: batch.batchId, taskId: 'core:common', verdict: 'pass' }), /reviewer/)
    assert.throws(() => submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: 'core:common', verdict: 'pass', findings: [{ unitId: 'core', severity: 'P1', summary: 'reachable defect', blocking: false }] }), /阻断/)
    submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: 'core:common', verdict: 'pass' })
    closeBatch(f.root, batch.batchId)
    assert.equal(loadBatch(f.root, batch.batchId).status, 'closed')
    assert.throws(() => submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: 'core:common', verdict: 'findings' }), /关闭/)
    assert.throws(() => loadBatch(f.root, '../../escape'))
  } finally { await f.close() }
})

test('a submitted verdict cannot be replaced within the same batch', async () => {
  const f = await fixture()
  try {
    const batch = createBatch(f.root, { mode: 'release', base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), reviewDir: f.root,
      tasks: [{ id: 'core:common', unitId: 'core', paths: ['a'], checklist: 'core.md', verdict: null, findings: [], gaps: [], note: '' }] })
    submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: 'core:common', verdict: 'findings',
      findings: [{ unitId: 'core', severity: 'P1', summary: 'reachable defect', blocking: true }] })
    assert.throws(() => submitVerdict(f.root, 'reviewer', { batchId: batch.batchId, taskId: 'core:common', verdict: 'pass' }), /已有结论/)
    assert.equal(loadBatch(f.root, batch.batchId).tasks[0].verdict, 'findings')
  } finally { await f.close() }
})
