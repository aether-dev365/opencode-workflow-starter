import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

export type EvidenceEntry = { id: string; units: string[]; kind: 'test' | 'build' | 'manual' | 'device'; command: string; cwd: string; exit: number | null; inputs: Record<string, string>; files: string[]; companion?: string[] }
export type EvidenceResult = { entries: EvidenceEntry[]; problems: string[] }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function evidenceFile(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.git')) throw new Error('证据路径越界或指向 Git 元数据')
  const base = realpathSync(root), file = realpathSync(resolve(root, path)), rel = relative(base, file)
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').includes('.git') || !statSync(file).isFile()) throw new Error('证据必须是检出内的普通文件')
  return file
}
export function validateEvidence(root: string, path: string, knownUnits: Set<string>, expected: { base: string; tree: string }): EvidenceResult {
  const entries: EvidenceEntry[] = [], problems: string[] = []
  try {
    const raw = JSON.parse(readFileSync(evidenceFile(root, path), 'utf8'))
    if (raw.version !== 1 || raw.base !== expected.base || raw.tree !== expected.tree) throw new Error('证据基线或候选内容树不一致')
    if (!Array.isArray(raw.entries) || !raw.entries.length) throw new Error('证据 entries 不能为空')
    const ids = new Set<string>()
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0)
    for (const row of raw.entries) {
      if (!row || !/^[a-zA-Z0-9_-]+$/.test(row.id) || ids.has(row.id) || !strings(row.units) || !row.units.length || row.units.some((u: string) => !knownUnits.has(u)) ||
          !['test', 'build', 'manual', 'device'].includes(row.kind) || typeof row.command !== 'string' || !row.command.trim() || typeof row.cwd !== 'string' || !row.cwd ||
          !(row.exit === null || Number.isInteger(row.exit)) || (['test', 'build'].includes(row.kind) && row.exit !== 0) ||
          !row.inputs || typeof row.inputs !== 'object' || Array.isArray(row.inputs) || !Object.values(row.inputs).every(v => typeof v === 'string') ||
          !strings(row.files) || !row.files.length || (row.companion !== undefined && !strings(row.companion))) throw new Error('证据条目无效或验证命令失败')
      ids.add(row.id)
      let readableCompanion = false
      let binaryEvidence = false
      for (const file of [...row.files, ...row.companion ?? []]) {
        const bytes = readFileSync(evidenceFile(root, file))
        let text: string | null = null
        try { if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {}
        if (text !== null) {
          if (file.endsWith('.json')) JSON.parse(text)
          else if (text.split('\n').some(line => line.length > 2000)) throw new Error('证据单行过长，请提供可读副本')
          if (row.companion?.includes(file) && text.trim()) readableCompanion = true
        } else if (row.files.includes(file)) binaryEvidence = true
      }
      if (binaryEvidence && !readableCompanion) throw new Error('二进制证据缺少可读 companion')
      entries.push(row)
    }
  } catch (error) { problems.push(String((error as Error).message)) }
  return { entries, problems }
}
export function evidenceDigest(root: string, path: string): string {
  const bytes = readFileSync(evidenceFile(root, path))
  const raw = JSON.parse(bytes.toString('utf8'))
  const files = [...new Set<string>(raw.entries.flatMap((e: EvidenceEntry) => [...e.files, ...e.companion ?? []]))].sort()
  return digest(JSON.stringify([digest(bytes), ...files.map(file => [file, digest(readFileSync(evidenceFile(root, file)))])]))
}
export function artifactDigests(root: string, entries: EvidenceEntry[], artifacts: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const path of artifacts) {
    const values = [...new Set(entries.map(e => e.inputs['sha256:' + path]).filter(Boolean))]
    if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(values[0])) throw new Error(`缺少或冲突的产物摘要：${path}`)
    const actual = digest(readFileSync(evidenceFile(root, path)))
    if (actual !== values[0]) throw new Error(`产物摘要不一致：${path}`)
    result[path] = actual
  }
  return result
}
