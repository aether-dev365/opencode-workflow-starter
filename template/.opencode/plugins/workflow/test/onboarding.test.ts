import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fixture, before, context, load } from './fixture.ts'
import { type SetupChoices } from '../onboarding-config.ts'
import { planSetup } from '../onboarding-files.ts'
import { SUPERPOWERS_SPEC } from '../onboarding-source.ts'
import { agentText } from '../onboarding-agents.ts'
import { verifySuperpowers, SkillEvidence, checkModels, runSetupDoctor, probeSetupRuntime, type SourceSnapshot } from '../onboarding-runtime.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const choices = (mode: 'basic' | 'full' = 'basic'): SetupChoices => ({ version: 2, mode, superpowers: mode === 'full' ? 'existing' : 'none', models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'inherit' } }, agents: [], existing: {}, components: { quality: 'off', ci: false, release: false, mcp: false } })
function trustedSource(root = join(process.cwd(), 'example', 'superpowers')) {
  const files = { 'index.js': 'entry\n', '.opencode/plugins/superpowers.js': 'plugin\n', 'package.json': '{"name":"superpowers"}\n' }
  const bodies = { brainstorming: '\n# Brainstorming\nComplete body.\n', 'writing-plans': '\n# Writing plans\nComplete plan.\n', 'using-superpowers': '\n# Using skills\n' }
  const skills = Object.entries(bodies).map(([id, content]) => ({ id, name: id, path: join(root, 'skills', id, 'SKILL.md'), content }))
  const pin = { spec: 'superpowers@trusted-pin', revision: 'a'.repeat(40), files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])), skills: Object.fromEntries(Object.entries(bodies).map(([id, text]) => [id, hash(text)])) }
  const snapshot: SourceSnapshot = { plugins: [{ id: 'superpowers', source: { type: 'local', path: join(root, 'index.js') }, features: { server: true }, state: { status: 'active' } }], skills, installation: { root, files, skills: Object.fromEntries(Object.entries(bodies).map(([id, text]) => [id, `---\nname: ${id}\n---\n${text}`])) } }
  return { pin, snapshot, skills }
}
const successful = (skill: { id: string; path: string; content: string }) => ({ content: [{ type: 'text', text: `<skill_content name="${skill.id}">\n# Skill: ${skill.id}\n\n${skill.content}\n</skill_content>` }], metadata: { name: skill.id, directory: join(skill.path, '..') } })

test('trusted source comparison checks active plugin, exact source, installed entries, path and full body; CRLF is equivalent', () => {
  const { pin, snapshot } = trustedSource()
  assert.deepEqual(verifySuperpowers(snapshot, pin).issues, [])
  const reordered = structuredClone(snapshot)
  reordered.skills.reverse()
  assert.equal(verifySuperpowers(reordered, pin).fingerprint, verifySuperpowers(snapshot, pin).fingerprint)
  for (const mutate of [
    (s: SourceSnapshot) => { s.plugins = [] },
    (s: SourceSnapshot) => { s.plugins[0].state = { status: 'failed', error: 'failed' } },
    (s: SourceSnapshot) => { s.plugins[0].source = { type: 'package', target: pin.spec, version: 'other' } },
    (s: SourceSnapshot) => { s.plugins[0].source = { type: 'local', path: join(s.installation!.root, '..', 'other', 'index.js') } },
    (s: SourceSnapshot) => { s.installation!.files['index.js'] += 'changed' },
    (s: SourceSnapshot) => { s.installation!.skills.brainstorming += 'changed' },
    (s: SourceSnapshot) => { s.skills[0].content = 'same name, different skill' },
    (s: SourceSnapshot) => { s.skills[0].path = join(s.installation!.root, '..', 'other', 'SKILL.md') },
  ]) {
    const altered = structuredClone(snapshot); mutate(altered)
    assert.ok(verifySuperpowers(altered, pin).issues.length)
  }
  const packageSource = structuredClone(snapshot)
  packageSource.plugins[0].source = { type: 'package', target: pin.spec, version: pin.revision }
  assert.deepEqual(verifySuperpowers(packageSource, pin).issues, [])
  for (const [key, value] of Object.entries(snapshot.installation!.files)) snapshot.installation!.files[key] = value.replaceAll('\n', '\r\n')
  for (const [key, value] of Object.entries(snapshot.installation!.skills)) snapshot.installation!.skills[key] = value.replaceAll('\n', '\r\n')
  snapshot.skills.forEach(skill => { skill.content = skill.content.replaceAll('\n', '\r\n') })
  assert.deepEqual(verifySuperpowers(snapshot, pin).issues, [])
})

test('skill evidence needs a started native call and complete successful content in the same session and binding', () => {
  const { skills } = trustedSource(), ledger = new SkillEvidence(), skill = skills[0]
  assert.equal(ledger.complete('s1', 'call', 'binding', skill, successful(skill)), false)
  ledger.begin('s1', 'call', 'binding')
  assert.equal(ledger.complete('s2', 'call', 'binding', skill, successful(skill)), false)
  assert.equal(ledger.complete('s1', 'call', 'binding', skill, { output: skill.content, content: 'wrong', metadata: successful(skill).metadata }), false)
  ledger.begin('s1', 'call2', 'binding')
  assert.equal(ledger.complete('s1', 'call2', 'binding', skill, successful(skill)), true)
  assert.deepEqual(ledger.reads('s1', 'binding'), ['brainstorming'])
  ledger.begin('s1', 'call3', 'binding')
  assert.equal(ledger.complete('s1', 'call3', 'binding', skill, { ...successful(skill), metadata: { name: skill.id, directory: join(skill.path, '..', '..') } }), false)
  assert.deepEqual(ledger.reads('s1', 'binding'), [])
})

test('Location, configuration, compaction and reload invalidate completed and in-flight skill evidence', () => {
  const skill = trustedSource().skills[0], ledger = new SkillEvidence()
  ledger.begin('s', 'one', 'location/config-A'); ledger.complete('s', 'one', 'location/config-A', skill, successful(skill))
  assert.deepEqual(ledger.reads('s', 'location/config-B'), [])
  ledger.begin('s', 'two', 'location/config-B'); ledger.invalidate('s')
  assert.equal(ledger.complete('s', 'two', 'location/config-B', skill, successful(skill)), false)
  ledger.begin('s', 'three', 'location/config-B'); ledger.complete('s', 'three', 'location/config-B', skill, successful(skill))
  assert.deepEqual(new SkillEvidence().reads('s', 'location/config-B'), [])
})

