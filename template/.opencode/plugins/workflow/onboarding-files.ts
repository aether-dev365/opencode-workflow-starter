import { constants } from 'node:fs'
import { lstat, readFile, readdir, realpath, mkdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, join, dirname, basename, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { applyEdits, modify, parse, parseTree, type ParseError, type Node } from 'jsonc-parser'
import { containedRelative, samePath, pythonCommand, pythonEnv, hookExecutable } from './platform.ts'
import { loadReleaseConfig } from './release.ts'
import { SETUP_PROFILE, SUPERPOWERS_SPEC, managedRoles, readSetupChoices, validateSetupChoices, type SetupChoices } from './onboarding-config.ts'
import { agentPath, agentText, unmodifiedAgent } from './onboarding-agents.ts'
import { detectExisting, type ExistingItem, type ExistingReport } from './onboarding-existing.ts'

export type SetupRequest = { kind: 'superpowers'; scope: 'project' | 'global' }
  | { kind: 'configure'; choices: SetupChoices; source?: string }
export type AgentPreview = { name: string; path: string; operation: 'create' | 'update' | 'keep'; text: string }
export type SetupPlan = {
  id: string; request: SetupRequest
  changes: { scope: 'project' | 'global'; path: string; before: string | null; after: string; operation: 'create' | 'update' | 'keep' }[]
  warnings: string[]; manualTasks: string[]; agents: AgentPreview[]
}

type Area = { anchor: string; prefix: string }
type Observation = { area: Area; path: string; kind: 'file' | 'directory'; digest: string | null; executable?: boolean }
type Write = { area: Area; path: string; text: string; before: string | null; beforeMode?: number; hook?: boolean; executable?: boolean }
type Built = { plan: SetupPlan; observations: Observation[]; writes: Write[]; hookState?: string }
type Saved = { version: 1; root: string; global: Area; plan: SetupPlan; observations: Observation[]; hookState?: string }
const STATE = '.opencode/workflow/.state/onboarding'
const CONFIGS = ['opencode.json', 'opencode.jsonc']
export const QUALITY = [
  'check-format.py', 'check-links.py', 'check-skips.py', 'check-sync.py', 'install-hooks.py', 'quality_lexer.py', 'quality_lib.py', 'quality_links.py',
  'quality_process.py', 'quality_snapshot.py', 'quality_sync.py', 'quality_testing.py', 'review-comments.py', 'run-hook.py',
  'test_changes.py', 'test_check_format.py', 'test_check_links.py', 'test_check_skips.py', 'test_check_sync.py', 'test_git_compat.py', 'test_install_hooks.py',
  'test_lexer.py', 'test_lib.py', 'test_links.py', 'test_paths.py', 'test_process.py', 'test_process_hook.py', 'test_review_comments.py',
  'test_run_hook.py', 'test_snapshot.py', 'test_stdio.py', 'test_strict.py', 'test_testing.py', 'quality.example.json',
]
const CI = [
  ['workflow-checks.yml', '.github/workflows/workflow-checks.yml'], ['resolve-scope.py', 'scripts/ci/resolve-scope.py'],
  ['scan-secrets.py', 'scripts/ci/scan-secrets.py'], ['run-quality.py', 'scripts/ci/run-quality.py'],
] as const
const digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex')
const keepEffect: Record<ExistingItem['opencode'], string> = {
  'not-loaded': 'OpenCode V2 不读取，其中的配置在 OpenCode 中不生效',
  loaded: 'OpenCode 会继续加载，不受向导管理',
  workspace: '工作目录位于该目录或更深时 OpenCode 会继续加载，不受向导管理',
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const projectArea = (root: string): Area => ({ anchor: root, prefix: '' })
const fullPath = (area: Area, name: string) => join(area.anchor, area.prefix, name)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

// 所有路径（包括被忽略的计划目录）逐段检查，不接受通过链接或非目录父级访问。
async function safePath(area: Area, name: string, directory = false): Promise<string> {
  if (!name || isAbsolute(name) || name.includes('\\') || name.includes('\0') || name.split('/').some(part => ['..', '.', ''].includes(part))) throw new Error(`接入路径越界：${name}`)
  const relative = [area.prefix, name].filter(Boolean).join('/')
  let current = area.anchor
  const base = await lstat(current)
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('接入目录不允许符号链接或非常规目录')
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`路径不允许符号链接：${name}`)
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`文件不允许共享 inode（硬链接）：${name}`)
      if ((index < parts.length - 1 || directory) ? !stat.isDirectory() : !stat.isFile()) throw new Error(`路径不是${index < parts.length - 1 || directory ? '目录' : '常规文件'}：${name}`)
    } catch (error) { if (missing(error)) break; throw error }
  }
  return fullPath(area, name)
}

