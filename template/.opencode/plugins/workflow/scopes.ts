import { access, readFile } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { containedFile } from './config.ts'
import { matchesPattern, patternProblem } from './patterns.ts'

export type Scope = { root: string; instruction: string; text: string }
export const SCOPE_TEXT_LIMIT = 40_000

export async function scopeRoot(path: string): Promise<string | undefined> {
  let here = resolve(path)
  while (true) {
    try { await access(resolve(here, '.git')); return here } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    }
    const parent = dirname(here)
    if (parent === here) return undefined
    here = parent
  }
}

export async function matchingScopes(paths: string[], directory: string): Promise<Scope[]> {
  const found = new Map<string, Scope>()
  const mappings = new Map<string, { paths: string[]; instruction: string }[]>()
  const definitionsFor = async (root: string) => {
    if (mappings.has(root)) return mappings.get(root)!
    let definitions: unknown
    try { definitions = JSON.parse(await readFile(resolve(root, '.opencode/workflow/scopes.json'), 'utf8')) } catch {
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
    const definitions = await definitionsFor(root)
    for (const definition of definitions) {
      if (!definition.paths.some(pattern => matchesPattern(relative(root, absolute), pattern))) continue
      const instruction = await containedFile(root, definition.instruction)
      const text = await readFile(instruction, 'utf8')
      if (!text.trim() || text.length > SCOPE_TEXT_LIMIT) throw new Error(`范围规则缺失或超过上限：${definition.instruction}`)
      found.set(instruction, { root, instruction, text })
    }
  }
  return [...found.values()]
}
