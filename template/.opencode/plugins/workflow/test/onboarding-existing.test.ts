import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectExisting, EXISTING_MARKERS } from '../onboarding-existing.ts'

// 检测走调用方的 Git 配置：屏蔽全局与系统配置，避免个人 excludes 改变结果。
async function repo(t: { after(fn: () => Promise<void>): void }, files: Record<string, string> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workflow-existing-')))
  const root = join(base, 'project'), home = join(base, 'home'), gitConfig = join(base, 'gitconfig')
  await mkdir(root); await mkdir(home); await writeFile(gitConfig, '')
  const old = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' })
  t.after(async () => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(base, { recursive: true, force: true })
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
    '.opencode/agents/AGENTS.md': '领域规则' })
  const managed = await detectExisting(f.root, { personal: false, managedAgents: ['web-implementer'] })
  assert.deepEqual(managed.items.map(i => [i.path, i.files]), [['.claude', 1], ['.opencode/package.json', 1]])
  assert.ok((await detectExisting(f.root, { personal: false })).items.some(i => i.path === '.opencode/agents/web-implementer.md'))
})

test('CLAUDE.md and GEMINI.md that only reference a sibling AGENTS.md are shared', async t => {
  const f = await repo(t, { 'AGENTS.md': '# rules', 'CLAUDE.md': '\uFEFF@./AGENTS.md\r\n', 'GEMINI.md': 'AGENTS.md\n', 'api/AGENTS.md': 'r', 'api/CLAUDE.md': '@AGENTS.md',
    'lonely/CLAUDE.md': '@AGENTS.md', 'big/AGENTS.md': 'r', 'big/CLAUDE.md': '@AGENTS.md\n' + 'x'.repeat(70 * 1024) })
  const report = await detectExisting(f.root, { personal: false })
  assert.deepEqual(report.shared.map(s => s.path), ['CLAUDE.md', 'GEMINI.md', 'api/CLAUDE.md'])
  assert.deepEqual(report.items.map(i => i.path), ['big/CLAUDE.md', 'lonely/CLAUDE.md'])
  assert.match(report.items.find(i => i.path === 'lonely/CLAUDE.md')!.note, /引用的 AGENTS\.md 不存在/)
})

test('a CLAUDE.md symlink to the sibling AGENTS.md is shared but other links are not followed', async t => {
  const f = await repo(t, { 'AGENTS.md': '# rules', 'other/AGENTS.md': 'r' })
  try { await symlink('AGENTS.md', join(f.root, 'CLAUDE.md')); await symlink('../AGENTS.md', join(f.root, 'other/CLAUDE.md')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
  const report = await detectExisting(f.root, { personal: false })
  assert.deepEqual([report.shared.map(s => s.path), report.items.map(i => i.path)], [['CLAUDE.md'], ['other/CLAUDE.md']])
})

test('paths with spaces and Chinese characters are reported verbatim and matched by their decisions', async t => {
  const f = await repo(t, { '文档 目录/CLAUDE.md': '规则', '前端 应用/.cursor/rules/规则.mdc': 'r' })
  const report = await detectExisting(f.root, { personal: false, decisions: { '文档 目录/CLAUDE.md': 'keep' } })
  assert.deepEqual(report.items.map(i => [i.path, i.decision]), [['前端 应用/.cursor', null], ['文档 目录/CLAUDE.md', 'keep']])
  assert.deepEqual(report.undecided, ['前端 应用/.cursor'])
})

test('git failures, timeouts, oversized listings, non-UTF-8 names and more than 100 items are incomplete', async t => {
  const f = await repo(t)
  const run = (result: object) => detectExisting(f.root, { personal: false, list: () => ({ status: 0, stdout: Buffer.alloc(0), ...result }) })
  const failure = (code: string) => Object.assign(new Error(`spawnSync git ${code}`), { code })
  const cases: [object, RegExp][] = [[{ status: null, error: failure('ETIMEDOUT') }, /20 秒.*\.gitignore/], [{ status: null, error: failure('ENOBUFS') }, /64 MiB/],
    [{ status: 128 }, /Git/], [{ stdout: Buffer.from([0x43, 0xff, 0x00]) }, /UTF-8/]]
  for (const [result, pattern] of cases) {
    const report = await run(result)
    assert.deepEqual([report.complete, report.items, report.undecided], [false, [], []])
    assert.match(report.issues.join('\n'), pattern)
  }
  const many = await run({ stdout: Buffer.from(Array.from({ length: 101 }, (_, i) => `p${i}/CLAUDE.md\0`).join('')) })
  assert.equal(many.complete, false)
  assert.match(many.issues.join('\n'), /超过 100/)
})

test('personal locations show home-relative paths and counts without plugin sources', async t => {
  const f = await repo(t), secret = ['token', 'example'].join('-')
  for (const [name, text] of [['.claude/skills/a/SKILL.md', 'a'], ['.claude/skills/b/SKILL.md', 'b'], ['.agents/skills/c/SKILL.md', 'c'],
    ['.config/opencode/AGENTS.md', 'r'], ['.config/opencode/agents/x.md', 'x'],
    ['.config/opencode/opencode.jsonc', `{ // 注释\n "plugins": ["other@git+https://${secret}@example.invalid/x.git", "superpowers@x"] }`]]) await f.put(name, text, f.home)
  const report = await detectExisting(f.root, { home: f.home })
  assert.deepEqual(report.personal.map(p => [p.path, p.entries]), [['~/.agents/skills', 1], ['~/.claude/skills', 2],
    ['~/.config/opencode/AGENTS.md', 1], ['~/.config/opencode/agents', 1], ['~/.config/opencode/opencode.jsonc', 2]])
  for (const value of [secret, f.home]) assert.equal(JSON.stringify(report).includes(value), false)
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'workflow-xdg-')))
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  await f.put('opencode/AGENTS.md', 'r', elsewhere)
  const outside = await detectExisting(f.root, { home: f.home, configHome: elsewhere })
  assert.ok(outside.personal.some(p => p.path === '$XDG_CONFIG_HOME/opencode/AGENTS.md'), JSON.stringify(outside.personal))
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