test('approval, edit approval and guard waits invalidate an earlier setup evidence checkpoint', async () => {
  const skills = trustedSource().skills.slice(0, 2), ledger = new SkillEvidence()
  for (const phase of ['permission', 'edit', 'guard']) {
    for (const skill of skills) { ledger.begin('s1', phase + skill.id, 'binding'); ledger.complete('s1', phase + skill.id, 'binding', skill, successful(skill)) }
    const checkpoint = ledger.checkpoint('s1', 'binding')
    assert.equal(ledger.isCurrent('s1', checkpoint), true)
    await Promise.resolve().then(() => { ledger.invalidate('s1') })
    assert.equal(ledger.isCurrent('s1', checkpoint), false)
    assert.deepEqual(ledger.reads('s1', 'binding'), [])
  }
})

test('a finishing checkpoint remains stale after compaction and genuine re-reading during the final pending-plan await', async () => {
  const skills = trustedSource().skills.slice(0, 2), ledger = new SkillEvidence()
  const read = (prefix: string) => { for (const skill of skills) { ledger.begin('s1', prefix + skill.id, 'binding'); ledger.complete('s1', prefix + skill.id, 'binding', skill, successful(skill)) } }
  read('before')
  const checkpoint = ledger.checkpoint('s1', 'binding')
  await Promise.resolve().then(() => { ledger.invalidate('s1'); read('after') })
  assert.deepEqual(ledger.reads('s1', 'binding'), ['brainstorming', 'writing-plans'])
  assert.equal(ledger.isCurrent('s1', checkpoint), false)
  assert.equal(ledger.isCurrent('s1', ledger.checkpoint('s1', 'binding')), true)
  const next = ledger.checkpoint('s1', 'binding')
  ledger.invalidateAll()
  assert.equal(ledger.isCurrent('s1', next), false)
})

test('runtime bindings follow actual project configuration, singular agent files and Location, not fixture-only config APIs', async () => {
  const f = await fixture(), other = await fixture(), ledger = new SkillEvidence(), skill = trustedSource().skills[0]
  try {
    const first = await probeSetupRuntime(f.ctx, 's1')
    ledger.begin('s1', 'read', first.fingerprint); ledger.complete('s1', 'read', first.fingerprint, skill, successful(skill))
    await mkdir(join(f.root, '.opencode/agent'), { recursive: true })
    await writeFile(join(f.root, '.opencode/agent/implementer.md'), '---\nmodel: fake/fixture\n---\nAgent')
    const changed = await probeSetupRuntime(f.ctx, 's1')
    assert.notEqual(changed.fingerprint, first.fingerprint)
    assert.deepEqual(ledger.reads('s1', changed.fingerprint), [])
    ledger.begin('s1', 'new', changed.fingerprint); ledger.complete('s1', 'new', changed.fingerprint, skill, successful(skill))
    ledger.invalidateAll()
    assert.deepEqual(ledger.reads('s1', changed.fingerprint), [])
    f.move(other.root)
    assert.notEqual((await probeSetupRuntime(f.ctx, 's1')).fingerprint, changed.fingerprint)
  } finally { await f.close(); await other.close() }
})

test('host catalogue ordering and descriptive metadata do not invalidate evidence but model capability changes do', async () => {
  const f = await fixture()
  try {
    f.models[0].variants = [{ id: 'fast' }, { id: 'deep' }]
    f.models.push({ ...structuredClone(f.models[0]), id: 'other', modelID: 'other' })
    const original = await probeSetupRuntime(f.ctx, 's1')
    f.models.reverse(); f.models.forEach(model => model.variants.reverse())
    assert.equal((await probeSetupRuntime(f.ctx, 's1')).fingerprint, original.fingerprint)
    f.models[0].name = 'Different display label'
    assert.equal((await probeSetupRuntime(f.ctx, 's1')).fingerprint, original.fingerprint)
    f.models[0].enabled = false
    assert.notEqual((await probeSetupRuntime(f.ctx, 's1')).fingerprint, original.fingerprint)
    f.models[0].enabled = true; f.models[0].capabilities.tools = false
    assert.notEqual((await probeSetupRuntime(f.ctx, 's1')).fingerprint, original.fingerprint)
    f.models[0].capabilities.tools = true; f.models[0].variants.pop()
    assert.notEqual((await probeSetupRuntime(f.ctx, 's1')).fingerprint, original.fingerprint)
  } finally { await f.close() }
})

test('candidate model checks allow target transitions while effective verification still rejects overrides and unloaded roles', async () => {
  const f = await fixture()
  try {
    const inherit = choices(), fixed = choices()
    fixed.models.reviewer = { mode: 'fixed', model: 'fake/fixture' }
    const agents = { reviewer: { id: 'reviewer', mode: 'subagent' as const, system: '只读审核。', model: { providerID: 'fake', id: 'fixture' } }, implementer: { id: 'implementer', mode: 'subagent' as const, system: '实现说明。' } }
    assert.deepEqual(checkModels(inherit, f.models, agents, false).issues, [])
    assert.deepEqual(checkModels(fixed, f.models, {}, false).issues, [])
    assert.ok(checkModels(inherit, f.models, agents).issues.some(issue => /继承/.test(issue)))
    assert.ok(checkModels(fixed, f.models, {}).issues.length)
    assert.ok(checkModels(fixed, [], {}, false).issues.length)
  } finally { await f.close() }
})

test('model checks use actual ModelRef.id and reject absent, disabled, no-tools, bad variants and inherited overrides', () => {
  const model = { id: 'fixture', modelID: 'fixture', providerID: 'fake', name: 'Fixture', enabled: true, capabilities: { tools: true }, variants: [{ id: 'deep' }] } as any
  const inherited = choices(), fixed = choices()
  fixed.models.implementer = { mode: 'fixed', model: 'fake/fixture#deep' }
  const agents = { implementer: { id: 'implementer', mode: 'subagent' as const, system: '实现说明。' }, reviewer: { id: 'reviewer', mode: 'subagent' as const, system: '只读审核说明。' } }
  assert.deepEqual(checkModels(inherited, [model], agents).issues, [])
  assert.deepEqual(checkModels(fixed, [model], { ...agents, implementer: { ...agents.implementer, model: { providerID: 'fake', id: 'fixture', variant: 'deep' } } }).issues, [])
  for (const models of [[], [{ ...model, enabled: false }], [{ ...model, capabilities: { tools: false } }], [{ ...model, variants: [] }]]) assert.ok(checkModels(fixed, models, agents).issues.length)
  assert.ok(checkModels(inherited, [model], { ...agents, reviewer: { ...agents.reviewer, model: { providerID: 'fake', id: 'fixture' } } }).issues.some(x => /继承/.test(x)))
  for (const agent of [{ id: 'reviewer' }, { ...agents.reviewer, system: '  ' }, { ...agents.reviewer, mode: 'primary' as const }]) assert.ok(checkModels(inherited, [model], { ...agents, reviewer: agent }).issues.some(x => /加载|子代理/.test(x)))
})

