import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { detectExisting, listFiles, EXISTING_MARKERS } from '../onboarding-existing.ts'

// 检测走调用方的 Git 配置：屏蔽全局与系统配置及默认的 $XDG_CONFIG_HOME/git/ignore，避免个人 excludes 改变结果。
async function repo(t: { after(fn: () => Promise<void>): void }, files: Record<string, string> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workflow-existing-')))
  const root = join(base, 'project'), home = join(base, 'home'), gitConfig = join(base, 'gitconfig')
  await mkdir(root); await mkdir(home); await writeFile(gitConfig, '')
  const old = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]))
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(base, 'xdg') })
  t.after(async () => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', root], { stdio: 'ignore' })
  const put = async (name: string, text: string, where = root) => {
    await mkdir(dirname(join(where, name)), { recursive: true }); await writeFile(join(where, name), text)
  }
  for (const [name, text] of Object.entries(files)) await put(name, text)
  return { root, home, put }
}

test('detects each marker class with its tool, file count and OpenCode loading state', async t => {
  const f = await repo(t, {
    'CLAUDE.md': '# rules\n', '.claude/agents/a.md': 'a', '.claude/commands/c.md': 'c', '.claude/skills/s/SKILL.md': 's', '.mcp.json': '{}',
    '.cursor/rules/r.mdc': 'r', '.cursorrules': 'r', '.codex/config.toml': '', 'AGENTS.override.md': 'o', '.agents/skills/x/SKILL.md': 'x',
    '.github/copilot-instructions.md': 'c', '.github/instructions/a.instructions.md': 'a', 'GEMINI.md': 'g', '.clinerules/a.md': 'a',
    'packages/web/.cursor/rules/w.mdc': 'w', 'packages/web/CLAUDE.md': 'w', 'packages/web/.claude/skills/y/SKILL.md': 'y', 'packages/web/opencode.jsonc': '{}',
    '.opencode/agents/custom.md': 'c', '.opencode/opencode.jsonc': '{}', '.opencode/skills/bar/SKILL.md': 'b', '.opencode/skills/bar/ref.md': 'r',
  })
  const report = await detectExisting(f.root, { personal: false })
  assert.equal(report.complete, true, report.issues.join('\n'))
  assert.deepEqual(Object.fromEntries(report.items.map(i => [i.path, [i.tool, i.files, i.opencode]])), {
    '.agents/skills': ['Agent Skills', 1, 'loaded'], '.claude': ['Claude Code', 2, 'not-loaded'], '.claude/skills': ['Claude Code', 1, 'loaded'],
    '.clinerules': ['Cline', 1, 'not-loaded'], '.codex': ['Codex', 1, 'not-loaded'], '.cursor': ['Cursor', 1, 'not-loaded'], '.cursorrules': ['Cursor', 1, 'not-loaded'],
    '.github/copilot-instructions.md': ['GitHub Copilot', 1, 'not-loaded'], '.github/instructions': ['GitHub Copilot', 1, 'not-loaded'], '.mcp.json': ['Claude Code', 1, 'not-loaded'],
    '.opencode/agents/custom.md': ['OpenCode', 1, 'loaded'], '.opencode/opencode.jsonc': ['OpenCode', 1, 'loaded'], '.opencode/skills/bar': ['OpenCode', 2, 'loaded'],
    'AGENTS.override.md': ['Codex', 1, 'not-loaded'], 'CLAUDE.md': ['Claude Code', 1, 'not-loaded'], 'GEMINI.md': ['Gemini CLI', 1, 'not-loaded'],
    'packages/web/.claude/skills': ['Claude Code', 1, 'workspace'], 'packages/web/.cursor': ['Cursor', 1, 'not-loaded'],
    'packages/web/CLAUDE.md': ['Claude Code', 1, 'not-loaded'], 'packages/web/opencode.jsonc': ['OpenCode', 1, 'workspace'],
  })
  assert.match(report.items.find(i => i.path === 'CLAUDE.md')!.note, /只读取 AGENTS\.md/)
  assert.match(report.items.find(i => i.path === '.opencode/opencode.jsonc')!.note, /覆盖根目录 opencode\.jsonc/)
  assert.deepEqual(report.items.map(i => i.path), report.items.map(i => i.path).sort())
  assert.deepEqual(report.undecided, report.items.map(i => i.path))
  assert.equal(new Set(EXISTING_MARKERS.map(m => m.marker)).size, EXISTING_MARKERS.length)
})

