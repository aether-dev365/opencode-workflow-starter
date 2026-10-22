import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const entrypoints = ['README.md', 'ADOPT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'AGENTS.md']

function files(path) {
  return readdirSync(path, { withFileTypes: true }).filter(e => !['node_modules', '__pycache__', '.state'].includes(e.name)).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])
}
const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(path => path && !path.endsWith('package-lock.json'))

test('public entrypoints and relative documentation links resolve within the deliverable', () => {
  for (const path of [...entrypoints, 'LICENSE', 'examples/adoption-report.md', 'optional/production/mcp-readonly.example.jsonc']) assert.ok(existsSync(path), path)
  // Claude Code 读 CLAUDE.md：它只引用 AGENTS.md，规则只维护一份。
  assert.equal(readFileSync('CLAUDE.md', 'utf8').trim(), '@AGENTS.md')
  for (const path of [...files('template'), ...files('optional'), ...files('examples'), ...entrypoints].filter(p => p.endsWith('.md'))) {
    const text = readFileSync(path, 'utf8')
    for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(link)) continue
      assert.ok(existsSync(resolve(dirname(path), link.split('#')[0])), `${path} → ${link}`)
    }
  }
})

test('tracked text files contain no local home paths or public IPv4 addresses', () => {
  // 测试和文档中的合成路径统一使用占位用户名 example。
  const homes = [/\/home\/(?!example\/)[a-z_][\w.-]*\//, /\/Users\/(?!example\/)[A-Za-z][\w.-]*\//, /[A-Za-z]:\\Users\\(?!example\\)[A-Za-z]/]
  for (const path of tracked()) {
    const text = readFileSync(path, 'utf8')
    for (const pattern of homes) assert.doesNotMatch(text, pattern, path)
    for (const [address] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) assert.ok(['127.0.0.1', '0.0.0.0'].includes(address), `${path}: ${address}`)
  }
})

test('maintainer-local forbidden patterns stay out of tracked files', () => {
  // 私有名称只写在被忽略的本地文件里，避免禁用词清单本身随仓库公开。
  const list = '.verification/forbidden-patterns.txt'
  if (!existsSync(list)) return
  const patterns = readFileSync(list, 'utf8').split('\n').map(line => line.trim().toLowerCase()).filter(line => line && !line.startsWith('#'))
  for (const path of tracked()) {
    const text = readFileSync(path, 'utf8').toLowerCase()
    assert.ok(!patterns.some(pattern => text.includes(pattern)), `${path} 含本地禁用词`)
  }
})

test('workflow scripts keep LF line endings on every checkout', () => {
  // Git for Windows 默认 core.autocrlf=true；CRLF 会让 bash 报 `set: pipefail: invalid option name`。
  for (const line of execFileSync('git', ['check-attr', 'eol', '--', 'template/.opencode/workflow/checks/run-tests.sh', 'scripts/verify.mjs'], { encoding: 'utf8' }).trim().split('\n')) {
    assert.match(line, /: eol: lf$/, line)
  }
  const root = mkdtempSync(join(tmpdir(), 'workflow-eol-'))
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=true', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' })
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'adopt')
    for (const path of ['.opencode/workflow/checks/run-tests.sh', 'scripts/workflow/doctor.mjs']) {
      rmSync(join(root, path))
      git('checkout', '--', path)
      assert.ok(!readFileSync(join(root, path), 'utf8').includes('\r'), path)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('documented OpenCode versions match the plugin baseline', () => {
  const manifest = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8'))
  const baseline = manifest.dependencies['@opencode/plugin']
  assert.equal(manifest.devDependencies['@opencode/client'], baseline)
  const docs = ['README.md', 'ADOPT.md', 'CONTRIBUTING.md', 'docs/skills.md', 'template/AGENTS.md', ...files('template/docs'), ...files('optional')].filter(p => p.endsWith('.md'))
  for (const path of docs) {
    // 带 + 的是其他组件的最低要求（如 Superpowers 要求 OpenCode 2.0.4+），不是本模板的基线。
    for (const [version] of readFileSync(path, 'utf8').matchAll(/(?<![\d.])2\.\d+\.\d+(?![\d.+])/g)) assert.equal(version, baseline, path)
  }
})

// 只看仓库自己的规则：屏蔽贡献者机器上的全局 excludes（例如 ~/.config/git/ignore）。
const ignoredBy = (cwd, paths) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], { cwd, input: paths.join('\n'), encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

test('local artifacts are ignored while deliverables stay committable', () => {
  const local = ['.env', 'config/.env.production', 'deploy/prod.env', '.DS_Store', 'Thumbs.db', '.vscode/settings.json', '.idea/workspace.xml',
    'debug.log', '.venv/bin/python', '.pytest_cache/v/cache', 'coverage/index.html', '.codegraph/index.db', '.claude/settings.local.json',
    'template/.opencode/plugins/workflow/opencode-workflow-starter-1.0.0.tgz', '.verification/report.json', 'artifacts/starter.tar.gz']
  assert.deepEqual(ignoredBy('.', local), local)
  assert.deepEqual(ignoredBy('.', [...tracked(), '.env.example', 'template/.env.example', '.github/workflows/ci.yml']), [])
})

test('the template ignores workflow state and credentials without hiding source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-ignore-'))
  try {
    cpSync('template/.gitignore', join(root, '.gitignore'))
    execFileSync('git', ['init', '-q', root])
    const local = ['.env', 'config/.env.local', 'deploy/prod.env', '.opencode/workflow/.state/review/x', '.opencode/plugins/workflow/node_modules/x/index.js', '.worktrees/a/file']
    assert.deepEqual(ignoredBy(root, local), local)
    assert.deepEqual(ignoredBy(root, ['.env.example', 'config/.env.example', 'src/app.env.ts', '.opencode/workflow/protection.json']), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the template carries the suite license', () => {
  const license = readFileSync('LICENSE', 'utf8')
  assert.match(license, /^MIT License\n/)
  assert.equal(readFileSync('template/.opencode/LICENSE', 'utf8'), license)
})

test('extended secret rules are valid protection rules', async () => {
  const { loadProjectConfig } = await import('../template/.opencode/plugins/workflow/config.ts')
  const { pythonCommand } = await import('../template/.opencode/plugins/workflow/platform.ts')
  const root = mkdtempSync(join(tmpdir(), 'workflow-protection-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    // 按 optional/protection/README.md 的做法：把示例规则追加到 protection.json 末尾。
    const file = join(root, '.opencode/workflow/protection.json')
    const protection = JSON.parse(readFileSync(file, 'utf8'))
    const extended = JSON.parse(readFileSync('optional/protection/extended-secrets.example.json', 'utf8'))
    writeFileSync(file, JSON.stringify({ ...protection, rules: [...protection.rules, ...extended.rules] }))
    await loadProjectConfig(root)
    const python = pythonCommand()
    const paths = ['deploy/key.pem', '.ssh/id_ed25519', 'id_ed25519.pub', '.env.example', 'src/app.ts']
    const result = spawnSync(python.command, [...python.args, join(root, '.opencode/workflow/checks/policy.py')], { input: JSON.stringify({ root, action: 'read', paths }), encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result.stdout), { denied: ['deploy/key.pem', '.ssh/id_ed25519'] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