function setupAgents(f: Awaited<ReturnType<typeof fixture>>) {
  for (const id of ['implementer', 'reviewer']) f.agents.set(id, { id, name: id, mode: 'subagent', hidden: false, system: `${id} 的真实说明。`, request: { settings: {}, headers: {}, body: {} }, permissions: [] })
}

async function setup(mode?: 'basic' | 'full') {
  const f = await fixture()
  setupAgents(f)
  await writeFile(join(f.root, '.gitignore'), '.opencode/workflow/.state/\n')
  await writeFile(join(f.root, 'opencode.jsonc'), '{"agents":{"implementer":{},"reviewer":{}}}\n')
  if (mode) await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify(choices(mode)))
  const oldXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(f.root, 'home/.config')
  // 既有 AI 配置检测走调用方的 Git 配置：屏蔽个人全局 excludes，避免 CLAUDE.md 等规则改变结果。
  const oldGit = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  const gitDirectory = await mkdtemp(join(tmpdir(), 'workflow-gitconfig-'))
  await writeFile(join(gitDirectory, 'gitconfig'), '')
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(gitDirectory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
  const dispose = await (await load())(f.ctx)
  await f.fire('tool.execute.before', before('read', { path: 'AGENTS.md' }))
  await f.fire('session.context', context())
  f.onPermission(async input => {
    const event = { ...input, effect: 'allow', message: '' }
    await f.fire('permission.evaluate', event)
    if (event.effect === 'deny') throw new Error(event.message)
  })
  const invoke = async (input: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
    const call = { ...before('workflow_setup', input), signal: new AbortController().signal, ...overrides }
    const result = await f.tools.get('workflow_setup').execute(input, call)
    return JSON.parse(typeof result.content === 'string' ? result.content : result.content.map((p: any) => p.text ?? '').join(''))
  }
  return { ...f, invoke, close: async () => {
    await dispose(); await f.close()
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg
    for (const [key, value] of Object.entries(oldGit)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(gitDirectory, { recursive: true, force: true })
  } }
}

test('registration is lazy and legacy plugin initializes without optional probe domains', async () => {
  const f = await fixture()
  try {
    delete (f.ctx as any).plugin; delete (f.ctx as any).model
    const dispose = await (await load())(f.ctx)
    assert.ok(f.tools.has('workflow_setup'))
    const response = await f.tools.get('workflow_setup').execute({ action: 'status' }, { ...before('workflow_setup', {}), signal: new AbortController().signal })
    assert.equal(JSON.parse(response.content).ready, false)
    await dispose()
  } finally { await f.close() }
})

test('a failed native invalidation subscription blocks full readiness without breaking basic mode', async () => {
  const f = await fixture()
  setupAgents(f)
  ;(f.ctx.event as any).subscribe = async function* () { throw new Error('event stream lost') }
  const dispose = await (await load())(f.ctx)
  try {
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify(choices('full')))
    const execute = () => f.tools.get('workflow_setup').execute({ action: 'verify' }, { ...before('workflow_setup', {}), signal: new AbortController().signal })
    const failed = JSON.parse((await execute()).content)
    assert.equal(failed.ready, false)
    assert.ok(failed.issues.some((x: string) => /事件流/.test(x)))
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify(choices()))
    assert.equal(JSON.parse((await execute()).content).ready, true)
  } finally { await dispose(); await f.close() }
})

test('a pending plan cleared with the ignored state directory does not block status or verify', async () => {
  const f = await setup('basic')
  try {
    assert.ok((await f.invoke({ action: 'plan', choices: choices() })).id)
    await rm(join(f.root, '.opencode/workflow/.state'), { recursive: true, force: true })
    for (const action of ['status', 'verify']) {
      const result = await f.invoke({ action })
      assert.equal(result.ready, true, JSON.stringify(result))
      assert.equal(result.pendingPlan, null)
    }
  } finally { await f.close() }
})

test('applying an earlier plan keeps a newer plan pending', async () => {
  const f = await setup('basic')
  try {
    const earlier = await f.invoke({ action: 'plan', choices: choices() })
    const newer = await f.invoke({ action: 'bootstrap', scope: 'project' })
    assert.equal((await f.invoke({ action: 'apply', planID: earlier.id })).applied, true)
    assert.equal((await f.invoke({ action: 'status' })).pendingPlan?.id, newer.id)
    assert.equal((await f.invoke({ action: 'apply', planID: newer.id })).applied, true)
    assert.equal((await f.invoke({ action: 'status' })).pendingPlan, null)
  } finally { await f.close() }
})

test('basic mode does not require Superpowers and status never creates default choices', async () => {
  const f = await setup()
  try {
    const missing = await f.invoke({ action: 'status' })
    assert.equal(missing.ready, false); assert.equal(missing.choices, null)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')))
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify(choices()))
    const result = await f.invoke({ action: 'verify' })
    assert.equal(result.ready, true, JSON.stringify(result))
    assert.ok(result.unverified.some((x: string) => /付费|调用/.test(x)))
    assert.deepEqual(result.choices, choices())
  } finally { await f.close() }
})

test('a saved version 1 profile still verifies in basic mode, reports normalized choices and cannot be planned', async () => {
  const f = await setup()
  try {
    const { agents: _a, existing: _e, ...rest } = choices(), legacy = { ...rest, version: 1 }
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify(legacy))
    const verified = await f.invoke({ action: 'verify' })
    assert.equal(verified.ready, true, JSON.stringify(verified.issues))
    assert.deepEqual(verified.choices, { ...legacy, agents: [], existing: {} })
    const planned = await f.invoke({ action: 'plan', choices: legacy })
    assert.equal(planned.ready, false)
    assert.match(JSON.stringify(planned.issues), /version 2/)
  } finally { await f.close() }
})

test('status and verify expose existing AI configuration and stay unready until every item is decided', async () => {
  const f = await setup('basic')
  try {
    await writeFile(join(f.root, 'CLAUDE.md'), '# rules\n')
    const status = await f.invoke({ action: 'status' })
    assert.deepEqual([status.ready, status.existing?.undecided], [false, ['CLAUDE.md']])
    assert.match(JSON.stringify(status.issues), /尚未决定的既有 AI 配置/)
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify({ ...choices(), existing: { 'CLAUDE.md': 'keep' } }))
    const verified = await f.invoke({ action: 'verify' })
    assert.equal(verified.ready, true, JSON.stringify(verified.issues))
    assert.equal(verified.existing.items[0].decision, 'keep')
  } finally { await f.close() }
})

