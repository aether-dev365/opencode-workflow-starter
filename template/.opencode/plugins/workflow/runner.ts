import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { parseResult } from './protocol.ts'
import type { WorkflowEvent, CheckResult } from './protocol.ts'

const directory = fileURLToPath(new URL('../../workflow/checks/', import.meta.url))

export async function runCheck(name: string, event: WorkflowEvent, signal?: AbortSignal): Promise<CheckResult> {
  const timeout = 10_000
  const outputLimit = 256 * 1024
  return new Promise((done, fail) => {
    if (signal?.aborted) { fail(new Error('检查取消；未执行操作')); return }
    const child = spawn('python3', [isAbsolute(name) ? name : resolve(directory, name)], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    })
    let output = ''; let bytes = 0; let settled = false
    const stop = (reason: string) => {
      if (settled) return
      settled = true
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Child may already have exited. */ }
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
    child.on('error', () => stop('检查失败：无法启动检查器；未执行操作'))
    child.stdin.on('error', () => stop('检查失败：检查器输入无法传递；未执行操作'))
    child.on('close', code => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      try {
        done(parseResult(output, code))
      } catch (error) {
        fail(error)
      }
    })
    child.stdin.end(JSON.stringify(event))
  })
}
