import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink, link, lstat, chmod, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { parse } from 'jsonc-parser'
import type { SetupChoices } from '../onboarding-config.ts'

import * as config from '../onboarding-config.ts'
import * as files from '../onboarding-files.ts'
import * as agents from '../onboarding-agents.ts'
const suite = fileURLToPath(new URL('../../../../..', import.meta.url))
const choices = (extra: Partial<SetupChoices> = {}): SetupChoices => ({
  version: 2, mode: 'basic', superpowers: 'none',
  models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'inherit' } }, agents: [], existing: {},
  components: { quality: 'off', ci: false, release: false, mcp: false }, ...extra,
})
const web = { name: 'web-implementer', description: '负责 web 前端', focus: '先读 web/AGENTS.md。', model: { mode: 'inherit' as const } }
const legacy = () => { const { agents: _a, existing: _e, ...rest } = choices(); return { ...rest, version: 1 as const } }

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workflow-onboarding-')))
  const root = join(base, 'project'), home = join(base, 'home')
  await mkdir(root); await mkdir(home)
  const gitConfig = join(base, 'gitconfig')
  await writeFile(gitConfig, '')
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  // 个人目录指向夹具：既有 AI 配置检测会读取主目录下的个人技能。
  const old = Object.fromEntries(['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]))
  Object.assign(process.env, { XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home })
  t.after(async () => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const put = async (name: string, text: string, where = root) => {
    await mkdir(dirname(join(where, name)), { recursive: true }); await writeFile(join(where, name), text)
  }
  await put('.gitignore', '.opencode/workflow/.state/\n')
  return { base, root, home, put, git, read: (name: string, where = root) => readFile(join(where, name), 'utf8'),
    plan: (value = choices(), source?: string) => files.planSetup(root, { kind: 'configure', choices: value, source }, { home }),
    apply: (id: string) => files.applySetup(root, id, { home }) }
}

async function sourceCopy(base: string) {
  const source = join(base, 'suite')
  for (const name of ['README.md', 'ADOPT.md', 'template/AGENTS.md', 'template/opencode.jsonc', 'template/.opencode/plugins/workflow/package.json', 'optional/quality', 'optional/ci']) {
    await mkdir(dirname(join(source, name)), { recursive: true })
    await cp(join(suite, name), join(source, name), { recursive: true, filter: name => !name.includes('__pycache__') })
  }
  return source
}

async function absent(file: string) { await assert.rejects(lstat(file), { code: 'ENOENT' }) }

test('没有明确选择、非法依赖或未知字段时拒绝，不能静默选择完整模式', () => {
  assert.equal(typeof config.validateSetupChoices, 'function', '必须提供选择校验接口')
  for (const value of [undefined, {}, { ...choices(), models: {} }, choices({ mode: 'full' }),
    choices({ components: { quality: 'off', ci: true, release: false, mcp: false } }),
    { ...choices(), token: 'not-a-setting' }, choices({ models: { implementer: { mode: 'inherit', model: '' } as never, reviewer: { mode: 'inherit' } } })]) {
    assert.throws(() => config.validateSetupChoices(value))
  }
  assert.deepEqual(config.validateSetupChoices(choices()), choices())
  assert.deepEqual(config.validateSetupChoices(choices({ mode: 'full', superpowers: 'existing' })).mode, 'full')
})

test('选择结构 v2 校验子代理与既有配置决定，拒绝含糊写法', () => {
  const valid = choices({ agents: [{ ...web, focus: '先读 web/AGENTS.md\r\n只改 web/' }], existing: { 'CLAUDE.md': 'migrate', '文档 目录/.cursor': 'keep' } })
  assert.equal(config.validateSetupChoices(valid).agents[0].focus, '先读 web/AGENTS.md\n只改 web/')
  const agent = (extra: object) => choices({ agents: [{ ...web, ...extra }] as SetupChoices['agents'] })
  const invalid = [
    ...['Web', 'w', 'x'.repeat(41), 'web_impl', '-web', 'web-', ...config.RESERVED_AGENT_NAMES, 'code-review', 'security-reviewer', 'con', 'aux', 'nul', 'com1', 'lpt9', 'constructor'].map(name => agent({ name })),
    ...['', ' ', '两行\n说明', '分隔\u2028符', '孤立\ud800代理', '非字符\uFFFE', '非字符\uFFFF', 'x'.repeat(201)].map(description => agent({ description })),
    ...['', 'x'.repeat(2001), '响铃\u0007', '回车\r单独', '孤立\udc00代理'].map(focus => agent({ focus })),
    agent({ model: { mode: 'fixed', model: 'bad' } }), agent({ tools: 'all' }),
    choices({ agents: Array.from({ length: 9 }, (_, i) => ({ ...web, name: `agent-${i}` })) }), choices({ agents: [web, web] }),
    ...['./CLAUDE.md', '.cursor/', '/CLAUDE.md', '~/.claude/skills', 'a\\b', 'a/../b', 'a//b', '', 'x'.repeat(513)].map(key => choices({ existing: { [key]: 'keep' } })),
    choices({ existing: { 'CLAUDE.md': 'delete' } as never }),
    choices({ existing: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p${i}/CLAUDE.md`, 'keep'])) }),
  ]
  for (const value of invalid) assert.throws(() => config.validateSetupChoices(value), Error, JSON.stringify(value).slice(0, 120))
  assert.throws(() => config.validateSetupChoices(legacy()), /version 2.*agents.*existing/)
  assert.deepEqual(config.validateSetupChoices(legacy(), { legacy: true }), { ...legacy(), agents: [], existing: {} })
  assert.throws(() => config.validateSetupChoices({ ...legacy(), agents: [] }, { legacy: true }))
})

test('读取 version 1 档案时补齐空的子代理与决定，不改写文件', async t => {
  const f = await fixture(t)
  await f.put('.opencode/workflow/onboarding.json', JSON.stringify(legacy()))
  assert.deepEqual(await config.readSetupChoices(f.root), { ...legacy(), agents: [], existing: {} })
  assert.deepEqual(JSON.parse(await f.read('.opencode/workflow/onboarding.json')), legacy())
})

test('配置计划要求每个既有 AI 配置都有明确决定，并按决定写入提示与人工任务', async t => {
  const f = await fixture(t)
  await f.put('CLAUDE.md', '# rules\n'); await f.put('.cursor/rules/a.mdc', 'a'); await f.put('.claude/skills/s/SKILL.md', 's')
  await assert.rejects(f.plan(), /尚未决定的既有 AI 配置：\.claude\/skills、\.cursor、CLAUDE\.md/)
  await assert.rejects(f.plan(choices({ existing: { 'claude.md': 'keep', '.cursor': 'keep', '.claude/skills': 'keep' } })), /尚未决定的既有 AI 配置：CLAUDE\.md/)
  const existing = { 'CLAUDE.md': 'migrate', '.cursor': 'keep', '.claude/skills': 'keep' } as const
  const plan = await f.plan(choices({ existing }))
  assert.ok(plan.manualTasks.includes('迁移 CLAUDE.md（Claude Code）：AI 评估后并入 OpenCode 结构，逐项展示差异并经你确认；原文件保留，能共用的改为引用'), JSON.stringify(plan.manualTasks))
  assert.ok(plan.warnings.includes('保留 .cursor（Cursor）：OpenCode V2 不读取，其中的配置在 OpenCode 中不生效'), JSON.stringify(plan.warnings))
  assert.ok(plan.warnings.includes('保留 .claude/skills（Claude Code）：OpenCode 会继续加载，不受向导管理'), JSON.stringify(plan.warnings))
  await f.apply(plan.id)
  assert.deepEqual(JSON.parse(await f.read('.opencode/workflow/onboarding.json')).existing, existing)
})

test('预览后新出现的既有 AI 配置使应用拒绝，活动配置不变', async t => {
  const f = await fixture(t), plan = await f.plan()
  await f.put('.windsurfrules', 'rules')
  await assert.rejects(f.apply(plan.id), /尚未决定的既有 AI 配置：\.windsurfrules/)
  await absent(join(f.root, '.opencode/workflow/onboarding.json'))
})

test('既有 AI 配置检测未完成时不生成计划', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 101; i++) await f.put(`p${i}/CLAUDE.md`, 'r')
  await assert.rejects(f.plan(), /既有 AI 配置检测未完成：检测到超过 100 处/)
})

test('inspect 报告既有 AI 配置；version 1 档案在记录决定前不就绪', async t => {
  const f = await fixture(t)
  await f.put('CLAUDE.md', 'r'); await f.put('.opencode/workflow/onboarding.json', JSON.stringify(legacy()))
  const before = await files.inspectSetup(f.root, { home: f.home })
  assert.deepEqual(before.existing.undecided, ['CLAUDE.md'])
  assert.ok(before.issues.includes('检测到尚未决定的既有 AI 配置：CLAUDE.md；请重新运行 /workflow-setup，评估后记录迁移或保留'), JSON.stringify(before.issues))
  await f.put('.opencode/workflow/onboarding.json', JSON.stringify(choices({ existing: { 'CLAUDE.md': 'keep' } })))
  const after = await files.inspectSetup(f.root, { home: f.home })
  assert.equal(after.existing.items[0].decision, 'keep')
  assert.ok(!after.issues.some(x => x.includes('既有 AI 配置')), JSON.stringify(after.issues))
  assert.ok(!after.unverified.some(x => x.startsWith('迁移 ')), JSON.stringify(after.unverified))
  await f.put('.opencode/workflow/onboarding.json', JSON.stringify(choices({ existing: { 'CLAUDE.md': 'migrate' } })))
  const migrated = await files.inspectSetup(f.root, { home: f.home })
  assert.ok(migrated.unverified.includes('迁移 CLAUDE.md（Claude Code）由 AI 完成，迁移内容是否完整、等价需要你核对'), JSON.stringify(migrated.unverified))
})

const docs = { name: 'docs-writer', description: '负责文档', focus: '只改 docs/。', model: { mode: 'inherit' as const } }

test('新增子代理按模板生成，固定模型写入项目配置并保留注释，继承不写 model', async t => {
  const f = await fixture(t)
  await f.put('opencode.jsonc', '// 保留注释\n{ "agents": { "implementer": {} } }\n')
  const selected = choices({ agents: [{ ...web, model: { mode: 'fixed', model: 'fake/fixture' } }, docs] })
  const plan = await f.plan(selected)
  assert.deepEqual(plan.agents.map(a => [a.name, a.path, a.operation]), [['web-implementer', '.opencode/agents/web-implementer.md', 'create'], ['docs-writer', '.opencode/agents/docs-writer.md', 'create']])
  assert.equal(plan.agents[0].text, agents.agentText(web))
  await f.apply(plan.id)
  assert.equal(await f.read('.opencode/agents/web-implementer.md'), plan.agents[0].text)
  const text = await f.read('opencode.jsonc'), value = parse(text)
  assert.ok(text.startsWith('// 保留注释'))
  assert.deepEqual([value.agents['web-implementer'].model, value.agents['docs-writer']], ['fake/fixture', undefined])
  assert.deepEqual(JSON.parse(await f.read('.opencode/workflow/onboarding.json')).agents, selected.agents)
})

test('受管子代理未修改时可以更新；人工修改、手写同名文件或同名代理配置时拒绝且不写入', async t => {
  const f = await fixture(t), renamed = { ...web, description: '负责 web 前端与样式' }, api = { ...web, name: 'api-implementer' }
  await f.apply((await f.plan(choices({ agents: [web] }))).id)
  assert.equal((await f.plan(choices({ agents: [web] }))).agents[0].operation, 'keep')
  assert.equal((await f.plan(choices({ agents: [renamed] }))).agents[0].operation, 'update')
  const generated = await f.read('.opencode/agents/web-implementer.md')
  await f.put('.opencode/agents/web-implementer.md', '\uFEFF' + generated.replaceAll('\n', '\r\n'))
  assert.equal((await f.plan(choices({ agents: [web] }))).agents[0].operation, 'keep')
  assert.equal((await f.plan(choices({ agents: [renamed] }))).agents[0].operation, 'update')
  await f.put('.opencode/agents/web-implementer.md', generated.replace('只改分配文件', '可以改任意文件'))
  await assert.rejects(f.plan(choices({ agents: [renamed] })), /子代理文件冲突：\.opencode\/agents\/web-implementer\.md/)
  await f.put('.opencode/agents/web-implementer.md', generated)
  await f.put('.opencode/agents/api-implementer.md', '---\ndescription: 手写\nmode: subagent\n---\n手写说明\n')
  await assert.rejects(f.plan(choices({ agents: [web, api] })), /子代理文件冲突：\.opencode\/agents\/api-implementer\.md/)
  await rm(join(f.root, '.opencode/agents/api-implementer.md'))
  for (const directory of ['agent', 'modes', 'mode']) {
    await f.put(`.opencode/${directory}/api-implementer.md`, '---\nmode: subagent\n---\nx\n')
    await assert.rejects(f.plan(choices({ agents: [web, api], existing: { [`.opencode/${directory}/api-implementer.md`]: 'keep' } })), new RegExp(`已有同名代理文件：\\.opencode/${directory}/`))
    await rm(join(f.root, `.opencode/${directory}`), { recursive: true })
  }
  await f.put('opencode.jsonc', '{ "agents": { "api-implementer": { "prompt": "x" } } }\n')
  await assert.rejects(f.plan(choices({ agents: [web, api] })), /已有同名代理配置/)
  await f.put('opencode.jsonc', '{ "agents": { "api-implementer": { "model": "fake/fixture" } } }\n')
  assert.equal((await f.plan(choices({ agents: [web, api] }))).agents[1].operation, 'create')
})

test('去掉受管子代理不删除文件，同一轮要求对它作出保留或迁移的决定', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ agents: [web] }))).id)
  await assert.rejects(f.plan(choices()), /尚未决定的既有 AI 配置：\.opencode\/agents\/web-implementer\.md/)
  const plan = await f.plan(choices({ existing: { '.opencode/agents/web-implementer.md': 'keep' } }))
  assert.ok(plan.warnings.includes('保留 .opencode/agents/web-implementer.md（OpenCode）：OpenCode 会继续加载，不受向导管理'), JSON.stringify(plan.warnings))
  await f.apply(plan.id)
  assert.ok((await f.read('.opencode/agents/web-implementer.md')).includes(agents.AGENT_CONTRACT))
})

test('受管子代理文件被人工修改后，核对时列为待你核对', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ agents: [web] }))).id)
  assert.deepEqual((await files.inspectSetup(f.root, { home: f.home })).unverified.filter(line => line.includes('web-implementer')), [])
  const generated = await f.read('.opencode/agents/web-implementer.md')
  await f.put('.opencode/agents/web-implementer.md', generated.replace("  - { action: subagent, resource: '*', effect: deny }\n", ''))
  const inspect = await files.inspectSetup(f.root, { home: f.home })
  assert.ok(inspect.unverified.includes('子代理 web-implementer 的代理文件 .opencode/agents/web-implementer.md 已被人工修改，权限和协作边界不再由向导保证，需要你核对'), JSON.stringify(inspect.unverified))
})

test('受管子代理文件无法读取时报告相对路径和原因，不回显原始错误', async t => {
  const f = await fixture(t), path = '.opencode/agents/web-implementer.md'
  await f.apply((await f.plan(choices({ agents: [web] }))).id)
  const generated = await f.read(path)
  await writeFile(join(f.root, path), Buffer.from('\uFEFF' + generated, 'utf16le'))
  let inspect = await files.inspectSetup(f.root, { home: f.home })
  assert.ok(inspect.issues.includes(`${path} 不是有效的 UTF-8 文本`), JSON.stringify(inspect.issues))
  // 系统错误的原始信息含绝对路径；Windows 和 root 用户无法用权限位制造 EACCES。
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await writeFile(join(f.root, path), generated); await chmod(join(f.root, path), 0o000)
    inspect = await files.inspectSetup(f.root, { home: f.home })
    await chmod(join(f.root, path), 0o644)
    assert.ok(inspect.issues.includes(`无法读取 ${path}（EACCES）`), JSON.stringify(inspect.issues))
    assert.equal(JSON.stringify(inspect.issues).includes(f.root), false)
  }
})

test('预览和核对读取项目文件出错时只报告相对路径和错误码', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const f = await fixture(t)
  await f.put('opencode.jsonc', '{}\n'); await chmod(join(f.root, 'opencode.jsonc'), 0o000)
  const refused = await f.plan().then(() => null, (error: Error) => error.message)
  await chmod(join(f.root, 'opencode.jsonc'), 0o644)
  assert.equal(refused, '无法读取 opencode.jsonc（EACCES）')
  await f.apply((await f.plan()).id)
  await chmod(join(f.root, '.opencode/workflow'), 0o600)
  const inspect = await files.inspectSetup(f.root, { home: f.home })
  await chmod(join(f.root, '.opencode/workflow'), 0o755)
  assert.ok(inspect.issues.includes('无法读取接入配置 .opencode/workflow/onboarding.json（EACCES）'), JSON.stringify(inspect.issues))
  assert.equal(JSON.stringify(inspect.issues).includes(f.root), false, JSON.stringify(inspect.issues))
})

test('迁移目标可以在同一次计划中预先记为保留，迁移后不再要求决定', async t => {
  const f = await fixture(t)
  await f.put('.claude/commands/deploy-check.md', '检查部署前状态\n')
  const existing = { '.claude': 'migrate', '.opencode/commands/deploy-check.md': 'keep' } as const
  await f.apply((await f.plan(choices({ existing }))).id)
  await f.put('.opencode/commands/deploy-check.md', '检查部署前状态：$ARGUMENTS\n')
  const after = await files.inspectSetup(f.root, { home: f.home })
  assert.deepEqual(after.existing.undecided, [])
  assert.equal(after.existing.items.find(item => item.path === '.opencode/commands/deploy-check.md')?.decision, 'keep')
})

test('预览不改变活动配置；继承保留 JSONC 注释、主模型、权限和代理其他字段', async t => {
  const f = await fixture(t)
  const before = '{\n // 私有提供商设置保留\n "model": "demo/main",\n "provider": {"demo":{"apiKey":"' + ['synthetic', 'private'].join('-') + '"}},\n "agents": {"implementer":{"model":"demo/old","permissions":[{"action":"read","effect":"allow"}]},"reviewer":{"model":"demo/old","description":"保持"}},\n "permissions": [{"action":"workflow_release","effect":"ask"}],\n}\n'
  await f.put('opencode.jsonc', before)
  const markdown = '---\ndescription: 审核\nmodel: demo/old\npermissions:\n  - { action: edit, effect: deny }\n---\n正文不变。\n'
  await f.put('.opencode/agents/reviewer.md', markdown)
  const plan = await f.plan()
  assert.equal(await f.read('opencode.jsonc'), before)
  await absent(join(f.root, config.SETUP_PROFILE))
  const serialized = JSON.stringify(await files.readSetupPlan(f.root, plan.id))
  assert.ok(!serialized.includes(['synthetic', 'private'].join('-')))
  const state = join(f.root, '.opencode/workflow/.state/onboarding')
  for (const name of await readdir(state)) assert.ok(!(await f.read(name, state)).includes(['synthetic', 'private'].join('-')))
  const result = await f.apply(plan.id)
  assert.equal(result.applied, true)
  const text = await f.read('opencode.jsonc'), value = parse(text)
  assert.match(text, /私有提供商设置保留/)
  assert.equal(value.model, 'demo/main')
  assert.equal(value.agents.implementer.model, undefined)
  assert.equal(value.agents.reviewer.model, undefined)
  assert.deepEqual(value.agents.implementer.permissions, [{ action: 'read', effect: 'allow' }])
  assert.equal(value.agents.reviewer.description, '保持')
  assert.equal(value.provider.demo.apiKey, ['synthetic', 'private'].join('-'))
  assert.equal(await f.read('.opencode/agents/reviewer.md'), markdown.replace('model: demo/old\n', ''))
  assert.deepEqual(await config.readSetupChoices(f.root), choices())
})

test('固定代理模型不改变主模型，模型字段必须完整有效', async t => {
  const f = await fixture(t)
  await f.put('opencode.jsonc', '{/* 保留 */"model":"demo/main","agents":{"reviewer":{"permissions":[]}}}')
  const value = choices({ models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'fixed', model: 'demo/review#careful' } } })
  await f.apply((await f.plan(value)).id)
  const actual = parse(await f.read('opencode.jsonc'))
  assert.equal(actual.model, 'demo/main'); assert.equal(actual.agents.reviewer.model, 'demo/review#careful')
  assert.deepEqual(actual.agents.reviewer.permissions, [])
  for (const model of ['', 'no-provider', 'demo/model\n', 'demo/model#']) assert.throws(() => config.validateSetupChoices(choices({ models: { implementer: { mode: 'fixed', model }, reviewer: { mode: 'inherit' } } })))
})

test('复杂 model frontmatter 必须人工处理，不能删除权限或先写 profile', async t => {
  const f = await fixture(t)
  for (const model of ['model: |\n  demo/old', 'model:\n  provider: demo', '"model": demo/old', '<<: *defaults', 'model: &shared demo/old', '  model: demo/old']) {
    const content = `---\n${model}\npermissions:\n  - { action: edit, effect: deny }\n---\n正文\n`
    await f.put('.opencode/agents/reviewer.md', content)
    await assert.rejects(f.plan(), /frontmatter|人工/)
    assert.equal(await f.read('.opencode/agents/reviewer.md'), content)
    await absent(join(f.root, config.SETUP_PROFILE))
  }
})

test('同时存在 JSON 与 JSONC 时继承移除两处代理覆盖但保留权限', async t => {
  const f = await fixture(t)
  await f.put('opencode.json', '{"agents":{"reviewer":{"model":"demo/first","permissions":[]}}}')
  await f.put('opencode.jsonc', '{// 第二层\n"agents":{"reviewer":{"model":"demo/second"}}}')
  await f.apply((await f.plan()).id)
  for (const name of ['opencode.json', 'opencode.jsonc']) assert.equal(parse(await f.read(name)).agents.reviewer.model, undefined)
  assert.deepEqual(parse(await f.read('opencode.json')).agents.reviewer.permissions, [])
})

test('重复应用没有额外活动修改，应用后用户修改不能被旧计划覆盖', async t => {
  const f = await fixture(t), plan = await f.plan()
  await f.apply(plan.id)
  const before = await f.read(config.SETUP_PROFILE)
  assert.deepEqual((await f.apply(plan.id)).changed, [])
  assert.equal(await f.read(config.SETUP_PROFILE), before)
  const next = await f.plan()
  assert.ok(next.changes.every(change => change.operation === 'keep'))
  assert.equal((await f.apply(next.id)).applied, false)
  await f.put(config.SETUP_PROFILE, JSON.stringify(choices({ superpowers: 'existing' })))
  await assert.rejects(f.apply(plan.id), /改变|过期/)
})

test('源改变或目标改变都在首次活动写入之前拒绝', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  const selected = choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } })
  const plan = await f.plan(selected, source)
  await writeFile(join(source, 'optional/ci/run-quality.py'), '# changed\n')
  await assert.rejects(f.apply(plan.id), /源|改变|过期/)
  await absent(join(f.root, config.SETUP_PROFILE)); await absent(join(f.root, 'scripts/quality/run-hook.py'))
  const next = await f.plan(selected, source)
  await f.put('scripts/ci/run-quality.py', '# local\n')
  await assert.rejects(f.apply(next.id), /冲突|改变|过期/)
  assert.equal(await f.read('scripts/ci/run-quality.py'), '# local\n')
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('同名不同内容完整预检，质量或 CI 冲突不得先写 profile', async t => {
  const f = await fixture(t)
  await f.put('scripts/ci/run-quality.py', '# custom CI\n')
  await assert.rejects(f.plan(choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } }), suite), /冲突.*run-quality|run-quality.*冲突/)
  await absent(join(f.root, config.SETUP_PROFILE)); await absent(join(f.root, 'scripts/quality/run-hook.py'))
})

test('就绪白名单与套件质量扩展的实际文件一致', async () => {
  const actual = (await readdir(join(suite, 'optional/quality'))).filter(name => name.endsWith('.py') || name === 'quality.example.json').sort()
  assert.deepEqual([...files.QUALITY].sort(), actual)
})

test('质量复制全部常规 py 与 example，CI 只复制四个白名单文件', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  await writeFile(join(source, 'optional/quality/extra.py'), '# additional module\n')
  await writeFile(join(source, 'optional/ci/do-not-copy.py'), '# excluded\n')
  const plan = await f.plan(choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } }), source)
  await f.apply(plan.id)
  const expected = (await readdir(join(source, 'optional/quality'))).filter(name => name.endsWith('.py') || name === 'quality.example.json').sort()
  assert.deepEqual((await readdir(join(f.root, 'scripts/quality'))).sort(), expected)
  assert.deepEqual((await readdir(join(f.root, 'scripts/ci'))).sort(), ['resolve-scope.py', 'run-quality.py', 'scan-secrets.py'])
  assert.equal(await f.read('.github/workflows/workflow-checks.yml'), await readFile(join(source, 'optional/ci/workflow-checks.yml'), 'utf8'))
  await absent(join(f.root, '.github/workflows/ci.yml')); await absent(join(f.root, 'node_modules'))
  const inspect = await files.inspectSetup(f.root)
  assert.equal(inspect.components.quality.status, 'configured'); assert.equal(inspect.components.ci.status, 'configured')
  assert.deepEqual(inspect.existing.personal, [])
  assert.ok(inspect.unverified.some(message => /远端.*CI|GitHub/.test(message)))
})

test('完整已有质量文件无需来源即可保留，但不冒充执行验收', async t => {
  const f = await fixture(t)
  const selected = choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } })
  await f.apply((await f.plan(selected, suite)).id)
  const plan = await f.plan(selected)
  assert.ok(plan.changes.every(change => change.operation === 'keep'))
  assert.ok(plan.warnings.some(message => /已有|保留/.test(message)))
  const result = await f.apply(plan.id)
  assert.ok(result.pending.some(message => /验收|验证/.test(message)))
})

test('可选依赖缺失必须指定完整套件来源，不接受单独 quality 目录', async t => {
  const f = await fixture(t)
  const value = choices({ components: { quality: 'checks', ci: false, release: false, mcp: false } })
  await assert.rejects(f.plan(value), /source|来源|套件/)
  await assert.rejects(f.plan(value, join(suite, 'optional/quality')), /套件/)
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('源文件和源目录的符号链接被拒绝', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  await rm(join(source, 'optional/quality/run-hook.py'))
  try { await symlink(join(suite, 'optional/quality/run-hook.py'), join(source, 'optional/quality/run-hook.py')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  await assert.rejects(f.plan(choices({ components: { quality: 'checks', ci: false, release: false, mcp: false } }), source), /链接/)
})

test('预览后父目录变成链接拒绝，不能写入外部或 profile', async t => {
  const f = await fixture(t)
  const plan = await f.plan(choices({ components: { quality: 'checks', ci: false, release: false, mcp: false } }), suite)
  const outside = join(f.base, 'outside'); await mkdir(outside)
  try { await symlink(outside, join(f.root, 'scripts'), 'dir') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  await assert.rejects(f.apply(plan.id), /链接/)
  assert.deepEqual(await readdir(outside), []); await absent(join(f.root, config.SETUP_PROFILE))
})

test('状态或计划目录链接也不能逃逸；profile 链接拒绝读取', async t => {
  for (const name of ['.opencode/workflow/.state', '.opencode/workflow/.state/onboarding', config.SETUP_PROFILE]) {
    const f = await fixture(t), outside = join(f.base, 'outside')
    await mkdir(outside); await mkdir(dirname(join(f.root, name)), { recursive: true })
    try { await symlink(outside, join(f.root, name), 'dir') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
    await assert.rejects(name === config.SETUP_PROFILE ? config.readSetupChoices(f.root) : f.plan(), /链接/)
    assert.deepEqual(await readdir(outside), [])
  }
})

test('计划文件本身链接及越界 id 被拒绝读取或应用', async t => {
  const f = await fixture(t), plan = await f.plan(), state = join(f.root, '.opencode/workflow/.state/onboarding')
  await assert.rejects(files.readSetupPlan(f.root, '../outside'), /计划|id/)
  const names = await readdir(state), name = names.find(name => name.includes(plan.id))!
  const outside = join(f.base, 'saved-plan'); await cp(join(state, name), outside); await rm(join(state, name))
  try { await symlink(outside, join(state, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  await assert.rejects(files.readSetupPlan(f.root, plan.id), /链接/)
  await assert.rejects(f.apply(plan.id), /链接/)
})

test('只有 scope=global 的安装会改 home，全局影响必须在预览标明', async t => {
  const f = await fixture(t)
  const project = await files.planSetup(f.root, { kind: 'superpowers', scope: 'project' }, { home: f.home })
  assert.ok(project.changes.every(change => change.scope === 'project'))
  await f.apply(project.id)
  await absent(join(f.home, '.config'))
  assert.deepEqual(parse(await f.read('opencode.jsonc')).plugins, [config.SUPERPOWERS_SPEC])
  await rm(join(f.root, 'opencode.jsonc'))
  const global = await files.planSetup(f.root, { kind: 'superpowers', scope: 'global' }, { home: f.home })
  assert.ok(global.changes.some(change => change.scope === 'global'))
  assert.ok(global.warnings.some(message => /全局|个人/.test(message)))
  await f.apply(global.id)
  assert.deepEqual(parse(await f.read('.config/opencode/opencode.jsonc', f.home)).plugins, [config.SUPERPOWERS_SPEC])
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('改写已有配置时保留文件开头的 BOM', async t => {
  const f = await fixture(t)
  await f.put('opencode.jsonc', '\uFEFF{\n  "plugins": []\n}\n')
  const plan = await files.planSetup(f.root, { kind: 'superpowers', scope: 'project' }, { home: f.home })
  await f.apply(plan.id)
  const bytes = await readFile(join(f.root, 'opencode.jsonc'))
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.deepEqual(parse(bytes.subarray(3).toString('utf8')).plugins, [config.SUPERPOWERS_SPEC])
})

test('默认全局目录尊重 XDG，显式 home 不借用真实 XDG', async t => {
  const f = await fixture(t), xdg = join(f.base, 'xdg')
  process.env.XDG_CONFIG_HOME = xdg
  const plan = await files.planSetup(f.root, { kind: 'superpowers', scope: 'global' })
  await files.applySetup(f.root, plan.id)
  assert.deepEqual(parse(await f.read('opencode/opencode.jsonc', xdg)).plugins, [config.SUPERPOWERS_SPEC])
  await absent(join(f.home, '.config'))
})

test('configure 选择 global 不暗中安装或修改全局模型', async t => {
  const f = await fixture(t)
  await f.put('.config/opencode/opencode.jsonc', '{"agents":{"reviewer":{"model":"demo/global"}}}', f.home)
  const before = await f.read('.config/opencode/opencode.jsonc', f.home)
  const plan = await f.plan(choices({ mode: 'full', superpowers: 'global' }))
  assert.ok(plan.changes.every(change => change.scope === 'project'))
  await f.apply(plan.id)
  assert.equal(await f.read('.config/opencode/opencode.jsonc', f.home), before)
})

for (const scope of ['project', 'global'] as const) for (const field of ['plugin', 'plugins']) for (const entry of ['string', 'object']) {
  test(`Superpowers ${scope}/${field}/${entry} 固定来源跨配置层保持幂等与 options`, async t => {
    const f = await fixture(t), where = scope === 'project' ? f.root : join(f.home, '.config/opencode')
    const plugin = entry === 'string' ? config.SUPERPOWERS_SPEC : { package: config.SUPERPOWERS_SPEC, options: { example: true } }
    const original = JSON.stringify({ [field]: ['unrelated-plugin', plugin] })
    await f.put('opencode.json', original, where)
    await f.put('opencode.jsonc', '{/* 保留另一层 */"plugins":[{"package":"another-plugin","options":{"enabled":true}}]}', where)
    for (const target of ['project', 'global'] as const) {
      const plan = await files.planSetup(f.root, { kind: 'superpowers', scope: target }, { home: f.home })
      assert.ok(plan.changes.every(change => change.operation === 'keep'), JSON.stringify(plan.changes))
      assert.deepEqual((await f.apply(plan.id)).changed, [])
      assert.equal(await f.read('opencode.json', where), original)
      assert.equal(parse(await f.read('opencode.jsonc', where)).plugin, undefined)
    }
  })
  test(`Superpowers ${scope}/${field}/${entry} 冲突在预览前拒绝，即使另一层已有固定来源`, async t => {
    const f = await fixture(t), where = scope === 'project' ? f.root : join(f.home, '.config/opencode')
    for (const source of ['superpowers@git+https://github.com/obra/superpowers.git#v7.0.0', 'file:///example/superpowers/index.js']) {
      const plugin = entry === 'string' ? source : { package: source, options: { example: true } }
      const original = JSON.stringify({ [field]: [plugin] })
      await f.put('opencode.json', original, where)
      await f.put('opencode.jsonc', JSON.stringify({ plugins: [config.SUPERPOWERS_SPEC] }), where)
      for (const target of ['project', 'global'] as const) await assert.rejects(files.planSetup(f.root, { kind: 'superpowers', scope: target }, { home: f.home }), /Superpowers|版本|冲突/)
      assert.equal(await f.read('opencode.json', where), original)
      await absent(join(f.root, '.opencode/workflow/.state/onboarding'))
    }
  })
}

for (const scope of ['project', 'global'] as const) test(`Superpowers ${scope} 新登记使用 V2 plugins，不删除旧字段或无关对象 options`, async t => {
  const f = await fixture(t), where = scope === 'project' ? f.root : join(f.home, '.config/opencode')
  const legacy = ['legacy-plugin'], plugins = [{ package: 'other-plugin', options: { enabled: false, example: ['value'] } }]
  await f.put('opencode.jsonc', '{/* 保留注释 */' + JSON.stringify({ plugin: legacy, plugins }).slice(1), where)
  const plan = await files.planSetup(f.root, { kind: 'superpowers', scope }, { home: f.home })
  await f.apply(plan.id)
  const text = await f.read('opencode.jsonc', where), actual = parse(text)
  assert.match(text, /保留注释/)
  assert.deepEqual(actual.plugin, legacy)
  assert.deepEqual(actual.plugins, [...plugins, config.SUPERPOWERS_SPEC])
  assert.deepEqual((await f.apply(plan.id)).changed, [])
})

test('已有不同 Superpowers 来源不追加、不覆盖，另一个范围也要检查', async t => {
  const f = await fixture(t)
  await f.put('.config/opencode/opencode.jsonc', '{/* existing */"plugin":["superpowers@old-version"]}', f.home)
  await assert.rejects(files.planSetup(f.root, { kind: 'superpowers', scope: 'project' }, { home: f.home }), /Superpowers|superpowers|版本|冲突/)
  await absent(join(f.root, 'opencode.jsonc'))
})

test('quality=hook 才安装真实 hook；重复应用保留；checks 不安装', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ components: { quality: 'checks', ci: false, release: false, mcp: false } }), suite)).id)
  await absent(join(f.root, '.git/hooks/post-commit'))
  const plan = await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }))
  await f.apply(plan.id)
  const hook = await f.read('.git/hooks/post-commit')
  assert.match(hook, /^#!\/bin\/sh\n# workflow-quality-hook\n/)
  assert.match(hook, /quality_dir='scripts\/quality'/)
  assert.equal((await files.inspectSetup(f.root)).components.quality.status, 'configured')
  assert.deepEqual((await f.apply(plan.id)).changed, [])
})

test('已有外来 hook 或 hooksPath 冲突时全量拒绝，不能只凭安装器退出零', async t => {
  const f = await fixture(t), value = choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } })
  await f.put('.git/hooks/post-commit', '#!/bin/sh\necho custom\n')
  await assert.rejects(f.plan(value, suite), /hook|冲突/)
  assert.equal(await f.read('.git/hooks/post-commit'), '#!/bin/sh\necho custom\n')
  await rm(join(f.root, '.git/hooks/post-commit'))
  const plan = await f.plan(value, suite)
  f.git('config', 'core.hooksPath', '.custom-hooks')
  await assert.rejects(f.apply(plan.id), /hooksPath|冲突|改变|过期/)
  await absent(join(f.root, config.SETUP_PROFILE)); await absent(join(f.root, 'scripts/quality/run-hook.py'))
})

test('release/mcp 只记录人工任务，缺失或未启用配置必须是 issues', async t => {
  const f = await fixture(t)
  const plan = await f.plan(choices({ components: { quality: 'off', ci: false, release: true, mcp: true } }))
  assert.ok(plan.manualTasks.some(task => /发布/.test(task))); assert.ok(plan.manualTasks.some(task => /MCP/.test(task)))
  await f.apply(plan.id)
  await absent(join(f.root, '.opencode/workflow/release.json'))
  let inspect = await files.inspectSetup(f.root)
  assert.equal(inspect.components.release.status, 'pending'); assert.equal(inspect.components.mcp.status, 'pending')
  assert.ok(inspect.issues.some(issue => /发布/.test(issue))); assert.ok(inspect.issues.some(issue => /MCP/.test(issue)))
  await f.put('.opencode/workflow/release.json', '{"version":1,"enabled":false}')
  await f.put('opencode.jsonc', '{"mcp":{"servers":{"read":{"type":"remote","url":"https://example.invalid","disabled":true}}}}')
  inspect = await files.inspectSetup(f.root)
  assert.ok(inspect.issues.some(issue => /发布/.test(issue))); assert.ok(inspect.issues.some(issue => /MCP/.test(issue)))
})

test('实际启用的发布与 MCP 配置可列 configured，远端与只读权限仍 unverified', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ components: { quality: 'off', ci: false, release: true, mcp: true } }))).id)
  await f.put('.opencode/workflow/release.json', JSON.stringify({ version: 1, enabled: true, tagPattern: '^v[0-9]+$', scope: { include: ['*'], exclude: [] }, entries: [{ id: 'release', argv: ['node', 'scripts/example-release.mjs'], artifacts: [] }] }))
  await f.put('opencode.jsonc', '{"mcp":{"servers":{"read":{"type":"remote","url":"https://example.invalid","disabled":false}}}}')
  const inspect = await files.inspectSetup(f.root)
  assert.equal(inspect.components.release.status, 'configured'); assert.equal(inspect.components.mcp.status, 'configured')
  assert.ok(inspect.unverified.some(message => /MCP.*只读|只读.*MCP/.test(message)))
  assert.ok(inspect.unverified.some(message => /业务测试/.test(message)))
})

test('off 不卸载已有能力，状态必须 preserved 而不是已禁用', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } }), suite)).id)
  const before = await f.read('scripts/quality/run-hook.py')
  await f.put('.opencode/workflow/release.json', '{"version":1,"enabled":false}')
  await f.put('opencode.jsonc', '{"mcp":{"servers":{"read":{"disabled":true}}}}')
  await f.apply((await f.plan()).id)
  const inspect = await files.inspectSetup(f.root)
  for (const name of ['quality', 'ci', 'release', 'mcp']) { assert.equal(inspect.components[name].status, 'preserved'); assert.equal(inspect.components[name].selected, false) }
  assert.equal(await f.read('scripts/quality/run-hook.py'), before)
})

test('inspect 缺少 profile 返回 null，失效配置不伪装为完成', async t => {
  const f = await fixture(t)
  assert.equal(await config.readSetupChoices(f.root), null)
  await f.put(config.SETUP_PROFILE, JSON.stringify(choices({ components: { quality: 'checks', ci: true, release: false, mcp: false } })))
  const inspect = await files.inspectSetup(f.root)
  assert.ok(inspect.issues.some(issue => /质量/.test(issue))); assert.ok(inspect.issues.some(issue => /CI/.test(issue)))
  await f.put(config.SETUP_PROFILE, '{invalid')
  await assert.rejects(config.readSetupChoices(f.root))
})

test('计划来源定位只能存入真正被 Git 忽略且未跟踪的状态目录', async t => {
  const f = await fixture(t)
  await rm(join(f.root, '.gitignore'))
  await assert.rejects(f.plan(), /忽略|ignore/)
  await absent(join(f.root, '.opencode/workflow/.state'))
})

test('安装器退出零但没有安装实际 hook 时拒绝，撤销已复制文件且不写 profile', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  const installer = await readFile(join(source, 'optional/quality/install-hooks.py'), 'utf8')
  await writeFile(join(source, 'optional/quality/install-hooks.py'), installer.replace('sys.exit(main(sys.argv[1:]))', 'sys.exit(0)'))
  const plan = await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }), source)
  await assert.rejects(f.apply(plan.id), /hook.*未完成|hook.*不匹配/)
  await absent(join(f.root, config.SETUP_PROFILE)); await absent(join(f.root, 'scripts/quality/run-hook.py'))
  await absent(join(f.root, '.git/hooks/post-commit'))
})

test('源目录新增文件、源目录换成链接与目标文件链接均使原计划失效', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  const value = choices({ components: { quality: 'checks', ci: false, release: false, mcp: false } })
  const first = await f.plan(value, source)
  await writeFile(join(source, 'optional/quality/new_module.py'), '# newly added\n')
  await assert.rejects(f.apply(first.id), /改变|过期/)
  const second = await f.plan(value, source)
  const original = join(source, 'optional/quality'), moved = join(source, 'optional/original')
  const { rename } = await import('node:fs/promises')
  await rename(original, moved)
  try { await symlink(moved, original, 'dir') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  await assert.rejects(f.apply(second.id), /链接/)
  await rm(original); await rename(moved, original)
  const third = await f.plan(value, source)
  await mkdir(join(f.root, 'scripts/quality'), { recursive: true })
  await symlink(join(source, 'optional/quality/run-hook.py'), join(f.root, 'scripts/quality/run-hook.py'))
  await assert.rejects(f.apply(third.id), /链接/)
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('全局目标父目录链接或预览后的全局目标更改不会写入任何活动配置', async t => {
  const f = await fixture(t), outside = join(f.base, 'outside')
  await mkdir(outside); await mkdir(join(f.home, '.config'))
  try { await symlink(outside, join(f.home, '.config/opencode'), 'dir') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  await assert.rejects(files.planSetup(f.root, { kind: 'superpowers', scope: 'global' }, { home: f.home }), /链接/)
  assert.deepEqual(await readdir(outside), [])
  await rm(join(f.home, '.config/opencode'))
  const plan = await files.planSetup(f.root, { kind: 'superpowers', scope: 'global' }, { home: f.home })
  await f.put('.config/opencode/opencode.jsonc', '{"plugin":["other-plugin"]}', f.home)
  await assert.rejects(f.apply(plan.id), /改变|过期/)
  assert.deepEqual(parse(await f.read('.config/opencode/opencode.jsonc', f.home)).plugin, ['other-plugin'])
})

test('计划 id 是绑定不可变预览内容的 SHA-256，重复预览同一输入得到同一摘要', async t => {
  const f = await fixture(t), first = await f.plan(), second = await f.plan()
  assert.match(first.id, /^[a-f0-9]{64}$/)
  assert.equal(first.id, second.id)
})

test('保存后的计划选择、变更、警告或观察摘要被改写时拒绝读取及应用', async t => {
  const f = await fixture(t), plan = await f.plan()
  const name = `.opencode/workflow/.state/onboarding/${plan.id}.json`, original = await f.read(name)
  for (const mutate of [
    (saved: any) => { saved.plan.request.choices.superpowers = 'existing' },
    (saved: any) => { saved.plan.changes[0].after = 'sha256:' + '0'.repeat(64) },
    (saved: any) => { saved.plan.warnings.push('changed warning') },
    (saved: any) => { saved.observations[0].digest = 'sha256:' + '0'.repeat(64) },
  ]) {
    const saved = JSON.parse(original); mutate(saved); await f.put(name, JSON.stringify(saved))
    await assert.rejects(files.readSetupPlan(f.root, plan.id), /摘要|改写|无效/)
    await assert.rejects(f.apply(plan.id), /摘要|改写|无效/)
    await absent(join(f.root, config.SETUP_PROFILE))
  }
})

test('项目配置硬链接不得写穿个人全局配置，预览与应用均拒绝共享 inode', async t => {
  const f = await fixture(t), original = '{"agents":{"reviewer":{"model":"demo/global","permissions":[{"action":"edit","effect":"deny"}]}}}'
  await f.put('.config/opencode/opencode.jsonc', original, f.home)
  await link(join(f.home, '.config/opencode/opencode.jsonc'), join(f.root, 'opencode.jsonc'))
  await assert.rejects(f.plan(), /硬链接|共享.*inode/)
  assert.equal(await f.read('.config/opencode/opencode.jsonc', f.home), original)
  await rm(join(f.root, 'opencode.jsonc'))
  const plan = await f.plan()
  await link(join(f.home, '.config/opencode/opencode.jsonc'), join(f.root, 'opencode.jsonc'))
  await assert.rejects(f.apply(plan.id), /硬链接|共享.*inode/)
  assert.equal(await f.read('.config/opencode/opencode.jsonc', f.home), original)
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('共享 inode 的 profile、计划、进度和 hook 同样拒绝，不覆盖外部硬链接', async t => {
  const f = await fixture(t), plan = await f.plan(), name = `.opencode/workflow/.state/onboarding/${plan.id}.json`
  const outside = join(f.base, 'shared-plan')
  await link(join(f.root, name), outside)
  await assert.rejects(files.readSetupPlan(f.root, plan.id), /硬链接|共享.*inode/)
  await assert.rejects(f.apply(plan.id), /硬链接|共享.*inode/)
  await rm(outside)
  await f.apply(plan.id)
  const progress = `.opencode/workflow/.state/onboarding/${plan.id}.applied.json`
  await link(join(f.root, progress), outside)
  await assert.rejects(f.apply(plan.id), /硬链接|共享.*inode/)
  await rm(outside)
  await link(join(f.root, config.SETUP_PROFILE), outside)
  await assert.rejects(config.readSetupChoices(f.root), /硬链接|共享.*inode/)
  await rm(outside)
  const hookChoices = choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } })
  await f.apply((await f.plan(hookChoices, suite)).id)
  const hook = await f.read('.git/hooks/post-commit')
  await link(join(f.root, '.git/hooks/post-commit'), outside)
  await assert.rejects(f.plan(hookChoices), /硬链接|共享.*inode/)
  assert.equal(await readFile(outside, 'utf8'), hook)
})

for (const fault of ['write', 'close'] as const) test(`活动配置 ${fault} ENOSPC 时保持原文与权限，不遗留临时文件`, async t => {
    const f = await fixture(t), target = join(f.root, 'opencode.jsonc')
    const original = '{"model":"demo/main","agents":{"reviewer":{"model":"demo/old","permissions":[{"action":"edit","effect":"deny"}]}}}'
    await f.put('opencode.jsonc', original); await chmod(target, 0o640)
    const mode = (await lstat(target)).mode, plan = await f.plan(), originalOpen = fsPromises.open
    let injected = false
    t.mock.method(fsPromises, 'open', async (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
      const handle = await originalOpen(file, flags, mode)
      if (!injected && (typeof flags === 'number' ? !!(flags & (constants.O_WRONLY | constants.O_RDWR)) : /[wa+]/.test(flags ?? '')) && String(file).startsWith(target)) {
        const write = handle.writeFile.bind(handle), close = handle.close.bind(handle)
        if (fault === 'write') t.mock.method(handle, 'writeFile', async () => {
          injected = true; await write('{"mod'); throw Object.assign(new Error('合成 ENOSPC'), { code: 'ENOSPC' })
        })
        else t.mock.method(handle, 'close', async () => {
          await close()
          if (!injected) { injected = true; throw Object.assign(new Error('合成 ENOSPC'), { code: 'ENOSPC' }) }
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    try { await assert.rejects(f.apply(plan.id), { code: 'ENOSPC' }) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(injected, true)
    assert.equal(await f.read('opencode.jsonc'), original)
    assert.equal((await lstat(target)).mode, mode)
    assert.deepEqual((await readdir(f.root)).filter(name => name.endsWith('.tmp')), [])
    await absent(join(f.root, config.SETUP_PROFILE))
})

test('保存计划部分写入失败也清理临时文件，不留下半份状态', async t => {
  const f = await fixture(t), originalOpen = fsPromises.open
  let injected = false
  t.mock.method(fsPromises, 'open', async (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    const handle = await originalOpen(file, flags, mode)
    if (!injected && flags !== 0 && String(file).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle)
      t.mock.method(handle, 'writeFile', async () => { injected = true; await write('{'); throw Object.assign(new Error('合成 ENOSPC'), { code: 'ENOSPC' }) })
    }
    return handle
  })
  syncBuiltinESMExports()
  try { await assert.rejects(f.plan(), { code: 'ENOSPC' }) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(injected, true)
  assert.deepEqual(await readdir(join(f.root, '.opencode/workflow/.state/onboarding')), [])
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('keep hook 不重跑已修改安装器，保留原 hook 正文和权限', async t => {
  const f = await fixture(t), value = choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } })
  await f.apply((await f.plan(value, suite)).id)
  const hook = await f.read('.git/hooks/post-commit'), mode = (await lstat(join(f.root, '.git/hooks/post-commit'))).mode
  const installer = await f.read('scripts/quality/install-hooks.py')
  await f.put('scripts/quality/install-hooks.py', installer.replace("hook.write_bytes(dispatcher(relative).encode('utf-8'))", "hook.write_bytes(b'#!/bin/sh\\n# incomplete hook\\n')\n        raise OSError('synthetic write failure')"))
  const plan = await f.plan(value)
  assert.equal(plan.changes.find(change => change.path.endsWith('hooks/post-commit'))?.operation, 'keep')
  assert.equal((await f.apply(plan.id)).applied, false)
  assert.equal(await f.read('.git/hooks/post-commit'), hook)
  assert.equal((await lstat(join(f.root, '.git/hooks/post-commit'))).mode, mode)
})

test('安装器留下非预期半份 hook 后失败时移除新 hook，并撤销本轮配置和质量文件', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base)
  const installerPath = join(source, 'optional/quality/install-hooks.py'), installer = await readFile(installerPath, 'utf8')
  await writeFile(installerPath, installer.replace("hook.write_bytes(dispatcher(relative).encode('utf-8'))", "hook.write_bytes(b'#!/bin/sh\\n# incomplete hook\\n')\n        raise OSError('synthetic write failure')"))
  const original = '{"agents":{"reviewer":{"model":"demo/old","permissions":[]}}}'
  await f.put('opencode.jsonc', original); await chmod(join(f.root, 'opencode.jsonc'), 0o640)
  const mode = (await lstat(join(f.root, 'opencode.jsonc'))).mode
  const plan = await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }), source)
  await assert.rejects(f.apply(plan.id), /hook.*未完成|hook.*不匹配/)
  await absent(join(f.root, '.git/hooks/post-commit')); await absent(join(f.root, config.SETUP_PROFILE))
  await absent(join(f.root, 'scripts/quality/run-hook.py'))
  assert.equal(await f.read('opencode.jsonc'), original)
  assert.equal((await lstat(join(f.root, 'opencode.jsonc'))).mode, mode)
})

test('回滚自身失败必须显式报告未恢复的路径，不能吞掉恢复错误', async t => {
  const f = await fixture(t), originalOpen = fsPromises.open
  const original = '{"agents":{"reviewer":{"model":"demo/old"}}}'
  await f.put('opencode.json', original); await f.put('opencode.jsonc', original)
  const plan = await f.plan()
  let firstWritten = false, failed = false
  t.mock.method(fsPromises, 'open', async (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    const handle = await originalOpen(file, flags, mode)
    const writable = typeof flags === 'number' ? !!(flags & (constants.O_WRONLY | constants.O_RDWR)) : /[wa+]/.test(flags ?? '')
    if (writable && String(file).startsWith(join(f.root, 'opencode.json'))) {
      const write = handle.writeFile.bind(handle)
      if (String(file).startsWith(join(f.root, 'opencode.jsonc'))) t.mock.method(handle, 'writeFile', async () => { failed = true; throw Object.assign(new Error('合成 ENOSPC'), { code: 'ENOSPC' }) })
      else if (firstWritten && failed) t.mock.method(handle, 'writeFile', async () => { throw Object.assign(new Error('合成恢复失败'), { code: 'EACCES' }) })
      else t.mock.method(handle, 'writeFile', async (...args: Parameters<typeof handle.writeFile>) => { await write(...args); firstWritten = true })
    }
    return handle
  })
  syncBuiltinESMExports()
  try { await assert.rejects(f.apply(plan.id), /回滚未完成.*opencode\.json/) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(firstWritten, true); assert.equal(failed, true)
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('JSON 与 YAML 流式映射及复杂键 frontmatter 明确拒绝，不留下继承与旧 model 并存', async t => {
  const f = await fixture(t)
  for (const frontmatter of [
    '{"description":"审核","model":"demo/old","permissions":[{"action":"edit","effect":"deny"}]}',
    '{description: 审核, model: demo/old, permissions: [{action: edit, effect: deny}]}',
    '{\n description: 审核,\n model: demo/old,\n permissions: [{action: edit, effect: deny}]\n}',
    '? model\n: demo/old\npermissions:\n  - { action: edit, effect: deny }',
    '"mo\\u0064el": demo/old\npermissions:\n  - { action: edit, effect: deny }',
  ]) {
    const original = `---\n${frontmatter}\n---\n审核正文。\n`
    await f.put('.opencode/agents/reviewer.md', original)
    await assert.rejects(f.plan(), /frontmatter.*人工|人工.*frontmatter/)
    assert.equal(await f.read('.opencode/agents/reviewer.md'), original)
    await absent(join(f.root, config.SETUP_PROFILE))
  }
})

test('hook 去掉 POSIX 执行位后 inspect 不能继续 configured，Windows 保持原生可执行语义', async t => {
  const f = await fixture(t)
  await f.apply((await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }), suite)).id)
  await chmod(join(f.root, '.git/hooks/post-commit'), 0o600)
  const inspect = await files.inspectSetup(f.root)
  if (process.platform === 'win32') assert.equal(inspect.components.quality.status, 'configured')
  else {
    assert.equal(inspect.components.quality.status, 'missing')
    assert.ok(inspect.issues.some(issue => /质量/.test(issue)))
    assert.throws(() => f.git('hook', 'run', 'post-commit'))
  }
})

test('原计划重放须核对实际 hook 可执行性，不只核对正文', async t => {
  const f = await fixture(t), plan = await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }), suite)
  await f.apply(plan.id)
  await chmod(join(f.root, '.git/hooks/post-commit'), 0o600)
  if (process.platform === 'win32') assert.equal((await f.apply(plan.id)).applied, false)
  else await assert.rejects(f.apply(plan.id), /可执行|执行属性|改变|过期/)
})

test('新预览显式列出执行属性修复，并用实际安装器恢复 hook 可执行性', async t => {
  const f = await fixture(t), value = choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } })
  await f.apply((await f.plan(value, suite)).id)
  await chmod(join(f.root, '.git/hooks/post-commit'), 0o600)
  const plan = await f.plan(value), hook = plan.changes.find(change => change.path.endsWith('hooks/post-commit'))!
  assert.equal(hook.operation, process.platform === 'win32' ? 'keep' : 'update')
  if (process.platform !== 'win32') assert.ok(plan.warnings.some(warning => /可执行|执行属性/.test(warning)))
  await f.apply(plan.id)
  assert.equal((await files.inspectSetup(f.root)).components.quality.status, 'configured')
})

test('修复执行属性的安装器写坏已有 hook 后失败，恢复原 hook 正文及原 mode', async t => {
  const f = await fixture(t), value = choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } })
  await f.apply((await f.plan(value, suite)).id)
  const hook = await f.read('.git/hooks/post-commit')
  await chmod(join(f.root, '.git/hooks/post-commit'), 0o600)
  const mode = (await lstat(join(f.root, '.git/hooks/post-commit'))).mode, installer = await f.read('scripts/quality/install-hooks.py')
  await f.put('scripts/quality/install-hooks.py', installer.replace("hook.write_bytes(dispatcher(relative).encode('utf-8'))", "hook.write_bytes(b'#!/bin/sh\\n# incomplete hook\\n')\n        hook.chmod(0o777)\n        raise OSError('synthetic write failure')"))
  const plan = await f.plan(value)
  if (process.platform === 'win32') assert.equal((await f.apply(plan.id)).applied, false)
  else await assert.rejects(f.apply(plan.id), /hook.*未完成|hook.*不匹配/)
  assert.equal(await f.read('.git/hooks/post-commit'), hook)
  assert.equal((await lstat(join(f.root, '.git/hooks/post-commit'))).mode, mode)
})

test('安装器退出零且正文正确但未设置执行属性时不能接受为成功', async t => {
  const f = await fixture(t), source = await sourceCopy(f.base), installerPath = join(source, 'optional/quality/install-hooks.py')
  const installer = await readFile(installerPath, 'utf8')
  await writeFile(installerPath, installer.replace('hook.chmod(hook.stat().st_mode | 0o111)', 'hook.chmod(0o600)'))
  const plan = await f.plan(choices({ components: { quality: 'hook', ci: false, release: false, mcp: false } }), source)
  if (process.platform === 'win32') assert.equal((await f.apply(plan.id)).applied, true)
  else {
    await assert.rejects(f.apply(plan.id), /hook.*不可执行|hook.*未完成/)
    await absent(join(f.root, '.git/hooks/post-commit')); await absent(join(f.root, config.SETUP_PROFILE))
    await absent(join(f.root, 'scripts/quality/run-hook.py'))
  }
})

for (const [label, frontmatter] of [
  ['空格缩进 JSON', '  {"description":"审核","model":"demo/old","permissions":[{"action":"edit","effect":"deny"}]}'],
  ['制表符前缀 JSON', '\t {"description":"审核","model":"demo/old","permissions":[{"action":"edit","effect":"deny"}]}'],
  ['空白与缩进注释后的 YAML', ' \n  # 代理配置\n\t\n  {description: 审核, model: demo/old, permissions: [{action: edit, effect: deny}]}'],
  ['注释后的多行根流式映射', '# 代理配置\n  {\n    description: 审核,\n    model: demo/old,\n    permissions: [{action: edit, effect: deny}]\n  }'],
] as const) test(`根节点空白与注释不能绕过复杂 frontmatter 拒绝：${label}`, async t => {
  const f = await fixture(t), original = `---\n${frontmatter}\n---\n审核正文。\n`
  await f.put('.opencode/agents/reviewer.md', original)
  await assert.rejects(f.plan(), /frontmatter.*人工|人工.*frontmatter/)
  assert.equal(await f.read('.opencode/agents/reviewer.md'), original)
  await absent(join(f.root, config.SETUP_PROFILE))
})

test('简单块映射根节点之前的空白与缩进注释保留，模型删除不影响权限和正文', async t => {
  const f = await fixture(t)
  const original = '---\n \n  # 代理配置\n\t\ndescription: 审核\nmodel: demo/old\npermissions:\n  - { action: edit, effect: deny }\n---\n审核正文。\n'
  await f.put('.opencode/agents/reviewer.md', original)
  await f.apply((await f.plan()).id)
  assert.equal(await f.read('.opencode/agents/reviewer.md'), original.replace('model: demo/old\n', ''))
  assert.deepEqual((await config.readSetupChoices(f.root))?.models.reviewer, { mode: 'inherit' })
})

for (const [label, opening] of [['BOM', '\uFEFF---\n'], ['分隔行尾随空白', '--- \t\r\n']] as const) test(`OpenCode 接受的${label} frontmatter 也删除模型`, async t => {
  const f = await fixture(t)
  const original = `${opening}description: 审核\nmodel: demo/old\n---\n审核正文。\n`
  await f.put('.opencode/agents/reviewer.md', original)
  await f.apply((await f.plan()).id)
  const bom = /^\uFEFF/
  assert.equal((await f.read('.opencode/agents/reviewer.md')).replace(bom, ''), original.replace(bom, '').replace('model: demo/old\n', ''))
})

test('新建的项目文件遵循 umask，计划状态文件仅属主可读', async t => {
  const f = await fixture(t), umask = process.umask(0o022)
  t.after(async () => { process.umask(umask) })
  const plan = await f.plan()
  await f.apply(plan.id)
  const mode = async (name: string) => (await lstat(join(f.root, name))).mode & 0o777
  if (process.platform !== 'win32') {
    assert.equal(await mode('.opencode/workflow/onboarding.json'), 0o644)
    assert.equal(await mode(`.opencode/workflow/.state/onboarding/${plan.id}.json`), 0o600)
  }
})

test('JSONC 损坏、重复字段或复杂代理结构在预览阶段拒绝', async t => {
  const f = await fixture(t)
  for (const content of ['{ invalid', '{"agents":[],"model":"demo/main"}', '{"agents":{"reviewer":null}}', '{"agents":{},"agents":{}}']) {
    await f.put('opencode.jsonc', content)
    await assert.rejects(f.plan(), /配置|重复|人工/)
    assert.equal(await f.read('opencode.jsonc'), content)
    await absent(join(f.root, config.SETUP_PROFILE))
  }
})
