import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { start, runCase, put, until } from './fixtures/native-harness.mjs'
import { superpowersDirectory, verifySuperpowers } from '../scripts/fetch-superpowers.mjs'
import { SUPERPOWERS_SOURCE, SUPERPOWERS_SPEC } from '../template/.opencode/plugins/workflow/onboarding-source.ts'

const choices = mode => ({ version: 2, mode, superpowers: mode === 'full' ? 'existing' : 'none', models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'inherit' } }, agents: [], existing: {}, components: { quality: 'off', ci: false, release: false, mcp: false } })
async function setupFixture({ mode, superpowers = false } = {}) {
  if (superpowers) assert.ok(verifySuperpowers(), '先运行 node scripts/fetch-superpowers.mjs 准备固定来源；缺失不能跳过验收')
  const h = await start({ prepare: directory => {
    const path = join(directory, 'opencode.jsonc'), config = JSON.parse(readFileSync(path, 'utf8'))
    for (const role of ['implementer', 'reviewer']) delete config.agents[role].model
    if (superpowers) config.plugins = [...config.plugins ?? [], superpowersDirectory]
    put(path, JSON.stringify(config))
    if (mode) put(join(directory, '.opencode/workflow/onboarding.json'), JSON.stringify(choices(mode)))
  } })
  if (superpowers) await until(async () => {
    const plugins = (await h.client.plugin.list({ location: h.location })).data
    return plugins.some(plugin => plugin.id === 'superpowers' && plugin.state.status === 'active') && (await h.client.skill.list({ location: h.location })).data.some(s => s.id === 'writing-plans')
  }, 'actual Superpowers plugin and skills')
  return h
}
function setupPayloads(result) {
  return result.requests.flatMap(request => (request.messages ?? []).filter(message => message.role === 'tool').flatMap(message => {
    try { const data = JSON.parse(message.content); return data && typeof data === 'object' ? [data] : [] } catch { return [] }
  }))
}
const setupResults = result => setupPayloads(result).filter(data => typeof data.ready === 'boolean')
const returnedPlan = result => {
  const plan = setupPayloads(result).findLast(data => typeof data.id === 'string' && Array.isArray(data.changes))
  assert.ok(plan, result.toolResults.slice(-4000))
  return plan
}
const readSkills = () => [[{ name: 'skill', input: { id: 'brainstorming' } }], [{ name: 'skill', input: { id: 'writing-plans' } }]]

test('fixed Superpowers skills are genuinely registered and returned by the native skill tool', { timeout: 180000 }, async () => {
  const h = await setupFixture({ superpowers: true })
  try {
    const registered = (await h.client.skill.list({ location: h.location })).data
    for (const id of ['brainstorming', 'writing-plans']) {
      const skill = registered.find(s => s.id === id)
      assert.equal(createHash('sha256').update(skill.content).digest('hex'), SUPERPOWERS_SOURCE.skills[id])
    }
    const result = await runCase(h, readSkills())
    assert.deepEqual(h.model.failures, [])
    for (const id of ['brainstorming', 'writing-plans']) assert.ok(result.toolResults.includes(registered.find(s => s.id === id).content.trim()))
  } finally { await h.close() }
})

test('full onboarding cannot finish from saved choices without actual Superpowers', { timeout: 180000 }, async () => {
  const h = await setupFixture({ mode: 'full' })
  try {
    const result = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.deepEqual(h.model.failures, [])
    assert.equal(setupResults(result).at(-1)?.ready, false)
    assert.match(result.toolResults, /Superpowers|superpowers/)
  } finally { await h.close() }
})