test('root-only markers are ignored in subdirectories and marker files inside a marker directory are not reported twice', async t => {
  const f = await repo(t, { 'docs/.mcp.json': '{}', 'docs/.rules': 'r', 'docs/.github/agents/a.md': 'a', 'docs/.cursorrules': 'r', '.claude/CLAUDE.md': 'c', '.vscode/settings.json': '{}', '.github/workflows/ci.yml': 'on: push' })
  assert.deepEqual((await detectExisting(f.root, { personal: false })).items.map(i => [i.path, i.files]), [['.claude', 1]])
})

test('ignored files, template agent files, managed agents and dependency bookkeeping are not existing configuration', async t => {
  const f = await repo(t, { '.gitignore': 'CLAUDE.local.md\n.claude/settings.local.json\n', 'CLAUDE.local.md': 'private', '.claude/settings.local.json': '{}', '.claude/agents/a.md': 'a',
    '.opencode/agents/web-implementer.md': 'w', '.opencode/agent/implementer.md': 'i', '.opencode/.gitignore': 'x', '.opencode/bun.lock': 'x', '.opencode/package.json': '{}',
    '.opencode/AGENTS.md': '领域规则', '.opencode/skills/AGENTS.md': '领域规则', '.opencode/plugins/AGENTS.md': '领域规则', '.opencode/modes/web/AGENTS.md': '领域规则' })
  const managed = await detectExisting(f.root, { personal: false, managedAgents: ['web-implementer'] })
  assert.deepEqual(managed.items.map(i => [i.path, i.files]), [['.claude', 1], ['.opencode/package.json', 1]])
  assert.ok((await detectExisting(f.root, { personal: false })).items.some(i => i.path === '.opencode/agents/web-implementer.md'))
})

test('AGENTS.md inside OpenCode agent, mode or command directories is reported because OpenCode loads it as an agent or command', async t => {
  const f = await repo(t, { '.opencode/agents/AGENTS.md': '领域规则', '.opencode/mode/AGENTS.md': '领域规则', '.opencode/commands/AGENTS.md': '领域规则', '.opencode/agent/web/AGENTS.md': '领域规则' })
  const report = await detectExisting(f.root, { personal: false })
  assert.deepEqual(report.items.map(i => [i.path, i.opencode]), [['.opencode/agent/web', 'loaded'], ['.opencode/agents/AGENTS.md', 'loaded'],
    ['.opencode/commands/AGENTS.md', 'loaded'], ['.opencode/mode/AGENTS.md', 'loaded']])
  assert.match(report.items.find(i => i.path === '.opencode/agents/AGENTS.md')!.note, /加载为代理.*领域规则/)
  assert.match(report.items.find(i => i.path === '.opencode/commands/AGENTS.md')!.note, /加载为命令.*领域规则/)
})

test('operating system bookkeeping files neither create nor count toward an item', async t => {
  const f = await repo(t, { '.cursor/.DS_Store': 'x', '.windsurf/Thumbs.db': 'x', '.kiro/Desktop.ini': 'x', '.claude/.DS_Store': 'x', '.claude/agents/a.md': 'a' })
  for (const name of ['.claude/skills/.DS_Store', '.agents/skills/.DS_Store', '.agents/skills/a/SKILL.md']) await f.put(name, 'x', f.home)
  const report = await detectExisting(f.root, { home: f.home })
  assert.deepEqual(report.items.map(i => [i.path, i.files]), [['.claude', 1]])
  assert.deepEqual(report.personal.map(p => [p.path, p.entries]), [['~/.agents/skills', 1]])
})

test('CLAUDE.md and GEMINI.md that only reference a sibling AGENTS.md are shared', async t => {
  const f = await repo(t, { 'AGENTS.md': '# rules', 'CLAUDE.md': '\uFEFF@./AGENTS.md\r\n', 'GEMINI.md': 'AGENTS.md\n', 'api/AGENTS.md': 'r', 'api/CLAUDE.md': '@AGENTS.md',
    'lonely/CLAUDE.md': '@AGENTS.md', 'big/AGENTS.md': 'r', 'big/CLAUDE.md': '@AGENTS.md\n' + 'x'.repeat(70 * 1024), 'le/AGENTS.md': 'r', 'be/AGENTS.md': 'r' })
  // PowerShell 5.1 的重定向写出带 BOM 的 UTF-16。
  await writeFile(join(f.root, 'le/CLAUDE.md'), Buffer.from('\uFEFF@AGENTS.md\r\n', 'utf16le'))
  await writeFile(join(f.root, 'be/CLAUDE.md'), Buffer.from('\uFEFF@AGENTS.md\r\n', 'utf16le').swap16())
  const report = await detectExisting(f.root, { personal: false })
  assert.deepEqual(report.shared.map(s => s.path), ['CLAUDE.md', 'GEMINI.md', 'api/CLAUDE.md', 'be/CLAUDE.md', 'le/CLAUDE.md'])
  assert.deepEqual(report.items.map(i => i.path), ['big/CLAUDE.md', 'lonely/CLAUDE.md'])
  assert.match(report.items.find(i => i.path === 'lonely/CLAUDE.md')!.note, /引用的 AGENTS\.md 不存在/)
})

