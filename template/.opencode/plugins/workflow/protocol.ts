import { isAbsolute, resolve } from 'node:path'
import { windowsPath } from './platform.ts'

export type WorkflowEvent = {
  version: 1; phase: 'before' | 'after' | 'inspect'; sessionId: string; callId: string
  directory: string; tool: string; input: Record<string, unknown>; paths: string[]
  result?: unknown
}
export type CheckResult = { decision: 'allow' | 'deny' | 'ask'; reason?: string; input?: Record<string, unknown>; reminders: string[] }
// volatile：放行结论依赖仓库内容（提交扫描、递归删除），不能缓存到 shell 创建时复用。
export type CombinedResult = CheckResult & { inspect?: { paths: string[]; readonly: boolean }; volatile?: boolean }

export function normalizeCall(tool: string, input: Record<string, unknown>, directory: string, sessionId: string, callId: string): WorkflowEvent {
  if (!isAbsolute(directory) || !sessionId || !callId || !tool || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('检查输入不完整；未执行操作')
  }
  const copied = structuredClone(input)
  for (const name of ['workdir', 'path', 'file_path', 'command']) {
    if (name in copied && typeof copied[name] !== 'string') throw new Error('检查输入不完整；未执行操作')
  }
  const cwd = resolve(directory, windowsPath(String(copied.workdir || '')))
  const paths: string[] = []
  if (tool === 'patch') {
    const text = copied.patchText
    const lines = typeof text === 'string' ? text.trim().split('\n') : []
    if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') {
      throw new Error('补丁输入无效；未执行操作')
    }
    // 原生解析会 trim 文件头及路径；只规范化检查视图，不改写补丁正文。
    let updating = false
    for (const line of lines) {
      // Update 正文里以空格开头的行是上下文，即使正文长得像文件头也不产生新目标。
      if (updating && line.startsWith(' ')) continue
      const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/s.exec(line.trim())
      if (match) {
        paths.push(resolve(cwd, windowsPath(match[2].trim())))
        updating = match[1] === 'Update File' || (updating && match[1] === 'Move to')
      }
    }
    if (!paths.length) throw new Error('补丁路径缺失；未执行操作')
  }
  for (const name of ['path', 'file_path']) if (copied[name]) paths.push(resolve(cwd, windowsPath(String(copied[name]))))
  if ('file_paths' in copied) {
    if (!Array.isArray(copied.file_paths) || !copied.file_paths.every(path => typeof path === 'string' && path.length > 0)) {
      throw new Error('路径输入无效；未执行操作')
    }
    paths.push(...copied.file_paths.map(path => resolve(cwd, windowsPath(String(path)))))
  }
  return { version: 1, phase: 'before', sessionId, callId, directory, tool, input: copied, paths: [...new Set(paths)] }
}

export function parseResult(text: string, code: number | null): CheckResult {
  let value: CheckResult
  try { value = JSON.parse(text) } catch { throw new Error('检查失败：结果不是有效 JSON；未执行操作') }
  if (!value || !['allow', 'deny', 'ask'].includes(value.decision) ||
      !Array.isArray(value.reminders) || !value.reminders.every(item => typeof item === 'string') ||
      (value.input !== undefined && (!value.input || typeof value.input !== 'object' || Array.isArray(value.input))) ||
      (value.reason !== undefined && typeof value.reason !== 'string') ||
      (value.decision === 'deny' ? code !== 2 : code !== 0)) {
    throw new Error('检查失败：结果或退出码无效；未执行操作')
  }
  return value
}

export function parseCombined(text: string, code: number | null, inspect: boolean): CombinedResult {
  const value = parseResult(text, code) as CombinedResult
  if (value.volatile !== undefined && typeof value.volatile !== 'boolean') throw new Error('检查结果无效：volatile 不是布尔值')
  if (inspect) {
    if (!Array.isArray(value.inspect?.paths) || !value.inspect.paths.every(path => typeof path === 'string')) throw new Error('检查路径无效')
    if (typeof value.inspect.readonly !== 'boolean') throw new Error('检查只读分类无效')
  }
  return value
}