async function textAt(area: Area, name: string): Promise<string | null> {
  const file = await safePath(area, name)
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const bytes = await handle.readFile()
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally { await handle.close() }
  } catch (error) { if (missing(error)) return null; throw error }
}

async function globalArea(home?: string): Promise<Area> {
  if (home !== undefined) return { anchor: await realpath(home), prefix: '.config/opencode' }
  if (!process.env.XDG_CONFIG_HOME) return { anchor: await realpath(homedir()), prefix: '.config/opencode' }
  const directory = resolve(process.env.XDG_CONFIG_HOME)
  let anchor = directory
  const suffix: string[] = ['opencode']
  while (true) {
    try {
      const stat = await lstat(anchor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('XDG_CONFIG_HOME 不允许符号链接或非常规目录')
      return { anchor: await realpath(anchor), prefix: suffix.join('/') }
    } catch (error) {
      if (!missing(error)) throw error
      suffix.unshift(basename(anchor))
      anchor = dirname(anchor)
    }
  }
}

function jsonConfig(text: string, name: string): Record<string, any> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: name.endsWith('.jsonc'), disallowComments: !name.endsWith('.jsonc') })
  if (errors.length || !object(value)) throw new Error(`配置 JSON 无效，请人工处理：${name}`)
  const tree = parseTree(text)
  const check = (node: Node | undefined) => {
    if (node?.type === 'object') {
      const keys = node.children?.map(child => child.children?.[0].value) ?? []
      if (new Set(keys).size !== keys.length) throw new Error(`配置存在重复字段，请人工处理：${name}`)
    }
    node?.children?.forEach(check)
  }
  check(tree)
  return value
}
const editJson = (text: string, keys: (string | number)[], value: unknown) => applyEdits(text, modify(text, keys, value, {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
}))