test('a CLAUDE.md symlink to the sibling AGENTS.md is shared but other links are not followed', async t => {
  const f = await repo(t, { 'AGENTS.md': '# rules', 'other/AGENTS.md': 'r', 'win/AGENTS.md': 'r' })
  // Windows 上 Node 把相对目标中的 / 写成 \，readlink 原样返回。
  try { await symlink('AGENTS.md', join(f.root, 'CLAUDE.md')); await symlink('../AGENTS.md', join(f.root, 'other/CLAUDE.md')); await symlink('.\\AGENTS.md', join(f.root, 'win/GEMINI.md')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  const report = await detectExisting(f.root, { personal: false })
  assert.deepEqual([report.shared.map(s => s.path), report.items.map(i => i.path)], [['CLAUDE.md', 'win/GEMINI.md'], ['other/CLAUDE.md']])
})

test('paths with spaces and Chinese characters are reported verbatim and matched by their decisions', async t => {
  const f = await repo(t, { '文档 目录/CLAUDE.md': '规则', '前端 应用/.cursor/rules/规则.mdc': 'r' })
  const report = await detectExisting(f.root, { personal: false, decisions: { '文档 目录/CLAUDE.md': 'keep' } })
  assert.deepEqual(report.items.map(i => [i.path, i.decision]), [['前端 应用/.cursor', null], ['文档 目录/CLAUDE.md', 'keep']])
  assert.deepEqual(report.undecided, ['前端 应用/.cursor'])
})

test('git failures, timeouts, oversized listings and more than 100 items are incomplete with advice', async t => {
  const f = await repo(t)
  const run = (result: object) => detectExisting(f.root, { personal: false, list: () => ({ status: 0, stdout: Buffer.alloc(0), ...result }) })
  const failure = (code: string) => Object.assign(new Error(`spawnSync git ${code}`), { code })
  const cases: [object, RegExp][] = [[{ status: null, error: failure('ETIMEDOUT') }, /20 秒.*\.gitignore/], [{ status: null, error: failure('ENOBUFS') }, /64 MiB.*\.gitignore/],
    [{ status: null, error: failure('ENOENT') }, /未找到 git.*PATH/], [{ status: null, error: failure('EACCES') }, /无法启动 Git（EACCES）/],
    [{ status: 128 }, /退出码 128.*Git 仓库.*safe\.directory/]]
  for (const [result, pattern] of cases) {
    const report = await run(result)
    assert.deepEqual([report.complete, report.items, report.undecided], [false, [], []])
    assert.match(report.issues.join('\n'), pattern)
  }
  const many = await run({ stdout: Buffer.from(Array.from({ length: 101 }, (_, i) => `p${i}/CLAUDE.md\0`).join('')) })
  assert.equal(many.complete, false)
  assert.match(many.issues.join('\n'), /超过 100/)
})

test('a non-UTF-8 file name only blocks detection when the reported path itself cannot be decoded', async t => {
  const f = await repo(t)
  const run = (...names: Buffer[]) => detectExisting(f.root, { personal: false, list: () => ({ status: 0, stdout: Buffer.concat(names.flatMap(name => [name, Buffer.from([0])])) }) })
  const bad = (before: string, after = '') => Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)])
  const fine = await run(bad('src/a'), bad('.claude/agents/', '.md'), Buffer.from('.claude/commands/c.md'), bad('.opencode/', '/.DS_Store'))
  assert.equal(fine.complete, true, fine.issues.join('\n'))
  assert.deepEqual(fine.items.map(i => [i.path, i.files]), [['.claude', 2]])
  const blocked = await run(bad('docs/'), bad('docs/', '/CLAUDE.md'))
  assert.deepEqual([blocked.complete, blocked.items], [false, []])
  assert.match(blocked.issues.join('\n'), /1 处.*不是有效 UTF-8.*docs\/�\/CLAUDE\.md.*重命名/)
})

