import type { Plugin } from '@opencode/plugin'
import { normalizeCall } from './protocol.ts'
import type { WorkflowEvent } from './protocol.ts'
import { runCheck } from './runner.ts'
import { REVIEWER } from './review.ts'

export const REVIEWER_ACTIONS: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'workflow_review_submit'])

export async function registerPathPermissions(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const lifetime = new AbortController()
  // grep 的权限资源只有模式；真实路径只能从同一次工具调用取得，不能拿模式冒充路径。
  const searches = new Map<string, WorkflowEvent>()
  const searchKey = (session: string, call: string) => `${session}\0${call}`
  const before = await ctx.tool.hook('execute.before', async event => {
    if (event.tool !== 'grep') return
    const key = searchKey(event.sessionID, event.id)
    searches.delete(key)
    const directory = (await ctx.session.get({ sessionID: event.sessionID })).location.directory
    const call = normalizeCall('grep', event.input as Record<string, unknown>, directory, event.sessionID, event.id)
    const result = await runCheck('pre-guard-paths.py', call, lifetime.signal)
    if (result.decision !== 'allow') throw new Error(result.reason || '搜索路径检查拒绝')
    searches.set(key, call)
  })
  const after = await ctx.tool.hook('execute.after', event => { searches.delete(searchKey(event.sessionID, event.id)) })
  const registration = await ctx.permission.hook('evaluate', async event => {
    if (event.effect === 'deny') return
    // 事件不带 agent 时查一次会话，路径检查复用同一结果。
    let session: Awaited<ReturnType<typeof ctx.session.get>> | undefined
    let agent: string | undefined = event.agent
    if (!agent) {
      try { session = await ctx.session.get({ sessionID: event.sessionID }); agent = session.agent }
      catch (error) { event.effect = 'deny'; event.message = `无法确认会话代理：${(error as Error).message}`; return }
    }
    // reviewer 的代理文件被 OpenCode 忽略时，配置里的同名代理会退回默认的全部允许；只读在这里强制，不依赖代理文件。
    if (agent === REVIEWER && !REVIEWER_ACTIONS.has(event.action)) {
      event.effect = 'deny'; event.message = `审核员只读：只允许 read、glob、grep 和 workflow_review_submit，已拒绝 ${event.action}`; return
    }
    if (event.action === 'grep') {
      const call = event.source?.type === 'tool' ? searches.get(searchKey(event.sessionID, event.source.id)) : undefined
      if (!call) { event.effect = 'deny'; event.message = '搜索路径未经检查，未执行搜索'; return }
      try {
        const result = await runCheck('pre-guard-paths.py', call, lifetime.signal)
        if (result.decision !== 'allow') { event.effect = 'deny'; event.message = result.reason || '受保护搜索路径' }
      } catch (error) { event.effect = 'deny'; event.message = `搜索路径检查无法验证：${(error as Error).message}` }
      return
    }
    if (!['read', 'edit'].includes(event.action)) return
    try {
      const directory = (session ?? await ctx.session.get({ sessionID: event.sessionID })).location.directory
      const call = normalizeCall('write', { file_paths: [...event.resources], action: event.action }, directory, event.sessionID, event.source?.type === 'tool' ? event.source.id : '__permission__')
      const result = await runCheck('pre-guard-paths.py', call, lifetime.signal)
      if (result.decision !== 'allow') { event.effect = 'deny'; event.message = result.reason || '受保护文件' }
    } catch (error) { event.effect = 'deny'; event.message = `文件权限检查无法验证：${(error as Error).message}` }
  })
  return async () => { lifetime.abort(); searches.clear(); await after.dispose(); await before.dispose(); await registration.dispose() }
}
