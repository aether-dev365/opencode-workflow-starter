import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { start, runCase, put, git, batches } from './fixtures/native-harness.mjs'

const patch = (path, content) => ({ name: 'patch', input: { patchText: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch` } })

test('a stale scope mapping keeps the plugin active and blocks shell writes', { timeout: 180000 }, async () => {
  const h = await start({ prepare: directory => put(join(directory, '.opencode/workflow/scopes.json'), JSON.stringify([
    { paths: ['**'], instruction: 'AGENTS.md' }, { paths: ['api/**'], instruction: 'api/AGENTS.md' }])) })
  try {
    const result = await runCase(h, [[{ name: 'shell', input: { command: 'mkdir -p vendor && echo x > vendor/a.js', workdir: h.directory } }]])
    assert.match(result.toolResults, /工作流配置无效/)
    assert.equal(existsSync(join(h.directory, 'vendor/a.js')), false)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('OpenCode 2.1.1 executes the isolated workflow through real native boundaries', { timeout: 180000 }, async t => {
  const h = await start()
  try {
    await t.test('ordinary shell commands with options run while the server starts elsewhere', async () => {
      const result = await runCase(h, [[{ name: 'shell', input: { command: 'ls -la && git status --short', workdir: h.directory } }]])
      assert.doesNotMatch(result.toolResults, /文件保护检查拒绝/)
      assert.match(result.toolResults, /AGENTS\.md/)
    })
    await t.test('ordinary writes load domain rules and protected multi-file patches are atomic', async () => {
      const result = await runCase(h, [
        [patch('src/probe.txt', 'native output')],
        [patch('src/probe.txt', 'native output')],
        [{ name: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: partial.txt\n+x\n*** Add File: vendor/blocked.txt\n+x\n*** End Patch' } }],
      ])
      assert.equal(readFileSync(join(h.directory, 'src/probe.txt'), 'utf8'), 'native output\n')
      assert.equal(existsSync(join(h.directory, 'partial.txt')), false)
      assert.equal(existsSync(join(h.directory, 'vendor/blocked.txt')), false)
      assert.match(result.toolResults, /上下文/)
      assert.ok(result.requests.some(r => JSON.stringify(r.messages).includes('NATIVE_DOMAIN_RULE')))
    })

    await t.test('shell failure is preserved and disabled production tools never start', async () => {
      const result = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'shell', input: { command: 'npm test | tail -n 3', workdir: h.directory } }]])
      assert.match(result.toolResults, /(?:code|exit|退出码|Exited with code)[^\n]{0,25}7/i)
      assert.equal(existsSync(join(h.temp, 'disabled-mcp.log')), false)
      assert.ok(!result.requests.some(r => r.tools?.some(t => t.function.name.startsWith('operations-prod_'))))
    })

    await t.test('only actual reviewer sessions complete a native review batch', async () => {
      const result = await runCase(h, [[{ name: 'workflow_review', input: { action: 'run', mode: 'branch', base: h.base } }]])
      assert.match(result.toolResults, /core:/)
      const batch = batches(h)[0]
      assert.ok(batch)
      const spoof = await runCase(h, [[{ name: 'workflow_review_submit', input: { batchId: batch.batchId, taskId: batch.tasks[0].id, verdict: 'pass' } }]])
      assert.match(spoof.toolResults, /reviewer/)
      for (const task of batch.tasks) {
        await runCase(h, [[{ name: 'workflow_review_submit', input: { batchId: batch.batchId, taskId: task.id, verdict: 'pass' } }]], { agent: 'reviewer' })
      }
      await runCase(h, [[{ name: 'workflow_review', input: { action: 'close', batchId: batch.batchId } }]])
      assert.equal(batches(h)[0].status, 'closed')
      assert.ok(batches(h)[0].tasks.every(t => t.verdict === 'pass'))
    })

    await t.test('shell writes to protected paths are denied before running', async () => {
      const result = await runCase(h, [[{ name: 'shell', input: { command: 'mkdir -p vendor && echo x > vendor/a.js', workdir: h.directory } }]])
      assert.match(result.toolResults, /第三方/)
      assert.equal(existsSync(join(h.directory, 'vendor/a.js')), false)
    })

    await t.test('a native shell rule keeps the release script behind the gated entry', async () => {
      const result = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'shell', input: { command: 'cd . && node publish.mjs', workdir: h.directory } }]])
      assert.doesNotMatch(result.toolResults, /范围规则尚未进入/)
      assert.equal(existsSync(join(h.directory, '.opencode/workflow/.state/deployed')), false)
    })

    await t.test('release stays blocked until the candidate is approved and asks before its fixed entry', async () => {
      git(h, ['add', '.'])
      git(h, ['commit', '-qm', 'candidate'])
      const tree = git(h, ['rev-parse', 'HEAD^{tree}'])
      put(join(h.directory, '.opencode/workflow/.state/verify.log'), 'native fixture verification\n')
      put(join(h.directory, '.opencode/workflow/.state/evidence.json'), JSON.stringify({ version: 1, base: h.base, tree, entries: [{ id: 'native', units: ['core', 'tests'], kind: 'test', command: 'native fixture', cwd: '.', exit: 0, inputs: {}, files: ['.opencode/workflow/.state/verify.log'] }] }))
      const denied = await runCase(h, [[{ name: 'workflow_release', input: { entry: 'demo' } }]])
      assert.match(denied.toolResults, /release/)
      assert.equal(existsSync(join(h.directory, '.opencode/workflow/.state/deployed')), false)
      await runCase(h, [[{ name: 'workflow_review', input: { action: 'run', mode: 'release', base: h.base, evidence: '.opencode/workflow/.state/evidence.json' } }]])
      const batch = batches(h).find(b => b.mode === 'release')
      assert.ok(batch)
      for (const task of batch.tasks) await runCase(h, [[{ name: 'workflow_review_submit', input: { batchId: batch.batchId, taskId: task.id, verdict: 'pass' } }]], { agent: 'reviewer' })
      await runCase(h, [[{ name: 'workflow_review', input: { action: 'close', batchId: batch.batchId } }]])
      const accepted = await runCase(h, [[{ name: 'workflow_release', input: { entry: 'demo' } }]], { replies: ['once'] })
      assert.equal(accepted.permissions.length, 1)
      assert.equal(readFileSync(join(h.directory, '.opencode/workflow/.state/deployed'), 'utf8'), 'released\n')
      put(join(h.directory, '.opencode/workflow/.state/verify.log'), 'changed after approval')
      const stale = await runCase(h, [[{ name: 'workflow_review', input: { action: 'check' } }]])
      assert.match(stale.toolResults, /false/)
    })
    await t.test('commits inside OpenCode scan staged additions and block a synthetic secret', async () => {
      const head = git(h, ['rev-parse', 'HEAD'])
      const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
      put(join(h.directory, 'leak.txt'), `access_token = "${secret}"\n`)
      try {
        const result = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }],
          [{ name: 'shell', input: { command: 'git add leak.txt', workdir: h.directory } }],
          [{ name: 'shell', input: { command: 'git commit -m leak', workdir: h.directory } }]])
        assert.equal(git(h, ['rev-parse', 'HEAD']), head)
        assert.match(git(h, ['diff', '--cached', '--name-only']), /leak\.txt/)
        assert.match(result.toolResults, /凭据/)
        assert.ok(!result.toolResults.includes(secret))
      } finally {
        git(h, ['rm', '-q', '--cached', '--ignore-unmatch', 'leak.txt'])
        rmSync(join(h.directory, 'leak.txt'), { force: true })
      }
    })
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})
