import { Plugin } from '@opencode/plugin'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeCall } from './protocol.ts'
import type { WorkflowEvent, CombinedResult } from './protocol.ts'
import { runChecks } from './runner.ts'
import type { CheckName } from './runner.ts'
import { matchingScopes, SCOPE_TEXT_LIMIT } from './scopes.ts'
import { registerPathPermissions, REVIEWER_ACTIONS } from './permissions.ts'
import { registerWatchdog } from './watchdog.ts'
import { scopeRoot } from './scopes.ts'
import { loadProjectConfig } from './config.ts'
import { registerReview, REVIEWER } from './review.ts'
import { registerRelease, loadReleaseConfig } from './release.ts'
import { containedRelative, unsupportedShell, windowsPath } from './platform.ts'

const guards: CheckName[] = ['pre-guard-paths', 'pre-secret-scan', 'pre-bash-pipefail']
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
  const allow = (result: CombinedResult, event: WorkflowEvent) => {
    if (result.decision !== 'allow') throw new Error(result.reason || '操作已拒绝')
    if (result.input) event.input = { ...event.input, ...result.input }
  }
  // OpenCode 的 shell 工具在 tool 钩子之后还会触发 create.before；刚检查过的同一条命令只放行一次，10 秒内有效。
  // 结论依赖仓库内容的命令（提交扫描、递归删除）不缓存：两次钩子之间暂存区或目录可能已被其他会话改变。
  const approvals = new Map<string, number>()
  const approvalKey = (cwd: string, command: string) => `${cwd}\0${command}`
  const approve = (event: WorkflowEvent) => {
    const now = Date.now()
    for (const [entry, expiry] of approvals) if (expiry < now) approvals.delete(entry)
    approvals.set(approvalKey(resolve(event.directory, windowsPath(String(event.input.workdir || ''))), String(event.input.command)), now + 10_000)
  }
  const consume = (cwd: string, command: string) => {
    const entry = approvalKey(cwd, command), expiry = approvals.get(entry)
    approvals.delete(entry)
    return expiry !== undefined && expiry >= Date.now()
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
    // OpenCode 只在工具自己请求权限时才做判定，没有命令的 shell 语句和插件工具会绕过权限钩子；reviewer 只读在每次调用前再拦一次。
    if (raw.agent === REVIEWER && !REVIEWER_ACTIONS.has(raw.tool)) throw new Error(`审核员只读：只允许 read、glob、grep 和 workflow_review_submit，已拒绝 ${raw.tool}`)
    const directory = await sessionDirectory(raw.sessionID)
    const event = normalizeCall(raw.tool, raw.input as Record<string, unknown>, directory, raw.sessionID, raw.id)
    if (!mutations.has(event.tool)) { await recordScopes(event, false); return }
    // 一个检查进程完成 shell 路径分析和全部守卫；shell 的守卫只看命令本身，只读候选路径用于加载规则。
    const shell = event.tool === 'shell'
    const result = await runChecks(event, shell ? ['inspect-paths', ...guards] : guards, controller.signal)
    if (shell) event.paths = result.inspect!.paths
    const mutation = shell ? !result.inspect!.readonly : true
    const problem = mutation ? await configProblem(event.directory) : undefined
    if (problem) {
      const currentRoot = await scopeRoot(event.directory)
      if (['patch', 'edit', 'write'].includes(event.tool) && currentRoot && event.paths.length && event.paths.every(path => isRepairPath(path, currentRoot))) {
        allow(result, event)
        raw.input = event.input
        return
      }
      throw new Error(`工作流配置无效：${problem}。修复后重试；修复期间只允许用 patch/edit/write 修改 .opencode/workflow/**、opencode.jsonc 和各目录 AGENTS.md。`)
    }
    allow(result, event)
    await recordScopes(event, mutation)
    if (shell && !result.volatile) approve(event)
    raw.input = event.input
  }))
  registrations.push(await ctx.shell.hook('create.before', async raw => {
    const refused = unsupportedShell(raw.shell)
    if (refused) throw new Error(refused)
    // 工具的 workdir 可以是相对路径；OpenCode 在本钩子之后才把它解析为绝对路径。
    const cwd = resolve(ctx.location.directory, windowsPath(raw.cwd || ''))
    if (consume(cwd, raw.command)) return
    const event = normalizeCall('shell', { command: raw.command }, cwd, '__shell__', '__shell__')
    allow(await runChecks(event, guards, controller.signal), event)
    raw.command = String(event.input.command)
  }))
  registrations.push(await ctx.session.hook('context', async raw => {
    const directory = await sessionDirectory(raw.sessionID)
    const problem = await configProblem(directory)
    if (problem) raw.system.push({ type: 'text', text: `工作流配置无效：${problem}。写入会被拒绝，先修复配置。` })
    const value = await state(raw.sessionID, directory)
    const visible: string[] = []
    for (const instruction of value.scopes) {
      let text: string
      try { text = await readFile(instruction, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        value.scopes = value.scopes.filter(path => path !== instruction)
        continue
      }
      if (!text.trim() || text.length > SCOPE_TEXT_LIMIT) {
        // 不中断整轮上下文：模型需要这一轮来修复规则文件；修复前该领域保持不可见，写入继续被拒绝。
        raw.system.push({ type: 'text', text: `领域规则 ${instruction} 为空或超过 ${SCOPE_TEXT_LIMIT} 字符，未注入；先修复该文件，再修改这个领域。` })
        continue
      }
      const block = `领域规则 ${instruction}\n${text}`
      if (!raw.system.some(part => part.type === 'text' && part.text.includes(text))) raw.system.push({ type: 'text', text: block })
      visible.push(instruction)
    }
    value.visible = visible
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
