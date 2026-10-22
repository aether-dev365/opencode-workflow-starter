import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RoutingConfig } from './config.ts'
import { matchesPattern } from './patterns.ts'

export type Mode = 'branch' | 'range' | 'preflight' | 'release'
export type Verdict = 'pass' | 'findings' | 'incomplete'
export type Finding = { unitId: string; severity: 'P0' | 'P1' | 'P2' | 'P3'; summary: string; blocking: boolean }
export type Gap = { unitId: string; reason: string }
export type PlannedTask = { id: string; unitId: string; paths: string[] }
export type ReviewTask = PlannedTask & { checklist: string; verdict: Verdict | null; findings: Finding[]; gaps: Gap[]; note: string }
export type Batch = { batchId: string; createdAt: number; mode: Mode; base: string; head: string; tree: string; status: 'open' | 'closed'; tasks: ReviewTask[]; reviewDir: string; authorization?: { evidencePath: string; evidenceDigest: string; configDigest: string; artifactDigests: Record<string, string> } }
export type Submission = { batchId: string; taskId: string; verdict: Verdict; findings?: Finding[]; gaps?: Gap[]; note?: string }

export function git(root: string, args: string[], env = process.env): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '')
}
export function reviewsDir(root: string): string {
  return join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'workflow/reviews/batches')
}
export function saveBatch(root: string, batch: Batch): void {
  const dir = reviewsDir(root)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, batch.batchId + '.json')
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(batch, null, 2))
  renameSync(temporary, path)
}
let lastCreated = 0
export function createBatch(root: string, input: Omit<Batch, 'batchId' | 'createdAt' | 'status'>): Batch {
  lastCreated = Math.max(Date.now(), lastCreated + 1)
  const batch: Batch = { ...input, batchId: 'b-' + randomUUID(), createdAt: lastCreated, status: 'open' }
  saveBatch(root, batch)
  return batch
}
export function loadBatch(root: string, id: string): Batch {
  if (!/^b-[a-f0-9-]{36}$/.test(id)) throw new Error('批次 ID 无效')
  const batch = JSON.parse(readFileSync(join(reviewsDir(root), id + '.json'), 'utf8'))
  if (batch.batchId !== id || !Array.isArray(batch.tasks) || !['open', 'closed'].includes(batch.status)) throw new Error('批次记录无效')
  return batch
}
export function listBatches(root: string): Batch[] {
  const dir = reviewsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(p => /^b-[a-f0-9-]{36}\.json$/.test(p)).map(p => loadBatch(root, p.slice(0, -5))).sort((a, b) => b.createdAt - a.createdAt)
}
export function planTasks(paths: string[], routing: RoutingConfig): PlannedTask[] {
  const areaOf = (p: string) => routing.areas.find(a => a.paths.some(pattern => matchesPattern(p, pattern)))?.id ?? 'common'
  const tasks: PlannedTask[] = []
  for (const id of ['core', 'tests']) for (const area of [...new Set(paths.map(areaOf))]) {
    tasks.push({ id: `${id}:${area}`, unitId: id, paths: paths.filter(p => areaOf(p) === area) })
  }
  for (const unit of routing.units.filter(u => !['core', 'tests'].includes(u.id))) {
    const selected = paths.filter(p => unit.areas.includes('*') || unit.areas.includes(areaOf(p)))
    if (selected.length) tasks.push({ id: unit.id, unitId: unit.id, paths: selected })
  }
  return tasks
}
export function submitVerdict(root: string, agent: string, input: Submission): Batch {
  if (agent !== 'reviewer') throw new Error('仅实际 reviewer 可提交审核结论')
  const batch = loadBatch(root, input.batchId)
  if (batch.status !== 'open') throw new Error('批次已经关闭')
  const task = batch.tasks.find(t => t.id === input.taskId)
  if (!task) throw new Error('未知审核任务')
  if (task.verdict !== null) throw new Error('该任务已有结论；修复或补证后按同一累计 base 重新 run')
  const findings = input.findings ?? [], gaps = input.gaps ?? []
  if (batch.mode === 'preflight' && (input.verdict === 'incomplete' || gaps.length)) throw new Error('预审只接受 pass/findings，不报证据缺口')
  if (!['pass', 'findings', 'incomplete'].includes(input.verdict) || !Array.isArray(findings) || !Array.isArray(gaps) ||
      findings.some(f => !f || f.unitId !== task.unitId || !['P0', 'P1', 'P2', 'P3'].includes(f.severity) || !f.summary || typeof f.blocking !== 'boolean') ||
      gaps.some(g => !g || g.unitId !== task.unitId || !g.reason)) throw new Error('审核结论格式无效')
  if (input.verdict === 'pass' && (gaps.length || findings.some(f => f.blocking || ['P0', 'P1'].includes(f.severity)))) throw new Error('存在阻断或证据缺口，不能通过')
  if (input.verdict === 'incomplete' && !gaps.length) throw new Error('未完成结论必须说明缺口')
  if (input.verdict === 'findings' && !findings.length) throw new Error('发现结论必须列出问题')
  Object.assign(task, { verdict: input.verdict, findings, gaps, note: input.note ?? '' })
  saveBatch(root, batch)
  return batch
}
export function closeBatch(root: string, id: string): Batch {
  const batch = loadBatch(root, id)
  if (!batch.tasks.length || batch.tasks.some(t => !t.verdict)) throw new Error('审核任务未完成')
  batch.status = 'closed'
  saveBatch(root, batch)
  return batch
}
export function renderReport(batch: Batch): string {
  return [`# ${batch.batchId}`, `模式：${batch.mode}；状态：${batch.status}`, `范围：${batch.base}..${batch.head}`, `内容树：${batch.tree}`, `材料：${batch.reviewDir}`,
    ...batch.tasks.map(t => `\n## ${t.id}\n结论：${t.verdict ?? '待审'}\n${t.note}\n${t.findings.map(f => JSON.stringify(f)).join('\n')}\n${t.gaps.map(g => JSON.stringify(g)).join('\n')}`)].join('\n')
}
