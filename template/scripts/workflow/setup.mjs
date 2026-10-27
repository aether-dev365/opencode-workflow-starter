#!/usr/bin/env node
// 接入准备：检查前置工具，安装插件依赖和固定版 Gitleaks，检测 OpenCode，最后运行 doctor。
// OpenCode 只在完全缺失且用户选择 CLI 时用 npm 安装验收版本；已有的 V1 或其他 V2 版本不会被替换。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`需要 Node.js 24 或更新版本，当前为 ${process.version}。下载：https://nodejs.org/en/download`)
  process.exit(1)
}
const { commandLine, executable, findExecutable, pythonCommand, pythonEnv, samePath } = await import('../../.opencode/plugins/workflow/platform.ts')

const docs = 'https://opencode.ai/v2/docs/'
const hints = {
  win32: { git: 'winget install --id Git.Git -e（含 Git Bash）', python: 'winget install --id Python.Python.3.12 -e' },
  darwin: { git: 'xcode-select --install 或 brew install git', python: 'brew install python@3.12' },
  linux: { git: 'sudo apt install git（其他发行版用对应包管理器）', python: 'sudo apt install python3（其他发行版用对应包管理器）' },
}[process.platform] ?? { git: 'https://git-scm.com/install/', python: 'https://www.python.org/downloads/' }

/** 交互选择 OpenCode 的安装方式；空行、无法识别的输入或输入结束都算跳过。 */
export async function ask(input = process.stdin, output = process.stdout) {
  const prompt = createInterface({ input, output })
  // 输入在回答前结束时 question 不会返回，用 close 事件兜底。
  const closed = new Promise(done => prompt.once('close', () => done('')))
  try {
    const answer = await Promise.race([closed, prompt.question('未找到 OpenCode。选择安装方式：\n  1) CLI（推荐，本模板的验收版本，经 npm 安装）\n  2) Desktop（打开官方下载页手动安装，本模板未验收）\n  3) 跳过\n请输入 1、2 或 3：')])
    return { 1: 'cli', 2: 'desktop' }[answer.trim()] ?? 'skip'
  } catch { return 'skip' } finally { prompt.close() }
}

// 不按名字启动：找不到时返回 ENOENT，与启动失败走同一提示。
function run(file, args, options = {}) {
  let resolved
  try { resolved = executable(file, { scripts: true }) } catch (error) { return { status: null, error, stdout: '', stderr: '' } }
  const invocation = commandLine(resolved, args)
  const { env = process.env, ...rest } = options
  return spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsVerbatimArguments: invocation.windowsVerbatimArguments, ...rest, env: { ...env, ...invocation.env } })
}

function opencodeVersion(binary) {
  const result = run(binary, ['--version'], { timeout: 20000 })
  const output = (result.stdout ?? '').trim()
  return { version: output.match(/\bv?(\d+)\.(\d+)\.(\d+)$/)?.slice(1), detail: result.error?.message ?? (output || (result.stderr ?? '').trim() || '（空输出）') }
}

