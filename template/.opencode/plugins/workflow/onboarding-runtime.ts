import type { Plugin } from '@opencode/plugin'
import type { AgentInfo, ModelInfo, ModelRef, PluginInfo, SkillInfo } from '@opencode/client'
import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { childOptions, killTree, findExecutable, containedRelative, samePath, nodeCheckCommand, pythonEnv } from './platform.ts'
import { scopeRoot } from './scopes.ts'
import { SUPERPOWERS_SOURCE, SUPERPOWERS_SPEC, SUPERPOWERS_REVISION } from './onboarding-source.ts'
import { SETUP_PROFILE, managedRoles, readSetupChoices, type SetupChoices } from './onboarding-config.ts'
import { agentPath } from './onboarding-agents.ts'
import { REVIEWER } from './review.ts'

const normalize = (text: string) => text.replaceAll('\r\n', '\n')
const hash = (text: string) => createHash('sha256').update(normalize(text)).digest('hex')
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const stable = (value: unknown) => JSON.stringify(value, (_key, part: unknown) => object(part) ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part)
const sorted = <T>(values: T[]): T[] => [...values].sort((a, b) => stable(a).localeCompare(stable(b)))
const requiredSkills = ['brainstorming', 'writing-plans'] as const
const skillBody = (text: string) => normalize(text).replace(/^---\n[\s\S]*?\n---\n/, '')
export type SourcePin = { spec: string; revision: string; files: Readonly<Record<string, string>>; skills: Readonly<Record<string, string>> }
export type SourceSnapshot = {
  plugins: PluginInfo[]; skills: SkillInfo[]
  installation?: { root: string; files: Record<string, string>; skills: Record<string, string> }
}
export type InstalledSuperpowers = { type: PluginInfo['source']['type']; source: string; version: string | null; status: PluginInfo['state']['status']; error?: string }
export type SuperpowersCheck = { issues: string[]; pinIssues: string[]; installed: InstalledSuperpowers[]; skills: SkillInfo[]; fingerprint: string }
const fixedPin: SourcePin = { spec: SUPERPOWERS_SPEC, revision: SUPERPOWERS_REVISION, files: SUPERPOWERS_SOURCE.files, skills: SUPERPOWERS_SOURCE.skills }