const managed = [{ name: 'web-implementer', description: '前端', focus: '前端。', model: { mode: 'inherit' as const } }, { name: 'docs-writer', description: '文档', focus: '文档。', model: { mode: 'fixed' as const, model: 'fake/fixture' } }]

test('model checks cover managed subagents: missing, not a subagent, empty prompt, mismatched fixed model and overridden inheritance', () => {
  const model = { id: 'fixture', modelID: 'fixture', providerID: 'fake', name: 'Fixture', enabled: true, capabilities: { tools: true }, variants: [] } as any
  const selected = { ...choices(), agents: managed }
  const loaded = (id: string, extra = {}) => ({ id, mode: 'subagent' as const, system: `${id} 说明。`, ...extra })
  const agents = { implementer: loaded('implementer'), reviewer: loaded('reviewer'), 'web-implementer': loaded('web-implementer'), 'docs-writer': loaded('docs-writer', { model: { providerID: 'fake', id: 'fixture' } }) }
  assert.deepEqual(checkModels(selected, [model], agents).issues, [])
  const { 'web-implementer': _, ...missing } = agents
  for (const [override, pattern] of [
    [missing, /无法确认有效 web-implementer 代理/],
    [{ ...agents, 'web-implementer': loaded('web-implementer', { mode: 'primary' }) }, /web-implementer 没有正确加载为可用子代理/],
    [{ ...agents, 'web-implementer': loaded('web-implementer', { system: ' ' }) }, /web-implementer 没有正确加载为可用子代理/],
    [{ ...agents, 'docs-writer': loaded('docs-writer') }, /docs-writer 有效模型与固定选择不一致/],
    [{ ...agents, 'web-implementer': loaded('web-implementer', { model: { providerID: 'fake', id: 'fixture' } }) }, /web-implementer 已选择动态继承/],
  ] as const) assert.match(checkModels(selected, [model], override as any).issues.join('\n'), pattern)
  assert.deepEqual(checkModels(selected, [model], { implementer: agents.implementer, reviewer: agents.reviewer }, false).issues, [])
})

test('verify waits until the host loads every managed subagent and status lists it as an effective role', async () => {
  const f = await setup('basic')
  try {
    await mkdir(join(f.root, '.opencode/agents'), { recursive: true })
    await writeFile(join(f.root, '.opencode/agents/web-implementer.md'), agentText(managed[0]))
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify({ ...choices(), agents: [managed[0]] }))
    const missing = await f.invoke({ action: 'verify' })
    assert.equal(missing.ready, false)
    assert.match(JSON.stringify(missing.issues), /web-implementer/)
    f.agents.set('web-implementer', { id: 'web-implementer', name: 'web-implementer', mode: 'subagent', hidden: false, system: '前端。', request: { settings: {}, headers: {}, body: {} }, permissions: [] })
    const ready = await f.invoke({ action: 'verify' })
    assert.equal(ready.ready, true, JSON.stringify(ready.issues))
    assert.deepEqual(Object.keys(ready.models.effective).sort(), ['implementer', 'reviewer', 'web-implementer'])
  } finally { await f.close() }
})

test('plan previews reasoning effort and inheritance notes for every managed role', async () => {
  const f = await setup('basic')
  try {
    f.models[0].variants = [{ id: 'high' }] as never
    const planned = await f.invoke({ action: 'plan', choices: { ...choices(), agents: [managed[0], { ...managed[1], model: { mode: 'fixed', model: 'fake/fixture#high' } }] } })
    assert.ok(planned.id, JSON.stringify(planned))
    assert.match(planned.effort['web-implementer'], /跟随发起会话的模型和思考强度/)
    assert.match(planned.effort['docs-writer'], /思考强度 high/)
    assert.ok(planned.unverified.some((x: string) => x.startsWith('web-implementer 的候选继承计划')))
  } finally { await f.close() }
})

test('editing a managed subagent file changes the runtime fingerprint', async () => {
  const f = await setup('basic')
  try {
    await mkdir(join(f.root, '.opencode/agents'), { recursive: true })
    await writeFile(join(f.root, '.opencode/agents/web-implementer.md'), agentText(managed[0]))
    await writeFile(join(f.root, '.opencode/workflow/onboarding.json'), JSON.stringify({ ...choices(), agents: [managed[0]] }))
    const first = (await probeSetupRuntime(f.ctx, 's1')).fingerprint
    await writeFile(join(f.root, '.opencode/agents/web-implementer.md'), agentText({ ...managed[0], focus: '改过。' }))
    assert.notEqual((await probeSetupRuntime(f.ctx, 's1')).fingerprint, first)
  } finally { await f.close() }
})

test('an unapplied plan saved by the version 1 wizard expires instead of breaking status, verify and finish', async () => {
  const f = await setup('basic')
  try {
    const planned = await f.invoke({ action: 'plan', choices: choices() })
    const state = join(f.root, '.opencode/workflow/.state/onboarding'), saved = JSON.parse(await readFile(join(state, `${planned.id}.json`), 'utf8'))
    const { agents: _a, existing: _e, ...rest } = saved.plan.request.choices
    saved.plan.request.choices = { ...rest, version: 1 }
    const { id: _id, ...plan } = saved.plan
    saved.plan.id = createHash('sha256').update(JSON.stringify({ ...saved, plan })).digest('hex')
    await writeFile(join(state, `${saved.plan.id}.json`), JSON.stringify(saved, null, 2) + '\n')
    await f.ctx.storage.set(`onboarding/plan/${f.root}`, saved.plan.id)
    for (const action of ['status', 'verify']) {
      const result = await f.invoke({ action })
      assert.equal(result.ready, true, JSON.stringify(result.issues))
      assert.equal(result.pendingPlan, null)
    }
    const applied = await f.invoke({ action: 'apply', planID: saved.plan.id })
    assert.equal(applied.ready, false)
    assert.match(JSON.stringify(applied.issues), /version 2/)
  } finally { await f.close() }
})

