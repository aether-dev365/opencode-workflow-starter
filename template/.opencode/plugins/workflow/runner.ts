import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { parseCombined, parseResult } from './protocol.ts'
import type { WorkflowEvent, CheckResult, CombinedResult } from './protocol.ts'
import { childOptions, killTree, pythonCommand, pythonEnv } from './platform.ts'

const directory = fileURLToPath(new URL('../../workflow/checks/', import.meta.url))
export type CheckName = 'inspect-paths' | 'pre-guard-paths' | 'pre-secret-scan' | 'pre-bash-pipefail'

function execute(script: string, payload: unknown, timeout: number, signal?: AbortSignal): Promise<{ output: string; code: number | null }> {
  const outputLimit = 256 * 1024
  return new Promise((done, fail) => {
    if (signal?.aborted) { fail(new Error('检查取消；未执行操作')); return }
    let python: ReturnType<typeof pythonCommand>
    try { python = pythonCommand() } catch (error) { fail(new Error(`检查失败：${(error as Error).message}；未执行操作`)); return }
    const child = spawn(python.command, [...python.args, isAbsolute(script) ? script : resolve(directory, script)], {
      stdio: ['pipe', 'pipe', 'pipe'], env: pythonEnv(), ...childOptions(),
    })
    let output = ''; let bytes = 0; let settled = false
    const stop = (reason: string) => {
      if (settled) return
      settled = true
      killTree(child)
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      fail(new Error(reason))
    }
    const abort = () => stop('检查取消；未执行操作')
    const timer = setTimeout(() => stop('检查超时；未执行操作'), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > outputLimit) { stop('检查失败：输出过大；未执行操作'); return }
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('error', error => stop(`检查失败：无法启动检查器 ${python.command}（${(error as NodeJS.ErrnoException).code ?? error.message}）。请安装 Python 3.10+ 或设置 WORKFLOW_PYTHON；OpenCode 以后台服务运行时，安装或修改环境变量后执行 opencode service restart；未执行操作`))
    child.stdin.on('error', () => stop('检查失败：检查器输入无法传递；未执行操作'))
    child.on('close', code => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      done({ output, code })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export async function runCheck(name: string, event: WorkflowEvent, signal?: AbortSignal): Promise<CheckResult> {
  const { output, code } = await execute(name, event, 10_000, signal)
  return parseResult(output, code)
}

// 一个 Python 进程依次完成路径分析和守卫；预算覆盖凭据扫描自身的 8 秒上限。
export async function runChecks(event: WorkflowEvent, checks: CheckName[], signal?: AbortSignal): Promise<CombinedResult> {
  const { output, code } = await execute('run-checks.py', { ...event, checks }, 20_000, signal)
  return parseCombined(output, code, checks.includes('inspect-paths'))
}
