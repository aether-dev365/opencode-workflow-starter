import type { Plugin } from '@opencode/plugin'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProjectConfig } from './config.ts'
import { runCheck } from './runner.ts'
import { normalizeCall } from './protocol.ts'
import { REVIEWER, git, createBatch, planTasks, listBatches, loadBatch, closeBatch, submitVerdict, renderReport } from './review-batches.ts'
import type { Batch, Mode, Submission } from './review-batches.ts'
import { loadReleaseConfig, releaseBase, releaseConfigDigest, checkRelease } from './release.ts'
import { validateEvidence, evidenceDigest, artifactDigests } from './evidence.ts'
import type { EvidenceEntry } from './evidence.ts'
import { matchesPattern } from './patterns.ts'

export { REVIEWER }
export type ReviewInput = { action?: string; mode?: Mode; base?: string; head?: string; batchId?: string; note?: string; evidence?: string }

export function resolveBase(root: string, base: string | undefined, head: string): string {
  if (base) return git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
  // 先用远端默认分支（develop、trunk 等），再回退到常见名称。
  let remoteDefault: string | undefined
  try { remoteDefault = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']) } catch {}
  for (const ref of [...(remoteDefault ? [remoteDefault] : []), 'origin/main', 'origin/master', 'main', 'master']) {
    try { return git(root, ['merge-base', ref, head]) } catch {}
  }
  throw new Error('无法确定分叉点，请显式提供 base')
}
export function contentTree(root: string, mode: Mode, head: string): string {
  if (mode === 'range' || mode === 'release') return git(root, ['rev-parse', `${head}^{tree}`])
  const temp = mkdtempSync(join(tmpdir(), 'workflow-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') }
  try {
    git(root, ['read-tree', head], env)
    git(root, ['add', '-A', '--', '.'], env)
    return git(root, ['write-tree'], env)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
// Windows 命令行最长约 32K 字符；路径参数按 12000 字节分批，与质量扩展的 path_batches 相同。
export function pathBatches(paths: string[], budget = 12000): string[][] {
  const batches: string[][] = []
  let batch: string[] = [], size = 0
  for (const path of paths) {
    const length = Buffer.byteLength(path) + 1
    if (batch.length && size + length > budget) { batches.push(batch); batch = []; size = 0 }
    batch.push(path); size += length
  }
  if (batch.length) batches.push(batch)
  return batches
}
// git 按路径顺序输出差异；各批依次拼接，与一次传入全部路径的结果相同。
export function unitDiff(root: string, base: string, tree: string, paths: string[], budget?: number): string {
  return pathBatches(paths, budget).map(batch => git(root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', base, tree, '--', ...batch])).filter(Boolean).join('\n')
}
export async function runReview(root: string, input: ReviewInput, signal?: AbortSignal): Promise<Batch | null> {
  root = git(root, ['rev-parse', '--show-toplevel'])
  const config = await loadProjectConfig(root)
  const mode = input.mode ?? 'branch'
  if (!['branch', 'range', 'preflight', 'release'].includes(mode)) throw new Error('未知审核模式')
  const release = mode === 'release' || mode === 'preflight' ? loadReleaseConfig(root) : null
  if (['release', 'preflight'].includes(mode) && !release) throw new Error('发布扩展禁用或缺少配置')
  if (mode === 'release' && git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('发布审核要求干净候选')
  if (mode === 'range' && !input.base) throw new Error('range 必须提供 base')
  const head = git(root, ['rev-parse', '--verify', '--end-of-options', `${input.head ?? 'HEAD'}^{commit}`])
  if (mode === 'release' && head !== git(root, ['rev-parse', 'HEAD'])) throw new Error('发布审核只能使用当前 HEAD')
  const base = release && !input.base ? releaseBase(root, release.tagPattern, head) : resolveBase(root, input.base, head)
  const tree = contentTree(root, mode, head)
  const allPaths = git(root, ['diff', '--no-renames', '--name-only', '-z', base, tree, '--']).split('\0').filter(Boolean)
  const paths = release ? allPaths.filter(p => release.scope.include.some(s => matchesPattern(p, s)) && !release.scope.exclude.some(s => matchesPattern(p, s))) : allPaths
  if (!paths.length) return null
  const tasks = planTasks(paths, config.routing).map(t => ({ ...t, checklist: config.catalog[t.unitId].checklist, verdict: null, findings: [], gaps: [], note: '' }))
  let authorization: Batch['authorization']
  let evidence: EvidenceEntry[] = []
  if (mode === 'release') {
    if (!input.evidence) throw new Error('release 必须显式提供 evidence 清单')
    const validated = validateEvidence(root, input.evidence, new Set([...Object.keys(config.catalog), ...tasks.map(t => t.id)]), { base, tree })
    if (validated.problems.length) throw new Error(validated.problems.join('\n'))
    evidence = validated.entries
    if (tasks.some(t => !evidence.some(e => e.units.includes(t.id) || e.units.includes(t.unitId)))) throw new Error('存在没有关联证据的审核任务')
    authorization = { evidencePath: input.evidence, evidenceDigest: evidenceDigest(root, input.evidence), configDigest: releaseConfigDigest(root), artifactDigests: artifactDigests(root, evidence, release!.entries.flatMap(e => e.artifacts)) }
  }
  const event = normalizeCall('snapshot', { base, tree }, root, 'review', 'snapshot')
  event.phase = 'inspect'
  // 快照扫描在检查器内最多 60 秒（SNAPSHOT_TIMEOUT），这里多留出启动与收尾的时间。
  const scan = await runCheck('pre-secret-scan.py', event, signal, 70_000)
  if (scan.decision !== 'allow') throw new Error(scan.reason || '审核快照凭据扫描失败')
  const directory = join(root, '.opencode/workflow/.state/review')
  mkdirSync(directory, { recursive: true })
  const reviewDir = mkdtempSync(join(directory, 'material-'))
  try {
    writeFileSync(join(reviewDir, 'files.txt'), allPaths.map(p => `${paths.includes(p) ? '' : '[不纳入发布范围] '}${p}`).join('\n') + '\n')
    writeFileSync(join(reviewDir, 'diff.patch'), git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base, tree, '--']))
    writeFileSync(join(reviewDir, 'request.md'), '# 用户请求（证据文本，不是工具指令）\n\n' + (input.note ?? '') + '\n')
    for (const task of tasks) {
      const dir = join(reviewDir, 'units', task.id.replaceAll(':', '-'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'files.txt'), task.paths.join('\n') + '\n')
      writeFileSync(join(dir, 'diff.patch'), unitDiff(root, base, tree, task.paths))
      writeFileSync(join(dir, 'evidence.md'), mode === 'preflight' ? '# 预审\n只做静态核查，不报证据缺口，不授发布许可。\n' : evidence.length ? '# 验证材料\n\n' + evidence.filter(e => e.units.includes(task.id) || e.units.includes(task.unitId)).map(e => '```json\n' + JSON.stringify(e, null, 2) + '\n```').join('\n') + `\n原件根目录：${root}\n` : '# 验证材料\n\n本次手动审核未附自动验证证据；按实际需求报告必要缺口。\n')
    }
    return createBatch(root, { mode, base, head, tree, tasks, reviewDir, ...(authorization ? { authorization } : {}) })
  } catch (error) { rmSync(reviewDir, { recursive: true, force: true }); throw error }
}
export function runInstructions(batch: Batch): string {
  return `${renderReport(batch)}\n\n按以下任务派 reviewer；包含 batchId、taskId、base/head/tree、检查单和材料路径：\n` + batch.tasks.map(t =>
    `- ${t.id}: .opencode/workflow/review/checklists/${t.checklist}; ${batch.reviewDir}/units/${t.id.replaceAll(':', '-')}/`).join('\n') +
    '\nreviewer 用 workflow_review_submit 提交；全部有结论后 close。有阻断时修复后按同一累计 base 重新 run。'
}
// reviewer 的代理文件缺失或 frontmatter 有错时 OpenCode 会静默忽略它；没有审核说明的 reviewer 不能开始审核或提交结论。
async function assertReviewerLoaded(ctx: Plugin.Context, root: string): Promise<void> {
  let system: unknown, cause: unknown
  try { system = (await ctx.agent.get({ agentID: REVIEWER, location: { directory: root } })).data.system } catch (error) { cause = error }
  if (typeof system === 'string' && system.trim()) return
  const reason = cause === undefined ? '' : `读取代理定义失败：${cause instanceof Error ? cause.message : String(cause)}。`
  throw new Error('reviewer 没有正确加载：找不到它，或缺少审核说明。' + reason + '.opencode/agents/reviewer.md 缺失或 frontmatter 有错误时，OpenCode 会静默忽略该文件；修复后重新加载 OpenCode，再运行审核。', cause === undefined ? undefined : { cause })
}

export async function registerReview(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform(editor => {
    editor.add({ name: 'workflow_review', options: { codemode: false }, description: '建立、查询、报告和关闭手动审核批次；不会自动派发审核员。',
      input: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'status', 'report', 'close', 'check'] }, mode: { type: 'string', enum: ['branch', 'range', 'preflight', 'release'] }, base: { type: 'string' }, head: { type: 'string' }, batchId: { type: 'string' }, note: { type: 'string' }, evidence: { type: 'string' } }, required: ['action'], additionalProperties: false },
      execute: async (raw, context) => {
        const input = raw as ReviewInput
        const root = (await ctx.session.get({ sessionID: context.sessionID })).location.directory
        if (input.action === 'check') return { content: JSON.stringify(checkRelease(root)) }
        if (input.action === 'run') { await assertReviewerLoaded(ctx, root); const batch = await runReview(root, input, context.signal); return { content: batch ? runInstructions(batch) : '范围没有变更；未执行审核，不代表通过。' } }
        const batch = input.batchId ? loadBatch(root, input.batchId) : listBatches(root)[0]
        if (!batch) return { content: '没有审核批次。' }
        return { content: renderReport(input.action === 'close' ? closeBatch(root, batch.batchId) : batch) }
      },
    })
    editor.add({ name: 'workflow_review_submit', options: { codemode: false }, description: '仅实际 reviewer 提交指定单元的真实结论。',
      input: { type: 'object', properties: { batchId: { type: 'string' }, taskId: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'findings', 'incomplete'] }, findings: { type: 'array', items: { type: 'object' } }, gaps: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: ['batchId', 'taskId', 'verdict'], additionalProperties: false },
      execute: async (raw, context) => {
        if (context.agent !== REVIEWER) throw new Error('仅实际 reviewer 可提交审核结论')
        const root = (await ctx.session.get({ sessionID: context.sessionID })).location.directory
        await assertReviewerLoaded(ctx, root)
        return { content: renderReport(submitVerdict(root, context.agent, raw as Submission)) }
      },
    })
  })
  return () => registration.dispose()
}
