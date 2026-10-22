import { Plugin } from '@opencode/plugin'
import { readFile } from 'node:fs/promises'
import { normalizeCall } from './protocol.ts'
import type { WorkflowEvent } from './protocol.ts'
import { runCheck } from './runner.ts'
import { matchingScopes, SCOPE_TEXT_LIMIT } from './scopes.ts'
import { registerPathPermissions } from './permissions.ts'
import { registerWatchdog } from './watchdog.ts'
import { scopeRoot } from './scopes.ts'
import { loadProjectConfig } from './config.ts'
import { registerReview } from './review.ts'
import { registerRelease, loadReleaseConfig } from './release.ts'
import { containedRelative } from './platform.ts'

const pre = ['pre-guard-paths.py', 'pre-secret-scan.py', 'pre-bash-pipefail.py']
const mutations = new Set(['patch', 'edit', 'write', 'shell'])
type State = { directory: string; epoch: number; scopes: string[]; visible: string[] }
const key = (sessionId: string) => `context/${sessionId}`

async function configProblem(directory: string): Promise<string | undefined> {
  try {
    const root = await scopeRoot(directory)
    if (!root) return '未找到 Git 检出根'
    await loadProjectConfig(root)
    loadReleaseConfig(root)
  } catch (error) { return String((error as Error).message) }
}

function isRepairPath(path: string, root: string): boolean {
  const name = containedRelative(root, path)
  return !!name && (name.startsWith('.opencode/workflow/') || name === 'opencode.jsonc' || name.split('/').at(-1) === 'AGENTS.md')
}

export async function registerWorkflow(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const root = await scopeRoot(ctx.location.directory)
  const registrations: { dispose(): Promise<void> }[] = []
  const controller = new AbortController()
  const cleanupPaths = await registerPathPermissions(ctx)
  const queues = new Map<string, Promise<unknown>>()
  const serial = async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) || Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    queues.set(sessionId, next)
    try { return await next } finally { if (queues.get(sessionId) === next) queues.delete(sessionId) }
  }
  const sessionDirectory = async (sessionId: Parameters<Plugin.Context['session']['get']>[0]['sessionID']) => (await ctx.session.get({ sessionID: sessionId })).location.directory
  const state = async (sessionId: string, directory: string): Promise<State> => {
    const old = await ctx.storage.get(key(sessionId)) as State | undefined
    if (old?.directory === directory) return old
    return { directory, epoch: (old?.epoch ?? 0) + 1, scopes: [], visible: [] }
  }
  const save = async (sessionId: string, value: State) => { await ctx.storage.set(key(sessionId), value) }
  const paths = async (event: WorkflowEvent) => {
    if (event.tool === 'shell') {
      const result = await runCheck('inspect-paths.py', event, controller.signal)
      const values = result.input?.paths
      if (!Array.isArray(values) || !values.every(path => typeof path === 'string')) throw new Error('检查路径无效')
      event.paths = values
      if (typeof result.input?.readonly !== 'boolean') throw new Error('检查只读分类无效')
      return !result.input.readonly
    }
    return mutations.has(event.tool)
  }
  const guards = async (event: WorkflowEvent) => {
    if (!mutations.has(event.tool)) return
    // Readonly candidates are for instruction discovery, not write intent.
    const guardEvent = event.tool === 'shell' ? { ...event, paths: [] } : event
    for (const name of pre) {
      const result = await runCheck(name, guardEvent, controller.signal)
      if (result.decision !== 'allow') throw new Error(result.reason || '操作已拒绝')
      if (result.input) {
        event.input = { ...event.input, ...result.input }
        guardEvent.input = event.input
      }
    }
  }
  const recordScopes = async (event: WorkflowEvent, requireVisible: boolean) => {
    let scopes: Awaited<ReturnType<typeof matchingScopes>>
    try { scopes = await matchingScopes(event.paths, event.directory) }
    catch (error) { if (requireVisible) throw error; return }
    await serial(event.sessionId, async () => {
      const value = await state(event.sessionId, event.directory)
      const unknown = scopes.some(scope => !value.visible.includes(scope.instruction))
      value.scopes = [...new Set([...value.scopes, ...scopes.map(scope => scope.instruction)])]
      await save(event.sessionId, value)
      if (requireVisible && unknown) throw new Error('范围规则尚未进入本轮上下文；未执行修改。下一轮先阅读规则，再显式重试。')
    })
  }
  registrations.push(await ctx.tool.hook('execute.before', async raw => {
    const directory = await sessionDirectory(raw.sessionID)
    const event = normalizeCall(raw.tool, raw.input as Record<string, unknown>, directory, raw.sessionID, raw.id)
    const mutation = await paths(event)
    const problem = mutation ? await configProblem(event.directory) : undefined
    if (problem) {
      const currentRoot = await scopeRoot(event.directory)
      if (['patch', 'edit', 'write'].includes(event.tool) && currentRoot && event.paths.length && event.paths.every(path => isRepairPath(path, currentRoot))) {
        await guards(event)
        raw.input = event.input
        return
      }
      throw new Error(`工作流配置无效：${problem}。修复后重试；修复期间只允许用 patch/edit/write 修改 .opencode/workflow/**、opencode.jsonc 和各目录 AGENTS.md。`)
    }
    await guards(event)
    await recordScopes(event, mutation)
    raw.input = event.input
  }))
  registrations.push(await ctx.shell.hook('create.before', async raw => {
    const event = normalizeCall('shell', { command: raw.command }, raw.cwd, '__shell__', '__shell__')
    await guards(event)
    raw.command = String(event.input.command)
  }))
  registrations.push(await ctx.session.hook('context', async raw => {
    const directory = await sessionDirectory(raw.sessionID)
    const problem = await configProblem(directory)
    if (problem) raw.system.push({ type: 'text', text: `工作流配置无效：${problem}。写入会被拒绝，先修复配置。` })
    const value = await state(raw.sessionID, directory)
    for (const instruction of value.scopes) {
      let text: string
      try { text = await readFile(instruction, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        value.scopes = value.scopes.filter(path => path !== instruction)
        continue
      }
      if (!text.trim() || text.length > SCOPE_TEXT_LIMIT) throw new Error(`范围规则缺失或超过上限：${instruction}`)
      const block = `领域规则 ${instruction}\n${text}`
      if (!raw.system.some(part => part.type === 'text' && part.text.includes(text))) raw.system.push({ type: 'text', text: block })
    }
    value.visible = [...value.scopes]
    await save(raw.sessionID, value)
  }))
  registrations.push(await ctx.session.hook('compaction', async raw => {
    const directory = await sessionDirectory(raw.sessionID)
    const value = await state(raw.sessionID, directory)
    value.epoch++; value.visible = []
    await save(raw.sessionID, value)
  }))
  const cleanupWatchdog = await registerWatchdog(ctx, ctx.location.directory)
  const cleanupReview = await registerReview(ctx)
  const cleanupRelease = await registerRelease(ctx, root)
  await ctx.storage.set('loaded', { version: 1, opencode: ctx.app.version })
  return async () => {
    controller.abort()
    await cleanupPaths()
    await cleanupWatchdog()
    await cleanupReview()
    await cleanupRelease()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default Plugin.define({ id: 'workflow.starter', setup: registerWorkflow })