// 列出全部同 id 插件，供展示和 bootstrap 判断；版本优先取唯一 active 那份安装目录中的 package.json。
// 该文件只在 name 为 superpowers 时才算 Superpowers 的清单，版本号限长，避免把无关或超长内容带进输出。
export function installedSuperpowers(plugins: PluginInfo[], manifest?: unknown): InstalledSuperpowers[] {
  const candidates = plugins.filter(plugin => plugin.id === 'superpowers')
  const active = candidates.length === 1 && candidates[0].state.status === 'active' ? candidates[0] : undefined
  const listed = object(manifest) && manifest.name === 'superpowers' && typeof manifest.version === 'string' && /^[\w.+-]{1,64}$/.test(manifest.version) ? manifest.version : undefined
  return candidates.map(plugin => {
    const source = plugin.source, state = plugin.state, declared = source.type === 'package' ? source.version ?? null : null
    return {
      type: source.type, source: source.type === 'package' ? source.target : source.type === 'local' ? source.path : source.type,
      version: plugin === active && listed !== undefined ? listed : declared, status: state.status,
      ...(state.status === 'failed' ? { error: state.error.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
    }
  })
}

// pin 由调用方信任的代码提供；原生工具只使用本模块的固定来源，不接受模型传入摘要。
// issues 是任何版本都要满足的来源结构；pinIssues 是与固定版本的差异，只有明确选择沿用已有安装时不拦截。
export function verifySuperpowers(snapshot: SourceSnapshot, pin: SourcePin = fixedPin): SuperpowersCheck {
  const issues: string[] = [], pinIssues: string[] = [], candidates = snapshot.plugins.filter(plugin => plugin.id === 'superpowers')
  const plugin = candidates.length === 1 ? candidates[0] : undefined, installation = snapshot.installation
  let manifest: unknown
  try { manifest = installation && typeof installation.files['package.json'] === 'string' ? JSON.parse(installation.files['package.json']) : undefined } catch { manifest = undefined }
  if (!plugin || plugin.state.status !== 'active' || !plugin.features.server) issues.push('未检测到唯一且 active 的 Superpowers 服务插件')
  if (!installation) issues.push('无法核对宿主报告的 Superpowers 安装路径与源码')
  if (plugin && installation) {
    const source = plugin.source
    if (source.type === 'package') {
      // 包插件的安装目录由技能路径推断，靠 package.json 排除恰好同名的其他技能目录。
      if (!object(manifest) || manifest.name !== 'superpowers') issues.push('Superpowers 包安装目录无法确认：package.json 缺失、无效或 name 不是 superpowers')
      if (source.target !== pin.spec || source.version !== pin.revision) pinIssues.push('Superpowers 包来源或版本不是已核对的固定提交')
    } else if (source.type !== 'local' || ![installation.root, join(installation.root, 'index.js')].some(path => samePath(path, source.path))) issues.push('Superpowers 实际 local 入口与技能安装目录不一致')
    const matches = (id: string, digest?: string) => {
      const found = snapshot.skills.filter(skill => skill.id === id), skill = found.length === 1 ? found[0] : undefined, text = installation.skills[id]
      return !!skill && skill.name === id && samePath(skill.path, join(installation.root, 'skills', id, 'SKILL.md')) && typeof text === 'string' && hash(skill.content) === hash(skillBody(text)) && (digest === undefined || hash(skill.content) === digest)
    }
    for (const id of requiredSkills) if (!matches(id)) issues.push(`Superpowers 技能来源、路径或完整正文不符：${id}`)
    for (const [name, digest] of Object.entries(pin.files)) if (typeof installation.files[name] !== 'string' || hash(installation.files[name]) !== digest) pinIssues.push(`Superpowers 安装源码摘要不符：${name}`)
    for (const [id, digest] of Object.entries(pin.skills)) if (!matches(id, digest)) pinIssues.push(`Superpowers 技能正文不是已核对的固定版本：${id}`)
  }
  const fingerprint = hash(stable({ plugins: sorted(snapshot.plugins), skills: sorted(snapshot.skills.map(skill => ({ ...skill, content: hash(skill.content) }))), installation: installation && { root: installation.root, files: Object.fromEntries(Object.entries(installation.files).map(([name, text]) => [name, hash(text)])), skills: Object.fromEntries(Object.entries(installation.skills).map(([name, text]) => [name, hash(text)])) } }))
  return { issues, pinIssues, installed: installedSuperpowers(snapshot.plugins, manifest), skills: issues.length ? [] : snapshot.skills.filter(skill => requiredSkills.includes(skill.id as typeof requiredSkills[number])), fingerprint }
}

export class SkillEvidence {
  private states = new Map<string, { binding: string; read: Set<string>; calls: Set<string> }>()
  has(sessionID: string): boolean { return this.states.has(sessionID) }
  checkpoint(sessionID: string, binding: string): object { return this.state(sessionID, binding) }
  isCurrent(sessionID: string, checkpoint: object): boolean { return this.states.get(sessionID) === checkpoint }
  private state(sessionID: string, binding: string) {
    let state = this.states.get(sessionID)
    if (!state || state.binding !== binding) { state = { binding, read: new Set(), calls: new Set() }; this.states.set(sessionID, state) }
    return state
  }
  begin(sessionID: string, callID: string, binding: string): void { this.state(sessionID, binding).calls.add(callID) }
  invalidate(sessionID: string): void { this.states.delete(sessionID) }
  invalidateAll(): void { this.states.clear() }
  reads(sessionID: string, binding: string): string[] { return [...this.state(sessionID, binding).read].sort() }
  complete(sessionID: string, callID: string, binding: string, skill: SkillInfo, result: unknown): boolean {
    const state = this.state(sessionID, binding)
    state.read.delete(skill.id)
    if (!state.calls.delete(callID) || !object(result)) return false
    const content = typeof result.content === 'string' ? result.content : Array.isArray(result.content) && result.content.every((part: unknown) => object(part) && part.type === 'text' && typeof part.text === 'string') ? result.content.map((part: { text: string }) => part.text).join('') : ''
    if (!object(result.metadata) || result.metadata.name !== skill.id || typeof result.metadata.directory !== 'string' || !samePath(result.metadata.directory, dirname(skill.path))) return false
    const text = normalize(content), start = text.indexOf(`<skill_content name="${skill.id}">`), end = text.indexOf('</skill_content>', start)
    if (start < 0 || end < 0 || !text.slice(start, end).includes(normalize(skill.content))) return false
    state.read.add(skill.id)
    return true
  }
}

export function checkModels(choices: SetupChoices, models: ModelInfo[], agents: Record<string, Pick<AgentInfo, 'id'> & Partial<AgentInfo>>, requireEffective = true): { issues: string[] } {
  const issues: string[] = []
  for (const [role, choice] of managedRoles(choices)) {
    const effective = agents[role]
    if (requireEffective) {
      if (!effective || effective.id !== role) { issues.push(`无法确认有效 ${role} 代理`); continue }
      if (!['subagent', 'all'].includes(effective.mode ?? '') || typeof effective.system !== 'string' || !effective.system.trim()) {
        issues.push(`${role} 没有正确加载为可用子代理或缺少说明；空 model 可能使 Markdown 代理文件被忽略，请修复后重载`)
        continue
      }
    }
    if (choice.mode === 'inherit') {
      if (requireEffective && effective.model !== undefined) issues.push(`${role} 已选择动态继承，但有效 agent.model 存在覆盖；请检查上级、全局及 Markdown 代理配置并重载`)
      continue
    }
    const [name, variant] = choice.model.split('#'), slash = name.indexOf('/'), providerID = name.slice(0, slash), id = name.slice(slash + 1)
    const model = models.find(model => model.providerID === providerID && model.id === id)
    if (!model || !model.enabled || model.capabilities.tools !== true || variant && !model.variants.some(value => value.id === variant)) issues.push(`${role} 固定模型不存在、已禁用、不支持工具或 variant 无效：${choice.model}`)
    if (requireEffective && (!effective.model || effective.model.providerID !== providerID || effective.model.id !== id || effective.model.variant !== variant)) issues.push(`${role} 有效模型与固定选择不一致；请应用配置并重载后核验`)
  }
  return { issues }
}

// 宿主按 显式 model → 代理 model → 父会话 model 解析子代理模型：继承时 variant 随父会话，固定且不写 variant 时用模型默认。
export function describeEffort(choices: SetupChoices, models: ModelInfo[]): Record<string, string> {
  const describe = (choice: SetupChoices['models']['implementer']) => {
    if (choice.mode === 'inherit') return '继承：跟随发起会话的模型和思考强度'
    const [name, variant] = choice.model.split('#'), slash = name.indexOf('/')
    if (variant) return `固定 ${name}，思考强度 ${variant}`
    const options = models.find(model => model.providerID === name.slice(0, slash) && model.id === name.slice(slash + 1))?.variants.map(value => value.id) ?? []
    return options.length ? `固定 ${name}，未选择思考强度：使用模型默认，不跟随主会话（可选：${options.join('、')}）` : `固定 ${name}，该模型没有可选思考强度`
  }
  return Object.fromEntries(managedRoles(choices).map(([role, choice]) => [role, describe(choice)]))
}

async function boundedText(file: string, anchor: string): Promise<string> {
  if (!isAbsolute(file) || !(samePath(anchor, file) || containedRelative(anchor, file))) throw new Error('运行时核验路径越界')
  const actual = await realpath(file)
  if (!(samePath(anchor, actual) || containedRelative(anchor, actual))) throw new Error('运行时核验路径越界或链接指向安装目录之外')
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('运行时核验目标不是有界常规文件')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = await handle.readFile()
    if (bytes.length > 1024 * 1024) throw new Error('运行时核验输出过大')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { await handle.close() }
}
async function optionalText(root: string, name: string): Promise<string | null> {
  try { return await boundedText(join(root, name), root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function sourceSnapshot(plugins: PluginInfo[], skills: SkillInfo[]): Promise<SourceSnapshot> {
  const snapshot: SourceSnapshot = { plugins, skills }, plugin = plugins.find(plugin => plugin.id === 'superpowers' && plugin.state.status === 'active')
  if (!plugin) return snapshot
  let root: string
  if (plugin.source.type === 'local') {
    const path = plugin.source.path
    if (!isAbsolute(path)) throw new Error('Superpowers 宿主安装路径不是绝对路径')
    root = await realpath((await lstat(path)).isDirectory() ? path : dirname(path))
  } else if (plugin.source.type === 'package') {
    // 宿主不报告包插件的安装目录：只在技能文件位于 <根>/skills/brainstorming/ 时由它推断，不读取无关的上级目录。
    const skill = skills.find(skill => skill.id === 'brainstorming')
    if (!skill || !isAbsolute(skill.path)) return snapshot
    const directory = dirname(skill.path)
    if (basename(skill.path) !== 'SKILL.md' || basename(directory) !== 'brainstorming' || basename(dirname(directory)) !== 'skills') return snapshot
    root = await realpath(resolve(directory, '../..'))
  } else return snapshot
  // 固定版本独有的文件可以缺失，只算与固定版本不同；越界、链接、超限或非 UTF-8 仍然整体拒绝。
  const files: Record<string, string> = {}, contents: Record<string, string> = {}
  for (const name of Object.keys(SUPERPOWERS_SOURCE.files)) {
    const text = await optionalText(root, name)
    if (text !== null) files[name] = text
  }
  for (const id of new Set<string>([...requiredSkills, ...Object.keys(SUPERPOWERS_SOURCE.skills)])) {
    const text = await optionalText(root, join('skills', id, 'SKILL.md'))
    if (text !== null) contents[id] = text
  }
  snapshot.installation = { root, files, skills: contents }
  return snapshot
}

export async function probeSetupRuntime(ctx: Plugin.Context, sessionID: Parameters<Plugin.Context['session']['get']>[0]['sessionID'], currentModel?: ModelRef) {
  const session = await ctx.session.get({ sessionID }), directory = session.location.directory
  const found = await scopeRoot(directory)
  if (!found) throw new Error('未找到当前 Location 的 Git 检出根')
  const root = await realpath(found), location = { directory }
  const [modelList, implementer, reviewer] = await Promise.all([ctx.model.list({ location }), ctx.agent.get({ agentID: 'implementer', location }), ctx.agent.get({ agentID: REVIEWER, location })])
  if (!Array.isArray(modelList.data) || !implementer.data || !reviewer.data) throw new Error('宿主模型或有效代理目录返回无效')
  // 受管子代理按档案逐个读取；档案无效时由 inspectSetup 报告，宿主没有返回的代理留给 checkModels 报告缺失。
  const managed = await readSetupChoices(root).then(choices => choices?.agents.map(agent => agent.name) ?? [], () => [] as string[])
  const extra = await Promise.all(managed.map(agentID => ctx.agent.get({ agentID, location }).then(result => result.data ?? undefined, () => undefined)))
  const agents: Record<string, AgentInfo> = { implementer: implementer.data, reviewer: reviewer.data }
  managed.forEach((name, index) => { const agent = extra[index]; if (agent) agents[name] = agent })
  let superpowers: SuperpowersCheck, plugins: PluginInfo[] = []
  try {
    // 技能目录出错时插件列表照常保留，bootstrap 仍能看到已登记的 Superpowers。
    const [pluginList, skillList] = await Promise.allSettled([ctx.plugin.list({ location }), ctx.skill.list({ location })])
    if (pluginList.status === 'fulfilled' && Array.isArray(pluginList.value.data)) plugins = pluginList.value.data
    if (pluginList.status === 'rejected') throw pluginList.reason
    if (skillList.status === 'rejected') throw skillList.reason
    if (!Array.isArray(pluginList.value.data) || !Array.isArray(skillList.value.data)) throw new Error('宿主插件或技能目录返回无效')
    superpowers = verifySuperpowers(await sourceSnapshot(plugins, skillList.value.data))
  } catch (error) {
    // 读取安装文件出错时仍按已取得的插件列表报告已登记的 Superpowers，bootstrap 据此不再登记第二份。
    superpowers = { issues: [`Superpowers 运行时核验失败：${(error as Error).message}`], pinIssues: [], installed: installedSuperpowers(plugins), skills: [], fingerprint: 'unavailable' }
  }
  const config = await Promise.all(['opencode.json', 'opencode.jsonc', SETUP_PROFILE, '.opencode/agents/implementer.md', '.opencode/agents/reviewer.md', '.opencode/agent/implementer.md', '.opencode/agent/reviewer.md', '.opencode/workflow/protection.json', ...managed.map(agentPath)].map(async name => [name, hash(await optionalText(root, name) ?? '<missing>')]))
  // 宿主异步刷新目录会重排；证据绑定模型身份与可用能力，不绑定价格和显示字段。
  const models = sorted(modelList.data.map(model => ({ providerID: model.providerID, id: model.id, enabled: model.enabled, tools: model.capabilities.tools, variants: model.variants.map(variant => variant.id).sort() })))
  const fingerprint = hash(stable({ directory, root, config, superpowers: superpowers.fingerprint, models, agents, sessionModel: session.model, currentModel }))
  return { root, directory, session, models: modelList.data, agents, superpowers, currentModel: currentModel ?? session.model, fingerprint }
}

export type DoctorReport = { ok: boolean; checks: { id: string; status: 'pass' | 'fail' | 'warn' | 'unverified'; message: string }[] }
export async function runSetupDoctor(root: string, { signal, timeoutMs = 180_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DoctorReport> {
  if (signal?.aborted) throw new Error('接入自检已取消')
  const node = findExecutable('node')
  if (!node) throw new Error('找不到外部 Node.js，无法执行真正的 doctor；嵌入式 OpenCode 不是 Node')
  const script = join(root, 'scripts/workflow/doctor.mjs')
  await boundedText(script, root)
  return new Promise((done, fail) => {
    const invocation = nodeCheckCommand(node, [script, '--root', root, '--json'])
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: pythonEnv(), stdio: ['ignore', 'pipe', 'pipe'], ...childOptions() })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0, settled = false
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const stop = (message: string) => {
      if (settled) return
      settled = true; killTree(child); cleanup(); fail(new Error(message))
    }
    const abort = () => stop('接入自检已取消')
    const timer = setTimeout(() => stop('接入自检超时，未确认就绪'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const consume = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) { stop('接入自检输出超过 1 MiB'); return }
      if (error) stderr.push(chunk); else stdout.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, false)); child.stderr.on('data', (chunk: Buffer) => consume(chunk, true))
    child.on('error', error => stop(`无法启动接入自检：${error.message}`))
    child.on('close', code => {
      if (settled) return
      settled = true; killTree(child); cleanup()
      try {
        const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout))
        const errorOutput = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stderr))
        if (code !== 0) throw new Error(`doctor 失败，退出码 ${code}；${errorOutput.slice(0, 2000)}\n${output.slice(0, 8000)}`)
        const report: unknown = JSON.parse(output)
        if (!object(report) || typeof report.ok !== 'boolean' || !Array.isArray(report.checks) || !report.checks.length || report.checks.some((check: unknown) => !object(check) || typeof check.id !== 'string' || !check.id || !['pass', 'fail', 'warn', 'unverified'].includes(check.status) || typeof check.message !== 'string') || !report.ok || report.checks.some((check: { status: string }) => check.status === 'fail')) throw new Error('doctor 报告无效、没有实际检查或存在失败')
        done(report as DoctorReport)
      } catch (error) { fail(new Error(`接入自检未通过：${(error as Error).message}`)) }
    })
  })
}