test('detected paths that cannot be recorded as decisions are incomplete instead of blocking every plan', async t => {
  const f = await repo(t)
  for (const path of ['a\\b/CLAUDE.md', '~old/CLAUDE.md', `${'x'.repeat(600)}/CLAUDE.md`]) {
    const report = await detectExisting(f.root, { personal: false, list: () => ({ status: 0, stdout: Buffer.from(`${path}\0.cursorrules\0`) }) })
    assert.deepEqual([report.complete, report.items], [false, []], path)
    assert.match(report.issues.join('\n'), /无法记录决定.*重命名/, path)
  }
})

test('personal locations show home-relative paths and counts without plugin sources', async t => {
  const f = await repo(t), secret = ['token', 'example'].join('-')
  for (const [name, text] of [['.claude/skills/a/SKILL.md', 'a'], ['.claude/skills/b/SKILL.md', 'b'], ['.agents/skills/c/SKILL.md', 'c'],
    ['.config/opencode/AGENTS.md', 'r'], ['.config/opencode/agents/x.md', 'x'],
    ['.config/opencode/opencode.jsonc', `{ // 注释\n "plugins": ["other@git+https://${secret}@example.invalid/x.git", "superpowers@x"] }`]]) await f.put(name, text, f.home)
  const report = await detectExisting(f.root, { home: f.home })
  assert.deepEqual(report.personal.map(p => [p.path, p.entries]), [['~/.agents/skills', 1], ['~/.claude/skills', 2],
    ['~/.config/opencode/AGENTS.md', 1], ['~/.config/opencode/agents', 1], ['~/.config/opencode/opencode.jsonc', 2]])
  // 主目录中的 \ 在 JSON 里转义为 \\，也可能以正斜杠出现：两种写法都要查。
  for (const value of [secret, JSON.stringify(f.home).slice(1, -1), f.home.replaceAll('\\', '/')]) assert.equal(JSON.stringify(report).includes(value), false, value)
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'workflow-xdg-')))
  t.after(() => rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await f.put('opencode/AGENTS.md', 'r', elsewhere)
  const outside = await detectExisting(f.root, { home: f.home, configHome: elsewhere })
  assert.ok(outside.personal.some(p => p.path === '$XDG_CONFIG_HOME/opencode/AGENTS.md'), JSON.stringify(outside.personal))
})

test('personal configuration that cannot be read safely is listed without counting plugins', async t => {
  const f = await repo(t)
  await f.put('.config/opencode/opencode.json', '{ "plugins": [', f.home)
  await f.put('.config/opencode/opencode.jsonc', 'x'.repeat(1024 * 1024 + 1), f.home)
  const report = await detectExisting(f.root, { home: f.home })
  assert.deepEqual(report.personal.map(p => [p.path, p.entries, p.note]), [['~/.config/opencode/opencode.json', null, '个人配置无法解析，未统计插件'],
    ['~/.config/opencode/opencode.jsonc', null, '个人配置无法安全读取，未统计插件']])
  // 指向自身的链接让 stat 报 ELOOP；Windows 上创建链接需要额外权限。
  if (process.platform !== 'win32') {
    await symlink('agents', join(f.home, '.config/opencode/agents'))
    const looped = await detectExisting(f.root, { home: f.home })
    assert.equal(looped.personal.find(p => p.path === '~/.config/opencode/agents')?.note, '无法读取（ELOOP）')
  }
})

test('symlinked marker directories listed by Git as single entries are still classified', async t => {
  const f = await repo(t)
  const entries = ['.claude', '.agents/skills', '.github/instructions', 'packages/web/.cursor', 'packages/api/.claude/skills', 'docs/.agents']
  const report = await detectExisting(f.root, { personal: false, list: () => ({ status: 0, stdout: Buffer.from(entries.map(path => path + '\0').join('')) }) })
  assert.deepEqual(report.items.map(i => [i.path, i.opencode]), [['.agents/skills', 'loaded'], ['.claude', 'loaded'], ['.github/instructions', 'not-loaded'],
    ['docs/.agents', 'workspace'], ['packages/api/.claude/skills', 'workspace'], ['packages/web/.cursor', 'not-loaded']])
  assert.match(report.items.find(i => i.path === '.claude')!.note, /符号链接.*skills/)
})

test('credential values in tool configuration never appear in the report', async t => {
  const token = ['sk', 'example', 'value'].join('-')
  const f = await repo(t, { '.mcp.json': JSON.stringify({ mcpServers: { x: { env: { API_KEY: token } } } }), '.aider.conf.yml': `openai-api-key: ${token}\n`, 'CLAUDE.md': `key ${token}` })
  const report = await detectExisting(f.root, { personal: false })
  assert.equal(report.items.length, 3)
  assert.equal(JSON.stringify(report).includes(token), false)
})

