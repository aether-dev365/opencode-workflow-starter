import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { start, runCase, put, git, batches, baseline } from './fixtures/native-harness.mjs'

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

test('原生补丁接受缩进与 CRLF 时路径检查不遗漏目标', { timeout: 180000 }, async () => {
  const h = await start({ prepare: directory => {
    put(join(directory, 'src/padded.txt'), 'before\n')
    put(join(directory, 'src/context.txt'), '*** Update File: vendor/not-a-target\nbefore\n')
    put(join(directory, 'vendor/padded.txt'), 'protected\n')
  } })
  try {
    const update = { name: 'patch', input: { patchText: '\uFEFF  *** Begin Patch\r\n\t*** Update File: src/padded.txt \t\r\n@@\r\n-before\r\n+after\r\n*** End Patch  \r\n' } }
    const allowed = await runCase(h, [[update], [update]])
    assert.match(allowed.toolResults, /上下文/)
    assert.equal(readFileSync(join(h.directory, 'src/padded.txt'), 'utf8'), 'after\n')
    assert.ok(allowed.requests.some(request => JSON.stringify(request.messages).includes('NATIVE_DOMAIN_RULE')))
    const contextPatch = { name: 'patch', input: { patchText: '*** Begin Patch\n  *** Update File: src/context.txt\n@@\n *** Update File: vendor/not-a-target\n-before\n+after\n*** End Patch' } }
    await runCase(h, [[contextPatch], [contextPatch]])
    assert.equal(readFileSync(join(h.directory, 'src/context.txt'), 'utf8'), '*** Update File: vendor/not-a-target\nafter\n')
    const separatorPath = 'src/line\u2028separator.txt'
    const separatorPatch = patch(separatorPath, 'separator output')
    await runCase(h, [[separatorPatch], [separatorPatch]])
    assert.equal(readFileSync(join(h.directory, separatorPath), 'utf8'), 'separator output\n')
    const refused = await runCase(h, [[{ name: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: partial-padded.txt\n+x\n  *** Update File: vendor/padded.txt\r\n@@\n-protected\n+changed\n*** End Patch' } }]])
    assert.match(refused.toolResults, /文件保护检查拒绝/)
    assert.equal(existsSync(join(h.directory, 'partial-padded.txt')), false)
    assert.equal(readFileSync(join(h.directory, 'vendor/padded.txt'), 'utf8'), 'protected\n')
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('原生 shell 创建拒绝 Bash 以外的解释器', { timeout: 180000 }, async () => {
  const h = await start({ prepare: directory => {
    const file = join(directory, 'opencode.jsonc')
    put(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), shell: '/bin/sh' }))
  } })
  try {
    const call = { name: 'shell', input: { command: 'echo marker > unsupported-shell.txt', workdir: h.directory } }
    const result = await runCase(h, [[call], [call]])
    assert.equal(existsSync(join(h.directory, 'unsupported-shell.txt')), false)
    assert.match(result.toolResults, /仅支持 Bash.*已拒绝执行/)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('a reviewer whose agent file OpenCode ignores stays read-only', { timeout: 180000 }, async t => {
  // 空的 model 让 OpenCode 忽略整个 reviewer.md；夹具的 opencode.jsonc 仍定义 agents.reviewer，reviewer 于是退回默认权限。
  const h = await start({ prepare: directory => {
    const file = join(directory, '.opencode/agents/reviewer.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('mode: subagent', 'mode: subagent\nmodel: ""'))
  } })
  try {
    await t.test('reviewer edits and shell commands are denied', async () => {
      const result = await runCase(h, [[patch('reviewer-probe.txt', 'x')], [patch('reviewer-probe.txt', 'x')],
        [{ name: 'shell', input: { command: 'echo $((40+2))MARK', workdir: h.directory } }]], { agent: 'reviewer' })
      assert.equal(existsSync(join(h.directory, 'reviewer-probe.txt')), false)
      assert.doesNotMatch(result.toolResults, /42MARK/)
      assert.match(result.toolResults, /审核员只读/)
    })

    await t.test('shell statements without a command and workflow tools are denied too', async () => {
      // 即使原生权限判定没有触发，工具调用前的只读限制也必须生效。
      const arithmetic = `x='a[$(echo $((40+2))ARITH > reviewer-arith.txt)]'; y=$((x))`
      const result = await runCase(h, [
        [{ name: 'shell', input: { command: '> reviewer-redirect.txt', workdir: h.directory } }],
        [{ name: 'shell', input: { command: arithmetic, workdir: h.directory } }],
        [{ name: 'shell', input: { command: arithmetic, workdir: h.directory } }],
        [{ name: 'workflow_review', input: { action: 'status' } }],
      ], { agent: 'reviewer' })
      assert.equal(existsSync(join(h.directory, 'reviewer-redirect.txt')), false)
      assert.equal(existsSync(join(h.directory, 'reviewer-arith.txt')), false)
      assert.doesNotMatch(result.toolResults, /没有审核批次/)
      assert.match(result.toolResults, /审核员只读/)
    })

    await t.test('OpenCode does not dispatch the ignored reviewer as a subagent', async () => {
      // 只有直接创建的 reviewer 会话会遇到这种情况；子代理派发在 OpenCode 这一层就被拒绝。
      const result = await runCase(h, [[{ name: 'subagent', input: { agent: 'reviewer', description: 'probe', prompt: 'probe' } }]])
      assert.match(result.toolResults, /cannot run as a subagent/)
    })

    await t.test('a review cannot start without a loaded reviewer', async () => {
      writeFileSync(join(h.directory, 'review-probe.txt'), 'x\n')
      const result = await runCase(h, [[{ name: 'workflow_review', input: { action: 'run', mode: 'branch', base: h.base } }]])
      assert.match(result.toolResults, /reviewer 没有正确加载/)
      assert.equal(batches(h).length, 0)
    })
  } finally { await h.close() }
})

test('a commit made through OpenCode shows the quality hook report', { timeout: 180000 }, async () => {
  const scripts = readdirSync('optional/quality').filter(name => name.endsWith('.py') && !name.startsWith('test_') && name !== 'quality_testing.py')
  const h = await start({ prepare: directory => {
    for (const name of scripts) put(join(directory, 'scripts/quality', name), readFileSync(join('optional/quality', name), 'utf8'))
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
    put(join(directory, 'scripts/quality/fake-format.py'), 'print("FORMAT_PROBE")\nraise SystemExit(1)\n')
    put(join(directory, 'scripts/quality/quality.json'), JSON.stringify({ version: 1, formats: [
      { id: 'probe', paths: ['tests/quality-probe.test.js'], check: [python, 'scripts/quality/fake-format.py', '{files}'] },
    ] }))
  } })
  try {
    const empty = join(h.temp, 'empty-gitconfig')
    writeFileSync(empty, '')
    execFileSync('python3', [join(h.directory, 'scripts/quality/install-hooks.py')], { cwd: h.directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' } })
    const head = git(h, ['rev-parse', 'HEAD'])
    put(join(h.directory, 'tests/quality-probe.test.js'), '// Task 3: probe\nit.skip("probe", () => {})\n')
    put(join(h.directory, 'docs/quality-probe.md'), '[probe](missing-quality-target.md)\n')
    const result = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }],
      [{ name: 'shell', input: { command: 'git add tests/quality-probe.test.js docs/quality-probe.md', workdir: h.directory } }],
      [{ name: 'shell', input: { command: 'git commit -m probe', workdir: h.directory } }]])
    assert.notEqual(git(h, ['rev-parse', 'HEAD']), head)
    assert.match(result.toolResults, /质量检查（提交已完成/)
    assert.match(result.toolResults, /tests\/quality-probe\.test\.js:1: \[tracking\]/)
    assert.match(result.toolResults, /tests\/quality-probe\.test\.js:2: \[skip\]/)
    assert.match(result.toolResults, /docs\/quality-probe\.md:1: \[link\]/)
    assert.match(result.toolResults, /格式检查 \[probe\].*未通过/)
    assert.match(result.toolResults, /FORMAT_PROBE/)
    const positions = ['[tracking]', '[skip]', '[link]', '格式检查 [probe] 未通过'].map(text => result.toolResults.indexOf(text))
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test(`OpenCode ${baseline} executes the isolated workflow through real native boundaries`, { timeout: 180000 }, async t => {
  const h = await start()
  try {
    await t.test('ordinary shell commands with options run while the server starts elsewhere', async () => {
      const result = await runCase(h, [[{ name: 'shell', input: { command: 'ls -la && git status --short', workdir: h.directory } }]])
      assert.doesNotMatch(result.toolResults, /文件保护检查拒绝/)
      assert.match(result.toolResults, /AGENTS\.md/)
    })
    await t.test('a relative workdir resolves against the location', async () => {
      const result = await runCase(h, [[{ name: 'shell', input: { command: 'ls', workdir: 'src' } }]])
      assert.doesNotMatch(result.toolResults, /检查输入不完整/)
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
    await t.test('shell heredoc writes load domain rules too', async () => {
      const heredoc = { name: 'shell', input: { command: "cat > src/heredoc.txt <<'EOF'\nheredoc output\nEOF", workdir: h.directory } }
      const result = await runCase(h, [[heredoc], [heredoc]])
      assert.match(result.toolResults, /上下文/)
      assert.equal(readFileSync(join(h.directory, 'src/heredoc.txt'), 'utf8'), 'heredoc output\n')
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

    await t.test('a reviewer dispatched through the subagent tool submits verdicts but cannot write', async () => {
      // 实际审核时 build 用 subagent 工具派发 reviewer：子会话能提交结论，写入和 shell 仍然写不进去。
      await runCase(h, [[{ name: 'workflow_review', input: { action: 'run', mode: 'branch', base: h.base } }]])
      const batch = batches(h)[0]
      assert.equal(batch.status, 'open')
      const child = randomUUID().replaceAll('-', '')
      h.model.enqueue(child, [[patch('reviewer-subagent.txt', 'x')],
        [{ name: 'shell', input: { command: 'echo x > reviewer-subagent-shell.txt', workdir: h.directory } }],
        ...batch.tasks.map(task => [{ name: 'workflow_review_submit', input: { batchId: batch.batchId, taskId: task.id, verdict: 'pass' } }])], true)
      const result = await runCase(h, [[{ name: 'subagent', input: { agent: 'reviewer', description: 'review probe', prompt: 'RUNTIME_CASE:' + child } }]])
      assert.equal(h.model.remaining(child), 0)
      // 子会话的写入和 shell 由插件的只读检查拒绝，不依赖 reviewer.md 的权限。
      assert.match(result.toolResults, /审核员只读[^"]*已拒绝 patch/)
      assert.match(result.toolResults, /审核员只读[^"]*已拒绝 shell/)
      assert.equal(existsSync(join(h.directory, 'reviewer-subagent.txt')), false)
      assert.equal(existsSync(join(h.directory, 'reviewer-subagent-shell.txt')), false)
      assert.ok(batches(h).find(b => b.batchId === batch.batchId).tasks.every(task => task.verdict === 'pass'))
      await runCase(h, [[{ name: 'workflow_review', input: { action: 'close', batchId: batch.batchId } }]])
    })

    await t.test('shell writes to protected paths are denied before running', async () => {
      const result = await runCase(h, [[{ name: 'shell', input: { command: 'mkdir -p vendor && echo x > vendor/a.js', workdir: h.directory } }]])
      assert.match(result.toolResults, /第三方/)
      assert.equal(existsSync(join(h.directory, 'vendor/a.js')), false)
    })

    await t.test('a native shell rule keeps the release script behind the gated entry', async () => {
      mkdirSync(join(h.directory, '.opencode/workflow/.state'), { recursive: true })
      const result = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'shell', input: { command: 'cd . && node publish.mjs', workdir: h.directory } }]])
      assert.doesNotMatch(result.toolResults, /范围规则尚未进入/)
      assert.equal(existsSync(join(h.directory, '.opencode/workflow/.state/deployed')), false)
      const command = "x='a[$(node publish.mjs)]'; y=$((x))"
      for (const agent of ['build', 'implementer']) {
        const hidden = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }],
          [{ name: 'shell', input: { command, workdir: h.directory } }]], { agent })
        assert.equal(existsSync(join(h.directory, '.opencode/workflow/.state/deployed')), false)
        assert.match(hidden.toolResults, /文件保护检查拒绝.*无法静态检查.*直接的命令/)
      }
    })

    await t.test('release stays blocked until the candidate is approved and asks before its fixed entry', async () => {
      git(h, ['add', '.'])
      git(h, ['commit', '-qm', 'candidate'])
      const tree = git(h, ['rev-parse', 'HEAD^{tree}'])
      put(join(h.directory, '.opencode/workflow/.state/verify.log'), 'native fixture verification\n')
      put(join(h.directory, '.opencode/workflow/.state/evidence.json'), JSON.stringify({ version: 1, base: h.base, tree, entries: [{ id: 'native', units: ['core', 'tests', 'sync'], kind: 'test', command: 'native fixture', cwd: '.', exit: 0, inputs: {}, files: ['.opencode/workflow/.state/verify.log'] }] }))
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