test('onboarding uses real native questions and cancellation does not create choices', { timeout: 180000 }, async () => {
  const h = await setupFixture()
  const question = { name: 'question', input: { questions: [{ header: '接入模式', question: '选择完整流程还是基础保护？', options: [{ label: '完整流程', description: '需要 Superpowers' }, { label: '基础保护', description: '不要求额外技能' }] }] } }
  try {
    const selected = await runCase(h, [[question], [{ name: 'workflow_setup', input: { action: 'status' } }]], {
      formReplies: [form => {
        const field = form.fields[0]
        return { [field.key]: field.options.find(option => option.label === '基础保护').value }
      }],
    })
    assert.equal(selected.forms.length, 1)
    assert.match(selected.toolResults, /基础保护/)
    assert.equal(setupResults(selected).at(-1)?.ready, false)
    const cancelled = await runCase(h, [[question]], { formReplies: [null] })
    assert.equal(cancelled.forms.length, 1)
    assert.equal(existsSync(join(h.directory, '.opencode/workflow/onboarding.json')), false)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('full onboarding requires both actual skill reads in the finishing session', { timeout: 180000 }, async () => {
  const h = await setupFixture({ mode: 'full', superpowers: true })
  try {
    const listed = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'status' } }], [{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.equal(setupResults(listed).at(-1)?.ready, false)
    const completed = await runCase(h, [...readSkills(), [{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.equal(setupResults(completed).at(-1)?.ready, true, JSON.stringify(setupResults(completed).at(-1)?.issues))
    const otherSession = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.equal(setupResults(otherSession).at(-1)?.ready, false)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('full onboarding invalidates reads after real compaction moves and reload in one session', { timeout: 180000 }, async () => {
  const h = await setupFixture({ mode: 'full', superpowers: true })
  try {
    const session = await h.client.session.create({ agent: 'build', model: { providerID: 'openai', id: 'gpt-fixture' }, location: h.location })
    const verifyCall = [{ name: 'workflow_setup', input: { action: 'verify' } }]
    const drive = async calls => setupResults(await runCase(h, calls, { session })).at(-1)
    assert.equal((await drive([...readSkills(), verifyCall])).ready, true)
    assert.ok((await h.client.session.context({ sessionID: session.id })).some(message => message.type === 'user'))
    await h.client.session.compact({ sessionID: session.id })
    await h.client.session.wait({ sessionID: session.id })
    assert.equal((await drive([verifyCall])).ready, false)
    assert.equal((await drive([...readSkills(), verifyCall])).ready, true)
    await h.client.session.move({ sessionID: session.id, directory: join(h.temp, 'elsewhere') })
    await h.client.session.wait({ sessionID: session.id })
    await h.client.session.move({ sessionID: session.id, directory: h.directory })
    await h.client.session.wait({ sessionID: session.id })
    assert.equal((await drive([verifyCall])).ready, false)
    assert.equal((await drive([...readSkills(), verifyCall])).ready, true)
    await h.client.location.reload()
    await until(async () => (await h.client.plugin.list({ location: h.location })).data.some(plugin => plugin.id === 'superpowers' && plugin.state.status === 'active'), 'Superpowers active after session reload')
    assert.equal((await drive([verifyCall])).ready, false)
    assert.equal((await drive([...readSkills(), verifyCall])).ready, true)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('basic onboarding needs native approval and reviewers cannot install', { timeout: 180000 }, async () => {
  const h = await setupFixture()
  try {
    const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: choices('basic') } }]]))
    const config = readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8')
    const denied = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['reject'] })
    assert.ok(denied.permissions.length > 0)
    assert.equal(existsSync(join(h.directory, '.opencode/workflow/onboarding.json')), false)
    assert.equal(readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8'), config)
    const applied = await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['once', 'once', 'once'] })
    assert.ok(applied.permissions.length > 0)
    await h.client.location.reload()
    const finished = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.equal(setupResults(finished).at(-1)?.ready, true, JSON.stringify(setupResults(finished).at(-1)?.issues))
    assert.deepEqual(JSON.parse(readFileSync(join(h.directory, '.opencode/workflow/onboarding.json'), 'utf8')), choices('basic'))
    const reviewer = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'bootstrap', scope: 'global' } }]], { agent: 'reviewer' })
    assert.match(reviewer.toolResults, /审核员只读|reviewer.*拒绝/)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('applying through the onboarding CLI in shell needs its own native approval', { timeout: 180000 }, async () => {
  const h = await setupFixture()
  try {
    const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: choices('basic') } }]]))
    const profile = join(h.directory, '.opencode/workflow/onboarding.json')
    const cli = () => [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'shell', input: { command: `node scripts/workflow/onboarding.mjs apply --plan ${plan.id} --confirm ${plan.id}`, workdir: h.directory } }]]
    const denied = await runCase(h, cli(), { replies: ['reject'] })
    assert.deepEqual(denied.permissions.map(request => request.action), ['shell'], denied.toolResults.slice(-800))
    assert.equal(existsSync(profile), false)
    const approved = await runCase(h, cli(), { replies: ['once'] })
    assert.deepEqual(approved.permissions.map(request => request.action), ['shell'], approved.toolResults.slice(-800))
    assert.deepEqual(JSON.parse(readFileSync(profile, 'utf8')), choices('basic'))
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('native setup applies the same invalid-config ban as patch and leaves agent models and profile untouched', { timeout: 180000 }, async () => {
  const h = await setupFixture()
  try {
    const agentFile = join(h.directory, '.opencode/agents/reviewer.md')
    const original = readFileSync(agentFile, 'utf8').replace('mode: subagent', 'mode: subagent\nmodel: openai/gpt-fixture')
    put(agentFile, original)
    put(join(h.directory, 'AGENTS.md'), 'x'.repeat(40_001))
    const ordinary = await runCase(h, [[{ name: 'patch', input: { patchText: '*** Begin Patch\n*** Update File: .opencode/agents/reviewer.md\n@@\n-model: openai/gpt-fixture\n*** End Patch' } }]])
    assert.match(ordinary.toolResults, /工作流配置无效/)
    const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: choices('basic') } }]]))
    const denied = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['once', 'once', 'once'] })
    assert.ok(denied.permissions.length > 0)
    assert.match(setupResults(denied).at(-1)?.issues.join(' '), /工作流配置无效/)
    assert.equal(readFileSync(agentFile, 'utf8'), original)
    assert.equal(existsSync(join(h.directory, '.opencode/workflow/onboarding.json')), false)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('native setup requires actual plan domain rules in context and succeeds only on explicit retry', { timeout: 180000 }, async () => {
  const h = await setupFixture()
  try {
    const rule = '接入代理领域必须保留只读审核权限。'
    const agentFile = join(h.directory, '.opencode/agents/reviewer.md')
    const original = readFileSync(agentFile, 'utf8').replace('mode: subagent', 'mode: subagent\nmodel: openai/gpt-fixture')
    put(agentFile, original)
    put(join(h.directory, '.opencode/agents/AGENTS.md'), rule)
    const mapping = join(h.directory, '.opencode/workflow/scopes.json')
    put(mapping, JSON.stringify([...JSON.parse(readFileSync(mapping, 'utf8')), { paths: ['.opencode/agents/**'], instruction: '.opencode/agents/AGENTS.md' }]))
    const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: choices('basic') } }]]))
    const session = await h.client.session.create({ agent: 'build', model: { providerID: 'openai', id: 'gpt-fixture' }, location: h.location })
    const apply = [{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]
    const denied = await runCase(h, [apply], { session, replies: ['once', 'once', 'once'] })
    assert.match(setupResults(denied).at(-1)?.issues.join(' '), /范围规则尚未进入本轮上下文/)
    assert.equal(readFileSync(agentFile, 'utf8'), original)
    assert.equal(existsSync(join(h.directory, '.opencode/workflow/onboarding.json')), false)
    const applied = await runCase(h, [apply], { session, replies: ['once', 'once', 'once'] })
    assert.equal(setupResults(applied).at(-1)?.applied, true, applied.toolResults)
    assert.ok(JSON.stringify(applied.requests).includes(rule))
    assert.equal(readFileSync(agentFile, 'utf8'), original.replace('model: openai/gpt-fixture\n', ''))
    assert.deepEqual(JSON.parse(readFileSync(join(h.directory, '.opencode/workflow/onboarding.json'), 'utf8')), choices('basic'))
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('setup approval does not bypass project edit protection', { timeout: 180000 }, async () => {
  const h = await start({ prepare: directory => {
    const policyFile = join(directory, '.opencode/workflow/protection.json'), policy = JSON.parse(readFileSync(policyFile, 'utf8'))
    policy.rules.push({ id: 'native-config', actions: ['edit'], paths: ['opencode.jsonc'], effect: 'deny', reason: '配置变更由维护者处理' })
    put(policyFile, JSON.stringify(policy))
    const file = join(directory, 'opencode.jsonc'), config = JSON.parse(readFileSync(file, 'utf8'))
    config.permissions.push({ action: 'edit', resource: 'opencode.jsonc', effect: 'deny' })
    put(file, JSON.stringify(config))
  } })
  try {
    const original = readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8')
    const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'bootstrap', scope: 'project' } }]]))
    await runCase(h, [[{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['once', 'once', 'once'] })
    assert.equal(readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8'), original)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('guided setup can change a role from inherited to fixed and back through approved plans', { timeout: 180000 }, async () => {
  const h = await setupFixture({ mode: 'basic' })
  try {
    for (const policy of [{ mode: 'fixed', model: 'openai/gpt-fixture' }, { mode: 'inherit' }]) {
      const selected = { ...choices('basic'), models: { implementer: { mode: 'inherit' }, reviewer: policy } }
      const plan = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: selected } }]]))
      await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['once', 'once', 'once'] })
      await h.client.location.reload()
      await until(async () => (await h.client.agent.list({ location: h.location })).data.some(agent => agent.id === 'reviewer' && agent.mode === 'subagent' && (policy.mode === 'fixed' ? agent.model?.id === 'gpt-fixture' : !agent.model)), 'approved reviewer policy effective')
      const verified = setupResults(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'verify' } }]])).at(-1)
      assert.equal(verified?.ready, true, JSON.stringify(verified?.issues))
      assert.deepEqual(JSON.parse(readFileSync(join(h.directory, '.opencode/workflow/onboarding.json'), 'utf8')).models.reviewer, policy)
    }
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('guided model policies distinguish fixed models inheritance and ignored agents', { timeout: 180000 }, async () => {
  const h = await setupFixture({ mode: 'basic' })
  try {
    const profile = join(h.directory, '.opencode/workflow/onboarding.json'), configFile = join(h.directory, 'opencode.jsonc')
    const config = JSON.parse(readFileSync(configFile, 'utf8')), originalMain = config.model
    const verify = async () => setupResults(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'verify' } }]])).at(-1)
    const fixed = { ...choices('basic'), models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'fixed', model: 'openai/gpt-fixture' } } }
    put(profile, JSON.stringify(fixed))
    assert.equal((await verify()).ready, false)
    config.agents.reviewer.model = 'openai/gpt-fixture'
    put(configFile, JSON.stringify(config))
    await h.client.location.reload()
    await until(async () => (await h.client.agent.list({ location: h.location })).data.some(agent => agent.id === 'reviewer' && agent.model?.id === 'gpt-fixture'), 'fixed reviewer model effective')
    const selected = await verify()
    assert.equal(selected.ready, true, JSON.stringify(selected.issues))
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).model, originalMain)
    put(profile, JSON.stringify(choices('basic')))
    const overridden = await verify()
    assert.equal(overridden.ready, false)
    assert.match(JSON.stringify(overridden.issues), /继承/)
    delete config.agents.reviewer.model
    put(configFile, JSON.stringify(config))
    const agentFile = join(h.directory, '.opencode/agents/reviewer.md')
    put(agentFile, readFileSync(agentFile, 'utf8').replace('mode: subagent', 'mode: subagent\nmodel: ""'))
    await h.client.location.reload()
    const ignored = await verify()
    assert.equal(ignored.ready, false)
    assert.match(JSON.stringify(ignored.issues), /reviewer/)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})