test('tool responses whitelist model summaries and never expose agent prompts, request headers or bodies', async () => {
  const f = await setup('basic')
  try {
    const system = 'private-' + 'agent-system', header = 'private-' + 'request-header', body = 'private-' + 'request-body'
    f.agents.set('reviewer', { ...f.agents.get('reviewer')!, system, request: { settings: {}, headers: { 'X-Example': header }, body: { example: body } } })
    f.models[0].headers = { 'X-Example': header }; f.models[0].body = { example: body }
    const result = await f.invoke({ action: 'status' }), serialized = JSON.stringify(result)
    for (const value of [system, header, body]) assert.equal(serialized.includes(value), false)
    assert.deepEqual(Object.keys(result.models.effective.reviewer).sort(), ['id', 'model'])
    f.agents.set('reviewer', { id: 'reviewer', name: 'reviewer', mode: 'subagent', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] })
    const unavailable = await f.invoke({ action: 'verify' })
    assert.equal(unavailable.ready, false)
    assert.ok(unavailable.issues.some((x: string) => /加载|子代理/.test(x)))
  } finally { await f.close() }
})

test('plan previews each role reasoning effort: chosen variant, model default without following the session, or inherited', async () => {
  const f = await setup('basic')
  try {
    f.models[0].variants = [{ id: 'low' }, { id: 'high' }]
    const fixed = choices()
    fixed.models.implementer = { mode: 'fixed', model: 'fake/fixture' }
    fixed.models.reviewer = { mode: 'fixed', model: 'fake/fixture#high' }
    const planned = await f.invoke({ action: 'plan', choices: fixed })
    assert.ok(planned.id, JSON.stringify(planned))
    assert.match(planned.effort.implementer, /未选择思考强度.*模型默认.*不跟随主会话.*low、high/)
    assert.match(planned.effort.reviewer, /思考强度 high/)
    f.models[0].variants = []
    const inherited = choices()
    inherited.models.reviewer = { mode: 'fixed', model: 'fake/fixture' }
    const plain = await f.invoke({ action: 'plan', choices: inherited })
    assert.match(plain.effort.implementer, /跟随发起会话的模型和思考强度/)
    assert.match(plain.effort.reviewer, /没有可选思考强度/)
  } finally { await f.close() }
})

test('a context invalidation during the last status storage await cannot return ready even in basic mode', async () => {
  const f = await setup('basic')
  try {
    const get = f.ctx.storage.get
    let invalidate = true
    ;(f.ctx.storage as any).get = async (key: string) => {
      if (invalidate && key.startsWith('onboarding/plan/')) {
        invalidate = false
        f.emit({ type: 'session.compaction.started', data: { sessionID: 's1' } })
        await new Promise(resolve => setImmediate(resolve))
      }
      return get(key)
    }
    const stale = await f.invoke({ action: 'verify' })
    assert.equal(stale.ready, false)
    assert.ok(stale.issues.some((issue: string) => /失效/.test(issue)))
    assert.equal((await f.invoke({ action: 'verify' })).ready, true)
  } finally { await f.close() }
})

test('a context invalidation during setup approval is rejected before any basic configuration write', async () => {
  const f = await setup()
  try {
    const planID = (await f.invoke({ action: 'plan', choices: choices() })).id
    f.onPermission(async input => {
      if (input.action === 'workflow_setup') {
        f.emit({ type: 'session.compaction.started', data: { sessionID: 's1' } })
        await new Promise(resolve => setImmediate(resolve))
      }
    })
    const result = await f.invoke({ action: 'apply', planID })
    assert.equal(result.ready, false)
    assert.ok(result.issues.some((issue: string) => /失效|审批期间.*改变/.test(issue)), JSON.stringify(result))
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')))
  } finally { await f.close() }
})

test('full configure plan/apply/finish fail closed without actual trusted skill evidence', async () => {
  const f = await setup('full')
  try {
    for (const action of ['plan', 'finish']) {
      const result = await f.invoke({ action, choices: choices('full') })
      assert.equal(result.ready, false); assert.ok(result.issues.some((x: string) => /Superpowers|技能/.test(x)))
    }
    const directPlan = await planSetup(f.root, { kind: 'configure', choices: choices('full') })
    const denied = await f.invoke({ action: 'apply', planID: directPlan.id })
    assert.equal(denied.ready, false)
    assert.ok(denied.issues.some((x: string) => /Superpowers|技能/.test(x)))
    f.plugins.push({ id: 'superpowers', source: { type: 'package', target: SUPERPOWERS_SPEC, version: 'wrong' }, state: { status: 'active' }, features: { server: true } })
    for (const id of ['brainstorming', 'writing-plans']) {
      f.skills.set(id, { id, name: id, path: join(f.root, id, 'SKILL.md'), content: 'not the trusted content' })
      const call = before('skill', { id })
      await f.fire('tool.execute.before', call)
      await f.fire('tool.execute.after', { ...call, status: 'completed', result: successful({ id, path: f.skills.get(id)!.path, content: f.skills.get(id)!.content }) })
    }
    const result = await f.invoke({ action: 'finish', verified: true })
    assert.equal(result.ready, false)
  } finally { await f.close() }
})

test('bootstrap is explicit, independent of Superpowers, and status restores its pending plan', async () => {
  const f = await setup()
  try {
    assert.equal((await f.invoke({ action: 'bootstrap' })).ready, false)
    const result = await f.invoke({ action: 'bootstrap', scope: 'project' })
    assert.equal(result.request.kind, 'superpowers')
    assert.equal(result.request.scope, 'project')
    assert.equal((await f.invoke({ action: 'status' })).pendingPlan.id, result.id)
    assert.equal((await readFile(join(f.root, 'opencode.jsonc'), 'utf8')).includes(SUPERPOWERS_SPEC), false)
  } finally { await f.close() }
})

test('apply requires a concrete digest, main session, non-reviewer and scoped permission; no-op is success', async () => {
  const f = await setup()
  try {
    const planned = await f.invoke({ action: 'plan', choices: choices() })
    assert.equal(planned.request.kind, 'configure')
    const planID = planned.id
    assert.equal((await f.invoke({ action: 'apply' })).ready, false)
    assert.equal((await f.invoke({ action: 'apply', planID }, { agent: 'reviewer' })).ready, false)
    f.childSessions.set('child', { id: 'child', parentID: 's1', agent: 'implementer', location: { directory: f.root } })
    assert.equal((await f.invoke({ action: 'apply', planID }, { sessionID: 'child', agent: 'implementer' })).ready, false)
    const requests: any[] = []
    f.onPermission(async input => { requests.push(input) })
    const applied = await f.invoke({ action: 'apply', planID })
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.equal(requests[0].action, 'workflow_setup')
    assert.ok(requests[0].resources.some((x: string) => x.includes(planID)))
    assert.ok(requests[0].resources.some((x: string) => x.includes('project')))
    const repeated = await f.invoke({ action: 'apply', planID })
    assert.equal(repeated.applied, false); assert.deepEqual(repeated.changed, [])
    assert.equal(repeated.issues.length, 0)
  } finally { await f.close() }
})

