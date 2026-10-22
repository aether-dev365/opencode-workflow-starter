import { isAbsolute, resolve } from 'node:path'

export type WorkflowEvent = {
  version: 1; phase: 'before' | 'after' | 'inspect'; sessionId: string; callId: string
  directory: string; tool: string; input: Record<string, unknown>; paths: string[]
  result?: unknown
}
export type CheckResult = { decision: 'allow' | 'deny' | 'ask'; reason?: string; input?: Record<string, unknown>; reminders: string[] }

export function normalizeCall(tool: string, input: Record<string, unknown>, directory: string, sessionId: string, callId: string): WorkflowEvent {
  if (!isAbsolute(directory) || !sessionId || !callId || !tool || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('检查输入不完整；未执行操作')
  }
  const copied = structuredClone(input)
  for (const name of ['workdir', 'path', 'file_path', 'command']) {
    if (name in copied && typeof copied[name] !== 'string') throw new Error('检查输入不完整；未执行操作')
  }
  const cwd = resolve(directory, String(copied.workdir || ''))
  const paths: string[] = []
  if (tool === 'patch') {
    const text = copied.patchText
    if (typeof text !== 'string' || !text.startsWith('*** Begin Patch\n') || !text.trimEnd().endsWith('*** End Patch')) {
      throw new Error('补丁输入无效；未执行操作')
    }
    for (const line of text.split('\n')) {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
      if (match) paths.push(resolve(cwd, match[1]))
    }
    if (!paths.length) throw new Error('补丁路径缺失；未执行操作')
  }
  for (const name of ['path', 'file_path']) if (copied[name]) paths.push(resolve(cwd, String(copied[name])))
  if ('file_paths' in copied) {
    if (!Array.isArray(copied.file_paths) || !copied.file_paths.every(path => typeof path === 'string' && path.length > 0)) {
      throw new Error('路径输入无效；未执行操作')
    }
    paths.push(...copied.file_paths.map(path => resolve(cwd, String(path))))
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
