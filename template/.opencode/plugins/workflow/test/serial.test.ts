import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionQueue } from '../serial.ts'

test('same-session actions run in order, other sessions do not wait, and a failure does not block the next', { timeout: 5000 }, async () => {
  const serial = sessionQueue()
  const events: string[] = []
  let release!: () => void
  const blocked = new Promise<void>(done => { release = done })
  const first = serial('s', async () => { events.push('first start'); await blocked; events.push('first end'); throw new Error('失败') })
  const second = serial('s', async () => { events.push('second'); return 2 })
  assert.equal(await serial('t', async () => 3), 3)
  assert.deepEqual(events, ['first start'])
  release()
  await assert.rejects(first, /失败/)
  assert.equal(await second, 2)
  assert.deepEqual(events, ['first start', 'first end', 'second'])
})
