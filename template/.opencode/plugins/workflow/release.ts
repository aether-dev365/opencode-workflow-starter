import type { Plugin } from '@opencode/plugin'
import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { git, listBatches } from './review-batches.ts'
import { digest, evidenceDigest, evidenceFile } from './evidence.ts'
import { patternProblem } from './patterns.ts'
import { childOptions, executable, killTree } from './platform.ts'

export type ReleaseEntry = { id: string; argv: string[]; artifacts: string[] }
export type ReleaseConfig = { version: 1; enabled: true; tagPattern: string; scope: { include: string[]; exclude: string[] }; entries: ReleaseEntry[] }
export type GateResult = { allow: boolean; reason: string }
export function loadReleaseConfig(root: string): ReleaseConfig | null {
  const path = join(root, '.opencode/workflow/release.json')
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('发布配置无效')
  if (!value.enabled) return null
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0 && !s.includes('\0'))
  const safe = (p: string) => !isAbsolute(p) && !p.split(/[\\/]/).some(s => ['..', '.git'].includes(s))
  if (typeof value.tagPattern !== 'string' || !value.tagPattern.startsWith('^') || !value.tagPattern.endsWith('$') ||
      !value.scope || !strings(value.scope.include) || !value.scope.include.length || !strings(value.scope.exclude) ||
      ![...value.scope.include, ...value.scope.exclude].every(safe) || !Array.isArray(value.entries) || !value.entries.length ||
      value.entries.some((e: ReleaseEntry) => !e || !/^[a-z][a-z0-9-]*$/.test(e.id) || !strings(e.argv) || !e.argv.length || !strings(e.artifacts) || !e.artifacts.every(safe)) ||
      new Set(value.entries.map((e: ReleaseEntry) => e.id)).size !== value.entries.length) throw new Error('发布配置无效')
  new RegExp(value.tagPattern)
  for (const pattern of [...value.scope.include, ...value.scope.exclude]) {
    const problem = patternProblem(pattern)
    if (problem) throw new Error(problem)
  }
  return value
}
export function releaseConfigDigest(root: string): string {
  return digest(readFileSync(join(root, '.opencode/workflow/release.json')))
}
export function releaseBase(root: string, pattern: string, head: string): string {
  const tags = git(root, ['tag', '--merged', head]).split('\n').filter(Boolean).filter(t => new RegExp(pattern).test(t))
  const candidates = tags.filter(t => git(root, ['cat-file', '-t', 'refs/tags/' + t]) === 'tag').map(t => ({
    commit: git(root, ['rev-parse', `refs/tags/${t}^{commit}`]), distance: Number(git(root, ['rev-list', '--count', `refs/tags/${t}..${head}`])),
  })).sort((a, b) => a.distance - b.distance)
  if (!candidates.length) throw new Error('找不到可达的 annotated 发布基线，请显式给 base')
  return candidates[0].commit
}
export function checkRelease(root: string, entryId?: string): GateResult {
  try {
    root = git(root, ['rev-parse', '--show-toplevel'])
    const config = loadReleaseConfig(root)
    if (!config) throw new Error('发布扩展禁用或缺少配置')
    if (entryId && !config.entries.some(e => e.id === entryId)) throw new Error('未知发布入口')
    if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('发布候选存在未提交改动')
    const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
    const batch = listBatches(root).find(b => b.mode === 'release' && b.tree === tree)
    if (!batch || batch.status !== 'closed' || !batch.tasks.length || batch.tasks.some(t => t.verdict !== 'pass' || t.gaps.length || t.findings.some(f => f.blocking || ['P0', 'P1'].includes(f.severity)))) throw new Error('缺少当前候选最新已关闭且通过的 release 批次')
    const auth = batch.authorization
    if (!auth || auth.configDigest !== releaseConfigDigest(root) || auth.evidenceDigest !== evidenceDigest(root, auth.evidencePath)) throw new Error('发布配置或审核证据已改变')
    const artifacts = config.entries.filter(e => !entryId || e.id === entryId).flatMap(e => e.artifacts)
    for (const path of artifacts) if (!auth.artifactDigests[path] || digest(readFileSync(evidenceFile(root, path))) !== auth.artifactDigests[path]) throw new Error('产物已改变或缺少摘要：' + path)
    return { allow: true, reason: '当前候选、审核、证据和产物一致' }
  } catch (error) { return { allow: false, reason: String((error as Error).message) } }
}
export function launchFailure(platform: NodeJS.Platform = process.platform): string {
  // Node 在 Windows 上不会直接启动 .cmd/.bat（npm、pnpm 等都是这类启动器）。
  return platform === 'win32' ? '无法启动发布入口：Windows 上 argv[0] 必须是可执行文件，不能是 .cmd/.bat；请改用 node 等入口，例如 ["node", "scripts/publish.mjs"]' : '无法启动发布入口'
}
export function missingEntry(name: string, platform: NodeJS.Platform = process.platform): string {
  // 不带路径的入口只在 PATH 中查找，不查项目目录；项目内的程序要写明路径。
  const windows = platform === 'win32' ? '；Windows 上只认 .exe/.com，.cmd/.bat 启动器（例如 npm、npx）请改用 ["node", "scripts/publish.mjs"] 这类入口' : ''
  return `无法启动发布入口：PATH 中找不到 ${name}；项目内的程序请写成带路径的形式，例如 ./scripts/publish${windows}`
}
export async function executeRelease(root: string, entryId: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  root = git(root, ['rev-parse', '--show-toplevel'])
  const gate = checkRelease(root, entryId)
  if (!gate.allow) throw new Error(gate.reason)
  if (signal?.aborted) throw new Error('发布已取消')
  const entry = loadReleaseConfig(root)!.entries.find(e => e.id === entryId)!
  return new Promise((done, fail) => {
    let command: string
    try { command = executable(entry.argv[0]) } catch { fail(new Error(missingEntry(entry.argv[0]))); return }
    const child = spawn(command, entry.argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...childOptions() })
    let output = '', bytes = 0, stopped = false
    const stop = (reason: string) => {
      if (stopped) return
      stopped = true
      killTree(child)
      signal?.removeEventListener('abort', abort)
      fail(new Error(reason))
    }
    const abort = () => stop('发布已取消')
    signal?.addEventListener('abort', abort, { once: true })
    const consume = (data: Buffer) => {
      bytes += data.length
      if (bytes > 1024 * 1024) { stop('发布输出超过 1 MiB'); return }
      output += data.toString('utf8')
    }
    child.stdout.on('data', consume); child.stderr.on('data', consume)
    child.on('error', () => stop(launchFailure()))
    child.on('close', code => {
      signal?.removeEventListener('abort', abort)
      if (stopped) return
      if (code !== 0) { fail(new Error(`发布入口失败，退出码 ${code}\n${output}`)); return }
      done({ code: 0, output })
    })
  })
}
export async function registerRelease(ctx: Plugin.Context, root: string | undefined): Promise<() => Promise<void>> {
  if (!root || !existsSync(join(root, '.opencode/workflow/release.json'))) return async () => {}
  const registration = await ctx.tool.transform(editor => editor.add({
    name: 'workflow_release', options: { codemode: false }, description: '核当前发布批次并执行已配置的固定入口；不接受临时命令。',
    input: { type: 'object', properties: { entry: { type: 'string' } }, required: ['entry'], additionalProperties: false },
    execute: async (raw, context) => {
      const directory = git((await ctx.session.get({ sessionID: context.sessionID })).location.directory, ['rev-parse', '--show-toplevel'])
      const entry = (raw as { entry: string }).entry
      const configHash = releaseConfigDigest(directory)
      const gate = checkRelease(directory, entry)
      if (!gate.allow) throw new Error(gate.reason)
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: 'tool', messageID: context.messageID, id: context.id }, action: 'workflow_release', resources: [entry], save: [entry] })
      if (releaseConfigDigest(directory) !== configHash) throw new Error('审批期间发布配置改变，请重新请求')
      const result = await executeRelease(directory, entry, context.signal)
      return { content: `退出码：${result.code}\n${result.output}` }
    },
  }))
  return () => registration.dispose()
}
