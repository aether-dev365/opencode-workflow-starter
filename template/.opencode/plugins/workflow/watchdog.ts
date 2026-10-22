import type { Plugin } from '@opencode/plugin'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WatchdogOptions {
  stallMs: number; toolMs: number; now: () => number
  lookup: (sessionID: string) => Promise<{ parentID?: string; title?: string } | null>
  notify: (parentID: string, text: string) => Promise<void>
}

export function createWatchdog(options: WatchdogOptions): {
  observe(event: { type: string; data?: { sessionID?: string; id?: string; error?: unknown } }): Promise<void>
  tick(): Promise<void>
} {
  type State = { parentID: string; title: string; busy: boolean; last: number; event: string; error?: unknown; warned: boolean; tools: Map<string, { start: number; warned: boolean }> }
  const sessions = new Map<string, Promise<State | null>>()
  const state = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, options.lookup(id).then(info => info?.parentID ? {
      parentID: info.parentID, title: info.title ?? '', busy: false, last: options.now(), event: '', warned: false, tools: new Map(),
    } : null).catch(() => null))
    return sessions.get(id)!
  }
  const notify = async (id: string, value: State, start: number, tool: boolean) => {
    const minutes = Math.floor((options.now() - start) / 60_000)
    const text = `子会话 ${id}（${value.title}）${tool ? `工具已运行 ${minutes} 分钟` : `已 ${minutes} 分钟无进展`}；最后活动：${value.event}。${value.error === undefined ? '' : `最近重试错误：${JSON.stringify(value.error)}。`}可中止并接手，或换模型重试；看门狗不会自动中止。`
    try { await options.notify(value.parentID, text) } catch { /* 父会话可能已删除，不让提醒干扰执行。 */ }
  }
  return {
    async observe(event) {
      const id = event.data?.sessionID
      if (!id || !event.type.startsWith('session.')) return
      const value = await state(id)
      if (!value) return
      if (event.type === 'session.retry.scheduled') { value.error = event.data?.error; return }
      value.last = options.now(); value.event = event.type; value.warned = false
      if (event.type === 'session.execution.started') { value.busy = true; value.error = undefined }
      if (/^session.execution.(succeeded|failed|interrupted)$/.test(event.type) || /^session.(deleted|removed)$/.test(event.type)) { value.busy = false; value.tools.clear() }
      const tool = event.data?.id
      if (event.type === 'session.tool.called' && tool) value.tools.set(tool, { start: options.now(), warned: false })
      if ((event.type === 'session.tool.success' || event.type === 'session.tool.failed') && tool) value.tools.delete(tool)
    },
    async tick() {
      for (const [id, pending] of sessions) {
        const value = await pending
        if (!value?.busy) continue
        if (value.tools.size) {
          for (const tool of value.tools.values()) if (!tool.warned && options.now() - tool.start >= options.toolMs) {
            tool.warned = true; await notify(id, value, tool.start, true)
          }
        } else if (!value.warned && options.now() - value.last >= options.stallMs) {
          value.warned = true; await notify(id, value, value.last, false)
        }
      }
    },
  }
}

export async function registerWatchdog(ctx: Plugin.Context, root: string): Promise<() => Promise<void>> {
  const config = { stallSeconds: 600, toolSeconds: 1800, checkSeconds: 30 }
  try {
    const raw = JSON.parse(await readFile(join(root, '.opencode/workflow/watchdog.json'), 'utf8'))
    for (const key of Object.keys(config) as (keyof typeof config)[]) if (typeof raw[key] === 'number' && raw[key] > 0 && Number.isFinite(raw[key])) config[key] = raw[key]
  } catch { /* 缺失或无效配置使用默认阈值。 */ }
  const watchdog = createWatchdog({
    stallMs: config.stallSeconds * 1000, toolMs: config.toolSeconds * 1000, now: Date.now,
    lookup: async sessionID => {
      const info = await ctx.session.get({ sessionID })
      return info.location.directory === root ? info : null
    },
    notify: async (parentID, text) => { await ctx.session.synthetic({ sessionID: parentID, text, description: '子代理停滞提醒', delivery: 'queue', resume: true }) },
  })
  const controller = new AbortController()
  const stream = (async () => {
    try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) if ('sessionID' in event.data) await watchdog.observe({ type: event.type, data: event.data }) }
    catch { /* 订阅在服务清理时终止。 */ }
  })()
  const timer = setInterval(() => { void watchdog.tick().catch(() => {}) }, config.checkSeconds * 1000)
  timer.unref()
  return async () => { controller.abort(); clearInterval(timer); await stream }
}
