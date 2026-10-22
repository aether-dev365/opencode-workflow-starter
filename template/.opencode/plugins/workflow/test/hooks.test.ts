import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, before, context, load } from './fixture.ts'

const staleMapping = async (root: string) => {
  const path = join(root, '.opencode/workflow/scopes.json')
  const existing = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify([...existing, { paths: ['api/**'], instruction: 'api/AGENTS.md' }]))
}

test('invalid configuration keeps the plugin loaded and denies writes with a repair hint', async () => {
  const f = await fixture()
  try {
    await staleMapping(f.root)
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：.*api\/AGENTS\.md/s)
    await f.fire('tool.execute.before', before('read', { path: 'src/file.ts' }))
    await f.fire('tool.execute.before', before('write', { path: 'api/AGENTS.md' }))
    await f.fire('tool.execute.before', before('write', { path: '.opencode/workflow/scopes.json' }))
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => part.text.startsWith('工作流配置无效：')))
    assert.ok(model.system.some(part => part.text.includes('src/AGENTS.md')))
    await mkdir(join(f.root, 'api'))
    await writeFile(join(f.root, 'api/AGENTS.md'), 'API rules for the fixture.\n')
    await f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }))
  } finally { await f.close() }
})

test('a location outside git and an invalid release file do not prevent loading', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, '.opencode/workflow/release.json'), JSON.stringify({ version: 1, enabled: true }))
    await (await load())(f.ctx)
    const release = f.tools.get('workflow_release')
    assert.ok(release)
    await assert.rejects(release.execute({ entry: 'demo' }, { sessionID: 's1', agent: 'build', messageID: 'm', id: 'c' }), /发布配置无效/)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：发布配置无效/)
  } finally { await f.close() }
  const g = await fixture()
  try {
    await rm(join(g.root, '.git'), { recursive: true, force: true })
    await (await load())(g.ctx)
    await assert.rejects(g.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：未找到 Git 检出根/)
  } finally { await g.close() }
})

test('unseen scopes deny once then inject; compaction and child sessions reset visibility', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(p => p.text.includes('src/AGENTS.md')))
    await f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }))
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }, 'child')), /上下文/)
    await f.fire('session.compaction', { sessionID: 's1' })
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
  } finally { await f.close() }
})

test('native read permission and multi-file patch reject protected paths', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const permission = { action: 'read', resources: ['.env'], effect: 'allow', sessionID: 's1' }
    await f.fire('permission.evaluate', permission)
    assert.equal(permission.effect, 'deny')
    await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText: '*** Begin Patch\n*** Add File: safe\n+x\n*** Add File: vendor/no\n+x\n*** End Patch' })), /第三方/)
  } finally { await f.close() }
})

test('moving a session clears rules from the previous checkout', async () => {
  const f = await fixture()
  const next = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })))
    await f.fire('session.context', context())
    f.move(next.root)
    const model = context()
    await f.fire('session.context', model)
    assert.equal(model.system.length, 0)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
  } finally { await f.close(); await next.close() }
})
