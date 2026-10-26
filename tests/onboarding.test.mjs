import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { essentialEnv } from './fixtures/env.mjs'
import { SUPERPOWERS_SPEC } from '../template/.opencode/plugins/workflow/onboarding-source.ts'

const basic = { version: 2, mode: 'basic', superpowers: 'none', models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'inherit' } }, agents: [], existing: {}, components: { quality: 'off', ci: false, release: false, mcp: false } }
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'workflow-onboarding-cli-')), root = join(temp, '接入 project'), home = join(temp, 'home')
  mkdirSync(home)
  cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
  cpSync('template/.opencode/plugins/workflow/node_modules', join(root, '.opencode/plugins/workflow/node_modules'), { recursive: true })
  writeFileSync(join(temp, 'gitconfig'), '')
  const env = { ...essentialEnv(), PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PYTHONDONTWRITEBYTECODE: '1' }
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', root], { env })
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const write = (path, value) => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target }
  const cli = (...args) => spawnSync(process.execPath, ['scripts/workflow/onboarding.mjs', ...args, '--root', root], { cwd: root, env, encoding: 'utf8', timeout: 30000 })
  const data = result => { assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout) }
  return { root, home, write, cli, data }
}

test('onboarding CLI starts unverified and never treats missing or invalid confirmation as approval', t => {
  const f = fixture(t), config = join(f.root, 'opencode.jsonc'), original = readFileSync(config, 'utf8')
  const status = f.data(f.cli('status'))
  assert.equal(status.choices, null)
  assert.equal(status.runtimeVerified, false)
  assert.equal(f.cli('bootstrap').status, 2)
  const plan = f.data(f.cli('bootstrap', '--scope', 'project'))
  assert.match(plan.id, /^[a-f0-9]{64}$/)
  assert.equal(readFileSync(config, 'utf8'), original)
  for (const args of [['apply', '--plan', plan.id], ['apply', '--plan', plan.id, '--confirm', 'no'], ['apply', '--plan', plan.id, '--confirm', plan.id, '--verified']]) {
    assert.equal(f.cli(...args).status, 2)
    assert.equal(readFileSync(config, 'utf8'), original)
  }
  assert.equal(existsSync(join(f.home, '.config/opencode/opencode.jsonc')), false)
})

test('onboarding CLI applies only the confirmed preview and repeats without duplicate plugins', t => {
  const f = fixture(t)
  const plan = f.data(f.cli('bootstrap', '--scope', 'project'))
  assert.equal(f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id)).applied, true)
  const config = join(f.root, 'opencode.jsonc'), first = readFileSync(config, 'utf8')
  assert.ok(first.includes(SUPERPOWERS_SPEC))
  const repeated = f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  assert.equal(repeated.applied, false)
  assert.deepEqual(repeated.changed, [])
  assert.equal(readFileSync(config, 'utf8'), first)
})

test('onboarding CLI refuses a stale preview without overwriting the new user edit', t => {
  const f = fixture(t), config = join(f.root, 'opencode.jsonc')
  const plan = f.data(f.cli('bootstrap', '--scope', 'project'))
  const changed = readFileSync(config, 'utf8') + '\n// user change\n'
  writeFileSync(config, changed)
  const denied = f.cli('apply', '--plan', plan.id, '--confirm', plan.id)
  assert.equal(denied.status, 2)
  assert.equal(JSON.parse(denied.stdout).ok, false)
  assert.equal(readFileSync(config, 'utf8'), changed)
})

test('onboarding CLI records basic choices without installing Superpowers or claiming runtime verification', t => {
  const f = fixture(t), answers = f.write('.opencode/workflow/.state/onboarding/answers.json', basic)
  const plan = f.data(f.cli('plan', '--answers', answers))
  f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.opencode/workflow/onboarding.json'), 'utf8')), basic)
  assert.ok(!readFileSync(join(f.root, 'opencode.jsonc'), 'utf8').includes(SUPERPOWERS_SPEC))
  const status = f.data(f.cli('status'))
  assert.deepEqual(status.choices, basic)
  assert.equal(status.runtimeVerified, false)
})

test('onboarding CLI asks to upgrade version 1 answers instead of filling defaults', t => {
  const f = fixture(t), { agents, existing, ...rest } = basic
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', { ...rest, version: 1 })
  const result = f.cli('plan', '--answers', answers)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /version 2.*agents.*existing/)
})

test('onboarding CLI lists existing AI configuration and records decisions only through a confirmed plan', t => {
  const f = fixture(t)
  f.write('CLAUDE.md', '# rules\n')
  assert.deepEqual(f.data(f.cli('status')).existing?.undecided, ['CLAUDE.md'])
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', basic), undecided = f.cli('plan', '--answers', answers)
  assert.equal(undecided.status, 2)
  assert.match(JSON.parse(undecided.stdout).error, /尚未决定的既有 AI 配置：CLAUDE\.md/)
  f.write('.opencode/workflow/.state/onboarding/answers.json', { ...basic, existing: { 'CLAUDE.md': 'keep' } })
  const plan = f.data(f.cli('plan', '--answers', answers))
  f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  const status = f.data(f.cli('status'))
  assert.deepEqual([status.existing.items[0].decision, status.existing.undecided], ['keep', []])
})

