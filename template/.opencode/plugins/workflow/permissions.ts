import type { Plugin } from '@opencode/plugin'
import { normalizeCall } from './protocol.ts'
import { runCheck } from './runner.ts'

export async function registerPathPermissions(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const lifetime = new AbortController()
  const registration = await ctx.permission.hook('evaluate', async event => {
    if (event.effect === 'deny' || !['read', 'edit'].includes(event.action)) return
    try {
      const directory = (await ctx.session.get({ sessionID: event.sessionID })).location.directory
      const call = normalizeCall('write', { file_paths: [...event.resources], action: event.action }, directory, event.sessionID, event.source?.type === 'tool' ? event.source.id : '__permission__')
      const result = await runCheck('pre-guard-paths.py', call, lifetime.signal)
      if (result.decision !== 'allow') { event.effect = 'deny'; event.message = result.reason || '受保护文件' }
    } catch { event.effect = 'deny'; event.message = '文件权限检查无法验证；未执行操作。' }
  })
  return async () => { lifetime.abort(); await registration.dispose() }
}
