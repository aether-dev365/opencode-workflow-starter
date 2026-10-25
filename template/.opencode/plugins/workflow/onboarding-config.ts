import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
export { SUPERPOWERS_SPEC, SUPERPOWERS_REVISION } from './onboarding-source.ts'

export const SETUP_PROFILE = '.opencode/workflow/onboarding.json'
export type ModelChoice = { mode: 'inherit' } | { mode: 'fixed'; model: string }
export type SetupChoices = {
  version: 1; mode: 'full' | 'basic'; superpowers: 'project' | 'global' | 'existing' | 'none'
  models: { implementer: ModelChoice; reviewer: ModelChoice }
  components: { quality: 'off' | 'checks' | 'hook'; ci: boolean; release: boolean; mcp: boolean }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error('接入选择必须完整、明确，且不能包含未知字段')
}

export function validateSetupChoices(value: unknown): SetupChoices {
  keys(value, ['version', 'mode', 'superpowers', 'models', 'components'])
  if (value.version !== 1 || !['full', 'basic'].includes(value.mode as string) || !['project', 'global', 'existing', 'none'].includes(value.superpowers as string)) throw new Error('接入模式或 Superpowers 选择无效')
  if (value.mode === 'full' && value.superpowers === 'none') throw new Error('完整模式必须明确选择 Superpowers 来源')
  keys(value.models, ['implementer', 'reviewer'])
  const model = (choice: unknown): ModelChoice => {
    if (object(choice) && choice.mode === 'inherit') { keys(choice, ['mode']); return { mode: 'inherit' } }
    keys(choice, ['mode', 'model'])
    if (choice.mode !== 'fixed' || typeof choice.model !== 'string' || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+(?:#[a-zA-Z0-9._-]+)?$/.test(choice.model)) throw new Error('固定模型必须使用 provider/model 或 provider/model#variant')
    return { mode: 'fixed', model: choice.model }
  }
  keys(value.components, ['quality', 'ci', 'release', 'mcp'])
  const components = value.components
  if (!['off', 'checks', 'hook'].includes(components.quality as string) || ['ci', 'release', 'mcp'].some(key => typeof components[key] !== 'boolean')) throw new Error('可选组件选择无效')
  if (components.ci && components.quality === 'off') throw new Error('CI 依赖完整质量检查，不能搭配 quality=off')
  return {
    version: 1, mode: value.mode as SetupChoices['mode'], superpowers: value.superpowers as SetupChoices['superpowers'],
    models: { implementer: model(value.models.implementer), reviewer: model(value.models.reviewer) },
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
  return validateSetupChoices(value)
}
