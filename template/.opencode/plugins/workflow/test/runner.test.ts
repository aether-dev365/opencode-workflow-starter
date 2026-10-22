import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCheck } from '../runner.ts'
import { normalizeCall } from '../protocol.ts'

test('checker malformed output and oversized output reject execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runner-'))
  try {
    const path = join(dir, 'check.py')
    for (const code of ['print("bad")', 'print("x" * 300000)', 'import sys; sys.exit(1)']) {
      await writeFile(path, code)
      await assert.rejects(runCheck(path, normalizeCall('shell', { command: 'true' }, dir, 's', 'c')))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('aborting a checker terminates the operation promptly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runner-'))
  const signal = new AbortController()
  try {
    const path = join(dir, 'sleep.py')
    const pidFile = join(dir, 'pid')
    await writeFile(path, `import os,time\nopen(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))\ntime.sleep(30)`)
    const task = runCheck(path, normalizeCall('shell', { command: 'true' }, dir, 's', 'c'), signal.signal)
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')) } catch {}
      if (!pid) await new Promise(r => setTimeout(r, 10))
    }
    assert.ok(pid)
    signal.abort()
    await assert.rejects(task, /取消/)
    await new Promise(r => setTimeout(r, 50))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a stalled checker hits the deadline rather than allowing execution', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-runner-'))
  try {
    const path = join(dir, 'sleep.py')
    await writeFile(path, 'import time; time.sleep(30)')
    await assert.rejects(runCheck(path, normalizeCall('shell', { command: 'true' }, dir, 's', 'c')), /超时/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a missing interpreter names the command, the override and the service restart', async () => {
  const previous = process.env.WORKFLOW_PYTHON
  process.env.WORKFLOW_PYTHON = join(tmpdir(), 'workflow-missing-python')
  try {
    await assert.rejects(runCheck('pre-guard-paths.py', normalizeCall('shell', { command: 'true' }, tmpdir(), 's', 'c')), (error: Error) =>
      error.message.includes('workflow-missing-python') && error.message.includes('WORKFLOW_PYTHON') && error.message.includes('opencode service restart'))
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PYTHON
    else process.env.WORKFLOW_PYTHON = previous
  }
})
