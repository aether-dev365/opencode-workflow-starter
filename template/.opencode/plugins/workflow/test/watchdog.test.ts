import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatchdog } from '../watchdog.ts'

test('idle work and long tools remind once and completion stops reminders', async () => {
  let now = 0
  const notices: string[] = []
  const watcher = createWatchdog({ stallMs: 600000, toolMs: 1800000, now: () => now, lookup: async () => ({ parentID: 'parent' }), notify: async (_, text) => { notices.push(text) } })
  await watcher.observe({ type: 'session.execution.started', data: { sessionID: 'child' } })
  now = 599999; await watcher.tick(); assert.equal(notices.length, 0)
  now = 600000; await watcher.tick(); assert.equal(notices.length, 1)
  await watcher.tick(); assert.equal(notices.length, 1)
  await watcher.observe({ type: 'session.tool.called', data: { sessionID: 'child', id: 'tool' } })
  now = 2399999; await watcher.tick(); assert.equal(notices.length, 1)
  now = 2400000; await watcher.tick(); assert.equal(notices.length, 2)
  await watcher.observe({ type: 'session.execution.succeeded', data: { sessionID: 'child' } })
  now += 1800001; await watcher.tick(); assert.equal(notices.length, 2)
})