test('guided setup installs the real pinned package before accepting a full configuration', { timeout: 300000 }, async () => {
  const h = await setupFixture(), full = { ...choices('full'), superpowers: 'project' }
  try {
    const bootstrap = returnedPlan(await runCase(h, [[{ name: 'workflow_setup', input: { action: 'bootstrap', scope: 'project' } }]]))
    assert.ok(!readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8').includes(SUPERPOWERS_SPEC))
    await runCase(h, [[{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'workflow_setup', input: { action: 'apply', planID: bootstrap.id } }]], { replies: ['once', 'once', 'once'] })
    assert.ok(readFileSync(join(h.directory, 'opencode.jsonc'), 'utf8').includes(SUPERPOWERS_SPEC))
    await h.client.location.reload()
    await until(async () => {
      const plugins = (await h.client.plugin.list({ location: h.location })).data
      return plugins.some(plugin => plugin.id === 'superpowers' && plugin.state.status === 'active') && (await h.client.skill.list({ location: h.location })).data.some(skill => skill.id === 'writing-plans')
    }, 'pinned package installed by setup', 120000)
    const plugin = (await h.client.plugin.list({ location: h.location })).data.find(p => p.id === 'superpowers')
    assert.equal(plugin?.state.status, 'active')
    assert.equal(plugin?.source.type, 'package')
    assert.equal(plugin?.source.target, SUPERPOWERS_SPEC)
    const blocked = await runCase(h, [[{ name: 'workflow_setup', input: { action: 'plan', choices: full } }]])
    assert.ok(!setupPayloads(blocked).some(data => typeof data.id === 'string' && Array.isArray(data.changes)))
    const plan = returnedPlan(await runCase(h, [...readSkills(), [{ name: 'workflow_setup', input: { action: 'plan', choices: full } }]]))
    await runCase(h, [...readSkills(), [{ name: 'read', input: { path: 'AGENTS.md' } }], [{ name: 'workflow_setup', input: { action: 'apply', planID: plan.id } }]], { replies: ['once', 'once', 'once'] })
    await h.client.location.reload()
    await until(async () => (await h.client.plugin.list({ location: h.location })).data.some(plugin => plugin.id === 'superpowers' && plugin.state.status === 'active'), 'Superpowers active after configuration reload')
    const finished = await runCase(h, [...readSkills(), [{ name: 'workflow_setup', input: { action: 'finish' } }]])
    assert.equal(setupResults(finished).at(-1)?.ready, true, JSON.stringify(setupResults(finished).at(-1)?.issues))
    assert.deepEqual(JSON.parse(readFileSync(join(h.directory, '.opencode/workflow/onboarding.json'), 'utf8')), full)
    assert.deepEqual(h.model.failures, [])
  } finally { await h.close() }
})
