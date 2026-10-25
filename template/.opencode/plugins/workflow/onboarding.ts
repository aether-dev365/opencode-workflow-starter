import type { Plugin } from '@opencode/plugin'
import type { ModelRef } from '@opencode/client'
import { isAbsolute } from 'node:path'
import { validateSetupChoices, type SetupChoices } from './onboarding-config.ts'
import { planSetup, readSetupPlan, pendingSetupPlan, setupWritePaths, applySetup, inspectSetup, type SetupPlan } from './onboarding-files.ts'
import { checkModels, probeSetupRuntime, runSetupDoctor, SkillEvidence, type DoctorReport } from './onboarding-runtime.ts'
import { normalizeCall, type WorkflowEvent } from './protocol.ts'
import { REVIEWER } from './review.ts'
import { sessionQueue } from './serial.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const actions = ['status', 'bootstrap', 'plan', 'apply', 'verify', 'finish']
const requiredSkills = ['brainstorming', 'writing-plans']
const external = ['模型目录可用不等于认证或实际付费调用已验证', '远端 CI、业务测试及 MCP 服务端只读权限尚未由此向导验证']
type Runtime = Awaited<ReturnType<typeof probeSetupRuntime>>
const pointer = (root: string) => `onboarding/plan/${root}`
const modelSummary = (model?: ModelRef) => model ? { providerID: model.providerID, id: model.id, ...(model.variant === undefined ? {} : { variant: model.variant }) } : null
function planningNotes(plan: SetupPlan | null): string[] {
  const request = plan?.request
  return request?.kind === 'configure' ? (['implementer', 'reviewer'] as const).filter(role => request.choices.models[role].mode === 'inherit').map(role => `${role} 的候选继承计划只移除本项目模型覆盖；上级或全局覆盖尚未确认，须应用并重载后由 verify/finish 核对真正有效配置`) : []
}

