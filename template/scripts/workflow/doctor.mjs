#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const install = 'npm --prefix .opencode/plugins/workflow ci --ignore-scripts'
// 插件模块依赖 jsonc-parser；依赖缺失时仍要输出结构化报告，而不是在导入阶段崩溃。
let plugin, pluginError
try {
  const [config, release] = await Promise.all([import('../../.opencode/plugins/workflow/config.ts'), import('../../.opencode/plugins/workflow/release.ts')])
  plugin = { ...config, ...release }
} catch (error) { pluginError = error }
const requirePlugin = () => {
  if (!plugin) throw new Error(`插件依赖缺失，未检查；先在目标根目录运行 ${install}`)
  return plugin
}
const loadProjectConfig = root => requirePlugin().loadProjectConfig(root)
const protectionPermissions = config => requirePlugin().protectionPermissions(config)
const readJson = path => requirePlugin().readJson(path)
const loadReleaseConfig = root => requirePlugin().loadReleaseConfig(root)

const args = process.argv.slice(2)
const root = resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : '.')
const checks = []
const command = (exe, args) => execFileSync(exe, args, { cwd: root, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function check(id, run) {
  try { const result = await run(); checks.push({ id, ...(result ?? { status: 'pass', message: '通过' }) }) }
  catch (error) { checks.push({ id, status: 'fail', message: String(error.message) }) }
}
let config
await check('config', async () => { config = await loadProjectConfig(root) })
if (config) await check('permissions', async () => {
  const native = await readJson(resolve(root, 'opencode.jsonc'))
  const block = protectionPermissions(config)
  const normalized = native.permissions?.slice(-block.length).map(({ action, resource, effect }) => ({ action, resource, effect }))
  if (JSON.stringify(normalized) !== JSON.stringify(block)) throw new Error('原生权限末尾与 protection.json 不一致；按声明顺序合并权限块')
})
await check('node', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本') })
await check('python', () => {
  const version = command('python3', ['--version']).match(/Python (\d+)\.(\d+)/)
  if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 10)) throw new Error('需要 Python 3.10 或更新版本')
})
await check('git', () => { command('git', ['--version']) })
await check('opencode-version', () => {
  const binary = process.env.WORKFLOW_OPENCODE_BIN || 'opencode'
  const guide = '官方安装入口：https://opencode.ai/v2/docs/\n安装验收版本：npm install -g @opencode/cli@2.1.1\n完整步骤及 V1 迁移：docs/workflow/opencode-install.md\n安装后运行 opencode --version，并确认 PATH 或 WORKFLOW_OPENCODE_BIN 指向所选 V2 CLI'
  let version
  try { version = command(binary, ['--version']) }
  catch (error) {
    const reason = error.code === 'ENOENT' ? `未找到 OpenCode CLI：${binary}` : `无法执行 ${binary} --version：${error.message}`
    throw new Error(`${reason}；请检查命令路径或按指南安装 OpenCode V2。\n${guide}`)
  }
  if (/\bv?2\.1\.1$/.test(version)) return
  const patch = version.match(/\bv?(2\.1\.\d+)$/)?.[1]
  if (patch) return { status: 'warn', message: `未在 v${patch} 做原生验收；按 docs/workflow/opencode-install.md 完成安装后检查和原生冒烟，并记录在接入报告` }
  const major = version.match(/\bv?(\d+)\.\d+\.\d+$/)?.[1]
  if (!major) throw new Error(`无法识别 OpenCode 版本：${version || '（空输出）'}。\n${guide}`)
  if (major !== '2') throw new Error(`本模板需要 OpenCode V2，实际为 ${version}；请按指南安装 V2 后重新检查。\n${guide}`)
  throw new Error(`已检测到 OpenCode V2，实际为 ${version}，但验收基线为 2.1.1；使用其他系列版本需同步依赖和原生验收。\n${guide}`)
})
await check('dependencies', () => {
  if (pluginError) throw new Error(`插件依赖未安装或无法加载（${String(pluginError.message).split('\n')[0]}）；在目标根目录运行 ${install}`)
  for (const [name, version] of [['@opencode/plugin', '2.1.1'], ['jsonc-parser', '3.3.1']]) {
    const file = join(root, '.opencode/plugins/workflow/node_modules', name, 'package.json')
    let installed
    try { installed = JSON.parse(readFileSync(file, 'utf8')).version } catch { throw new Error(`缺少依赖 ${name}；在目标根目录运行 ${install}`) }
    if (installed !== version) throw new Error(`依赖版本不一致：${name} 需要 ${version}，实际为 ${installed}；运行 ${install}`)
  }
})
await check('git-ignore', () => {
  if (realpathSync(command('git', ['rev-parse', '--show-toplevel'])) !== realpathSync(root)) throw new Error('目标必须是独立 Git 检出根，不能借用祖先仓库')
  for (const path of ['.opencode/workflow/.state/probe', '.worktrees/probe', '.verification/probe']) command('git', ['check-ignore', '--no-index', '-q', path])
})
await check('tracked-protected', () => {
  const deadline = Date.now() + 120000
  const options = () => ({ cwd: root, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const paths = execFileSync('git', ['ls-files', '-z'], options()).split('\0').filter(Boolean)
    const result = JSON.parse(execFileSync('python3', [join(root, '.opencode/workflow/checks/policy.py')], { ...options(), input: JSON.stringify({ root, action: 'read', paths }) }))
    if (!Array.isArray(result.denied) || result.denied.some(path => typeof path !== 'string')) throw new Error('凭据规则检查输出无效')
    if (result.denied.length) return { status: 'warn', message: `已跟踪文件命中读取保护（共 ${result.denied.length} 个，最多列出 20 个）：\n${result.denied.slice(0, 20).join('\n')}\n源码误伤请追加精确 allow；真实凭据须移出仓库并轮换` }
  } catch (error) {
    if (error.code === 'ETIMEDOUT') return { status: 'warn', message: '已跟踪文件过多，未完成凭据规则扫描' }
    throw error
  }
})
await check('scanner', () => {
  const scanner = (process.env.PATH || '').split(':').map(p => join(p, 'gitleaks')).find(existsSync) || join(homedir(), '.local/bin/gitleaks')
  command('python3', [join(root, '.opencode/secret-scan/install.py'), '--check', '--bin-dir', dirname(scanner)])
})
await check('release-config', () => { loadReleaseConfig(root) })
await check('placeholders', async () => {
  const native = await readJson(join(root, 'opencode.jsonc'))
  const active = { native, config, release: loadReleaseConfig(root) }
  if (/REPLACE_ME|<YOUR_[A-Z_]+>/.test(JSON.stringify(active))) throw new Error('活动配置仍有未填写项；examples/ 和禁用扩展示例不会启用')
})
await check('references', () => {
  for (const path of ['AGENTS.md', '.opencode/agents/implementer.md', '.opencode/agents/reviewer.md', '.opencode/commands/review.md', 'docs/workflow/development.md', 'docs/workflow/testing.md', 'docs/workflow/review-policy.md', 'docs/workflow/opencode-install.md']) {
    if (!readFileSync(join(root, path), 'utf8').trim()) throw new Error('入口文档为空：' + path)
  }
})
checks.push({ id: 'native-runtime', status: 'unverified', message: '静态自检不证明插件已加载；另行执行原生验收。' })
const report = { ok: !checks.some(c => c.status === 'fail'), checks }
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : checks.map(c => `${c.status} ${c.id}: ${c.message}`).join('\n'))
process.exitCode = report.ok ? 0 : 1
