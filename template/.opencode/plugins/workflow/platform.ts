import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
// macOS 自带的 python3 是 3.9，部分 Linux 发行版也偏旧；python3 不够新时再找带版本号的解释器。
const posixLaunchers: Command[] = ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'].map(command => ({ command, args: [] }))
const probeLauncher = (launcher: Command) => spawnSync(launcher.command, [...launcher.args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
  { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0
let cached: { key: string; value: Command } | undefined

// WORKFLOW_PYTHON 是解释器路径，不拆分参数。其余情况按顺序探测 3.10+ 并按 PATH 缓存：
// Windows 上 python3 常是应用商店占位程序，macOS 自带的 python3 版本过旧。Windows 上探测和缓存的都是绝对路径。
export function pythonCommand({ env = process.env, platform = process.platform, probe, exists }: { env?: NodeJS.ProcessEnv; platform?: Platform; probe?: (launcher: Command) => boolean; exists?: (file: string) => boolean } = {}): Command {
  const override = envValue(env, 'WORKFLOW_PYTHON')
  if (override) return { command: executable(override, { env, platform, exists }), args: [] }
  const candidates = platform === 'win32' ? launchers : posixLaunchers
  const key = `${platform}\0${envValue(env, 'PATH') ?? ''}`
  if (!probe && cached?.key === key) return { ...cached.value, args: [...cached.value.args] }
  const located = candidates.flatMap(candidate => {
    try { return [{ ...candidate, command: executable(candidate.command, { env, platform, exists }) }] } catch { return [] }
  })
  const value = located.find(probe ?? probeLauncher)
  if (!value) {
    const tried = candidates.map(c => [c.command, ...c.args].join(' ')).join('、')
    const install = platform === 'darwin' ? '请 brew install python@3.12' : '请安装 Python 3.10+'
    throw new Error(`找不到 Python 3.10+（已尝试 ${tried}）；${install}，或设置 WORKFLOW_PYTHON 指向解释器`)
  }
  if (!probe) cached = { key, value }
  return { ...value, args: [...value.args] }
}

// Windows 的监督器在恢复 Node 主线程之前绑定 kill-on-close Job；父退出或被取消也会回收深层后代。
export function nodeCheckCommand(node: string, args: string[], options: Parameters<typeof pythonCommand>[0] = {}): Command {
  if ((options.platform ?? process.platform) !== 'win32') return { command: node, args }
  const python = pythonCommand(options)
  return { command: python.command, args: [...python.args, fileURLToPath(new URL('../../workflow/checks/run-node-check.py', import.meta.url)), node, ...args] }
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
      if (platform === 'win32') run(systemCommand('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'])
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* 进程可能已经退出，或 taskkill 不可用。 */ }
  }
  try { child.kill('SIGKILL') } catch { /* 进程可能已经退出。 */ }
}

// Windows 应用执行别名（Microsoft Store 与 Python 安装管理器放在 WindowsApps 下的 py.exe、python.exe）是重解析点：
// stat 报 EACCES，existsSync 返回 false，但 CreateProcess 能启动它；lstat 能看到这个链接。
export function launchable(file: string, platform: Platform = process.platform): boolean {
  if (existsSync(file)) return true
  if (platform !== 'win32') return false
  try { return lstatSync(file).isSymbolicLink() } catch { return false }
}

// Git for Windows 通过解释器读取 hook；POSIX 必须具有实际执行权限。
export function hookExecutable(file: string, platform: Platform = process.platform): boolean {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false
    accessSync(file, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch { return false }
}

// Windows 只按 PATHEXT 查找：npm 在同一目录放有无扩展名的 sh 启动脚本，它不能直接执行。
// 只查 PATH 中的绝对目录：`.` 一类相对项会指向当前目录。
type Lookup = { env?: NodeJS.ProcessEnv; platform?: Platform; exists?: (file: string) => boolean }
export function findExecutable(name: string, { env = process.env, platform = process.platform, exists = (file: string) => launchable(file, platform), pathext }: Lookup & { pathext?: string } = {}): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix
  const known = (pathext ?? envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const extensions = platform !== 'win32' || known.some(ext => name.toLowerCase().endsWith(ext.toLowerCase())) ? [''] : known
  const first = (base: string) => extensions.map(ext => base + ext).find(exists)
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) return first(name)
  for (const directory of (envValue(env, 'PATH') ?? '').split(p.delimiter).filter(entry => p.isAbsolute(entry))) {
    const found = first(p.join(directory, name))
    if (found) return found
  }
}

// Windows 的进程创建（CreateProcess、libuv）先在当前目录或 cwd 中查找不带路径的命令，项目里的同名程序会被执行。
// 因此 Windows 上先在 PATH 的绝对目录中解析出绝对路径；直接启动只接受 .exe/.com，scripts 时也接受交给 commandLine 的 .bat/.cmd。
// 找不到时报 ENOENT，不退回按名字启动。带路径的名称是调用方明确给出的，原样返回；其他平台不查当前目录，也原样返回。
export function executable(name: string, { env = process.env, platform = process.platform, exists, scripts = false }: Lookup & { scripts?: boolean } = {}): string {
  if (platform !== 'win32' || /[\\/]/.test(name)) return name
  const found = findExecutable(name, { env, platform, exists, pathext: scripts ? undefined : '.com;.exe' })
  if (found) return found
  throw Object.assign(new Error(`找不到 ${name}：请确认它在 PATH 中`), { code: 'ENOENT' })
}

// cmd.exe、taskkill.exe 等系统程序固定取自 %SystemRoot%\System32。
export function systemCommand(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(envValue(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', name)
}

// Node 不再直接启动 .cmd/.bat；改经 cmd.exe，/s 去掉最外层引号后按原样执行整行。
export function commandLine(file: string, args: string[], platform: Platform = process.platform): Command {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { command: file, args }
  const quote = (value: string) => {
    if (/["%!]/.test(value)) throw new Error(`参数含有 cmd 无法安全转义的字符：${value}`)
    return /[\s&|<>^()]/.test(value) ? `"${value}"` : value
  }
  return { command: systemCommand('cmd.exe'), args: ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], windowsVerbatimArguments: true }
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

// 守卫只支持 Bash；未知解释器拒绝，WSL 启动器也不能操作当前 Windows 检出。
export function unsupportedShell(shell: string | undefined, platform: Platform = process.platform): string | undefined {
  const file = (shell ?? '').trim()
  const base = file.split(/[\\/]/).at(-1) ?? ''
  const name = platform === 'win32' ? base.toLowerCase().replace(/\.exe$/, '') : base
  if (platform === 'win32' && name === 'bash' && /[\\/](?:system32|sysnative|syswow64|windowsapps)[\\/]bash\.exe$/i.test(path.win32.normalize(file))) {
    return `当前 shell 解析到了 WSL 启动器（${file}）：命令会在 WSL 中执行，与当前 Windows 检出不一致，已拒绝执行。请安装 Git for Windows，或在全局配置中把 "shell" 设为 Git Bash 的完整路径（例如 C:\\Program Files\\Git\\bin\\bash.exe）。`
  }
  if (name === 'bash') return
  return `当前 shell 为 ${file || '（未提供）'}：工作流守卫仅支持 Bash，无法可靠检查 PowerShell/cmd 等其他解释器的命令，已拒绝执行。请在 opencode.jsonc 中设置 "shell": "bash"（Windows 上会使用 Git Bash），或在 WSL 中运行 OpenCode。`
}
