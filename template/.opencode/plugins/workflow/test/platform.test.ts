import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { windowsPath, portableRelative, containedRelative, pythonCommand, pythonEnv, childOptions, killTree, findExecutable, commandLine, samePath, unsupportedShell, launchable, executable, systemCommand, missingLongName } from '../platform.ts'
import * as hookPlatform from '../platform.ts'

test('hook 可执行性使用平台语义，拒绝目录、缺失及共享 inode', () => {
  assert.equal(typeof hookPlatform.hookExecutable, 'function')
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-hook-executable-')), file = path.join(root, 'post-commit')
  try {
    writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o600)
    assert.equal(hookPlatform.hookExecutable(file, 'win32'), true)
    assert.equal(hookPlatform.hookExecutable(file), process.platform === 'win32')
    chmodSync(file, 0o700)
    assert.equal(hookPlatform.hookExecutable(file), true)
    assert.equal(hookPlatform.hookExecutable(root), false)
    assert.equal(hookPlatform.hookExecutable(path.join(root, 'missing')), false)
    linkSync(file, path.join(root, 'shared'))
    assert.equal(hookPlatform.hookExecutable(file), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Git Bash drive paths map to Windows drives only on Windows', () => {
  for (const [value, expected] of [['/c/Users/example', 'C:/Users/example'], ['/C:/x', 'C:/x'], ['/C:\\x', 'C:/x'], ['/cygdrive/d/x', 'D:/x'],
    ['/mnt/e/x', 'E:/x'], ['/c', 'C:/'], ['/home/x', '/home/x'], ['src/a', 'src/a']]) assert.equal(windowsPath(value, 'win32'), expected, value)
  assert.equal(windowsPath('/c/Users/example', 'linux'), '/c/Users/example')
})

test('拒绝原因中的长路径只保留首尾', () => {
  // 与守卫 hooklib.brief 相同：超过 160 个字符时保留首尾各 60 个。
  assert.equal(typeof hookPlatform.briefPath, 'function')
  assert.equal(hookPlatform.briefPath('x'.repeat(160)), 'x'.repeat(160))
  assert.equal(hookPlatform.briefPath(`${'a'.repeat(100)}${'b'.repeat(100)}`), `${'a'.repeat(60)}…${'b'.repeat(60)}（共 200 个字符）`)
})

test('工具路径与 OpenCode FileAccess.resolve 的解析相同', () => {
  // 守卫 hooklib.tool_path 用同一组例子：盘符写法、`~` 与 `~/`、字面合并 `..`。
  assert.equal(typeof hookPlatform.toolPath, 'function')
  const windows = { platform: 'win32' as const, env: { OPENCODE_TEST_HOME: 'C:/Users/example' } }
  for (const [value, expected] of [['~/x', 'C:\\Users\\example\\x'], ['~', 'C:\\Users\\example'], ['~\\x', 'C:\\repo\\~\\x'],
    ['/d/data/../x', 'D:\\x'], ['src/missing/..', 'C:\\repo\\src'], ['', 'C:\\repo']]) assert.equal(hookPlatform.toolPath('C:\\repo', value, windows), expected, value)
  const posix = { platform: 'linux' as const, env: { OPENCODE_TEST_HOME: '/home/example' } }
  for (const [value, expected] of [['~/x', '/home/example/x'], ['~', '/home/example'], ['~user/x', '/repo/~user/x'],
    ['/c/x', '/c/x'], ['src/missing/..', '/repo/src'], ['', '/repo']]) assert.equal(hookPlatform.toolPath('/repo', value, posix), expected, value)
})

test('relative paths use forward slashes on Windows', () => {
  assert.equal(portableRelative('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32), 'src/a.ts')
  assert.equal(portableRelative('/repo', '/repo/src/a.ts', path.posix), 'src/a.ts')
})

test('contained paths exclude the root itself, parents, siblings and other drives', () => {
  assert.equal(containedRelative('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32), 'src/a.ts')
  for (const file of ['C:\\repo', 'C:\\outside\\x', 'C:\\repository\\x', 'D:\\repo\\x']) assert.equal(containedRelative('C:\\repo', file, path.win32), undefined, file)
  for (const file of ['/repo', '/outside/x', '/repository/x']) assert.equal(containedRelative('/repo', file, path.posix), undefined, file)
  assert.equal(containedRelative('/repo', '/repo/..cache/x', path.posix), '..cache/x')
})

test('the Python override is used as one executable path without probing', () => {
  const never = () => { throw new Error('must not probe') }
  assert.deepEqual(pythonCommand({ env: { WORKFLOW_PYTHON: 'C:\\Program Files\\Python312\\python.exe' }, platform: 'win32', probe: never }),
    { command: 'C:\\Program Files\\Python312\\python.exe', args: [] })
  assert.deepEqual(pythonCommand({ env: { WORKFLOW_PYTHON: '/opt/python/bin/python3' }, platform: 'darwin', probe: never }), { command: '/opt/python/bin/python3', args: [] })
  assert.throws(() => pythonCommand({ env: { WORKFLOW_PYTHON: 'python3.12' }, platform: 'linux', probe: never, exists: () => false }),
    /WORKFLOW_PYTHON.*python3\.12.*绝对路径.*opencode service restart/s)
})

test('macOS and Linux require python3 to be 3.10+ and fall back to versioned interpreters', () => {
  // macOS 自带的 python3 是 3.9；Homebrew 的 python3.12 不一定排在 PATH 前面。
  // 探测和缓存的都是 PATH 中的绝对路径：PATH 的空项指向当前目录，按名字启动可能换成项目里的同名程序。
  const env = { PATH: ':/usr/bin:/opt/homebrew/bin' }, files = new Set(['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.13'])
  const exists = (file: string) => files.has(file), tried: string[] = []
  const found = pythonCommand({ env, platform: 'darwin', exists, probe: c => { tried.push(c.command); return c.command.endsWith('python3.12') } })
  assert.deepEqual(found, { command: '/opt/homebrew/bin/python3.12', args: [] })
  assert.deepEqual(tried, ['/usr/bin/python3', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12'])
  assert.deepEqual(pythonCommand({ env, platform: 'linux', exists, probe: c => c.command.endsWith('/python3') }), { command: '/usr/bin/python3', args: [] })
  assert.throws(() => pythonCommand({ env, platform: 'darwin', exists, probe: () => false }), /python3.*python3\.10.*brew install python@3\.12.*WORKFLOW_PYTHON/s)
  assert.throws(() => pythonCommand({ env: { PATH: '' }, platform: 'linux', exists, probe: () => true }), /python3.*python3\.10.*WORKFLOW_PYTHON/s)
})

test('Node checks use a suspended-job Python supervisor on Windows and direct Node elsewhere', () => {
  assert.equal(typeof hookPlatform.nodeCheckCommand, 'function')
  const node = 'C:\\Program Files\\nodejs\\node.exe', args = ['C:\\repo\\scripts\\workflow\\doctor.mjs', '--root', 'C:\\repo', '--json']
  const command = hookPlatform.nodeCheckCommand(node, args, { platform: 'win32', env: { WORKFLOW_PYTHON: 'C:\\tools\\python.exe' } })
  assert.equal(command.command, 'C:\\tools\\python.exe')
  assert.match(command.args[0].replaceAll('\\', '/'), /\/workflow\/checks\/run-node-check\.py$/)
  assert.deepEqual(command.args.slice(1), [node, ...args])
  assert.deepEqual(hookPlatform.nodeCheckCommand('/opt/node', ['/repo/doctor.mjs'], { platform: 'linux' }), { command: '/opt/node', args: ['/repo/doctor.mjs'] })
  assert.throws(() => hookPlatform.nodeCheckCommand(node, args, { platform: 'win32', env: {}, probe: () => false }), /Python/)
})

test('Windows tries the py launcher, then python, then python3, each at its absolute PATH location', () => {
  const env = { Path: 'C:\\Python312;C:\\Windows' }, files = new Set(['C:\\Windows\\py.exe', 'C:\\Python312\\python.exe'])
  const exists = (file: string) => files.has(file), tried: string[] = []
  const found = pythonCommand({ env, platform: 'win32', exists, probe: c => { tried.push([c.command, ...c.args].join(' ')); return c.command.endsWith('python.exe') } })
  assert.deepEqual(found, { command: 'C:\\Python312\\python.exe', args: [] })
  assert.deepEqual(tried, ['C:\\Windows\\py.exe -3', 'C:\\Python312\\python.exe'])
  assert.throws(() => pythonCommand({ env, platform: 'win32', exists, probe: () => false }), /py -3.*python.*python3.*WORKFLOW_PYTHON/s)
  // 不在 PATH 中的启动器不按名字启动，否则会执行当前目录里的同名程序。
  assert.throws(() => pythonCommand({ env: {}, platform: 'win32', exists, probe: () => true }), /py -3.*python.*python3/s)
  assert.deepEqual(pythonCommand({ env: { ...env, WORKFLOW_PYTHON: 'python' }, platform: 'win32', exists, probe: () => false }), { command: 'C:\\Python312\\python.exe', args: [] })
})

test('Python children always exchange UTF-8', () => {
  const env = pythonEnv({ PATH: '/bin', PYTHONIOENCODING: 'cp1252' })
  assert.deepEqual([env.PATH, env.PYTHONUTF8, env.PYTHONIOENCODING], ['/bin', '1', 'utf-8'])
})

test('children are hidden on Windows and own a process group elsewhere', () => {
  assert.deepEqual(childOptions('win32'), { detached: false, windowsHide: true })
  assert.deepEqual(childOptions('linux'), { detached: true, windowsHide: true })
})

test('killTree ends the whole Windows process tree with taskkill', () => {
  const calls: string[][] = []
  killTree({ pid: 42, kill: () => true }, 'win32', (command, args) => { calls.push([command, ...args]) })
  assert.deepEqual(calls, [[systemCommand('taskkill.exe'), '/pid', '42', '/T', '/F']])
})

test('killTree still ends the direct child when taskkill is unavailable', () => {
  let killed = 0
  killTree({ pid: 42, kill: () => { killed++; return true } }, 'win32', () => { throw new Error('spawn taskkill ENOENT') })
  assert.equal(killed, 1)
})

test('Windows executables are found through PATH and PATHEXT, not extensionless shims', () => {
  const env = { Path: 'C:\\empty;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.CMD' }
  const files = new Set(['C:\\Program Files\\nodejs\\opencode', 'C:\\Program Files\\nodejs\\opencode.CMD', 'C:\\tools\\gitleaks.exe'])
  const exists = (file: string) => files.has(file)
  assert.equal(findExecutable('opencode', { env, platform: 'win32', exists }), 'C:\\Program Files\\nodejs\\opencode.CMD')
  assert.equal(findExecutable('C:\\tools\\gitleaks.exe', { env, platform: 'win32', exists }), 'C:\\tools\\gitleaks.exe')
  assert.equal(findExecutable('C:\\Program Files\\nodejs\\opencode', { env, platform: 'win32', exists }), 'C:\\Program Files\\nodejs\\opencode.CMD')
  assert.equal(findExecutable('missing', { env, platform: 'win32', exists }), undefined)
  assert.equal(findExecutable('gitleaks', { env: { PATH: '/empty:/opt/bin' }, platform: 'linux', exists: f => f === '/opt/bin/gitleaks' }), '/opt/bin/gitleaks')
})

test('command lookup skips relative PATH entries, so the working directory is never searched', () => {
  const files = new Set(['git.exe', 'tools\\git.exe', 'C:\\bin\\git.exe', 'git', 'bin/git', '/usr/bin/git'])
  const exists = (file: string) => files.has(file)
  assert.equal(findExecutable('git', { env: { Path: '.;tools;C:\\bin', PATHEXT: '.exe' }, platform: 'win32', exists }), 'C:\\bin\\git.exe')
  assert.equal(findExecutable('git', { env: { PATH: '.:bin:/usr/bin' }, platform: 'linux', exists }), '/usr/bin/git')
})

test('Windows starts PATH programs only by absolute path and system programs from System32', () => {
  const env = { Path: 'C:\\scripts;C:\\Git\\cmd', PATHEXT: '.com;.exe;.bat;.cmd', SystemRoot: 'D:\\Windows' }
  const files = new Set(['C:\\scripts\\git.cmd', 'C:\\Git\\cmd\\git.exe', 'C:\\scripts\\npm.cmd'])
  const exists = (file: string) => files.has(file)
  assert.equal(executable('git', { env, platform: 'win32', exists }), 'C:\\Git\\cmd\\git.exe')
  assert.equal(executable('git', { env, platform: 'win32', exists, scripts: true }), 'C:\\scripts\\git.cmd')
  assert.throws(() => executable('npm', { env, platform: 'win32', exists }), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && /npm.*PATH/.test(error.message))
  for (const name of ['C:\\tools\\node.exe', 'scripts\\publish.exe', './run']) assert.equal(executable(name, { env, platform: 'win32', exists }), name)
  // 带引号的 PATH 项按其中的目录查找，与系统一致。
  assert.equal(executable('git', { env: { Path: '"C:\\Git\\cmd"' }, platform: 'win32', exists }), 'C:\\Git\\cmd\\git.exe')
  assert.equal(systemCommand('cmd.exe', env), 'D:\\Windows\\System32\\cmd.exe')
  assert.equal(systemCommand('cmd.exe', { windir: 'E:\\WINNT' }), 'E:\\WINNT\\System32\\cmd.exe')
  // 空的 SystemRoot 也要回退，否则得到相对路径，又会按当前目录查找。
  assert.equal(systemCommand('cmd.exe', { SystemRoot: '', windir: 'E:\\WINNT' }), 'E:\\WINNT\\System32\\cmd.exe')
  assert.equal(systemCommand('cmd.exe', { SystemRoot: '' }), 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(systemCommand('taskkill.exe', {}), 'C:\\Windows\\System32\\taskkill.exe')
})

test('macOS and Linux also start PATH programs by absolute path, because an empty PATH entry means the working directory', () => {
  const files = new Set(['git', '/usr/bin/git', '/usr/local/bin/opencode'])
  const exists = (file: string) => files.has(file)
  assert.equal(executable('git', { env: { PATH: ':/usr/bin' }, platform: 'linux', exists }), '/usr/bin/git')
  assert.equal(executable('opencode', { env: { PATH: '/usr/bin:/usr/local/bin:' }, platform: 'darwin', exists, scripts: true }), '/usr/local/bin/opencode')
  assert.throws(() => executable('git', { env: { PATH: ':.' }, platform: 'linux', exists }), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  for (const name of ['./run', '/opt/tool']) assert.equal(executable(name, { env: {}, platform: 'linux', exists }), name)
  // 没有 PATH 时与 Python 的 shutil.which 一样用 /bin:/usr/bin。
  assert.equal(executable('git', { env: {}, platform: 'linux', exists }), '/usr/bin/git')
})

test('cmd scripts run through cmd.exe with the whole command line quoted', () => {
  assert.deepEqual(commandLine('C:\\Program Files\\nodejs\\opencode.cmd', ['--version'], 'win32'),
    { command: systemCommand('cmd.exe'), args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\opencode.cmd" --version"'], windowsVerbatimArguments: true,
      // npm 的 .cmd 启动器在旁边没有 node.exe 时按名字启动 node，cmd.exe 认这个变量，不再先查当前目录。
      env: { NoDefaultCurrentDirectoryInExePath: '1' } })
  assert.deepEqual(commandLine('C:\\tools\\gitleaks.exe', ['version'], 'win32'), { command: 'C:\\tools\\gitleaks.exe', args: ['version'] })
  assert.deepEqual(commandLine('/usr/bin/opencode.cmd', ['--version'], 'linux'), { command: '/usr/bin/opencode.cmd', args: ['--version'] })
  assert.throws(() => commandLine('C:\\x\\a.cmd', ['say "hi"'], 'win32'), /cmd/)
})

test('overlong names count as missing only when no file can have them', () => {
  // 整条路径短于上限时名字过长只能来自某一段，或某段超过 255 个 UTF-16 码元；整条路径超长而每段正常时可能真实存在。
  const tooLong = (file?: string, code = 'ENAMETOOLONG') => Object.assign(new Error('name too long'), { code, path: file })
  const deep = '/repo' + ('/' + 'a'.repeat(200)).repeat(30)
  const wide = '/repo/' + '说'.repeat(200) + '/' + '明'.repeat(200)
  const windows = 'C:\\repo' + ('\\' + 'a'.repeat(200)).repeat(30)
  for (const [platform, file, missing] of [
    ['linux', '/repo/' + 'x'.repeat(300) + '/.git', true], ['linux', '/repo/' + '提交说明'.repeat(25), true],
    ['linux', deep, false], ['linux', deep + '/' + 'x'.repeat(256), true], ['linux', wide, true], ['darwin', wide, false],
    ['win32', windows, true], ['win32', windows.repeat(6), false], ['win32', windows.repeat(6) + '\\' + 'x'.repeat(256), true],
    ['freebsd', '/repo/' + 'x'.repeat(300), true], ['freebsd', '/repo/x', false],
  ] as const) assert.equal(missingLongName(tooLong(file), platform), missing, `${platform} ${file.length}`)
  assert.equal(missingLongName(tooLong('/repo/' + 'x'.repeat(300), 'EACCES'), 'linux'), false)
  assert.equal(missingLongName(tooLong(undefined), 'linux'), false)
})

test('Windows paths compare case-insensitively', () => {
  assert.equal(samePath('C:\\Repo', 'c:/repo', 'win32'), true)
  assert.equal(samePath('/Repo', '/repo', 'linux'), false)
})

test('shells the guards cannot parse are refused with guidance', () => {
  for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe']) {
    assert.match(unsupportedShell(shell, 'win32') ?? '', /"shell": "bash"/, shell)
  }
  assert.match(unsupportedShell('/usr/bin/pwsh', 'linux') ?? '', /PowerShell/)
  for (const shell of ['C:\\Windows\\System32\\bash.exe', 'C:/Users/example/AppData/Local/Microsoft/WindowsApps/bash.exe']) assert.match(unsupportedShell(shell, 'win32') ?? '', /WSL/, shell)
  for (const shell of ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash']) assert.equal(unsupportedShell(shell, 'win32'), undefined, String(shell))
})

test('shell 支持集仅接受 Bash，未知或无法确认的解释器拒绝', async t => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) await t.test(platform, () => {
    for (const shell of ['bash', '/bin/bash', '/usr/local/bin/bash']) assert.equal(unsupportedShell(shell, platform), undefined, shell)
    for (const shell of ['fish', '/usr/bin/fish', 'nu', '/opt/bin/nu', 'zsh', '/bin/sh', 'dash', 'unknown-shell', 'bash -l', '', ' \t', undefined]) {
      assert.match(unsupportedShell(shell, platform) ?? '', /"shell": "bash"/, String(shell))
    }
  })
  for (const shell of ['bash.exe', 'BASH.EXE', 'C:\\Program Files\\Git\\bin\\BASH.EXE']) {
    assert.equal(unsupportedShell(shell, 'win32'), undefined, shell)
  }
  for (const shell of ['BASH', 'bash.exe', '/bin/BASH']) assert.ok(unsupportedShell(shell, 'linux'), shell)
  for (const shell of ['C:\\Windows\\Sysnative\\bash.exe', 'C:\\Windows\\SysWOW64\\bash.exe', 'C:\\Windows\\System32\\.\\bash.exe']) {
    assert.match(unsupportedShell(shell, 'win32') ?? '', /WSL/, shell)
  }
})

test('Windows app execution aliases count as launchable although stat cannot follow them', () => {
  // WindowsApps 下的 py.exe、python.exe 是重解析点：lstat 看到链接，stat 报 EACCES，existsSync 返回 false。
  // Linux 上用一个无法跟随的链接模拟它。
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-alias-'))
  try {
    const alias = path.join(root, 'py.exe'), real = path.join(root, 'real')
    symlinkSync(path.join(root, 'missing-target'), alias)
    writeFileSync(real, '')
    assert.equal(launchable(alias, 'win32'), true)
    assert.equal(launchable(alias, 'linux'), false)
    // macOS 和 Linux 上只有带执行权限的常规文件可以启动；Windows 宿主上 X_OK 只检查存在。
    if (process.platform !== 'win32') assert.equal(launchable(real, 'linux'), false)
    chmodSync(real, 0o755)
    assert.equal(launchable(real, 'linux'), true)
    assert.equal(launchable(root, 'linux'), false)
    assert.equal(launchable(path.join(root, 'absent'), 'win32'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
