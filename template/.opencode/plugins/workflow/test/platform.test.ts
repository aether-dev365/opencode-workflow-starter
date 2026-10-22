import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { windowsPath, portableRelative, containedRelative, pythonCommand, pythonEnv, childOptions, killTree, findExecutable, commandLine, samePath, unsupportedShell } from '../platform.ts'

test('Git Bash drive paths map to Windows drives only on Windows', () => {
  for (const [value, expected] of [['/c/Users/a', 'C:/Users/a'], ['/C:/x', 'C:/x'], ['/C:\\x', 'C:/x'], ['/cygdrive/d/x', 'D:/x'],
    ['/mnt/e/x', 'E:/x'], ['/c', 'C:/'], ['/home/x', '/home/x'], ['src/a', 'src/a']]) assert.equal(windowsPath(value, 'win32'), expected, value)
  assert.equal(windowsPath('/c/Users/a', 'linux'), '/c/Users/a')
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
  assert.deepEqual(pythonCommand({ env: {}, platform: 'linux', probe: never }), { command: 'python3', args: [] })
})

test('Windows tries the py launcher, then python, then python3', () => {
  const tried: string[] = []
  const found = pythonCommand({ env: {}, platform: 'win32', probe: c => { tried.push([c.command, ...c.args].join(' ')); return c.command === 'python' } })
  assert.deepEqual(found, { command: 'python', args: [] })
  assert.deepEqual(tried, ['py -3', 'python'])
  assert.throws(() => pythonCommand({ env: {}, platform: 'win32', probe: () => false }), /py -3.*python.*python3.*WORKFLOW_PYTHON/s)
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
  assert.deepEqual(calls, [['taskkill', '/pid', '42', '/T', '/F']])
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

test('cmd scripts run through cmd.exe with the whole command line quoted', () => {
  assert.deepEqual(commandLine('C:\\Program Files\\nodejs\\opencode.cmd', ['--version'], 'win32'),
    { command: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\opencode.cmd" --version"'], windowsVerbatimArguments: true })
  assert.deepEqual(commandLine('C:\\tools\\gitleaks.exe', ['version'], 'win32'), { command: 'C:\\tools\\gitleaks.exe', args: ['version'] })
  assert.deepEqual(commandLine('/usr/bin/opencode.cmd', ['--version'], 'linux'), { command: '/usr/bin/opencode.cmd', args: ['--version'] })
  assert.throws(() => commandLine('C:\\x\\a.cmd', ['say "hi"'], 'win32'), /cmd/)
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
  for (const shell of ['C:\\Windows\\System32\\bash.exe', 'C:/Users/a/AppData/Local/Microsoft/WindowsApps/bash.exe']) assert.match(unsupportedShell(shell, 'win32') ?? '', /WSL/, shell)
  for (const shell of ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/bin/zsh', '', undefined]) assert.equal(unsupportedShell(shell, 'win32'), undefined, String(shell))
})
