import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { normalizeCall, parseResult } from '../protocol.ts'

test('patch moves and deletes normalize every source and destination before mutation', () => {
  const input = { patchText: '*** Begin Patch\n*** Update File: a\n*** Move to: vendor/b\n@@\n-x\n+y\n*** Delete File: c\n*** End Patch' }
  const root = resolve('/project')
  assert.deepEqual(normalizeCall('patch', input, root, 's', 'c').paths, [join(root, 'a'), join(root, 'vendor/b'), join(root, 'c')])
  assert.throws(() => normalizeCall('patch', { patchText: 'invalid' }, root, 's', 'c'))
})

test('补丁路径提取覆盖原生接受的缩进、CRLF 和路径空白，保留原始正文', async t => {
  const root = resolve('/project')
  const cases: [string, string, string[]][] = [
    ['缩进添加头', '*** Begin Patch\n\t *** Add File: vendor/new.txt \t\n+  keep spaces  \n*** End Patch', ['vendor/new.txt']],
    ['缩进删除头', '*** Begin Patch\n  *** Delete File: vendor/old.txt\n*** End Patch', ['vendor/old.txt']],
    ['CRLF 更新及移动', '*** Begin Patch\n*** Update File: a\r\n*** Move to: vendor/b \t\r\n@@\n-x\n+y\n*** End Patch', ['a', 'vendor/b']],
    ['完整 CRLF 及外层空白', '\uFEFF  *** Begin Patch\r\n\t*** Update File: src/a \t\r\n@@\r\n-x\r\n+y\r\n*** End Patch  \r\n', ['src/a']],
    ['混合多文件头', '*** Begin Patch\n*** Add File: safe\n+*** Update File: not-a-header\n  *** Update File: a \r\n*** Move to: vendor/b\r\n@@\n-x\n+y\n*** Delete File: c \r\n*** End Patch', ['safe', 'a', 'vendor/b', 'c']],
    ['更新正文中的上下文不是文件头', '*** Begin Patch\n  *** Update File: src/a\n@@\n *** Update File: vendor/not-a-target\n *** Move to: vendor/not-a-move\n-x\n+y\n*** End Patch', ['src/a']],
  ]
  for (const separator of ['\r', '\u2028', '\u2029']) {
    const source = `src/a${separator}b`, destination = `vendor/c${separator}d`, deleted = `vendor/e${separator}f`, added = `vendor/g${separator}h`
    cases.push([`路径内部分隔字符 ${JSON.stringify(separator)}`,
      `*** Begin Patch\n*** Add File: safe\n+x\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n-x\n+y\n*** Delete File: ${deleted}\n*** Add File: ${added}\n+x\n*** End Patch`,
      ['safe', source, destination, deleted, added]])
  }
  for (const [name, patchText, paths] of cases) await t.test(name, () => {
    const result = normalizeCall('patch', { patchText }, root, 's', 'c')
    assert.deepEqual(result.paths, paths.map(path => join(root, path)))
    assert.equal(result.input.patchText, patchText)
  })
})

test('invalid checker output or exit code is not interpreted as permission', () => {
  assert.throws(() => parseResult('not json', 0))
  assert.throws(() => parseResult('{"decision":"allow","reminders":[]}', 2))
  assert.equal(parseResult('{"decision":"deny","reminders":[]}', 2).decision, 'deny')
})