export async function registerSetupTools(ctx: Plugin.Context, validateMutation: (event: WorkflowEvent, signal: AbortSignal) => Promise<void>): Promise<() => Promise<void>> {
  const ledger = new SkillEvidence(), currentModels = new Map<string, ModelRef>(), reloadRequired = new Set<string>()
  const lifetime = new AbortController(), registrations: { dispose(): Promise<void> }[] = []
  let eventsHealthy = true
  const stream = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        if (event.type === 'config.updated' || event.type === 'plugin.updated') { ledger.invalidateAll(); continue }
        if (!['session.moved', 'session.deleted', 'session.model.selected', 'session.agent.selected', 'session.compaction.started'].includes(event.type) || !('sessionID' in event.data)) continue
        const sessionID = event.data.sessionID
        if (typeof sessionID === 'string') { ledger.invalidate(sessionID); currentModels.delete(sessionID) }
      }
    } catch { /* 订阅中断不影响基础工作流；完整模式必须重新加载才能恢复可验证的失效边界。 */ }
    if (!lifetime.signal.aborted) { eventsHealthy = false; ledger.invalidateAll() }
  })()
  const serial = sessionQueue()
  const probe = (sessionID: Parameters<Plugin.Context['session']['get']>[0]['sessionID']) => probeSetupRuntime(ctx, sessionID, currentModels.get(sessionID))
  const gates = (choices: SetupChoices, runtime: Runtime, sessionID: string, effective = true, checkpoint?: object) => {
    const issues = checkModels(choices, runtime.models, runtime.agents, effective).issues
    if (choices.mode === 'full') {
      if (!eventsHealthy) issues.push('原生失效事件流已中断，无法验证 Location、配置与压缩边界；请重载 OpenCode 并重新读取技能')
      issues.push(...runtime.superpowers.issues)
      const read = ledger.reads(sessionID, runtime.fingerprint)
      for (const id of requiredSkills) if (!read.includes(id)) issues.push(`完整模式需要当前会话真实成功读取 ${id} 技能；列表、自报完成、其他会话或过期证据不算`)
    }
    if (checkpoint && !ledger.isCurrent(sessionID, checkpoint)) issues.push('本次接入操作期间运行时或技能读取证据已失效；请重新核验后显式重试')
    return issues
  }
  const pending = async (runtime: Runtime): Promise<SetupPlan | null> => {
    const id = await ctx.storage.get(pointer(runtime.root))
    if (id === undefined || id === null) return null
    if (typeof id !== 'string') throw new Error('待应用计划指针无效，请重新生成计划')
    return pendingSetupPlan(runtime.root, id)
  }
  const status = async (runtime: Runtime, sessionID: string, checkpoint: object, doctor?: DoctorReport) => {
    const installed = await inspectSetup(runtime.root), pendingPlan = await pending(runtime), issues = [...installed.issues], unverified = [...installed.unverified, ...external, ...planningNotes(pendingPlan)]
    if (!installed.choices) issues.push('尚未记录完整、明确的接入选择；请先调查并向用户提问，不能默认代答')
    else issues.push(...gates(installed.choices, runtime, sessionID, true, checkpoint))
    if (reloadRequired.has(runtime.root)) issues.push('配置已变更，请重载 OpenCode 后重新核对运行时并读取技能；不会沿用旧会话证据')
    if (doctor) {
      for (const check of doctor.checks) if (check.status === 'warn' || check.status === 'unverified') unverified.push(`${check.id}：${check.message}`)
    } else unverified.push('此操作未运行 doctor；完成接入请调用 finish')
    return {
      ready: issues.length === 0, issues: [...new Set(issues)], unverified: [...new Set(unverified)], choices: installed.choices,
      pendingPlan, components: installed.components,
      steps: ['调查项目并逐项询问接入选择', '完整模式先预览安装 Superpowers；授权应用后重载', '真实读取 brainstorming 与 writing-plans，再设计完整配置计划', '预览具体摘要及项目/个人全局影响，申请权限后应用', '重载后核对有效模型与技能，运行 finish 执行 doctor，交付未验证事项'],
      models: { candidates: runtime.models.filter(model => model.enabled && model.capabilities.tools).map(model => ({ providerID: model.providerID, id: model.id, name: model.name, enabled: model.enabled, tools: model.capabilities.tools, variants: model.variants.map(variant => variant.id) })), effective: Object.fromEntries(Object.entries(runtime.agents).map(([role, agent]) => [role, { id: agent.id, model: modelSummary(agent.model) }])), session: modelSummary(runtime.session.model), current: modelSummary(runtime.currentModel) },
      superpowers: { available: !runtime.superpowers.issues.length, issues: runtime.superpowers.issues, read: ledger.reads(sessionID, runtime.fingerprint) },
      ...(doctor ? { doctor } : {}),
    }
  }
  registrations.push(await ctx.tool.hook('execute.before', async event => {
    if (event.tool !== 'skill' || !object(event.input) || !requiredSkills.includes(String(event.input.id))) return
    await serial(event.sessionID, async () => {
      try {
        const runtime = await probe(event.sessionID)
        if (runtime.superpowers.issues.length) { ledger.invalidate(event.sessionID); return }
        ledger.begin(event.sessionID, event.id, runtime.fingerprint)
      } catch { ledger.invalidate(event.sessionID) }
    })
  }))
  registrations.push(await ctx.tool.hook('execute.after', async event => {
    if (event.tool !== 'skill' || !object(event.input) || !requiredSkills.includes(String(event.input.id))) return
    await serial(event.sessionID, async () => {
      try {
        if (event.status !== 'completed') { ledger.invalidate(event.sessionID); return }
        const runtime = await probe(event.sessionID), id = (event.input as { id: string }).id
        const skill = runtime.superpowers.skills.find(skill => skill.id === id)
        if (!skill || !ledger.complete(event.sessionID, event.id, runtime.fingerprint, skill, event.result)) ledger.invalidate(event.sessionID)
      } catch { ledger.invalidate(event.sessionID) }
    })
  }))
  registrations.push(await ctx.session.hook('context', async event => {
    await serial(event.sessionID, async () => {
      currentModels.set(event.sessionID, event.model)
      if (!ledger.has(event.sessionID)) return
      try { ledger.reads(event.sessionID, (await probe(event.sessionID)).fingerprint) } catch { ledger.invalidate(event.sessionID) }
    })
  }))
  registrations.push(await ctx.session.hook('compaction', async event => { await serial(event.sessionID, async () => { ledger.invalidate(event.sessionID) }) }))
  registrations.push(await ctx.tool.transform(editor => editor.add({
    name: 'workflow_setup', options: { codemode: false },
    description: '引导式接入：status 查看已有选择、候选模型和待应用计划；bootstrap 明确项目/个人全局安装计划；plan 预览完整选择；apply 授权指定 planID；verify 核对真实运行时；finish 运行 doctor。不会代用户回答或接受自报技能证据。',
    input: { type: 'object', properties: {
      action: { type: 'string', enum: actions }, scope: { type: 'string', enum: ['project', 'global'] }, choices: { type: 'object' }, source: { type: 'string' }, planID: { type: 'string' },
    }, required: ['action'], additionalProperties: false },
    execute: async (input, context) => serial(context.sessionID, async () => {
      const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal
      const respond = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
      try {
        if (signal.aborted) throw new Error('接入操作已取消')
        if (!object(input) || !actions.includes(String(input.action)) || Object.keys(input).some(name => !['action', 'scope', 'choices', 'source', 'planID'].includes(name))) throw new Error('接入请求无效；必须使用明确选择，不接受 verified 或其他自报证据')
        const runtime = await probe(context.sessionID)
        if (context.agent === REVIEWER || runtime.session.agent === REVIEWER) throw new Error('审核员只读，不能直接调用 workflow_setup；请由主会话操作')
        const action = input.action, checkpoint = ledger.checkpoint(context.sessionID, runtime.fingerprint)
        if (['bootstrap', 'plan', 'apply'].includes(String(action)) && runtime.session.parentID) throw new Error('接入安装和配置只能由主会话预览与应用，子会话不能安装')
        if (action === 'status' || action === 'verify') return respond(await status(runtime, context.sessionID, checkpoint))
        if (action === 'bootstrap' || action === 'plan') {
          let plan: SetupPlan
          if (action === 'bootstrap') {
            if (input.scope !== 'project' && input.scope !== 'global') throw new Error('安装前必须明确选择 project 项目级或 global 个人全局范围')
            plan = await planSetup(runtime.root, { kind: 'superpowers', scope: input.scope })
          } else {
            const choices = validateSetupChoices(input.choices), issues = gates(choices, runtime, context.sessionID, false, checkpoint)
            if (issues.length) return respond({ ready: false, issues, unverified: external })
            if (input.source !== undefined && (typeof input.source !== 'string' || !isAbsolute(input.source))) throw new Error('可选组件 source 必须为用户指定的完整套件绝对路径')
            plan = await planSetup(runtime.root, { kind: 'configure', choices, ...(typeof input.source === 'string' ? { source: input.source } : {}) })
          }
          await ctx.storage.set(pointer(runtime.root), plan.id)
          // 生成与保存计划期间证据可能失效：用同一 checkpoint 再核对，失效时不交出计划 id。
          if (plan.request.kind === 'configure') {
            const issues = gates(plan.request.choices, runtime, context.sessionID, false, checkpoint)
            if (issues.length) return respond({ ready: false, issues, unverified: external })
          }
          return respond({ ...plan, ready: false, issues: [], unverified: ['计划尚未应用；请向用户说明目标摘要、范围与冲突后，使用此 id 作为 planID 申请权限', ...planningNotes(plan)] })
        }
        if (action === 'apply') {
          if (typeof input.planID !== 'string') throw new Error('apply 必须指定已预览的具体 planID，不能默认应用上次计划')
          const plan = await readSetupPlan(runtime.root, input.planID)
          if (plan.request.kind === 'configure') {
            const issues = gates(plan.request.choices, runtime, context.sessionID, false, checkpoint)
            if (issues.length) return respond({ ready: false, issues, unverified: external })
          }
          const source = { type: 'tool' as const, messageID: context.messageID, id: context.id }
          await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: 'workflow_setup', resources: [`plan:${plan.id}`, ...plan.changes.map(change => `${change.scope}:${change.path}:${change.after}`)], source })
          const paths = await setupWritePaths(runtime.root, plan.id)
          if (paths.length) await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: 'edit', resources: paths, source })
          const latest = await probe(context.sessionID)
          if (signal.aborted || latest.fingerprint !== runtime.fingerprint || latest.session.parentID || latest.session.agent === REVIEWER) throw new Error('审批期间 Location、配置、模型或来源已改变或操作已取消；未应用，请重新预览核验')
          // 校验回调由插件注册时提供，只使用不可变计划的真实修改路径，不能由工具参数替换。
          if (paths.length) await validateMutation(normalizeCall('write', { file_paths: paths, action: 'edit' }, runtime.directory, context.sessionID, context.id), signal)
          if (signal.aborted) throw new Error('接入操作已取消')
          if (plan.request.kind === 'configure') {
            const issues = gates(plan.request.choices, latest, context.sessionID, false, checkpoint)
            if (issues.length) return respond({ ready: false, issues, unverified: external })
          }
          const result = await applySetup(runtime.root, plan.id)
          if (result.changed.length) { ledger.invalidate(context.sessionID); reloadRequired.add(runtime.root) }
          // 指针只记最新的计划；应用的是更早的计划时，较新的计划仍待应用。
          if (await ctx.storage.get(pointer(runtime.root)) === plan.id) await ctx.storage.remove(pointer(runtime.root))
          return respond({ ...result, ready: false, issues: [], unverified: [...result.pending, ...planningNotes(plan), '应用不等于完成；如有配置变更，请重载 OpenCode 后重新核验并调用 finish'] })
        }
        const before = await status(runtime, context.sessionID, checkpoint)
        if (!before.ready) return respond(before)
        const doctor = await runSetupDoctor(runtime.root, { signal })
        const latest = await probe(context.sessionID)
        if (signal.aborted || runtime.fingerprint !== latest.fingerprint) throw new Error('doctor 执行期间 Location、配置、模型或来源已改变，未确认就绪；请重新核验')
        return respond(await status(latest, context.sessionID, checkpoint, doctor))
      } catch (error) { return respond({ ready: false, issues: [`接入操作未完成：${(error as Error).message}`], unverified: external }) }
    }),
  })))
  return async () => {
    lifetime.abort()
    for (const registration of registrations.reverse()) await registration.dispose()
    await stream
    ledger.invalidateAll(); currentModels.clear(); reloadRequired.clear()
  }
}