// 假 git 经 PATH 直接启动只在 POSIX 上可行：Windows 只按 .exe、.com 查找。
test('listing project files leaves the host event loop running and stops at its time and size limits', async t => {
  if (process.platform === 'win32') return
  const f = await repo(t), bin = join(dirname(f.root), 'bin')
  await f.put('git', `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake.mjs')}"\n`, bin)
  await chmod(join(bin, 'git'), 0o755)
  await f.put('fake.mjs', [
    "import { writeFileSync } from 'node:fs'",
    "const mode = process.env.WORKFLOW_FAKE_GIT",
    "if (mode === 'hang') { writeFileSync(process.env.WORKFLOW_FAKE_GIT_PID, String(process.pid)); setTimeout(() => {}, 60000) }",
    "else if (mode === 'large') process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x61))",
    "else setTimeout(() => process.stdout.write('CLAUDE.md\\0'), 1000)", ''].join('\n'), bin)
  const path = process.env.PATH
  process.env.PATH = bin + delimiter + path
  t.after(() => { process.env.PATH = path; delete process.env.WORKFLOW_FAKE_GIT; delete process.env.WORKFLOW_FAKE_GIT_PID })
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const report = await detectExisting(f.root, { personal: false })
  clearInterval(timer)
  assert.deepEqual(report.items.map(i => i.path), ['CLAUDE.md'])
  assert.ok(ticks > 30, `检测期间事件循环只运行了 ${ticks} 次`)
  const pidFile = join(dirname(f.root), 'fake-git.pid')
  Object.assign(process.env, { WORKFLOW_FAKE_GIT: 'hang', WORKFLOW_FAKE_GIT_PID: pidFile })
  // 留足启动时间：慢的 runner 上假 git 要先写出进程号，才能核对超时后它已终止。
  const started = Date.now(), hanging = listFiles(f.root, { timeout: 3000 })
  let pid = 0
  for (let attempt = 0; attempt < 150 && !pid; attempt++) { pid = Number(await readFile(pidFile, 'utf8').catch(() => '')); if (!pid) await sleep(20) }
  const hung = await hanging
  assert.deepEqual([hung.status, hung.error?.code], [null, 'ETIMEDOUT'])
  assert.ok(Date.now() - started < 10000)
  assert.ok(pid > 0, '假 git 没有写出进程号')
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await sleep(20)
  assert.equal(alive(), false, '超时后 git 进程仍在运行')
  process.env.WORKFLOW_FAKE_GIT = 'large'
  const large = await listFiles(f.root, { limit: 1024 * 1024 })
  assert.deepEqual([large.status, large.error?.code], [null, 'ENOBUFS'])
})

// 以假子进程覆盖各平台都会走到的事件顺序：启动失败、超限后仍有数据、超时。
function fakeLaunch(stdout: PassThrough | null, kills: number[]) {
  const child = Object.assign(new EventEmitter(), { stdout, pid: undefined, kill: () => true }) as unknown as ChildProcess
  return { child, kill: () => { kills.push(1) }, launch: () => child }
}

test('listing project files reports spawn failures without unhandled errors and stops only once', async () => {
  // 文件描述符耗尽时 spawn 返回没有 stdout 的子进程，并在下一轮事件循环报告错误。
  const exhausted = fakeLaunch(null, [])
  const pending = listFiles('.', { launch: exhausted.launch, kill: exhausted.kill })
  process.nextTick(() => exhausted.child.emit('error', Object.assign(new Error('spawn git EMFILE'), { code: 'EMFILE' })))
  assert.deepEqual(await pending.then(result => [result.status, result.error?.code]), [null, 'EMFILE'])
  const thrown = await listFiles('.', { launch: () => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) } })
  assert.deepEqual([thrown.status, thrown.error?.code], [null, 'EINVAL'])
  const kills: number[] = [], flooding = fakeLaunch(new PassThrough(), kills)
  const large = listFiles('.', { limit: 4, launch: flooding.launch, kill: flooding.kill })
  for (let chunk = 0; chunk < 3; chunk++) flooding.child.stdout!.emit('data', Buffer.from('CLAUDE.md\0'))
  flooding.child.emit('close', null)
  assert.deepEqual(await large.then(result => [result.status, result.error?.code]), [null, 'ENOBUFS'])
  assert.equal(kills.length, 1)
  const waits: number[] = [], silent = fakeLaunch(new PassThrough(), waits)
  const timed = await listFiles('.', { timeout: 50, launch: silent.launch, kill: silent.kill })
  assert.deepEqual([timed.status, timed.error?.code, waits.length], [null, 'ETIMEDOUT', 1])
})