async function main() {
  const args = process.argv.slice(2)
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const root = resolve(option('--root') ?? '.')
  const choice = option('--opencode')
  if (choice !== undefined && !['cli', 'desktop', 'skip'].includes(choice)) throw new Error('--opencode 只能是 cli、desktop 或 skip')
  const manifestPath = join(root, '.opencode/plugins/workflow/package.json')
  if (!existsSync(manifestPath)) throw new Error(`未找到 ${manifestPath}；请在已合并模板的项目根目录运行，或用 --root 指定该目录`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const baseline = manifest.dependencies['@opencode/plugin']
  const cliInstall = `npm install -g @opencode/cli@${baseline}`
  let installed = false

  console.log('==> 前置工具')
  const git = findExecutable('git')
  let python
  try { python = pythonCommand() } catch (error) { console.log(`fail python: ${error.message}\n  安装：${hints.python}`) }
  if (!git) console.log(`fail git: 未找到 Git\n  安装：${hints.git}`)
  const npm = findExecutable('npm')
  if (!npm) console.log('fail npm: 未找到 npm；它随 Node.js 一起安装：https://nodejs.org/en/download')
  if (!git || !python || !npm) return 1
  // OpenCode 在 Windows 上把 "shell": "bash" 解析为 Git 安装目录下的 bin\bash.exe。
  if (process.platform === 'win32' && !existsSync(join(git, '..', '..', 'bin', 'bash.exe'))) {
    console.log(`warn git-bash: ${git} 旁没有 bin\\bash.exe（MinGit 不含 Git Bash），OpenCode 将无法使用 bash；安装完整的 Git for Windows：${hints.git}`)
  }
  console.log(`ok node ${process.version}、git、python（${[python.command, ...python.args].join(' ')}）`)

  console.log('==> 插件依赖')
  const current = Object.entries(manifest.dependencies).every(([name, version]) => {
    try { return JSON.parse(readFileSync(join(root, '.opencode/plugins/workflow/node_modules', name, 'package.json'), 'utf8')).version === version } catch { return false }
  })
  if (current) console.log('ok 已安装且版本一致')
  else {
    const result = run(npm, ['--prefix', '.opencode/plugins/workflow', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) console.log('fail npm ci 失败；检查网络与 npm 配置后重试')
    else installed = true
  }

  console.log('==> 固定版 Gitleaks')
  // 提交扫描先用 PATH 中第一个 gitleaks，找不到时回退到 ~/.local/bin。install.py 只校验已有文件，不覆盖。
  const fallback = join(homedir(), '.local', 'bin')
  const scanner = findExecutable('gitleaks')
  const pin = directory => {
    const result = run(python.command, [...python.args, join(root, '.opencode/secret-scan/install.py'), '--bin-dir', directory], { cwd: root, env: pythonEnv(), timeout: 120000 })
    process.stdout.write(result.stdout ?? '')
    if (result.status === 0 && /^Installed /m.test(result.stdout ?? '')) installed = true
    return result.status === 0 ? undefined : (result.stderr || result.error?.message || '').trim()
  }
  const problem = pin(scanner ? dirname(scanner) : fallback)
  if (problem && scanner && !samePath(dirname(scanner), fallback)) {
    // PATH 上是其他版本：固定版本装到 ~/.local/bin，由用户决定卸载旧版本还是调整 PATH 顺序。
    const pinned = pin(fallback)
    console.log(pinned ? `fail ${pinned}` : `fail PATH 上的 ${scanner} 不是固定版本，提交扫描会先用它并因版本不符拒绝提交；卸载它，或把 ${fallback} 放到 PATH 中它所在目录之前`)
  } else if (problem) console.log(`fail ${problem}`)

  console.log('==> OpenCode')
  const binary = process.env.WORKFLOW_OPENCODE_BIN || findExecutable('opencode')
  const { version, detail } = binary ? opencodeVersion(binary) : {}
  if (binary && !version) console.log(`fail 无法识别 ${binary} --version 的结果：${detail}；检查该可执行文件或 WORKFLOW_OPENCODE_BIN`)
  else if (version?.join('.') === baseline) console.log(`ok ${binary}：${baseline}`)
  else if (version && version[0] !== '2') {
    console.log(`fail ${binary} 是 OpenCode ${version.join('.')}，不是 V2。不会自动替换；先按官方迁移指南用原包管理器卸载 V1：${docs}migrate-v1/，再运行 ${cliInstall}`)
  } else if (version) {
    console.log(`warn 已安装 OpenCode ${version.join('.')}，验收基线为 ${baseline}；不会自动替换已有安装。需要切换时运行 ${cliInstall}（只替换 npm 安装的同名包）`)
  } else {
    const selected = choice ?? (process.stdin.isTTY ? await ask() : undefined)
    if (selected === 'cli') {
      const result = run(npm, ['install', '-g', `@opencode/cli@${baseline}`, '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' })
      if (result.status !== 0) console.log('fail npm 全局安装失败；若提示无写入权限，配置用户可写的 npm 全局目录并把它加入 PATH 后重试')
      else if (!findExecutable('opencode')) console.log('warn 已安装，但当前 PATH 中找不到 opencode；把 npm prefix -g 输出的目录（Linux/macOS 为其中的 bin）加入 PATH 后重新打开终端')
      else { installed = true; console.log(`ok 已安装 OpenCode CLI ${baseline}`) }
    } else if (selected === 'desktop') {
      console.log(`Desktop 从官方入口下载：${docs}\nDesktop 未验收（本模板只在 CLI 上做过原生验收）；工作流仍需要终端中可运行的 opencode CLI（doctor 检查它的版本），可再运行 ${cliInstall}`)
    } else {
      console.log(`未安装 OpenCode。安装验收版本：${cliInstall}（或重新运行本脚本并加 --opencode cli）；Desktop 加 --opencode desktop 查看下载入口`)
    }
  }

  if (installed) console.log('如果 OpenCode 后台服务已在运行，执行 opencode service restart，让它使用新安装的依赖和命令。')
  console.log('==> doctor')
  const doctor = spawnSync(process.execPath, [join(root, 'scripts/workflow/doctor.mjs'), '--root', root], { cwd: root, stdio: 'inherit' })
  const code = doctor.status ?? 1
  console.log(code === 0
    ? '基础依赖准备完成。请在 OpenCode 中运行 /workflow-setup，选择完整或基础模式、子代理模型和可选组件；从空目录开始的新项目改为运行 /workflow-new，它会在需要时调用 /workflow-setup。这不表示完整流程已验收。'
    : '基础检查未通过；先处理上述失败，再在 OpenCode 中运行 /workflow-setup（新项目运行 /workflow-new），不能把当前状态报告为安装完成。')
  return code
}

// 被测试导入时 import.meta.main 为 false，只导出 ask；直接运行时执行接入准备。
if (import.meta.main !== false) {
  try { process.exitCode = await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
