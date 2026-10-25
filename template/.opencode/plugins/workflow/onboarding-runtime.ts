import type { Plugin } from '@opencode/plugin'
import type { AgentInfo, ModelInfo, ModelRef, PluginInfo, SkillInfo } from '@opencode/client'
import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { childOptions, killTree, findExecutable, containedRelative, samePath, nodeCheckCommand, pythonEnv } from './platform.ts'
import { scopeRoot } from './scopes.ts'
import { SUPERPOWERS_SOURCE, SUPERPOWERS_SPEC, SUPERPOWERS_REVISION } from './onboarding-source.ts'
import { SETUP_PROFILE, type SetupChoices } from './onboarding-config.ts'
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
const fixedPin: SourcePin = { spec: SUPERPOWERS_SPEC, revision: SUPERPOWERS_REVISION, files: SUPERPOWERS_SOURCE.files, skills: SUPERPOWERS_SOURCE.skills }

// pin 由调用方信任的代码提供；原生工具只使用本模块的固定来源，不接受模型传入摘要。
export function verifySuperpowers(snapshot: SourceSnapshot, pin: SourcePin = fixedPin): { issues: string[]; skills: SkillInfo[]; fingerprint: string } {
  const issues: string[] = [], candidates = snapshot.plugins.filter(plugin => plugin.id === 'superpowers')
  const plugin = candidates.length === 1 ? candidates[0] : undefined, installed = snapshot.installation
  if (!plugin || plugin.state.status !== 'active' || !plugin.features.server) issues.push('未检测到唯一且 active 的 Superpowers 服务插件')
  if (!installed) issues.push('无法核对宿主报告的 Superpowers 安装路径与源码')
  if (plugin && installed) {
    const source = plugin.source
    if (source.type === 'package') {
      if (source.target !== pin.spec || source.version !== pin.revision) issues.push('Superpowers 包来源或版本不是已核对的固定提交；保留原安装，请人工处理或选择基础模式')
    } else if (source.type !== 'local' || ![installed.root, join(installed.root, 'index.js')].some(path => samePath(path, source.path))) issues.push('Superpowers 实际 local 入口与技能安装目录不一致')
    for (const [name, digest] of Object.entries(pin.files)) if (typeof installed.files[name] !== 'string' || hash(installed.files[name]) !== digest) issues.push(`Superpowers 安装源码摘要不符：${name}`)
    for (const [id, digest] of Object.entries(pin.skills)) {
      const found = snapshot.skills.filter(skill => skill.id === id), skill = found.length === 1 ? found[0] : undefined
      if (!skill || skill.name !== id || !samePath(skill.path, join(installed.root, 'skills', id, 'SKILL.md')) || hash(skill.content) !== digest || typeof installed.skills[id] !== 'string' || hash(skillBody(installed.skills[id])) !== digest) issues.push(`Superpowers 技能来源、路径或完整正文不符：${id}`)
    }
  }
  const fingerprint = hash(stable({ plugins: sorted(snapshot.plugins), skills: sorted(snapshot.skills.map(skill => ({ ...skill, content: hash(skill.content) }))), installation: installed && { root: installed.root, files: Object.fromEntries(Object.entries(installed.files).map(([name, text]) => [name, hash(text)])), skills: Object.fromEntries(Object.entries(installed.skills).map(([name, text]) => [name, hash(text)])) } }))
  return { issues, skills: issues.length ? [] : snapshot.skills.filter(skill => requiredSkills.includes(skill.id as typeof requiredSkills[number])), fingerprint }
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
  for (const role of ['implementer', 'reviewer'] as const) {
    const choice = choices.models[role], effective = agents[role]
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
  } else if (plugin.source.type === 'package' && plugin.source.target === SUPERPOWERS_SPEC && plugin.source.version === SUPERPOWERS_REVISION) {
    const skill = skills.find(skill => skill.id === 'brainstorming')
    if (!skill || !isAbsolute(skill.path)) return snapshot
    root = await realpath(resolve(dirname(skill.path), '../..'))
  } else return snapshot
  const files: Record<string, string> = {}, contents: Record<string, string> = {}
  for (const name of Object.keys(SUPERPOWERS_SOURCE.files)) files[name] = await boundedText(join(root, name), root)
  for (const id of Object.keys(SUPERPOWERS_SOURCE.skills)) contents[id] = await boundedText(join(root, 'skills', id, 'SKILL.md'), root)
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
  const agents = { implementer: implementer.data, reviewer: reviewer.data }
  let superpowers: ReturnType<typeof verifySuperpowers>
  try {
    const [plugins, skills] = await Promise.all([ctx.plugin.list({ location }), ctx.skill.list({ location })])
    if (!Array.isArray(plugins.data) || !Array.isArray(skills.data)) throw new Error('宿主插件或技能目录返回无效')
    superpowers = verifySuperpowers(await sourceSnapshot(plugins.data, skills.data))
  } catch (error) { superpowers = { issues: [`Superpowers 运行时核验失败：${(error as Error).message}`], skills: [], fingerprint: 'unavailable' } }
  const config = await Promise.all(['opencode.json', 'opencode.jsonc', SETUP_PROFILE, '.opencode/agents/implementer.md', '.opencode/agents/reviewer.md', '.opencode/agent/implementer.md', '.opencode/agent/reviewer.md', '.opencode/workflow/protection.json'].map(async name => [name, hash(await optionalText(root, name) ?? '<missing>')]))
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