test('onboarding CLI previews and writes a generated implementation subagent', t => {
  const f = fixture(t), agent = { name: 'web-implementer', description: '负责 web 前端', focus: '先读 web/AGENTS.md。', model: { mode: 'inherit' } }
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', { ...basic, agents: [agent] })
  const plan = f.data(f.cli('plan', '--answers', answers))
  assert.equal(plan.agents?.[0]?.operation, 'create')
  assert.ok(plan.agents[0].text.includes('主代理负责最终集成和提交。'))
  f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  assert.equal(readFileSync(join(f.root, '.opencode/agents/web-implementer.md'), 'utf8'), plan.agents[0].text)
})

test('onboarding CLI never echoes unknown arguments or embedded credential values', t => {
  const f = fixture(t), marker = ['private', 'argument', 'marker'].join('-')
  for (const args of [['status', '--api-key=' + marker], ['status', marker], ['apply', '--credential=' + marker]]) {
    const result = f.cli(...args)
    assert.equal(result.status, 2)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker))
    assert.match(JSON.parse(result.stdout).error, /未知参数/)
  }
})

test('onboarding CLI rejects directories instead of treating them as an answers stream', t => {
  const f = fixture(t), result = f.cli('plan', '--answers', f.root)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /常规文件/)
})

test('onboarding CLI rejects oversized choice files before generating a plan', t => {
  const f = fixture(t), value = { ...basic, models: { ...basic.models, reviewer: { mode: 'fixed', model: 'provider/' + 'x'.repeat(1024 * 1024) } } }
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', value)
  const result = f.cli('plan', '--answers', answers)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /过大|64 KiB/)
})

test('onboarding CLI rejects invalid UTF-8 rather than changing a selected model', t => {
  const f = fixture(t), value = { ...basic, models: { ...basic.models, reviewer: { mode: 'fixed', model: 'provider/MARK' } } }
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', value)
  const raw = readFileSync(answers), start = raw.indexOf('MARK')
  writeFileSync(answers, Buffer.concat([raw.subarray(0, start), Buffer.from([255]), raw.subarray(start + 4)]))
  const result = f.cli('plan', '--answers', answers)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).error, /UTF-8/)
})

test('onboarding CLI does not echo an invalid answers file into diagnostics', t => {
  const f = fixture(t), answers = f.write('.opencode/workflow/.state/onboarding/answers.json', 'private-input-marker')
  const result = f.cli('plan', '--answers', answers)
  assert.equal(result.status, 2)
  assert.doesNotMatch(result.stdout + result.stderr, /private-input/)
  assert.match(JSON.parse(result.stdout).error, /JSON/)
})

test('onboarding installs a working hook from a CRLF source checkout', t => {
  const f = fixture(t), source = join(dirname(f.root), 'suite')
  cpSync('template', join(source, 'template'), { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
  cpSync('optional', join(source, 'optional'), { recursive: true, filter: p => !p.split(/[\\/]/).includes('__pycache__') })
  for (const name of ['README.md', 'ADOPT.md']) cpSync(name, join(source, name))
  const installer = join(source, 'optional/quality/install-hooks.py')
  writeFileSync(installer, readFileSync(installer, 'utf8').replace(/\r?\n/g, '\r\n'))
  const answers = f.write('.opencode/workflow/.state/onboarding/answers.json', { ...basic, components: { ...basic.components, quality: 'hook' } })
  const plan = f.data(f.cli('plan', '--answers', answers, '--source', source))
  const applied = f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  assert.equal(applied.applied, true)
  const status = f.data(f.cli('status'))
  assert.equal(status.components.quality.status, 'configured')
  assert.ok(readFileSync(join(f.root, '.git/hooks/post-commit'), 'utf8').startsWith('#!/bin/sh\n'))
})

test('onboarding CLI requires the CI dependency and copies quality without forcing a local hook', t => {
  const f = fixture(t), answers = f.write('.opencode/workflow/.state/onboarding/answers.json', { ...basic, components: { ...basic.components, ci: true } })
  assert.equal(f.cli('plan', '--answers', answers, '--source', resolve('.')).status, 2)
  f.write('.opencode/workflow/.state/onboarding/answers.json', { ...basic, components: { ...basic.components, quality: 'checks', ci: true } })
  const plan = f.data(f.cli('plan', '--answers', answers, '--source', resolve('.')))
  f.data(f.cli('apply', '--plan', plan.id, '--confirm', plan.id))
  assert.equal(readFileSync(join(f.root, 'scripts/quality/check-skips.py'), 'utf8'), readFileSync('optional/quality/check-skips.py', 'utf8'))
  assert.equal(readFileSync(join(f.root, '.github/workflows/workflow-checks.yml'), 'utf8'), readFileSync('optional/ci/workflow-checks.yml', 'utf8'))
  assert.equal(existsSync(join(f.root, '.git/hooks/post-commit')), false)
})
