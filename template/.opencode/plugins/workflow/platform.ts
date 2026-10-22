import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'

// 操作系统差异集中在这里：路径分隔符、Python 启动器、.cmd 启动器、进程树终止和 shell 识别。
export type Platform = NodeJS.Platform
export type Command = { command: string; args: string[]; windowsVerbatimArguments?: boolean }

// 与 OpenCode FSUtil.windowsPath 相同：Git Bash、Cygwin、WSL 风格的盘符路径在 Windows 上指向 `X:/`。
const driveForms = [/^\/([a-zA-Z]):(?:[\\/]|$)/, /^\/([a-zA-Z])(?:\/|$)/, /^\/cygdrive\/([a-zA-Z])(?:\/|$)/, /^\/mnt\/([a-zA-Z])(?:\/|$)/]
export function windowsPath(value: string, platform: Platform = process.platform): string {
  if (platform !== 'win32') return value
  return driveForms.reduce((current, form) => current.replace(form, (_, drive: string) => `${drive.toUpperCase()}:/`), value)
}

// 路径模式按 `/` 书写；Windows 的 relative() 返回反斜杠。
export function portableRelative(from: string, to: string, p: path.PlatformPath = path): string {
  const relative = p.relative(from, to)
  return p.sep === '\\' ? relative.replaceAll('\\', '/') : relative
}

export function containedRelative(root: string, file: string, p: path.PlatformPath = path): string | undefined {
  const relative = portableRelative(root, file, p)
  if (!relative || relative === '..' || relative.startsWith('../') || p.isAbsolute(relative)) return undefined
  return relative
}

const envValue = (env: NodeJS.ProcessEnv, name: string) => env[Object.keys(env).find(key => key.toUpperCase() === name) ?? name]

const launchers: Command[] = [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
const probeLauncher = (launcher: Command) => spawnSync(launcher.command, [...launcher.args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
  { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0
let cached: { key: string; value: Command } | undefined

// WORKFLOW_PYTHON 是解释器路径，不拆分参数。Windows 上 python3 常是应用商店占位程序，所以按顺序探测并缓存。
export function pythonCommand({ env = process.env, platform = process.platform, probe }: { env?: NodeJS.ProcessEnv; platform?: Platform; probe?: (launcher: Command) => boolean } = {}): Command {
  const override = envValue(env, 'WORKFLOW_PYTHON')
  if (override) return { command: override, args: [] }
  if (platform !== 'win32') return { command: 'python3', args: [] }
  const key = envValue(env, 'PATH') ?? ''
  if (!probe && cached?.key === key) return { ...cached.value, args: [...cached.value.args] }
  const value = launchers.find(probe ?? probeLauncher)
  if (!value) throw new Error('找不到 Python 3.10+（已尝试 py -3、python、python3）；请安装 Python，或设置 WORKFLOW_PYTHON 指向解释器')
  if (!probe) cached = { key, value }
  return { ...value, args: [...value.args] }
}

// 插件与检查器之间的 JSON 固定为 UTF-8，不随 Windows 代码页变化。
export function pythonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
}

// POSIX 用独立进程组以便整组终止；Windows 的 detached 会为子进程打开新的控制台窗口。
export function childOptions(platform: Platform = process.platform): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true }
}

export function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, platform: Platform = process.platform,
  run: (command: string, args: string[]) => void = (command, args) => { spawnSync(command, args, { windowsHide: true, stdio: 'ignore', timeout: 10_000 }) }): void {
  if (child.pid) {
    try {
      if (platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* 进程可能已经退出，或 taskkill 不可用。 */ }
  }
  try { child.kill('SIGKILL') } catch { /* 进程可能已经退出。 */ }
}

// Windows 只按 PATHEXT 查找：npm 在同一目录放有无扩展名的 sh 启动脚本，它不能直接执行。
export function findExecutable(name: string, { env = process.env, platform = process.platform, exists = existsSync }: { env?: NodeJS.ProcessEnv; platform?: Platform; exists?: (file: string) => boolean } = {}): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix
  const pathext = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const extensions = platform !== 'win32' || pathext.some(ext => name.toLowerCase().endsWith(ext.toLowerCase())) ? [''] : pathext
  const first = (base: string) => extensions.map(ext => base + ext).find(exists)
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) return first(name)
  for (const directory of (envValue(env, 'PATH') ?? '').split(p.delimiter).filter(Boolean)) {
    const found = first(p.join(directory, name))
    if (found) return found
  }
}

// Node 不再直接启动 .cmd/.bat；改经 cmd.exe，/s 去掉最外层引号后按原样执行整行。
export function commandLine(file: string, args: string[], platform: Platform = process.platform): Command {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { command: file, args }
  const quote = (value: string) => {
    if (/["%!]/.test(value)) throw new Error(`参数含有 cmd 无法安全转义的字符：${value}`)
    return /[\s&|<>^()]/.test(value) ? `"${value}"` : value
  }
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], windowsVerbatimArguments: true }
}

export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const canonical = (value: string) => {
    let resolved: string
    try { resolved = realpathSync.native(value) } catch { resolved = p.resolve(value) }
    return platform === 'win32' ? p.normalize(resolved).toLowerCase() : resolved
  }
  return canonical(a) === canonical(b)
}

// 守卫按 bash 语法解析命令；PowerShell/cmd 的语义不同，WSL 启动器会把命令带到另一套文件系统中执行。
export function unsupportedShell(shell: string | undefined, platform: Platform = process.platform): string | undefined {
  const file = (shell ?? '').trim()
  if (!file) return
  const name = (file.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')
  if (['pwsh', 'powershell', 'cmd'].includes(name)) {
    return `当前 shell 为 ${name}（${file}）：工作流守卫只能解析 bash 语法，无法可靠检查 PowerShell/cmd 命令，已拒绝执行。请在 opencode.jsonc 中设置 "shell": "bash"（Windows 上会使用 Git Bash），或在 WSL 中运行 OpenCode。`
  }
  if (platform === 'win32' && name === 'bash' && /[\\/](?:system32|windowsapps)[\\/]bash\.exe$/i.test(file)) {
    return `当前 shell 解析到了 WSL 启动器（${file}）：命令会在 WSL 中执行，与当前 Windows 检出不一致，已拒绝执行。请安装 Git for Windows，或在全局配置中把 "shell" 设为 Git Bash 的完整路径（例如 C:\\Program Files\\Git\\bin\\bash.exe）。`
  }
}