test('evidence invalidated while a plan is being saved is caught by the final checkpoint', async () => {
  const f = await setup('basic')
  try {
    const set = f.ctx.storage.set
    ;(f.ctx.storage as any).set = async (key: string, value: Parameters<typeof set>[1]) => {
      if (key.startsWith('onboarding/plan/')) {
        f.emit({ type: 'session.compaction.started', data: { sessionID: 's1' } })
        await new Promise(resolve => setImmediate(resolve))
      }
      return set(key, value)
    }
    const result = await f.invoke({ action: 'plan', choices: choices() })
    assert.equal(result.id, undefined, JSON.stringify(result))
    assert.ok(result.issues.some((issue: string) => /失效/.test(issue)), JSON.stringify(result))
  } finally { await f.close() }
})

test('global apply asks edit permission for the same real path it writes', async () => {
  const f = await setup(), xdg = process.env.XDG_CONFIG_HOME
  try {
    await mkdir(join(f.root, 'home/.config'), { recursive: true })
    await symlink(join(f.root, 'home'), join(f.root, 'home-link'), 'junction')
    process.env.XDG_CONFIG_HOME = join(f.root, 'home-link/.config')
    const plan = await f.invoke({ action: 'bootstrap', scope: 'global' })
    const requests: any[] = []
    f.onPermission(async input => { requests.push(input) })
    const applied = await f.invoke({ action: 'apply', planID: plan.id })
    assert.equal(applied.applied, true, JSON.stringify(applied))
    const target = join(await realpath(join(f.root, 'home/.config')), 'opencode/opencode.jsonc')
    assert.deepEqual(requests.find(request => request.action === 'edit')?.resources, [target])
    assert.ok((await readFile(target, 'utf8')).includes(SUPERPOWERS_SPEC))
  } finally { process.env.XDG_CONFIG_HOME = xdg; await f.close() }
})

test('an approved inheritance plan may remove project fixed models without claiming upper-level overrides are resolved', async () => {
  const f = await setup('basic')
  try {
    const file = join(f.root, 'opencode.jsonc')
    await writeFile(file, '{"agents":{"reviewer":{"model":"fake/fixture"}}}\n')
    f.agents.set('reviewer', { ...f.agents.get('reviewer')!, model: { providerID: 'fake', id: 'fixture' } })
    assert.equal((await f.invoke({ action: 'verify' })).ready, false)
    const planned = await f.invoke({ action: 'plan', choices: choices() })
    assert.equal(typeof planned.id, 'string', JSON.stringify(planned))
    assert.ok(planned.unverified.some((issue: string) => /reviewer.*上级/.test(issue)))
    assert.ok((await f.invoke({ action: 'status' })).unverified.some((issue: string) => /reviewer.*上级/.test(issue)))
    const applied = await f.invoke({ action: 'apply', planID: planned.id })
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.equal(JSON.parse(await readFile(file, 'utf8')).agents.reviewer.model, undefined)
    const verified = await f.invoke({ action: 'verify' })
    assert.equal(verified.ready, false)
    assert.ok(verified.issues.some((issue: string) => /继承/.test(issue)))
  } finally { await f.close() }
})

test('apply cannot bypass native edit denial or the project path guard', async () => {
  const f = await setup()
  try {
    await writeFile(join(f.root, 'opencode.jsonc'), '{"agents":{"implementer":{"model":"fake/fixture"},"reviewer":{}}}\n')
    const planID = (await f.invoke({ action: 'plan', choices: choices() })).id
    const original = await readFile(join(f.root, 'opencode.jsonc'), 'utf8')
    const requests: any[] = []
    f.onPermission(async input => {
      requests.push(input)
      if (input.action === 'edit' && input.resources.some((path: string) => path.endsWith('opencode.jsonc'))) throw new Error('用户保护 opencode.jsonc')
    })
    const denied = await f.invoke({ action: 'apply', planID })
    assert.equal(denied.ready, false); assert.match(denied.issues.join(' '), /保护/)
    assert.ok(requests.some(input => input.action === 'edit'))
    assert.equal(await readFile(join(f.root, 'opencode.jsonc'), 'utf8'), original)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')))
    f.onPermission(async () => {})
    await writeFile(join(f.root, '.opencode/workflow/protection.json'), JSON.stringify({ version: 1, rules: [{ id: 'config', actions: ['edit'], paths: ['opencode.jsonc'], effect: 'deny', reason: '项目禁止配置写入' }] }))
    const guarded = await f.invoke({ action: 'apply', planID })
    assert.equal(guarded.ready, false)
    assert.match(guarded.issues.join(' '), /项目禁止配置写入/)
    assert.equal(await readFile(join(f.root, 'opencode.jsonc'), 'utf8'), original)
  } finally { await f.close() }
})

