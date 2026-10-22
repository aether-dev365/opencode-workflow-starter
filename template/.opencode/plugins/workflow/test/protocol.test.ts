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

test('invalid checker output or exit code is not interpreted as permission', () => {
  assert.throws(() => parseResult('not json', 0))
  assert.throws(() => parseResult('{"decision":"allow","reminders":[]}', 2))
  assert.equal(parseResult('{"decision":"deny","reminders":[]}', 2).decision, 'deny')
})