function withoutMarkdownModel(text: string, name: string): string {
  const lines = text.split(/(?<=\n)/)
  // 与 OpenCode 的解析一致：开头可有 BOM，分隔行允许尾随空白。
  if (!/^﻿?---[ \t]*\r?\n$/.test(lines[0] ?? '')) return text
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
  if (end < 0) throw new Error(`代理 frontmatter 无法安全处理，请人工合并：${name}`)
  const root = lines.slice(1, end).find(line => line.trim() && !line.trimStart().startsWith('#'))
  if (root !== undefined && !/^[a-zA-Z_][\w-]*\s*:/.test(root)) throw new Error(`复杂代理 frontmatter 请人工处理：${name}`)
  const remove: number[] = []
  for (let index = 1; index < end; index++) {
    const line = lines[index]
    if (/^\S/.test(line) && !/^#/.test(line) && !/^[a-zA-Z_][\w-]*\s*:/.test(line)) throw new Error(`复杂代理 frontmatter 请人工处理：${name}`)
    if (/^\s*(?:<<\s*:|['"]model['"]\s*:)/.test(line) || /^\s+model\s*:/.test(line)) throw new Error(`复杂代理 frontmatter 请人工处理：${name}`)
    if (!/^model\s*:/.test(line)) continue
    const value = line.replace(/^model\s*:\s*/, '').trim()
    const scalar = /^(?:[\w./#:@+-]+|"[\w./#:@+-]+"|'[\w./#:@+-]+')(?:\s+#.*)?$/.test(value)
    let next = index + 1
    while (next < end && /^\s*(?:#.*)?$/.test(lines[next])) next++
    if (!scalar || (next < end && /^\s+\S/.test(lines[next]))) throw new Error(`复杂 model frontmatter 请人工处理：${name}`)
    remove.push(index)
  }
  if (remove.length > 1) throw new Error(`重复 model frontmatter 请人工处理：${name}`)
  return lines.filter((_, index) => !remove.includes(index)).join('')
}

function git(root: string, args: string[], absent = false): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (absent && result.status === 1 && !result.error) return null
  if (result.error || result.status !== 0) throw new Error('Git 接入预检失败，未应用配置')
  return result.stdout.trim()
}

function hookConfiguration(root: string): string {
  const hooksPath = git(root, ['config', '--get', 'core.hooksPath'], true)
  if (hooksPath !== null) throw new Error('已有 core.hooksPath 冲突，请人工合并 hook；未修改 Git 配置')
  return digest(JSON.stringify([git(root, ['rev-parse', '--git-path', 'hooks']), hooksPath]))
}

// 只读取安装器里的字面量分发器，不在预览阶段执行来源中的 Python。
function hookText(installer: string): string {
  const normalized = installer.replaceAll('\r\n', '\n')
  const marker = "def dispatcher(relative_dir: str) -> str:\n    return '''"
  const start = normalized.indexOf(marker)
  const end = normalized.indexOf("'''.replace('{dir}',", start + marker.length)
  if (start < 0 || end < 0) throw new Error('质量 hook 安装器无法安全核对，请人工处理')
  const template = normalized.slice(start + marker.length, end)
  const suffix = normalized.slice(end).split('\n')[0]
  if (suffix !== "'''.replace('{dir}', \"'\" + relative_dir.replace(\"'\", \"'\\\\''\") + \"'\")" || template.includes('\\') || !template.startsWith('#!/bin/sh\n# workflow-quality-hook\n') || template.split('{dir}').length !== 2) throw new Error('质量 hook 安装器无法安全核对，请人工处理')
  return template.replace('{dir}', "'scripts/quality'")
}

function requestValue(value: SetupRequest): SetupRequest {
  if (!object(value)) throw new Error('必须明确指定接入请求')
  if (value.kind === 'superpowers' && ['project', 'global'].includes(value.scope) && Object.keys(value).length === 2) return { kind: 'superpowers', scope: value.scope }
  if (value.kind === 'configure' && Object.keys(value).every(key => ['kind', 'choices', 'source'].includes(key)) && (value.source === undefined || typeof value.source === 'string' && !!value.source.trim())) return {
    kind: 'configure', choices: validateSetupChoices(value.choices), ...(value.source === undefined ? {} : { source: resolve(value.source) }),
  }
  throw new Error('接入请求无效，不能默认选择或应用')
}

async function build(root: string, request: SetupRequest, global: Area, id: string): Promise<Built> {
  const project = projectArea(root)
  const plan: SetupPlan = { id, request, changes: [], warnings: [], manualTasks: [], agents: [] }
  const observations: Observation[] = [], writes: Write[] = []
  const observe = async (area: Area, name: string) => {
    const text = await textAt(area, name)
    observations.push({ area, path: name, kind: 'file', digest: text === null ? null : digest(text) })
    return text
  }
  const list = async (area: Area, name: string) => {
    const directory = await safePath(area, name, true)
    const entries = (await readdir(directory)).sort()
    observations.push({ area, path: name, kind: 'directory', digest: digest(JSON.stringify(entries)) })
    return entries
  }
  const change = async (scope: 'project' | 'global', name: string, after: string, before?: string | null, hook = false) => {
    const area = scope === 'project' ? project : global
    if (before === undefined) before = await observe(area, name)
    const executable = hook ? hookExecutable(await safePath(area, name)) : undefined
    if (hook) {
      observations.findLast(item => item.area === area && item.path === name)!.executable = executable
      if (before !== null && !executable) plan.warnings.push(`hook 缺少可执行性，将重新安装修复执行属性：${name}`)
    }
    const keep = before === after && (!hook || executable)
    plan.changes.push({ scope, path: name, before: before === null ? null : digest(before), after: digest(after), operation: keep ? 'keep' : before === null ? 'create' : 'update' })
    writes.push({ area, path: name, text: after, before, beforeMode: before === null ? undefined : (await lstat(await safePath(area, name))).mode & 0o777, hook, executable })
  }
  for (const name of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']) if (process.env[name]) plan.warnings.push(`${name} 存在额外配置覆盖；不自动修改，请重载后核对有效配置与代理模型`)
  if (request.kind === 'superpowers') {
    const all = new Map<string, string | null>()
    let installed = false
    for (const [scope, area] of [['project', project], ['global', global]] as const) {
      for (const name of CONFIGS) {
        const text = await observe(area, name)
        all.set(`${scope}/${name}`, text)
        if (text === null) continue
        const value = jsonConfig(text, name)
        for (const field of ['plugin', 'plugins']) {
          if (value[field] === undefined) continue
          if (!Array.isArray(value[field])) throw new Error(`插件列表无法安全合并，请人工处理：${name} ${field}`)
          for (const item of value[field]) {
            const source = typeof item === 'string' ? item : object(item) ? item.package : undefined
            if (typeof source !== 'string' || !source.trim()) throw new Error(`插件条目无法安全合并，请人工处理：${name} ${field}`)
            if (/superpowers/i.test(source) && source !== SUPERPOWERS_SPEC) throw new Error('已有不同来源或版本的 Superpowers，不能静默追加或替换；请人工处理冲突')
            if (source === SUPERPOWERS_SPEC) installed = true
          }
        }
      }
    }
    const scope = request.scope
    if (installed) plan.warnings.push('已有固定来源的 Superpowers，保留原配置及 options，不重复登记或迁移范围')
    else {
      const name = all.get(`${scope}/opencode.jsonc`) !== null ? 'opencode.jsonc' : all.get(`${scope}/opencode.json`) !== null ? 'opencode.json' : 'opencode.jsonc'
      const before = all.get(`${scope}/${name}`) ?? null
      const value = jsonConfig(before ?? '{}', name)
      const after = editJson(before ?? '{}\n', ['plugins'], [...value.plugins ?? [], SUPERPOWERS_SPEC])
      await change(scope, name, after, before)
      if (scope === 'global') plan.warnings.push('此计划将修改个人全局 OpenCode 配置，影响其他项目')
    }
    plan.manualTasks.push('重新加载 OpenCode，核对实际插件来源、技能正文及本会话读取证据；安装不等于运行时验收')
    return { plan, observations, writes }
  }

  const choices = request.choices
  // 既有 AI 配置的每一项都要有用户的明确决定；以本次选择中的子代理作为受管名单。
  const existing = await detectExisting(root, { managedAgents: choices.agents.map(agent => agent.name), decisions: choices.existing, personal: false })
  if (!existing.complete) throw new Error(existing.issues.join('；'))
  if (existing.undecided.length) throw new Error(`检测到尚未决定的既有 AI 配置：${existing.undecided.join('、')}；请先评估并取得用户的迁移或保留决定，再重新预览`)
  for (const item of existing.items) {
    if (item.decision === 'migrate') plan.manualTasks.push(`迁移 ${item.path}（${item.tool}）：AI 评估后并入 OpenCode 结构，逐项展示差异并经你确认；原文件保留，能共用的改为引用`)
    else plan.warnings.push(`保留 ${item.path}（${item.tool}）：${keepEffect[item.opencode]}`)
  }
  const roles = managedRoles(choices)
  const generated = new Set(choices.agents.map(agent => agent.name))
  const configs: [string, string | null][] = []
  for (const name of CONFIGS) configs.push([name, await observe(project, name)])
  if (configs.every(([, text]) => text === null) && roles.some(([, value]) => value.mode === 'fixed')) configs.push(['opencode.jsonc', '{}\n'])
  for (const [name, before] of configs) {
    if (before === null) continue
    const value = jsonConfig(before, name)
    if (value.agents !== undefined && !object(value.agents)) throw new Error(`代理配置无法安全合并，请人工处理：${name}`)
    let after = before
    for (const [agent, choice] of roles) {
      if (value.agents?.[agent] !== undefined && !object(value.agents[agent])) throw new Error(`代理配置无法安全合并，请人工处理：${name}`)
      if (generated.has(agent) && Object.keys(value.agents?.[agent] ?? {}).some(key => key !== 'model')) throw new Error(`已有同名代理配置，无法安全生成子代理，请人工合并：${agent}`)
      if (choice.mode === 'fixed') after = editJson(after, ['agents', agent, 'model'], choice.model)
      else if (Object.hasOwn(value.agents?.[agent] ?? {}, 'model')) after = editJson(after, ['agents', agent, 'model'], undefined)
    }
    const original = observations.find(item => item.area === project && item.path === name)?.digest === null ? null : before
    await change('project', name, after, original)
  }
  for (const directory of ['agents', 'agent']) for (const agent of ['implementer', 'reviewer']) {
    const name = `.opencode/${directory}/${agent}.md`, before = await observe(project, name)
    if (before !== null) await change('project', name, withoutMarkdownModel(before, name), before)
  }
  // 子代理文件只在不存在、内容相同或仍是未修改的生成文件时写入；其他情况保留用户内容，整个计划拒绝。
  for (const agent of choices.agents) {
    for (const directory of ['agent', 'modes', 'mode']) {
      const name = `.opencode/${directory}/${agent.name}.md`
      if (await observe(project, name) !== null) throw new Error(`已有同名代理文件：${name}；请人工合并或改名`)
    }
    const path = agentPath(agent.name), text = agentText(agent), before = await observe(project, path)
    const same = before !== null && before.replaceAll('\r\n', '\n') === text
    if (before !== null && !same && !unmodifiedAgent(before)) throw new Error(`子代理文件冲突：${path} 已存在且不是向导生成的原文；保留原文件，请人工合并或改名`)
    await change('project', path, same ? before : text, before)
    plan.agents.push({ name: agent.name, path, operation: plan.changes.at(-1)!.operation, text })
  }

  const quality = choices.components.quality !== 'off', ci = choices.components.ci
  const targets: [string, string][] = []
  let source: Area | undefined
  if ((quality || ci) && request.source) {
    const stat = await lstat(request.source)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('完整套件来源不能是符号链接或非常规目录')
    source = projectArea(await realpath(request.source))
    for (const name of ['README.md', 'ADOPT.md', 'template/AGENTS.md', 'template/opencode.jsonc', 'template/.opencode/plugins/workflow/package.json']) {
      if (await observe(source, name) === null) throw new Error('source 必须是完整套件目录，不能是单独的可选组件目录')
    }
    const manifest = JSON.parse((await textAt(source, 'template/.opencode/plugins/workflow/package.json'))!)
    if (manifest.name !== 'opencode-workflow-starter' || !manifest.dependencies?.['@opencode/plugin']) throw new Error('来源不是完整工作流套件')
    if (quality) {
      const names = await list(source, 'optional/quality')
      if (QUALITY.some(name => !names.includes(name))) throw new Error('来源缺少完整质量扩展文件，请使用完整套件')
      for (const name of names.filter(name => name.endsWith('.py') || name === 'quality.example.json')) {
        if (name !== 'quality.example.json' && !/^[a-zA-Z0-9_-]+\.py$/.test(name)) throw new Error('质量来源白名单文件名无效')
        targets.push([`optional/quality/${name}`, `scripts/quality/${name}`])
      }
    }
    if (ci) for (const [name, target] of CI) targets.push([`optional/ci/${name}`, target])
  } else {
    if (quality) for (const name of QUALITY) targets.push(['', `scripts/quality/${name}`])
    if (ci) for (const [, target] of CI) targets.push(['', target])
  }
  for (const [from, target] of targets) {
    const before = await observe(project, target)
    const after = source ? await observe(source, from) : before
    if (after === null) throw new Error(`缺少可选组件文件 ${target}；请指定完整套件 source 来源`)
    if (source && before !== null && before !== after) throw new Error(`文件冲突：${target}；保留用户内容，请人工合并`)
    await change('project', target, after, before)
  }
  if (targets.length) {
    if (plan.changes.some(change => change.operation === 'keep' && /^(scripts\/quality|scripts\/ci|\.github\/)/.test(change.path))) plan.warnings.push('已保留完整的已有可选组件文件，仍需实际运行验收')
    plan.manualTasks.push('实际运行质量检查并登记项目已有格式工具；文件完整不代表业务测试、格式与质量验收已通过')
  }
  let hookState: string | undefined
  if (choices.components.quality === 'hook') {
    hookState = hookConfiguration(root)
    const hooks = resolve(root, git(root, ['rev-parse', '--git-path', 'hooks'])!)
    const relative = containedRelative(root, join(hooks, 'post-commit'))
    if (!relative) throw new Error('hook 目录位于项目外，不能自动写入；请人工处理')
    const installer = writes.find(write => write.path === 'scripts/quality/install-hooks.py')!.text
    const expected = hookText(installer), before = await observe(project, relative)
    if (before !== null && before !== expected) throw new Error(`已有 post-commit hook 冲突：${relative}；请人工合并`)
    await change('project', relative, expected, before, true)
  }
  if (ci) plan.manualTasks.push('远端 GitHub CI、fork PR 与 required check 尚未验收')
  if (choices.components.release) plan.manualTasks.push('按发布扩展说明人工填写并启用真实发布配置；不生成发布命令、不保存凭据、不执行发布')
  if (choices.components.mcp) plan.manualTasks.push('按只读 MCP 说明人工配置并启用服务，确认服务端只读账号与权限；不生成凭据或线上试写')
  const before = await observe(project, SETUP_PROFILE)
  await change('project', SETUP_PROFILE, JSON.stringify(choices, null, 2) + '\n', before)
  return { plan, observations, writes, hookState }
}

async function stateDirectory(root: string) {
  await safePath(projectArea(root), STATE, true)
  if (git(root, ['check-ignore', '-q', '--', STATE + '/'], true) === null || git(root, ['ls-files', '--', STATE])) throw new Error('接入状态目录必须被 Git 忽略且未跟踪；请人工添加 .opencode/workflow/.state/ 忽略规则')
}

async function writeState(root: string, name: string, text: string) {
  await stateDirectory(root)
  await writeAtomic(projectArea(root), `${STATE}/${name}`, text, 0o600)
}

function planID(saved: Saved): string {
  const { id: _, ...plan } = saved.plan
  return createHash('sha256').update(JSON.stringify({ ...saved, plan })).digest('hex')
}

async function save(root: string, saved: Saved) {
  await stateDirectory(root)
  const name = `${saved.plan.id}.json`, existing = await textAt(projectArea(root), `${STATE}/${name}`)
  if (existing !== null) { await savedPlan(root, saved.plan.id); return }
  await writeState(root, name, JSON.stringify(saved, null, 2) + '\n')
}

async function savedPlan(root: string, id: string): Promise<Saved> {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('计划 id 无效')
  const text = await textAt(projectArea(root), `${STATE}/${id}.json`)
  if (text === null) throw new Error('接入计划不存在或已过期')
  let saved: Saved
  try { saved = JSON.parse(text) } catch { throw new Error('接入计划无效') }
  if (!object(saved) || saved.version !== 1 || saved.root !== root || saved.plan?.id !== id || !Array.isArray(saved.observations) || planID(saved) !== id) throw new Error('接入计划摘要无效、内容已改写或 Location 已改变')
  requestValue(saved.plan.request)
  return saved
}

export async function planSetup(root: string, request: SetupRequest, options: { home?: string } = {}): Promise<SetupPlan> {
  const base = await realpath(root), global = await globalArea(options.home)
  const built = await build(base, requestValue(request), global, '')
  const saved: Saved = { version: 1, root: base, global, plan: built.plan, observations: built.observations, hookState: built.hookState }
  built.plan.id = planID(saved)
  await save(base, saved)
  return built.plan
}

export async function readSetupPlan(root: string, id: string): Promise<SetupPlan> {
  return (await savedPlan(await realpath(root), id)).plan
}

// 申请权限与守卫核对的路径取自计划保存的位置，与 applySetup 实际写入的真实路径一致。
export async function setupWritePaths(root: string, id: string): Promise<string[]> {
  const saved = await savedPlan(await realpath(root), id)
  return saved.plan.changes.filter(change => change.operation !== 'keep').map(change => fullPath(change.scope === 'project' ? projectArea(saved.root) : saved.global, change.path))
}

// 被忽略的状态目录可能被整体清除：待应用指针指向的计划不存在时视为没有待应用计划，内容无效仍然拒绝。
// 升级前由 version 1 向导保存、尚未应用的配置计划视为过期，需要重新预览；apply 仍然拒绝它。
export async function pendingSetupPlan(root: string, id: string): Promise<SetupPlan | null> {
  const base = await realpath(root)
  if (/^[a-f0-9]{64}$/.test(id) && await textAt(projectArea(base), `${STATE}/${id}.json`) === null) return null
  try { return (await savedPlan(base, id)).plan } catch (error) {
    let saved: any
    try { saved = JSON.parse((await textAt(projectArea(base), `${STATE}/${id}.json`))!) } catch { throw error }
    if (saved?.plan?.request?.kind === 'configure' && saved.plan.request.choices?.version === 1) return null
    throw error
  }
}

async function verify(observations: Observation[]) {
  for (const item of observations) {
    const current = item.kind === 'directory'
      ? digest(JSON.stringify((await readdir(await safePath(item.area, item.path, true))).sort()))
      : await textAt(item.area, item.path).then(text => text === null ? null : digest(text))
    if (current !== item.digest) throw new Error(`计划过期，源或目标已改变：${item.path}`)
    if (item.executable !== undefined && hookExecutable(fullPath(item.area, item.path)) !== item.executable) throw new Error(`计划过期，hook 可执行性已改变：${item.path}`)
  }
}

async function leadingBom(file: string): Promise<boolean> {
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const head = Buffer.alloc(3)
      return (await handle.read(head, 0, 3, 0)).bytesRead === 3 && head.equals(Buffer.from([0xef, 0xbb, 0xbf]))
    } finally { await handle.close() }
  } catch (error) { if (missing(error)) return false; throw error }
}

async function writeAtomic(area: Area, name: string, text: string, mode?: number) {
  const file = await safePath(area, name)
  // 已有文件保持原权限和开头的 BOM（textAt 读出的文本不含 BOM）；新建文件未指定时按 umask 取默认权限。
  if (mode === undefined) {
    try { mode = (await lstat(file)).mode & 0o777 } catch (error) { if (!missing(error)) throw error }
  }
  const bom = await leadingBom(file) ? '﻿' : ''
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${name}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(await safePath(area, temporary), 'wx', mode)
    created = true
    let failure: unknown
    try { await handle.writeFile(bom + text, 'utf8'); if (mode !== undefined) await handle.chmod(mode); await handle.sync() } catch (error) { failure = error }
    try { await handle.close() } catch (error) {
      try { await handle.close() } catch (retry) { throw new AggregateError([failure, error, retry].filter(Boolean), '临时文件关闭失败，请人工检查') }
      failure = failure ? new AggregateError([failure, error], '临时文件写入及关闭失败') : error
    }
    if (failure) throw failure
    if (await textAt(area, temporary) !== text) throw new Error(`临时文件写入核对失败：${name}`)
    await safePath(area, name)
    await rename(fullPath(area, temporary), file)
    created = false
  } catch (error) {
    if (created) {
      try { await unlink(await safePath(area, temporary)) } catch (cleanup) {
        if (!missing(cleanup)) throw new AggregateError([error, cleanup], `临时文件清理失败，请人工检查：${name}`)
      }
    }
    throw error
  }
}

async function writeActive(write: Write, text: string | null, mode?: number) {
  if (text === null) {
    try { await unlink(await safePath(write.area, write.path)) } catch (error) { if (!missing(error)) throw error }
    return
  }
  await writeAtomic(write.area, write.path, text, mode)
}

async function isApplied(root: string, id: string): Promise<boolean> {
  const text = await textAt(projectArea(root), `${STATE}/${id}.applied.json`)
  if (text === null) return false
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('接入计划应用状态无效') }
  if (!object(value) || Object.keys(value).length !== 3 || value.version !== 1 || value.id !== id || value.applied !== true) throw new Error('接入计划应用状态无效')
  return true
}

function appliedObservations(saved: Saved): Observation[] {
  return saved.observations.map(item => {
    const change = saved.plan.changes.find(change => fullPath(change.scope === 'project' ? projectArea(saved.root) : saved.global, change.path) === fullPath(item.area, item.path))
    return change ? { ...item, digest: change.after, ...(item.executable === undefined ? {} : { executable: true }) } : item
  })
}

export async function applySetup(root: string, id: string, options: { home?: string } = {}): Promise<{ applied: boolean; choices: SetupChoices | null; changed: string[]; pending: string[] }> {
  const base = await realpath(root), saved = await savedPlan(base, id), global = await globalArea(options.home)
  if (!samePath(fullPath(global, 'opencode.jsonc'), fullPath(saved.global, 'opencode.jsonc'))) throw new Error('全局配置位置已改变，计划过期')
  await stateDirectory(base)
  const applied = await isApplied(base, id)
  await verify(applied ? appliedObservations(saved) : saved.observations)
  if (saved.hookState !== undefined && hookConfiguration(base) !== saved.hookState) throw new Error('Git hook 配置已改变，计划过期')
  if (applied) return { applied: false, choices: await readSetupChoices(base), changed: [], pending: saved.plan.manualTasks }
  const built = await build(base, requestValue(saved.plan.request), global, id)
  if (JSON.stringify(built.plan) !== JSON.stringify(saved.plan) || JSON.stringify(built.observations) !== JSON.stringify(saved.observations)) throw new Error('计划输入已改变，请重新预览确认')
  // 先完整验证所有读写目标与状态目录，再执行任何活动写入。
  await safePath(projectArea(base), STATE, true)
  for (const write of built.writes) await safePath(write.area, write.path)
  const changed: string[] = [], completed: Write[] = []
  const effective = built.writes.filter(write => write.before !== write.text || write.hook && !write.executable)
  try {
    for (const write of effective.filter(write => !write.hook && write.path !== SETUP_PROFILE)) {
      await writeActive(write, write.text); completed.push(write); changed.push(write.path)
    }
    const hook = effective.find(write => write.hook)
    if (hook) {
      hookConfiguration(base)
      await safePath(hook.area, hook.path)
      const launcher = pythonCommand()
      completed.push(hook)
      const result = spawnSync(launcher.command, [...launcher.args, fullPath(projectArea(base), 'scripts/quality/install-hooks.py')], {
        cwd: base, env: pythonEnv({ ...process.env, PYTHONDONTWRITEBYTECODE: '1' }), encoding: 'utf8', windowsHide: true, timeout: 30_000,
      })
      // 安装器可能在冲突时只报告而退出零，因此退出码不是成功证据。
      hookConfiguration(base)
      if (result.error || result.status !== 0 || await textAt(hook.area, hook.path) !== hook.text || !hookExecutable(fullPath(hook.area, hook.path))) throw new Error('质量 hook 安装未完成、实际 hook 不匹配或不可执行，请人工检查')
      changed.push(hook.path)
    }
    const profile = effective.find(write => write.path === SETUP_PROFILE)
    if (profile) { await writeActive(profile, profile.text); completed.push(profile); changed.push(profile.path) }
    await writeState(base, `${id}.applied.json`, JSON.stringify({ version: 1, id, applied: true }) + '\n')
  } catch (error) {
    const failures: unknown[] = [], paths: string[] = []
    for (const write of completed.reverse()) {
      try {
        if (!write.hook && await textAt(write.area, write.path) !== write.text) throw new Error('回滚目标已改变，未覆盖用户内容')
        await writeActive(write, write.before, write.beforeMode)
      } catch (failure) { failures.push(failure); paths.push(write.path) }
    }
    if (failures.length) throw new AggregateError([error, ...failures], `回滚未完成：${paths.join('、')}；请人工检查原文件与权限`)
    throw error
  }
  return { applied: changed.length > 0, choices: await readSetupChoices(base), changed, pending: saved.plan.manualTasks }
}

export async function inspectSetup(root: string, options: { home?: string; configHome?: string } = {}): Promise<{
  choices: SetupChoices | null; issues: string[]; unverified: string[]
  components: Record<string, { selected: boolean; status: 'off' | 'preserved' | 'configured' | 'missing' | 'pending'; message: string }>
  existing: ExistingReport
}> {
  const base = await realpath(root), area = projectArea(base), issues: string[] = [], unverified: string[] = []
  let choices: SetupChoices | null = null
  try { choices = await readSetupChoices(base) } catch (error) { issues.push((error as Error).message) }
  const existing = await detectExisting(base, { managedAgents: choices?.agents.map(agent => agent.name) ?? [], decisions: choices?.existing ?? {}, home: options.home, configHome: options.configHome })
  issues.push(...existing.issues)
  if (choices && existing.undecided.length) issues.push(`检测到尚未决定的既有 AI 配置：${existing.undecided.join('、')}；请重新运行 /workflow-setup，评估后记录迁移或保留`)
  for (const item of existing.items) if (item.decision === 'migrate') unverified.push(`迁移 ${item.path}（${item.tool}）由 AI 完成，迁移内容是否完整、等价需要你核对`)
  const components: Awaited<ReturnType<typeof inspectSetup>>['components'] = {}
  const read = async (name: string) => {
    try { return await textAt(area, name) } catch (error) { issues.push((error as Error).message); return null }
  }
  // 摘要不成立说明受管子代理文件被人工修改过，权限和协作边界需要用户自己核对。
  for (const agent of choices?.agents ?? []) {
    const path = agentPath(agent.name), text = await read(path)
    if (text !== null && !unmodifiedAgent(text)) unverified.push(`子代理 ${agent.name} 的代理文件 ${path} 已被人工修改，权限和协作边界不再由向导保证，需要你核对`)
  }
  const configs: Record<string, any>[] = []
  for (const name of CONFIGS) {
    const text = await read(name)
    if (text !== null) { try { configs.push(jsonConfig(text, name)) } catch (error) { issues.push((error as Error).message) } }
  }
  const status = (name: string, selected: boolean, present: boolean, configured: boolean, label: string, manual = false) => {
    const state = !selected ? present ? 'preserved' : 'off' : configured ? 'configured' : manual ? 'pending' : 'missing'
    const message = !selected ? present ? `已保留已有${label}，未新增也未卸载` : `未选择新增${label}，未发现已有配置` : configured ? `${label}已配置，实际运行仍待验收` : `${label}缺失、无效或尚未启用，请人工配置并验收`
    components[name] = { selected, status: state, message }
    if (selected && !configured) issues.push(message)
  }
  const qualityFiles = await Promise.all(QUALITY.map(name => read(`scripts/quality/${name}`)))
  let qualityReady = qualityFiles.every(text => text !== null), qualityPresent = qualityFiles.some(text => text !== null)
  if (choices?.components.quality === 'hook') {
    try {
      hookConfiguration(base)
      const relative = containedRelative(base, resolve(base, git(base, ['rev-parse', '--git-path', 'hooks'])!, 'post-commit'))
      const actual = relative ? await read(relative) : null
      qualityReady = qualityReady && actual !== null && actual === hookText(qualityFiles[QUALITY.indexOf('install-hooks.py')] ?? '') && hookExecutable(fullPath(area, relative!))
      qualityPresent ||= actual !== null
    } catch { qualityReady = false }
  }
  status('quality', !!choices && choices.components.quality !== 'off', qualityPresent, qualityReady, '质量检查')
  const ciFiles = await Promise.all(CI.map(([, name]) => read(name)))
  status('ci', choices?.components.ci ?? false, ciFiles.some(text => text !== null), ciFiles.every(text => text !== null) && qualityFiles.every(text => text !== null), 'CI')
  const releaseText = await read('.opencode/workflow/release.json')
  let releaseReady = false
  if (releaseText !== null) { try { releaseReady = loadReleaseConfig(base) !== null } catch { if (choices?.components.release) issues.push('发布配置无效，请人工处理') } }
  status('release', choices?.components.release ?? false, releaseText !== null, releaseReady, '发布', true)
  const servers = Object.assign({}, ...configs.map(value => object(value.mcp?.servers) ? value.mcp.servers : {}))
  const mcpReady = Object.values(servers).some(server => object(server) && (server.disabled === undefined || server.disabled === false) && (
    server.type === 'remote' && typeof server.url === 'string' && !!server.url.trim() || server.type === 'local' && Array.isArray(server.command) && server.command.length > 0 && server.command.every((part: unknown) => typeof part === 'string' && !!part.trim())))
  status('mcp', choices?.components.mcp ?? false, configs.some(value => value.mcp !== undefined), mcpReady, 'MCP', true)
  if (!choices) issues.push('尚无有效且已确认的接入选择')
  else {
    unverified.push('业务测试与模型实际调用尚未验收；静态配置不证明运行成功')
    if (components.quality.status === 'configured' || components.quality.status === 'preserved') unverified.push('质量检查与项目格式工具的实际执行尚未验收')
    if (components.ci.status === 'configured' || components.ci.status === 'preserved') unverified.push('远端 GitHub CI、fork PR、默认分支运行与 required check 尚未验收')
    if (choices.components.release || releaseText !== null) unverified.push('真实发布入口、产物与受控发布流程尚未运行验收')
    if (choices.components.mcp || Object.keys(servers).length) unverified.push('MCP 连通性、服务端只读账号及只读权限尚未验收')
  }
  return { choices, issues, unverified, components, existing }
}
