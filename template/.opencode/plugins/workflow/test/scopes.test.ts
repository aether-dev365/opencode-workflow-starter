import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture } from './fixture.ts'
import { matchingScopes, scopeRoot } from '../scopes.ts'

test('opencode config files without git do not create a checkout root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workflow-home-'))
  try {
    await mkdir(join(home, '.opencode'))
    await writeFile(join(home, '.opencode/opencode.json'), '{}')
    await writeFile(join(home, 'opencode.jsonc'), '{}')
    assert.equal(await scopeRoot(join(home, 'notes.md')), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a path with an overlong name still finds its checkout root', async () => {
  // 名字超过文件系统上限的路径不可能存在，向上查找 .git 时跳过它。
  const f = await fixture()
  try {
    assert.equal(await scopeRoot(join(f.root, 'x'.repeat(300), 'y')), f.root)
    assert.equal(await scopeRoot(join(f.root, '提交说明'.repeat(25))), f.root)
  } finally { await f.close() }
})

test('a path beyond the system limit is refused without echoing it', async () => {
  const f = await fixture()
  try {
    const deep = join(f.root, ...Array(30).fill('a'.repeat(200)))
    // Windows 对不存在的超长路径报 ENOENT，按不存在继续向上查找。
    if (process.platform === 'win32') { assert.equal(await scopeRoot(deep), f.root); return }
    await assert.rejects(scopeRoot(deep), (error: Error) => /超过系统长度上限/.test(error.message) && !error.message.includes(deep) && error.message.length < 400)
  } finally { await f.close() }
})

test('other lookup errors are refused with only the ends of the path', async t => {
  // 指向自身的链接让查询报 ELOOP，无法确认而拒绝；原因保留错误码，不整段回显参数。
  // Windows 对经过自指链接的路径报 ENOENT，属于“继续向上找”，会解析到检出根（pathError 的截断由 platform 单元用例覆盖）。
  const f = await fixture()
  try {
    try { await symlink('loop', join(f.root, 'loop')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
    const tail = 'b'.repeat(200)
    const lookup = scopeRoot(join(f.root, 'loop', 'a'.repeat(200), tail))
    if (process.platform === 'win32') assert.equal(await lookup, f.root)
    else await assert.rejects(lookup, (error: Error) => /无法检查路径/.test(error.message) && !error.message.includes(tail) && error.message.length < 400)
  } finally { await f.close() }
})

test('nested edits receive both root and domain instructions', async () => {
  const f = await fixture()
  try {
    const found = await matchingScopes(['new.ts'], join(f.root, 'src'))
    assert.deepEqual(found.map(s => s.instruction), [join(f.root, 'AGENTS.md'), join(f.root, 'src/AGENTS.md')])
  } finally { await f.close() }
})

test('the catch-all scope covers dot directories', async () => {
  const f = await fixture()
  try {
    const found = await matchingScopes(['.github/workflows/ci.yml'], f.root)
    assert.ok(found.some(s => s.instruction === join(f.root, 'AGENTS.md')))
  } finally { await f.close() }
})

test('a foreign checkout without scope mappings adds no rules while a broken mapping still fails', async () => {
  const f = await fixture()
  const other = await mkdtemp(join(tmpdir(), 'workflow-other-'))
  try {
    await mkdir(join(other, '.git'))
    const found = await matchingScopes([join(other, 'README.md'), 'src/new.ts'], f.root)
    assert.deepEqual(found.map(s => s.instruction), [join(f.root, 'AGENTS.md'), join(f.root, 'src/AGENTS.md')])
    await mkdir(join(other, '.opencode/workflow'), { recursive: true })
    await writeFile(join(other, '.opencode/workflow/scopes.json'), '[]')
    await assert.rejects(matchingScopes([join(other, 'README.md')], f.root), /范围映射无效/)
    await writeFile(join(other, '.opencode/workflow/scopes.json'), '{')
    await assert.rejects(matchingScopes([join(other, 'README.md')], f.root), /范围映射缺失或无法读取/)
  } finally {
    await f.close()
    await rm(other, { recursive: true, force: true })
  }
})

test('independent nested checkout cannot borrow parent mappings', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'nested/.git'), { recursive: true })
    await assert.rejects(matchingScopes(['file'], join(f.root, 'nested')), /范围/)
    await writeFile(join(f.root, '.opencode/workflow/scopes.json'), '[]')
    await assert.rejects(matchingScopes(['file'], f.root), /范围/)
  } finally { await f.close() }
})
