import { lstat, open, readFile, readdir, readlink, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { containedRelative } from './platform.ts'
import { decisionKey, type ExistingDecision } from './onboarding-config.ts'

export type ExistingItem = { path: string; tool: string; files: number; opencode: 'loaded' | 'workspace' | 'not-loaded'; note: string; decision: ExistingDecision | null }
export type SharedItem = { path: string; tool: string; note: string }
export type PersonalItem = { path: string; tool: string; entries: number | null; opencode: 'loaded'; note: string }
export type ExistingReport = { complete: boolean; issues: string[]; items: ExistingItem[]; shared: SharedItem[]; personal: PersonalItem[]; undecided: string[] }
export type ExistingOptions = {
  managedAgents?: readonly string[]; decisions?: Readonly<Record<string, ExistingDecision>>
  personal?: boolean; home?: string; configHome?: string
  list?: (root: string) => { status: number | null; stdout: Buffer; error?: NodeJS.ErrnoException }
}

// 只认标记，不解析各工具的格式；目录标记以 / 结尾。接入文档的标记表与此一致，由分发测试核对。
export const EXISTING_MARKERS: readonly { tool: string; marker: string; where: 'any' | 'root' | 'nested' }[] = [
  { tool: 'Claude Code', marker: '.claude/', where: 'any' }, { tool: 'Claude Code', marker: 'CLAUDE.md', where: 'any' }, { tool: 'Claude Code', marker: '.mcp.json', where: 'root' },
  { tool: 'Cursor', marker: '.cursor/', where: 'any' }, { tool: 'Cursor', marker: '.cursorrules', where: 'root' }, { tool: 'Cursor', marker: '.cursorignore', where: 'root' },
  { tool: 'Codex', marker: '.codex/', where: 'any' }, { tool: 'Codex', marker: 'AGENTS.override.md', where: 'any' },
  { tool: 'Agent Skills', marker: '.agents/', where: 'any' },
  { tool: 'GitHub Copilot', marker: '.github/copilot-instructions.md', where: 'root' }, { tool: 'GitHub Copilot', marker: '.github/instructions/', where: 'root' },
  { tool: 'GitHub Copilot', marker: '.github/prompts/', where: 'root' }, { tool: 'GitHub Copilot', marker: '.github/agents/', where: 'root' },
  { tool: 'GitHub Copilot', marker: '.github/chatmodes/', where: 'root' }, { tool: 'GitHub Copilot', marker: '.vscode/mcp.json', where: 'root' },
  { tool: 'Gemini CLI', marker: 'GEMINI.md', where: 'any' }, { tool: 'Gemini CLI', marker: '.gemini/', where: 'any' },
  { tool: 'Windsurf', marker: '.windsurfrules', where: 'root' }, { tool: 'Windsurf', marker: '.windsurf/', where: 'any' },
  { tool: 'Cline', marker: '.clinerules', where: 'root' }, { tool: 'Roo Code', marker: '.roo/', where: 'any' }, { tool: 'Roo Code', marker: '.roomodes', where: 'root' },
  { tool: 'Aider', marker: '.aider.conf.yml', where: 'root' }, { tool: 'Kiro', marker: '.kiro/', where: 'any' }, { tool: 'Continue', marker: '.continue/', where: 'any' },
  { tool: 'Zed', marker: '.rules', where: 'root' }, { tool: 'Junie', marker: '.junie/', where: 'any' }, { tool: 'Amazon Q', marker: '.amazonq/', where: 'any' },
  { tool: 'Trae', marker: '.trae/', where: 'any' }, { tool: 'Augment', marker: '.augment/', where: 'any' }, { tool: 'Augment', marker: '.augment-guidelines', where: 'root' },
  { tool: 'OpenCode', marker: '.opencode/', where: 'nested' }, { tool: 'OpenCode', marker: 'opencode.json', where: 'nested' }, { tool: 'OpenCode', marker: 'opencode.jsonc', where: 'nested' },
]

// 根 .opencode/ 下的模板文件、领域规则 AGENTS.md、向导按套件角色处理的代理和依赖安装的附属文件不算既有配置。
const TEMPLATE_FILES = new Set(['LICENSE', 'agents/implementer.md', 'agents/reviewer.md', 'agent/implementer.md', 'agent/reviewer.md', 'commands/review.md', 'commands/workflow-setup.md', '.gitignore', 'bun.lock', 'bun.lockb', 'package-lock.json'])
const TEMPLATE_PREFIXES = ['plugins/workflow/', 'secret-scan/', 'skills/workflow-onboarding/', 'workflow/', 'node_modules/']
const POINTER_FILES = ['CLAUDE.md', 'GEMINI.md']
const LIMIT = 100, POINTER_BYTES = 64 * 1024
const anyDirectories = new Map(EXISTING_MARKERS.filter(m => m.where === 'any' && m.marker.endsWith('/')).map(m => [m.marker.slice(0, -1), m.tool]))
const anyFiles = new Map(EXISTING_MARKERS.filter(m => m.where === 'any' && !m.marker.endsWith('/')).map(m => [m.marker, m.tool]))
const rootMarkers = EXISTING_MARKERS.filter(m => m.where === 'root')
const ignored = (tool: string) => `OpenCode V2 不读取 ${tool} 的这部分配置`
const WORKSPACE = '工作目录位于该目录或更深时，OpenCode 会加载并覆盖上层同名设置'
const SHARED = '只引用 AGENTS.md，与 OpenCode 共用同一份规则'
const shorten = (path: string) => [...path].length > 80 ? [...path].slice(0, 77).join('') + '…' : path

type Found = { path: string; tool: string; opencode: ExistingItem['opencode']; note: string; pointer?: boolean }

function classify(path: string, managed: readonly string[]): Found | null {
  const parts = path.split('/')
  if (parts[0] === '.opencode') {
    const rest = parts.slice(1).join('/')
    if (TEMPLATE_FILES.has(rest) || TEMPLATE_PREFIXES.some(prefix => rest.startsWith(prefix)) || parts.at(-1) === 'AGENTS.md' || managed.some(name => rest === `agents/${name}.md`)) return null
    const key = ['.opencode', ...parts.slice(1, 3)].join('/')
    const note = key === '.opencode/opencode.json' || key === '.opencode/opencode.jsonc' ? '会覆盖根目录 opencode.jsonc 的同名设置，可能改变 shell、权限和代理模型' : 'OpenCode 会加载；不受向导管理'
    return { path: key, tool: 'OpenCode', opencode: 'loaded', note }
  }
  for (const { tool, marker } of rootMarkers) {
    const name = marker.replace(/\/$/, '')
    if (path === name || path.startsWith(name + '/')) return { path: name, tool, opencode: 'not-loaded', note: ignored(tool) }
  }
  // 目录标记可能是符号链接：Git 把链接本身列为一项，最后一段同样按目录标记归类。
  for (let index = 0; index < parts.length; index++) {
    const segment = parts[index], nested = segment === '.opencode' && index > 0
    if (!anyDirectories.has(segment) && !nested) continue
    const tool = nested ? 'OpenCode' : anyDirectories.get(segment)!
    if ((segment === '.claude' || segment === '.agents') && index === parts.length - 1) {
      return { path, tool, opencode: index === 0 ? 'loaded' : 'workspace', note: '符号链接；链接目标中的 skills 会被 OpenCode V2 加载，其余不读取' }
    }
    if ((segment === '.claude' || segment === '.agents') && parts[index + 1] === 'skills') {
      const key = parts.slice(0, index + 2).join('/')
      return index === 0 ? { path: key, tool, opencode: 'loaded', note: 'OpenCode V2 会把这些技能加载进本项目；同 ID 技能按优先级覆盖' } : { path: key, tool, opencode: 'workspace', note: WORKSPACE }
    }
    return { path: parts.slice(0, index + 1).join('/'), tool, opencode: nested ? 'workspace' : 'not-loaded', note: nested ? WORKSPACE : ignored(tool) }
  }
  const name = parts.at(-1)!
  if (anyFiles.has(name)) {
    const tool = anyFiles.get(name)!, pointer = POINTER_FILES.includes(name)
    return { path, tool, opencode: 'not-loaded', note: pointer ? `OpenCode V2 只读取 AGENTS.md，不读取 ${name}` : ignored(tool), pointer }
  }
  if ((name === 'opencode.json' || name === 'opencode.jsonc') && parts.length > 1) return { path, tool: 'OpenCode', opencode: 'workspace', note: WORKSPACE }
  return null
}

// 只引用 AGENTS.md：@ 引用、指向它的符号链接（只读链接目标），或不支持符号链接的检出中 Git 写出的占位文件。
async function references(file: string): Promise<boolean> {
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink()) return ['AGENTS.md', './AGENTS.md', '.\\AGENTS.md'].includes(await readlink(file))
    if (!info.isFile() || info.size > POINTER_BYTES) return false
    const handle = await open(file, 'r')
    try {
      const text = (await handle.readFile('utf8')).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trim()
      return ['@AGENTS.md', '@./AGENTS.md', 'AGENTS.md'].includes(text)
    } finally { await handle.close() }
  } catch { return false }
}

