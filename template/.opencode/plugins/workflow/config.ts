import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { patternProblem } from './patterns.ts'

export type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
export type ProtectionRule = { id: string; actions: ('read' | 'edit')[]; paths: string[]; effect: 'allow' | 'deny'; reason: string }
export type Catalog = Record<string, { group: string; checklist: string }>
export type RoutingConfig = { version: 1; areas: { id: string; paths: string[] }[]; units: { id: string; areas: string[] }[] }
export type ProjectConfig = {
  scopes: { paths: string[]; instruction: string }[]
  protection: { version: 1; rules: ProtectionRule[] }
  watchdog: { stallSeconds: number; toolSeconds: number; checkSeconds: number }
  catalog: Catalog
  routing: RoutingConfig
  pipefail?: { version: 1; commandPrefixes: string[][] }
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim())
const id = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v)
const safePath = (p: string) => !!p && !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0')
function requireValue(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason) }

export async function readJson(path: string): Promise<any> {
  const text = await readFile(path, 'utf8')
  if (!path.endsWith('.jsonc')) return JSON.parse(text)
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  requireValue(!errors.length, `配置 JSON 无效：${path}`)
  return value
}

export async function containedFile(root: string, path: string): Promise<string> {
  requireValue(safePath(path), `路径必须位于检出内：${path}`)
  const base = await realpath(root)
  const file = await realpath(resolve(base, path))
  const rel = relative(base, file)
  requireValue(rel && !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel), `路径越界：${path}`)
  return file
}

export function validateRouting(value: unknown): RoutingConfig {
  requireValue(object(value) && value.version === 1 && Array.isArray(value.areas) && Array.isArray(value.units), '审核路由格式无效')
  requireValue(value.areas.every((v: any) => object(v) && id(v.id) && v.id !== 'common' && strings(v.paths) && v.paths.every(safePath)), '审核领域无效')
  for (const area of value.areas) for (const pattern of area.paths) {
    const problem = patternProblem(pattern)
    if (problem) throw new Error(problem)
  }
  const areas = new Set(value.areas.map((v: any) => v.id))
  requireValue(areas.size === value.areas.length, '审核领域重复')
  requireValue(value.units.every((v: any) => object(v) && id(v.id) && strings(v.areas) && v.areas.every((a: string) => a === '*' || a === 'common' || areas.has(a))), '审核单元领域无效')
  const units = new Set(value.units.map((v: any) => v.id))
  requireValue(units.size === value.units.length, '审核单元重复')
  for (const name of ['core', 'tests']) requireValue(value.units.some((v: any) => v.id === name && v.areas.includes('*')), `缺少覆盖全部路径的 ${name}`)
  return value as RoutingConfig
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const load = async (name: string) => readJson(await containedFile(root, '.opencode/workflow/' + name))
  const scopes = await load('scopes.json')
  requireValue(Array.isArray(scopes) && scopes.length && scopes.every(v => object(v) && strings(v.paths) && v.paths.every(safePath) && typeof v.instruction === 'string'), '范围映射无效')
  for (const scope of scopes) {
    for (const pattern of scope.paths) {
      const problem = patternProblem(pattern)
      if (problem) throw new Error(problem)
    }
    const text = await readFile(await containedFile(root, scope.instruction), 'utf8')
    requireValue(text.trim() && text.length <= 40_000, `规则为空或超过 40000 字符：${scope.instruction}`)
  }
  const protection = await load('protection.json')
  requireValue(object(protection) && protection.version === 1 && Array.isArray(protection.rules) && protection.rules.length, '保护配置无效')
  for (const rule of protection.rules) requireValue(object(rule) && id(rule.id) && strings(rule.actions) && rule.actions.every(a => ['read', 'edit'].includes(a)) && strings(rule.paths) && rule.paths.every(safePath) && ['allow', 'deny'].includes(rule.effect) && typeof rule.reason === 'string' && rule.reason.trim(), '保护规则无效')
  requireValue(new Set(protection.rules.map((r: any) => r.id)).size === protection.rules.length, '保护规则 ID 重复')
  for (const rule of protection.rules) for (const pattern of rule.paths) {
    const problem = patternProblem(pattern)
    if (problem) throw new Error(problem)
  }
  const watchdog = await load('watchdog.json')
  requireValue(object(watchdog) && ['stallSeconds', 'toolSeconds', 'checkSeconds'].every(k => Number.isFinite(watchdog[k]) && watchdog[k] > 0), '停滞阈值无效')
  const catalog = await load('review/catalog.json')
  requireValue(object(catalog) && Object.keys(catalog).length, '检查单目录无效')
  for (const [key, item] of Object.entries(catalog)) {
    requireValue(id(key) && object(item) && typeof item.group === 'string' && typeof item.checklist === 'string' && safePath(item.checklist), '检查单条目无效')
    const text = await readFile(await containedFile(root, '.opencode/workflow/review/checklists/' + item.checklist), 'utf8')
    requireValue(text.trim(), `检查单为空：${key}`)
  }
  const routing = validateRouting(await load('review/routing.json'))
  requireValue(routing.units.every(u => catalog[u.id]), '路由引用未知检查单')
  let pipefail: ProjectConfig['pipefail']
  try {
    const value = await load('pipefail.json')
    requireValue(object(value) && value.version === 1 && Array.isArray(value.commandPrefixes) && value.commandPrefixes.every((prefix: unknown) =>
      Array.isArray(prefix) && prefix.length > 0 && prefix.every(token => typeof token === 'string' && token.length > 0)), '命令前缀格式无效')
    pipefail = value as NonNullable<ProjectConfig['pipefail']>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`pipefail.json 无效：${(error as Error).message}`)
  }
  return { scopes, protection, watchdog, catalog, routing, pipefail } as ProjectConfig
}

export function protectionPermissions(config: ProjectConfig): PermissionRule[] {
  return config.protection.rules.flatMap(r => r.paths.flatMap(resource => r.actions.map(action => ({ action, resource, effect: r.effect }))))
}
