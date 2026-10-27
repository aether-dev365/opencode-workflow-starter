import { access, readFile } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { containedFile, SCOPE_TEXT_LIMIT } from './config.ts'
import { matchesPattern, patternProblem } from './patterns.ts'
import { missingLongName, pathTooLong, portableRelative } from './platform.ts'

export type Scope = { root: string; instruction: string; text: string }
export { SCOPE_TEXT_LIMIT }

export async function scopeRoot(path: string): Promise<string | undefined> {
  let here = resolve(path)
  while (true) {
    try { await access(resolve(here, '.git')); return here } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || ''
      // 名字超过文件系统上限的路径不存在，继续向上查找。
      if (code === 'ENAMETOOLONG') { if (!missingLongName(error)) throw pathTooLong(path) }
      else if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code)) throw error
    }
    const parent = dirname(here)
    if (parent === here) return undefined
    here = parent
  }
}

export async function matchingScopes(paths: string[], directory: string): Promise<Scope[]> {
  const found = new Map<string, Scope>()
  const mappings = new Map<string, { paths: string[]; instruction: string }[]>()
  const definitionsFor = async (root: string, optional = false) => {
    if (mappings.has(root)) return mappings.get(root)!
    let definitions: unknown
    try { definitions = JSON.parse(await readFile(resolve(root, '.opencode/workflow/scopes.json'), 'utf8')) } catch (error) {
      // 外部检出没有范围映射时不加载规则，与路径守卫沿用会话规则一致；映射存在但读不出来仍拒绝。
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { mappings.set(root, []); return [] }
      throw new Error(`范围映射缺失或无法读取：${root}`)
    }
    if (!Array.isArray(definitions) || !definitions.length || definitions.some(value =>
      !value || !Array.isArray(value.paths) || !value.paths.length || !value.paths.every((path: unknown) => typeof path === 'string' && path.length > 0) ||
      typeof value.instruction !== 'string' || !value.instruction || isAbsolute(value.instruction) || relative(root, resolve(root, value.instruction)).startsWith('..'))) {
      throw new Error(`范围映射无效：${root}`)
    }
    for (const definition of definitions) for (const pattern of definition.paths) {
      const problem = patternProblem(pattern)
      if (problem) throw new Error(problem)
    }
    mappings.set(root, definitions)
    return definitions as { paths: string[]; instruction: string }[]
  }
  const currentRoot = await scopeRoot(directory)
  if (currentRoot) await definitionsFor(currentRoot)
  for (const path of paths) {
    const absolute = resolve(directory, path)
    const root = await scopeRoot(absolute)
    if (!root) continue
    const definitions = await definitionsFor(root, root !== currentRoot)
    for (const definition of definitions) {
      if (!definition.paths.some(pattern => matchesPattern(portableRelative(root, absolute), pattern))) continue
      const instruction = await containedFile(root, definition.instruction)
      const text = await readFile(instruction, 'utf8')
      if (!text.trim() || text.length > SCOPE_TEXT_LIMIT) throw new Error(`范围规则缺失或超过上限：${definition.instruction}`)
      found.set(instruction, { root, instruction, text })
    }
  }
  return [...found.values()]
}