function listFiles(root: string) {
  return spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
}

async function personalItems(home: string, configHome: string): Promise<PersonalItem[]> {
  const items: PersonalItem[] = []
  const display = (file: string) => {
    const inHome = containedRelative(home, file)
    return inHome ? `~/${inHome}` : `$XDG_CONFIG_HOME/${containedRelative(configHome, file) ?? ''}`
  }
  const opencode = join(configHome, 'opencode'), skills = 'OpenCode V2 会把这些技能加载进本项目', shared = 'OpenCode 会在所有项目中加载这部分个人配置'
  const locations: [string, string, 'directory' | 'file' | 'config', string][] = [
    [join(home, '.claude', 'skills'), 'Claude Code', 'directory', skills], [join(home, '.agents', 'skills'), 'Agent Skills', 'directory', skills],
    [join(opencode, 'AGENTS.md'), 'OpenCode', 'file', shared],
    ...['agents', 'agent', 'modes', 'mode', 'commands', 'command', 'skills', 'plugins', 'plugin'].map(name => [join(opencode, name), 'OpenCode', 'directory', shared] as [string, string, 'directory', string]),
    ...['opencode.json', 'opencode.jsonc'].map(name => [join(opencode, name), 'OpenCode', 'config', shared] as [string, string, 'config', string]),
  ]
  for (const [file, tool, kind, note] of locations) {
    try {
      const info = await stat(file)
      let entries: number
      if (kind === 'directory') { if (!info.isDirectory()) continue; entries = (await readdir(file)).length }
      else if (kind === 'file') { if (!info.isFile()) continue; entries = 1 }
      else {
        if (!info.isFile() || info.size > 1024 * 1024) { items.push({ path: display(file), tool, entries: null, opencode: 'loaded', note: '个人配置无法安全读取，未统计插件' }); continue }
        const errors: ParseError[] = [], value = parse(await readFile(file, 'utf8'), errors, { allowTrailingComma: true })
        if (errors.length || !value || typeof value !== 'object') { items.push({ path: display(file), tool, entries: null, opencode: 'loaded', note: '个人配置无法解析，未统计插件' }); continue }
        entries = ['plugins', 'plugin'].reduce((count, key) => count + (Array.isArray(value[key]) ? value[key].length : 0), 0)
      }
      if (entries > 0) items.push({ path: display(file), tool, entries, opencode: 'loaded', note: kind === 'config' ? `个人配置登记了 ${entries} 个插件，会在所有项目中加载` : note })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') items.push({ path: display(file), tool, entries: null, opencode: 'loaded', note: `无法读取（${code ?? '未知错误'}）` })
    }
  }
  return items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export async function detectExisting(root: string, options: ExistingOptions = {}): Promise<ExistingReport> {
  const home = options.home ?? homedir()
  const configHome = options.configHome ?? (options.home === undefined ? process.env.XDG_CONFIG_HOME || join(home, '.config') : join(home, '.config'))
  const personal = options.personal === false ? [] : await personalItems(home, configHome)
  const incomplete = (reason: string): ExistingReport => ({ complete: false, issues: [`既有 AI 配置检测未完成：${reason}`], items: [], shared: [], personal, undecided: [] })
  const result = (options.list ?? listFiles)(root)
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT') return incomplete('列出项目文件超过 20 秒；把构建产物等加入 .gitignore 后重试')
  if (code === 'ENOBUFS') return incomplete('文件清单超过 64 MiB；把构建产物、依赖目录等加入 .gitignore 后重试')
  if (code === 'ENOENT') return incomplete('未找到 git 命令；安装 Git 并确认它在 PATH 中后重试')
  if (result.error) return incomplete(`无法启动 Git（${code ?? '未知错误'}）`)
  // 不回显 Git 的错误输出：其中可能有绝对路径。
  if (result.status !== 0) return incomplete(`Git 无法列出项目文件（退出码 ${result.status ?? '未知'}）；确认项目是 Git 仓库、当前用户有权访问（必要时检查 safe.directory）后重试`)
  // 逐个解码：无效 UTF-8 的文件名只有在检测项路径本身无法解码时才挡住检测，其余照常归类。
  const managed = options.managedAgents ?? [], strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), lossy = new TextDecoder('utf-8', { ignoreBOM: true })
  const paths: string[] = [], undecodable: string[] = []
  for (let start = 0, end; start < result.stdout.length; start = end + 1) {
    end = result.stdout.indexOf(0, start)
    if (end === -1) end = result.stdout.length
    const bytes = result.stdout.subarray(start, end)
    if (!bytes.length) continue
    try { paths.push(strict.decode(bytes)) } catch {
      const path = lossy.decode(bytes), match = classify(path, managed)
      if (match?.path.includes('�')) undecodable.push(path); else if (match) paths.push(path)
    }
  }
  if (undecodable.length) return incomplete(`${undecodable.length} 处 AI 配置的文件名不是有效 UTF-8（如 ${shorten(undecodable[0])}）；请重命名为 UTF-8 文件名后重试`)
  const files = new Set(paths), found = new Map<string, Found & { files: number }>()
  for (const path of paths) {
    const match = classify(path, managed)
    if (!match) continue
    const existing = found.get(match.path)
    if (existing) existing.files++; else found.set(match.path, { ...match, files: 1 })
  }
  const decisions = options.decisions ?? {}, items: ExistingItem[] = [], shared: SharedItem[] = []
  for (const item of found.values()) {
    if (item.pointer) {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/') + 1) : ''
      if (await references(join(root, ...item.path.split('/')))) {
        if (files.has(`${parent}AGENTS.md`)) { shared.push({ path: item.path, tool: item.tool, note: SHARED }); continue }
        item.note = `引用的 AGENTS.md 不存在；OpenCode V2 不读取 ${item.path.split('/').at(-1)}`
      }
    }
    items.push({ path: item.path, tool: item.tool, files: item.files, opencode: item.opencode, note: item.note, decision: Object.hasOwn(decisions, item.path) ? decisions[item.path] : null })
  }
  const blocked = items.filter(item => !decisionKey(item.path))
  if (blocked.length) return incomplete(`${blocked.length} 处既有 AI 配置的路径无法记录决定（含 \\ 或控制字符、以 ~ 开头或超过 512 个字符，如 ${shorten(blocked[0].path)}）；请重命名后重试`)
  if (items.length > LIMIT) return incomplete(`检测到超过 ${LIMIT} 处既有 AI 配置，请先人工梳理`)
  const order = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  items.sort(order); shared.sort(order)
  return { complete: true, issues: [], items, shared, personal, undecided: items.filter(item => item.decision === null).map(item => item.path) }
}