for (const problem of ['oversized-rule', 'missing-checklist', 'invalid-release']) test(`接入 apply 复用普通写入的配置禁令：${problem}`, async () => {
  const f = await setup()
  try {
    const path = join(f.root, '.opencode/agents/reviewer.md'), original = '---\nmodel: fake/fixture\n---\n只读审核。\n'
    await mkdir(join(f.root, '.opencode/agents'), { recursive: true }); await writeFile(path, original)
    if (problem === 'oversized-rule') await writeFile(join(f.root, 'AGENTS.md'), 'x'.repeat(40_001))
    if (problem === 'missing-checklist') await writeFile(join(f.root, '.opencode/workflow/review/catalog.json'), JSON.stringify({ core: { group: 'core', checklist: 'missing.md' } }))
    if (problem === 'invalid-release') await writeFile(join(f.root, '.opencode/workflow/release.json'), '{"version":1,"enabled":true}')
    await assert.rejects(f.fire('tool.execute.before', before('write', { path, content: original.replace('model: fake/fixture\n', '') })), /工作流配置无效/)
    const plan = await f.invoke({ action: 'plan', choices: choices() })
    assert.equal(typeof plan.id, 'string', JSON.stringify(plan))
    const denied = await f.invoke({ action: 'apply', planID: plan.id })
    assert.match(denied.issues.join(' '), /工作流配置无效/)
    assert.equal(await readFile(path, 'utf8'), original)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('失效配置仅保留真实修复路径例外，不把未变更代理文件或个人全局配置算作修复', async () => {
  const f = await setup()
  try {
    await mkdir(join(f.root, '.opencode/agents'), { recursive: true })
    await writeFile(join(f.root, '.opencode/agents/reviewer.md'), '---\ndescription: 审核\n---\n只读审核。\n')
    await writeFile(join(f.root, 'AGENTS.md'), 'x'.repeat(40_001))
    const plan = await f.invoke({ action: 'plan', choices: choices() })
    assert.equal(plan.changes.find((change: any) => change.path.endsWith('reviewer.md')).operation, 'keep')
    const repaired = await f.invoke({ action: 'apply', planID: plan.id })
    assert.equal(repaired.applied, true, JSON.stringify(repaired))
    const global = await f.invoke({ action: 'bootstrap', scope: 'global' })
    const denied = await f.invoke({ action: 'apply', planID: global.id })
    assert.match(denied.issues.join(' '), /工作流配置无效/)
    await assert.rejects(readFile(join(f.root, 'home/.config/opencode/opencode.jsonc')), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('接入计划真实领域未进入上下文时拒绝，注入后显式重试，压缩后重新拒绝', async () => {
  const f = await setup()
  try {
    await mkdir(join(f.root, '.opencode/agents'), { recursive: true })
    const path = join(f.root, '.opencode/agents/reviewer.md'), original = '---\nmodel: fake/fixture\n---\n只读审核。\n'
    await writeFile(path, original)
    await writeFile(join(f.root, '.opencode/agents/AGENTS.md'), '接入代理领域必须保留审核权限。\n')
    const scopesFile = join(f.root, '.opencode/workflow/scopes.json'), scopes = JSON.parse(await readFile(scopesFile, 'utf8'))
    await writeFile(scopesFile, JSON.stringify([...scopes, { paths: ['.opencode/agents/**'], instruction: '.opencode/agents/AGENTS.md' }]))
    const plan = await f.invoke({ action: 'plan', choices: choices() })
    const denied = await f.invoke({ action: 'apply', planID: plan.id })
    assert.match(denied.issues.join(' '), /范围规则尚未进入本轮上下文/)
    assert.equal(await readFile(path, 'utf8'), original)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')), { code: 'ENOENT' })
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => part.text.includes('接入代理领域必须保留审核权限')))
    await f.fire('session.compaction', { sessionID: 's1' })
    assert.match((await f.invoke({ action: 'apply', planID: plan.id })).issues.join(' '), /范围规则尚未进入本轮上下文/)
    await f.fire('session.context', context())
    const applied = await f.invoke({ action: 'apply', planID: plan.id })
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.equal(await readFile(path, 'utf8'), original.replace('model: fake/fixture\n', ''))
  } finally { await f.close() }
})

test('共享配置与领域门槛 await 期间失效仍由最后 checkpoint 拒绝', async () => {
  const f = await setup()
  try {
    const plan = await f.invoke({ action: 'plan', choices: choices() }), set = f.ctx.storage.set
    let invalidated = false
    ;(f.ctx.storage as any).set = async (key: string, value: Parameters<typeof set>[1]) => {
      if (!invalidated && key === 'context/s1') {
        invalidated = true
        f.emit({ type: 'session.compaction.started', data: { sessionID: 's1' } })
        await new Promise(resolve => setImmediate(resolve))
      }
      return set(key, value)
    }
    const denied = await f.invoke({ action: 'apply', planID: plan.id })
    assert.equal(invalidated, true)
    assert.match(denied.issues.join(' '), /失效/)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('permission rejection, changed Location during approval, invalid input and probe errors are structured failures', async () => {
  const f = await setup()
  try {
    const planID = (await f.invoke({ action: 'plan', choices: choices() })).id
    f.onPermission(async () => { throw new Error('用户取消') })
    assert.equal((await f.invoke({ action: 'apply', planID })).ready, false)
    await assert.rejects(readFile(join(f.root, '.opencode/workflow/onboarding.json')))
    f.onPermission(async () => { f.move(join(f.root, 'moved')) })
    assert.equal((await f.invoke({ action: 'apply', planID })).ready, false)
    f.move(f.root)
    const result = await f.invoke({ action: 'plan', choices: { ...choices(), verified: true } })
    assert.equal(result.ready, false)
    ;(f.ctx.model as any).list = async () => { throw new Error('目录不可用') }
    assert.equal((await f.invoke({ action: 'status' })).ready, false)
  } finally { await f.close() }
})

async function doctorFixture(script: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-doctor-')))
  await mkdir(join(root, 'scripts/workflow'), { recursive: true })
  await writeFile(join(root, 'scripts/workflow/doctor.mjs'), script)
  return { root, close: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

// Windows 的 unref 不阻止 libuv 随父进程清理子树；detached 避开夹具的自动清理，但仍属于外部 Job。
async function doctorOrphanFixture(output?: string) {
  const f = await doctorFixture(''), script = join(f.root, 'scripts/workflow/doctor.mjs')
  const alive = join(f.root, 'child-alive'), exited = join(f.root, 'middle-exit'), stderr = join(f.root, 'child-stderr')
  const finish = join(f.root, 'finish'), release = join(f.root, 'release'), marker = join(f.root, 'late-marker')
  const child = `const fs=require('node:fs');let tick=0;const timer=setInterval(()=>{fs.appendFileSync(${JSON.stringify(alive)},JSON.stringify({pid:process.pid,tick:++tick})+'\\n');if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(marker)},'late');clearInterval(timer)}},10)`
  const intermediate = `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(stderr)},'a');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','ignore',fd],windowsHide:true,detached:process.platform==='win32'}).unref();fs.closeSync(fd)`
  await writeFile(script, `import {spawn} from 'node:child_process';import fs from 'node:fs';const fd=fs.openSync(${JSON.stringify(stderr)},'a');const child=spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:['ignore','ignore',fd],windowsHide:true,detached:process.platform==='win32'});fs.closeSync(fd);child.on('exit',(code,signal)=>{fs.writeFileSync(${JSON.stringify(exited + '.tmp')},JSON.stringify({code,signal}));fs.renameSync(${JSON.stringify(exited + '.tmp')},${JSON.stringify(exited)})});child.unref();while(!fs.existsSync(${JSON.stringify(finish)}))await new Promise(resolve=>setTimeout(resolve,10));${output === undefined ? '' : `console.log(${JSON.stringify(output)})`}`)
  return { ...f, script, alive, exited, stderr, finish, release, marker }
}

async function doctorOrphanReady(f: Awaited<ReturnType<typeof doctorOrphanFixture>>, settled?: Promise<unknown>) {
  let ended = false, outcome: unknown, firstTick: number | undefined
  const remember = (value: unknown) => { ended = true; outcome = value }
  void settled?.then(remember, remember)
  const optional = async (path: string) => {
    try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  const deadline = Date.now() + 5000
  while (true) {
    const [aliveText, exitText, diagnostic] = await Promise.all([optional(f.alive), optional(f.exited), optional(f.stderr)])
    const heartbeat = aliveText.split('\n').slice(0, -1).at(-1)
    const alive = heartbeat ? JSON.parse(heartbeat) as { pid: number; tick: number } : undefined
    const exited = exitText ? JSON.parse(exitText) as { code: number | null; signal: string | null } : undefined
    const state = `中间进程=${exitText || '尚未退出'}；后代=${heartbeat || '未就绪'}；stderr=${diagnostic.slice(0, 2000)}`
    if (ended) throw new Error(`后代就绪前自检已结束：${outcome instanceof Error ? outcome.message : JSON.stringify(outcome)}；${state}`, { cause: outcome })
    if (diagnostic || exited && (exited.code !== 0 || exited.signal !== null)) throw new Error(`后代启动异常；${state}`)
    if (exited && alive) {
      assert.ok(Number.isInteger(alive.pid) && alive.pid > 0 && Number.isInteger(alive.tick) && alive.tick > 0, state)
      if (firstTick !== undefined && alive.tick > firstTick) return alive
      firstTick ??= alive.tick
    }
    if (Date.now() >= deadline) throw new Error(`后代未在启动期限内就绪；${state}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function doctorOrphanRelease(f: Awaited<ReturnType<typeof doctorOrphanFixture>>, expectMarker: boolean) {
  await writeFile(f.release, 'go')
  const deadline = Date.now() + 900
  while (Date.now() < deadline) {
    try {
      const marker = await readFile(f.marker, 'utf8')
      assert.equal(expectMarker, true, '监督结束后深层孤儿仍能写入 marker')
      assert.equal(marker, 'late')
      return
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(expectMarker, false, '未受监督的存活后代必须能响应 release 并写入 marker')
}

test('doctor orphan fixture remains alive after both parent exits without production cleanup', async () => {
  const f = await doctorOrphanFixture('control')
  const running = promisify(execFile)(process.execPath, [f.script], { cwd: f.root, timeout: 5000 })
  const settled = running.catch(error => error)
  try {
    await doctorOrphanReady(f, settled)
    await writeFile(f.finish, 'go')
    await running
    await doctorOrphanReady(f)
    await doctorOrphanRelease(f, true)
  } finally { await writeFile(f.finish, 'go'); await writeFile(f.release, 'go'); await settled; await f.close() }
})

test('doctor readiness reports an early supervisor failure instead of waiting for an absent descendant', async () => {
  const f = await doctorOrphanFixture()
  try {
    await writeFile(f.script, 'process.stderr.write("synthetic startup failure");process.exitCode=7')
    const settled = runSetupDoctor(f.root).catch(error => error)
    await assert.rejects(doctorOrphanReady(f, settled), /就绪前.*退出码 7.*synthetic startup failure/s)
  } finally { await f.close() }
})

test('finish really executes doctor in the project root and preserves warnings/unverified', async () => {
  const f = await setup('basic')
  try {
    await mkdir(join(f.root, 'scripts/workflow'), { recursive: true })
    await writeFile(join(f.root, 'scripts/workflow/doctor.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync("doctor-ran",process.cwd()); writeFileSync("doctor-argv",JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true,checks:[{id:"example",status:"warn",message:"人工检查"},{id:"external",status:"unverified",message:"远端未验证"}]}))')
    const result = await f.invoke({ action: 'finish' })
    assert.equal(result.ready, true, JSON.stringify(result))
    assert.equal(await readFile(join(f.root, 'doctor-ran'), 'utf8'), f.root)
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'doctor-argv'), 'utf8')), ['--root', f.root, '--json'])
    assert.ok(result.unverified.some((x: string) => /远端未验证/.test(x)))
    assert.ok(result.doctor.checks.some((x: any) => x.status === 'warn'))
  } finally { await f.close() }
})
test('doctor completion reaps live descendants on both invalid and valid reports', async () => {
  for (const valid of [false, true]) {
    const output = valid ? JSON.stringify({ ok: true, checks: [{ id: 'example', status: 'pass', message: '通过' }] }) : 'not JSON'
    const f = await doctorOrphanFixture(output), abort = new AbortController()
    const settled = runSetupDoctor(f.root, { signal: abort.signal, timeoutMs: 1500 }).catch(error => error)
    try {
      await doctorOrphanReady(f, settled)
      await writeFile(f.finish, 'go')
      const outcome = await settled
      if (valid) { assert.ok(!(outcome instanceof Error), String(outcome)); assert.equal(outcome.ok, true) }
      else { assert.ok(outcome instanceof Error); assert.match(outcome.message, /自检未通过/) }
      await doctorOrphanRelease(f, false)
    } finally { abort.abort(); await settled; await writeFile(f.release, 'go'); await f.close() }
  }
})

test('doctor timeout and cancellation reap deep orphans even after their intermediate parent exits', async () => {
  for (const kind of ['timeout', 'cancel']) {
    const f = await doctorOrphanFixture(), abort = new AbortController()
    const settled = runSetupDoctor(f.root, { signal: abort.signal, timeoutMs: 5000 }).catch(error => error)
    try {
      await doctorOrphanReady(f, settled)
      if (kind === 'cancel') abort.abort()
      const error = await settled
      assert.ok(error instanceof Error)
      assert.match(error.message, kind === 'cancel' ? /取消/ : /超时/)
      await doctorOrphanRelease(f, false)
    } finally { abort.abort(); await settled; await writeFile(f.release, 'go'); await f.close() }
  }
})

test('doctor rejects nonzero exits, empty checks, invalid JSON, hangs and cancellation', async () => {
  for (const script of ['console.log("not JSON")', 'console.log(JSON.stringify({ok:true,checks:[]}))', 'console.log(JSON.stringify({ok:true,checks:[{id:"x",status:"pass",message:"ok"}]}));process.exitCode=4', 'process.exit(7)', 'console.log(JSON.stringify({ok:true,checks:[{id:"x",status:"unknown",message:"bad"}]}))', 'process.stdout.write(Buffer.concat([Buffer.from(\'{"ok":true,"checks":[{"id":"x","status":"pass","message":"\'),Buffer.from([255]),Buffer.from(\'"}]}\')]))', 'setInterval(()=>{},1000)']) {
    const f = await doctorFixture(script)
    try { await assert.rejects(runSetupDoctor(f.root, { timeoutMs: 150 })) } finally { await f.close() }
  }
  const f = await doctorFixture('setInterval(()=>{},1000)')
  try {
    const abort = new AbortController(), result = runSetupDoctor(f.root, { signal: abort.signal })
    abort.abort(); await assert.rejects(result, /取消/)
  } finally { await f.close() }
})
