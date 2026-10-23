import type { Plugin } from '@opencode/plugin'
import { normalizeCall } from './protocol.ts'
import { runCheck } from './runner.ts'
import { REVIEWER } from './review.ts'

export const REVIEWER_ACTIONS: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'workflow_review_submit'])

export async function registerPathPermissions(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const lifetime = new AbortController()
  const registration = await ctx.permission.hook('evaluate', async event => {
    if (event.effect === 'deny') return
    // 事件不带 agent 时查一次会话，路径检查复用同一结果。
    let session: Awaited<ReturnType<typeof ctx.session.get>> | undefined
    let agent: string | undefined = event.agent
    if (!agent) {
      try { session = await ctx.session.get({ sessionID: event.sessionID }); agent = session.agent }
      catch (error) { event.effect = 'deny'; event.message = `无法确认会话代理：${(error as Error).message}`; return }
    }
    // reviewer.md 被 OpenCode 忽略时，配置里的同名代理会退回默认的全部允许；只读在这里强制，不依赖代理文件。
    if (agent === REVIEWER && !REVIEWER_ACTIONS.has(event.action)) {
      event.effect = 'deny'; event.message = `审核员只读：只允许 read、glob、grep 和 workflow_review_submit，已拒绝 ${event.action}`; return
    }
    if (!['read', 'edit'].includes(event.action)) return
    try {
      const directory = (session ?? await ctx.session.get({ sessionID: event.sessionID })).location.directory
      const call = normalizeCall('write', { file_paths: [...event.resources], action: event.action }, directory, event.sessionID, event.source?.type === 'tool' ? event.source.id : '__permission__')
      const result = await runCheck('pre-guard-paths.py', call, lifetime.signal)
      if (result.decision !== 'allow') { event.effect = 'deny'; event.message = result.reason || '受保护文件' }
    } catch (error) { event.effect = 'deny'; event.message = `文件权限检查无法验证：${(error as Error).message}` }
  })
  return async () => { lifetime.abort(); await registration.dispose() }
}
