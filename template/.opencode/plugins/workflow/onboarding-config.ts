import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
export { SUPERPOWERS_SPEC, SUPERPOWERS_REVISION } from './onboarding-source.ts'

export const SETUP_PROFILE = '.opencode/workflow/onboarding.json'
export type ModelChoice = { mode: 'inherit' } | { mode: 'fixed'; model: string }
export type ExistingDecision = 'migrate' | 'keep'
export type AgentChoice = { name: string; description: string; focus: string; model: ModelChoice }
export type SetupChoices = {
  version: 1 | 2; mode: 'full' | 'basic'; superpowers: 'project' | 'global' | 'existing' | 'none'
  models: { implementer: ModelChoice; reviewer: ModelChoice }
  agents: AgentChoice[]; existing: Record<string, ExistingDecision>
  components: { quality: 'off' | 'checks' | 'hook'; ci: boolean; release: boolean; mcp: boolean }
}
// 内置代理与套件角色的名称不能被新增子代理占用。
export const RESERVED_AGENT_NAMES: readonly string[] = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary', 'implementer', 'reviewer']

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error('接入选择必须完整、明确，且不能包含未知字段')
}
const length = (text: string) => [...text].length
// u 标志下成对的代理项是一个码点，只有孤立代理项会命中；它们无法写成有效 UTF-8。
const malformed = (text: string) => /[\ud800-\udfff]/u.test(text)
const model = (choice: unknown): ModelChoice => {
  if (object(choice) && choice.mode === 'inherit') { keys(choice, ['mode']); return { mode: 'inherit' } }
  keys(choice, ['mode', 'model'])
  if (choice.mode !== 'fixed' || typeof choice.model !== 'string' || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+(?:#[a-zA-Z0-9._-]+)?$/.test(choice.model)) throw new Error('固定模型必须使用 provider/model 或 provider/model#variant')
  return { mode: 'fixed', model: choice.model }
}

function agent(value: unknown): AgentChoice {
  keys(value, ['name', 'description', 'focus', 'model'])
  const { name, description, focus } = value
  if (typeof name !== 'string' || name.length < 2 || name.length > 40 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error('子代理名称只能使用小写字母、数字和连字符，长度 2–40')
  if (RESERVED_AGENT_NAMES.includes(name) || name.split('-').some(part => part === 'review' || part === 'reviewer')) throw new Error(`子代理名称不能占用内置代理或套件角色，也不能包含 review、reviewer 段；需要更多审核视角时增加检查单：${name}`)
  const text = typeof description === 'string' ? description.trim() : ''
  if (!text || length(text) > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text) || malformed(text)) throw new Error(`子代理 ${name} 的 description 必须是 1–200 个字符的一行文字，不含控制字符`)
  const body = typeof focus === 'string' ? focus.replaceAll('\r\n', '\n') : ''
  if (!body.trim() || length(body) > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body) || malformed(body)) throw new Error(`子代理 ${name} 的 focus 必须是 1–2000 个字符，除换行和制表符外不含控制字符`)
  return { name, description: text, focus: body, model: model(value.model) }
}

// 决定的键必须是检测结果中的 path 原样：项目相对路径，不能指向个人目录或带有 ./、../ 写法。
function existing(value: unknown): Record<string, ExistingDecision> {
  if (!object(value)) throw new Error('existing 必须是以检测项 path 为键的对象')
  const entries = Object.entries(value)
  if (entries.length > 200) throw new Error('既有 AI 配置的决定最多 200 条')
  const result: Record<string, ExistingDecision> = {}
  for (const [path, decision] of entries) {
    if (!path || path.length > 512 || path.startsWith('/') || path.startsWith('~') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => ['', '.', '..'].includes(part))) {
      throw new Error('既有 AI 配置的决定键必须是检测结果中的 path 原样：项目相对路径，用 / 分隔，不以 ./、/ 或 ~ 开头')
    }
    if (decision !== 'migrate' && decision !== 'keep') throw new Error('既有 AI 配置的决定只能是 migrate 或 keep')
    result[path] = decision
  }
  return result
}

export function validateSetupChoices(value: unknown, { legacy = false }: { legacy?: boolean } = {}): SetupChoices {
  if (object(value) && value.version === 1) {
    if (!legacy) throw new Error('接入选择需要升级到 version 2：补充 agents（新增子代理，可为空数组）与 existing（既有 AI 配置的决定）；不会自动补默认值')
    keys(value, ['version', 'mode', 'superpowers', 'models', 'components'])
  } else keys(value, ['version', 'mode', 'superpowers', 'models', 'agents', 'existing', 'components'])
  if (![1, 2].includes(value.version as number) || !['full', 'basic'].includes(value.mode as string) || !['project', 'global', 'existing', 'none'].includes(value.superpowers as string)) throw new Error('接入模式或 Superpowers 选择无效')
  if (value.mode === 'full' && value.superpowers === 'none') throw new Error('完整模式必须明确选择 Superpowers 来源')
  keys(value.models, ['implementer', 'reviewer'])
  keys(value.components, ['quality', 'ci', 'release', 'mcp'])
  const components = value.components
  if (!['off', 'checks', 'hook'].includes(components.quality as string) || ['ci', 'release', 'mcp'].some(key => typeof components[key] !== 'boolean')) throw new Error('可选组件选择无效')
  if (components.ci && components.quality === 'off') throw new Error('CI 依赖完整质量检查，不能搭配 quality=off')
  let agents: AgentChoice[] = []
  if (value.version === 2) {
    if (!Array.isArray(value.agents) || value.agents.length > 8) throw new Error('agents 必须是数组，新增子代理最多 8 个')
    agents = value.agents.map(agent)
    if (new Set(agents.map(item => item.name)).size !== agents.length) throw new Error('新增子代理的名称不能重复')
  }
  return {
    version: value.version as SetupChoices['version'], mode: value.mode as SetupChoices['mode'], superpowers: value.superpowers as SetupChoices['superpowers'],
    models: { implementer: model(value.models.implementer), reviewer: model(value.models.reviewer) },
    agents, existing: value.version === 2 ? existing(value.existing) : {},
    components: { quality: components.quality as SetupChoices['components']['quality'], ci: components.ci as boolean, release: components.release as boolean, mcp: components.mcp as boolean },
  }
}

export async function readSetupChoices(root: string): Promise<SetupChoices | null> {
  const base = await realpath(resolve(root))
  let file = base
  for (const part of SETUP_PROFILE.split('/')) {
    file = join(file, part)
    try {
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error(`接入配置路径不允许符号链接：${SETUP_PROFILE}`)
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`接入配置不允许共享 inode（硬链接）：${SETUP_PROFILE}`)
      if (file !== join(base, SETUP_PROFILE) && !stat.isDirectory()) throw new Error(`接入配置父路径不是目录：${SETUP_PROFILE}`)
      if (file === join(base, SETUP_PROFILE) && !stat.isFile()) throw new Error(`接入配置不是常规文件：${SETUP_PROFILE}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  let value: unknown
  try { value = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('接入选择 JSON 无效，请人工检查 onboarding.json') }
  return validateSetupChoices(value, { legacy: true })
}
