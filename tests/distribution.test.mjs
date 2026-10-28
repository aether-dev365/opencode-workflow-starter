import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { assertPythonSuiteComplete } from './fixtures/python-suite.mjs'
import { forbiddenPatterns, leaks } from './fixtures/privacy.mjs'

const entrypoints = ['README.md', 'ADOPT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'AGENTS.md']

function files(path) {
  return readdirSync(path, { withFileTypes: true }).filter(e => !['node_modules', '__pycache__', '.state'].includes(e.name)).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])
}
const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(path => path && !path.endsWith('package-lock.json'))
// 新项目技能按这句占位说明判断根规则的项目概要是否已填写，阶段名在流程文档和技能中保持一致。
const SUMMARY_PLACEHOLDER = '（接入时填写，保持简短：用途、技术栈、目录与领域、验证命令入口，以及设计记录的位置和何时阅读。）'
const NEW_PROJECT_PHASES = ['准备', '最小接入与基线提交', '设计', '搭骨架', '项目规则', '第二轮配置', '验收与交接']

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

// 模板会被复制进接入方项目，指向模板之外的链接在那里会失效。
test('template Markdown links stay inside the template', () => {
  const inside = resolve('template') + sep
  for (const path of files('template').filter(p => p.endsWith('.md'))) {
    const text = readFileSync(path, 'utf8')
    // 行内链接可以带尖括号和标题；引用式链接的目标写在定义行。
    const links = [...text.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))/g), ...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/gm)]
    for (const link of links.map(match => match[1] ?? match[2])) {
      if (/^(https?:|#|mailto:)/.test(link)) continue
      assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(link), `${path} → ${link}`)
      assert.ok(resolve(dirname(path), link.split('#')[0]).startsWith(inside), `${path} → ${link}`)
    }
  }
})

test('the root rules template has the project summary placeholder and the guide lists every phase', () => {
  const rules = readFileSync('template/AGENTS.md', 'utf8')
  assert.equal(rules.match(/^## 项目概要\n\n(.+)\n/m)?.[1], SUMMARY_PLACEHOLDER)
  for (const text of ['/workflow-new', 'docs/workflow/new-project.md']) assert.ok(rules.includes(text), text)
  const guide = readFileSync('template/docs/workflow/new-project.md', 'utf8')
  NEW_PROJECT_PHASES.forEach((name, index) => assert.match(guide, new RegExp(`^## 第 ${index} 阶段：${name}$`, 'm'), name))
})

// 命令按 ID 加载技能：改名时命令、技能目录和 frontmatter 的 name 要一起改，否则技能加载不到。
test('template commands load skills that exist under the same name', () => {
  const named = readdirSync('template/.opencode/commands').filter(name => name.endsWith('.md'))
    .flatMap(name => [...readFileSync(join('template/.opencode/commands', name), 'utf8').matchAll(/加载 `([a-z0-9-]+)` 技能/g)].map(match => match[1]))
  assert.deepEqual(named.sort(), ['workflow-new-project', 'workflow-onboarding'])
  for (const id of named) {
    const front = readFileSync(join('template/.opencode/skills', id, 'SKILL.md'), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
    assert.ok(front.split('\n').includes(`name: ${id}`), id)
  }
})

test('the new-project command and skill keep the guide phases, the summary placeholder and the flow boundaries', () => {
  const command = readFileSync('template/.opencode/commands/workflow-new.md', 'utf8')
  const skill = readFileSync('template/.opencode/skills/workflow-new-project/SKILL.md', 'utf8')
  for (const text of ['/workflow-setup', 'docs/workflow/new-project.md']) {
    assert.ok(command.includes(text), `command: ${text}`)
    assert.ok(skill.includes(text), `skill: ${text}`)
  }
  NEW_PROJECT_PHASES.forEach((name, index) => assert.match(skill, new RegExp(`^${index}\\. \\*\\*${name}\\*\\*：`, 'm'), name))
  for (const text of [SUMMARY_PLACEHOLDER, 'workflow-onboarding', '不推送、不发布、不创建远端仓库', '`protection.json` 只给拟议差异']) assert.ok(skill.includes(text), text)
})

test('the onboarding guide and skill hand brand-new projects to /workflow-new', () => {
  const guide = readFileSync('template/docs/workflow/onboarding.md', 'utf8')
  const skill = readFileSync('template/.opencode/skills/workflow-onboarding/SKILL.md', 'utf8')
  assert.ok(guide.includes('[新项目流程](new-project.md)'))
  for (const text of ['/workflow-new', '第二轮']) {
    assert.ok(guide.includes(text), `guide: ${text}`)
    assert.ok(skill.includes(text), `skill: ${text}`)
  }
})

test('the suite entrypoints route brand-new projects to /workflow-new', () => {
  for (const path of ['README.md', 'ADOPT.md']) {
    const text = readFileSync(path, 'utf8')
    for (const needle of ['](template/docs/workflow/new-project.md)', '/workflow-new']) assert.ok(text.includes(needle), `${path}: ${needle}`)
  }
  assert.ok(readFileSync('CHANGELOG.md', 'utf8').split('\n## [1.1.0]')[0].includes('/workflow-new'))
})

// 插件把解析到项目根的修改类参数按保护配置拒绝，模型照文档运行 doctor --root . 会被拦下；doctor 默认检查当前目录。
// 可选组件由模型按各自说明合并和验收，其说明同样在 OpenCode 中执行。
test('doctor commands the model runs from the docs do not pass --root', () => {
  for (const path of [...files('template'), ...files('optional')].filter(p => p.endsWith('.md')).concat('ADOPT.md')) {
    for (const [command] of readFileSync(path, 'utf8').matchAll(/doctor\.mjs[^`\n]*/g)) assert.doesNotMatch(command, /--root/, `${path}: ${command}`)
  }
})

test('tracked text files contain no local home paths or IPv4 addresses', () => {
  for (const path of tracked()) assert.deepEqual(leaks(readFileSync(path, 'utf8')), [], path)
})

test('maintainer-local forbidden patterns stay out of tracked files', t => {
  // 外部贡献者和 CI 没有这份清单。断言只报文件名，不回显禁用词，免得它进入验证日志。
  const patterns = forbiddenPatterns('.')
  if (patterns === null) t.diagnostic('未找到 .verification/forbidden-patterns.txt，未检查本地禁用词')
  for (const path of tracked()) {
    assert.ok(!leaks(readFileSync(path, 'utf8'), patterns ?? []).some(found => found.kind === 'forbidden'), `${path} 含本地禁用词`)
  }
})

test('privacy rules report home paths, IPv4 addresses and local words by line', () => {
  // 样例在运行时拼接，本文件自身也要通过上面的扫描；地址用 RFC 5737 保留给文档的网段。
  const windows = 'C:' + '\\Users\\' + 'B', escaped = 'C:' + '\\\\Users\\\\' + 'B', lower = 'c:' + '\\users\\' + 'b', forward = 'c:' + '/users/' + 'b'
  const unc = '\\home\\' + 'alice\\', address = ['192', '0', '2', '1'].join('.')
  const text = ['/home/example/x 127.0.0.1 0.0.0.0 C:\\Users\\example\\x C:/Users/example/x C:/Users/example \\\\wsl.localhost\\Ubuntu\\home\\example\\x',
    '/home/' + 'alice/x', '/Users/' + 'Bob/x', windows + 'ob', escaped + 'ob', lower + 'ob', forward + 'ob',
    '\\\\wsl.localhost\\Ubuntu' + unc + 'x', address, 'a Secret Word'].join('\n')
  assert.deepEqual(leaks(text, ['Secret Word']), [
    { line: 2, kind: 'home', match: '/home/' + 'alice/' },
    { line: 3, kind: 'home', match: '/Users/' + 'Bob/' },
    { line: 4, kind: 'home', match: windows },
    { line: 5, kind: 'home', match: escaped },
    { line: 6, kind: 'home', match: lower },
    { line: 7, kind: 'home', match: forward },
    { line: 8, kind: 'home', match: unc },
    { line: 9, kind: 'ipv4', match: address },
    { line: 10, kind: 'forbidden', match: 'secret word' },
  ])
  assert.deepEqual(leaks(text.split('\n')[0]), [])
})

test('forbidden patterns come from the ignored local list', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-forbidden-'))
  try {
    assert.equal(forbiddenPatterns(root), null)
    const list = join(root, '.verification/forbidden-patterns.txt')
    mkdirSync(list, { recursive: true })
    assert.throws(() => forbiddenPatterns(root), { code: 'EISDIR' })
    rmSync(list, { recursive: true })
    writeFileSync(list, '# 注释\n\n  Private Name  \nINTERNAL-HOST\n')
    assert.deepEqual(forbiddenPatterns(root), ['private name', 'internal-host'])
    // Windows 上编辑的清单可能带 BOM 和 CRLF；存成 UTF-16 时按 UTF-8 读会得到匹配不到任何文本的词，必须报错。
    writeFileSync(list, '﻿Private Name\r\nINTERNAL-HOST\r\n')
    assert.deepEqual(forbiddenPatterns(root), ['private name', 'internal-host'])
    writeFileSync(list, Buffer.from('﻿private name\r\n', 'utf16le'))
    assert.throws(() => forbiddenPatterns(root), /不是 UTF-8 文本/)
  } finally { rmSync(root, { recursive: true, force: true }) }
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

// 接入方复制这些文件后，git diff --check 会把其中的行尾空白和文件末尾空行报给他们；按暂存内容比较，不受 Windows 检出换行影响。
test('deliverable files pass git diff --check', () => {
  const empty = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { input: '', encoding: 'utf8' }).trim()
  const result = spawnSync('git', ['diff', '--cached', '--check', empty, '--', 'template', 'optional', 'examples'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('documented OpenCode versions match the plugin baseline', () => {
  const manifest = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8'))
  const baseline = manifest.dependencies['@opencode/plugin']
  assert.equal(manifest.devDependencies['@opencode/client'], baseline)
  const docs = ['README.md', 'ADOPT.md', 'CONTRIBUTING.md', 'docs/skills.md', 'template/AGENTS.md', ...files('template/docs'), ...files('optional')].filter(p => p.endsWith('.md'))
  for (const path of docs) {
    // 带 + 的是其他组件的最低要求（如 Superpowers 要求 OpenCode 2.0.4+），不是本模板的基线。
    for (const [version] of readFileSync(path, 'utf8').matchAll(/(?<![\d.])2\.\d+\.\d+(?![\d.+])/g)) assert.equal(version, baseline, path)
    // doctor 对基线所在系列的其他补丁版本报 warn，文档中的系列写法（如 2.1.x）须跟随基线。
    for (const [series] of readFileSync(path, 'utf8').matchAll(/(?<![\d.])2\.\d+\.x\b/g)) assert.equal(series, baseline.replace(/\d+$/, 'x'), path)
  }
})

test('a hung plugin test fails by name instead of holding the run until the stage timeout', () => {
  // 只有单测超时时，残留的子进程句柄仍让测试文件不退出；强制退出后超时的用例才会作为失败报告。
  const script = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8')).scripts.test
  assert.match(script, /--test-timeout=[1-9]\d* /)
  assert.match(script, /--test-force-exit /)
})

test('the suite version agrees across the changelog, README and plugin manifests', () => {
  // 发布时这几处要一起改；模板版本以插件 package.json 为准。
  const version = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8')).version
  const lock = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package-lock.json', 'utf8'))
  assert.deepEqual([lock.version, lock.packages[''].version], [version, version])
  const changelog = readFileSync('CHANGELOG.md', 'utf8')
  assert.equal(changelog.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m)?.[1], version)
  const links = Object.fromEntries([...changelog.matchAll(/^\[([^\]]+)\]: (\S+)$/gm)].map(([, name, url]) => [name, url]))
  const tag = 'v' + version.replaceAll('.', '\\.')
  assert.match(links['未发布'] ?? '', new RegExp(`/compare/${tag}\\.\\.\\.HEAD$`))
  assert.match(links[version] ?? '', new RegExp(`/releases/tag/${tag}$`))
  const mentions = [...readFileSync('README.md', 'utf8').matchAll(/--branch v(\d+\.\d+\.\d+)|^version=(\d+\.\d+\.\d+)$/gm)].map(match => match[1] ?? match[2])
  assert.equal(mentions.length, 2)
  for (const mention of mentions) assert.equal(mention, version)
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

test('post-commit and CI run the same quality check entries', () => {
  const entries = path => [...readFileSync(path, 'utf8').match(/^CHECKS = \(([\s\S]*?)\)\n/m)[1].matchAll(/'([a-z-]+\.py)'/g)].map(match => match[1])
  assert.deepEqual(entries('optional/quality/run-hook.py'), entries('optional/ci/run-quality.py'))
  assert.ok(entries('optional/ci/run-quality.py').includes('check-sync.py'))
})

test('the template review routes the sync unit over every changed path', async () => {
  const { loadProjectConfig } = await import('../template/.opencode/plugins/workflow/config.ts')
  const { planTasks } = await import('../template/.opencode/plugins/workflow/review-batches.ts')
  const root = mkdtempSync(join(tmpdir(), 'workflow-sync-review-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    const config = await loadProjectConfig(root)
    assert.deepEqual(config.catalog.sync, { group: 'core', checklist: 'sync.md' })
    const paths = ['src/a.ts', 'docs/workflow/onboarding.md', '.opencode/skills/workflow-onboarding/SKILL.md']
    assert.deepEqual(planTasks(paths, config.routing).find(task => task.id === 'sync'), { id: 'sync', unitId: 'sync', paths })
    const checklist = readFileSync('template/.opencode/workflow/review/checklists/sync.md', 'utf8')
    for (const text of ['quality.json', 'sync 登记', '`blocking: false`', '结论仍为 pass']) assert.ok(checklist.includes(text), text)
    // reviewer 说明与检查单对不阻断发现的提交方式一致：pass 可以附带它们，findings 只用于有阻断。
    assert.ok(readFileSync('template/.opencode/agents/reviewer.md', 'utf8').includes('`blocking: false`'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the onboarding guide lists every existing AI configuration marker the wizard detects', async () => {
  const { EXISTING_MARKERS } = await import('../template/.opencode/plugins/workflow/onboarding-existing.ts')
  const guide = readFileSync('template/docs/workflow/onboarding.md', 'utf8')
  for (const { marker } of EXISTING_MARKERS) assert.ok(guide.includes('`' + marker + '`'), marker)
})

test('generated subagents keep the implementer collaboration contract and permission denies', async () => {
  const { AGENT_CONTRACT, agentText } = await import('../template/.opencode/plugins/workflow/onboarding-agents.ts')
  const [, front, body] = readFileSync('template/.opencode/agents/implementer.md', 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  assert.equal(AGENT_CONTRACT, body.trim())
  const permissions = text => text.split('\n').filter(line => line.startsWith('  - {'))
  const generated = agentText({ description: '示例', focus: '示例职责。' }).split('\n---\n')[0]
  assert.equal(permissions(front).length, 3)
  assert.deepEqual(permissions(generated), permissions(front))
})

test('the release evidence example covers every unit that routes all paths', () => {
  const routing = JSON.parse(readFileSync('template/.opencode/workflow/review/routing.json', 'utf8'))
  const example = JSON.parse(readFileSync('optional/release/evidence.example.json', 'utf8'))
  const covered = new Set(example.entries.flatMap(entry => entry.units))
  for (const unit of routing.units.filter(unit => unit.areas.includes('*'))) assert.ok(covered.has(unit.id), unit.id)
})

test('the comment checklist joins the review catalog as the quality README describes', async () => {
  const { loadProjectConfig } = await import('../template/.opencode/plugins/workflow/config.ts')
  const root = mkdtempSync(join(tmpdir(), 'workflow-quality-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    const review = join(root, '.opencode/workflow/review')
    cpSync('optional/quality/comments-checklist.md', join(review, 'checklists/comments.md'))
    const catalog = JSON.parse(readFileSync(join(review, 'catalog.json'), 'utf8'))
    writeFileSync(join(review, 'catalog.json'), JSON.stringify({ ...catalog, comments: { group: 'core', checklist: 'comments.md' } }))
    const routing = JSON.parse(readFileSync(join(review, 'routing.json'), 'utf8'))
    writeFileSync(join(review, 'routing.json'), JSON.stringify({ ...routing, units: [...routing.units, { id: 'comments', areas: ['*'] }] }))
    const config = await loadProjectConfig(root)
    assert.equal(config.catalog.comments.checklist, 'comments.md')
    assert.ok(config.routing.units.some(unit => unit.id === 'comments'))
    const readme = readFileSync('optional/quality/README.md', 'utf8')
    for (const text of ['"comments": { "group": "core", "checklist": "comments.md" }', '{ "id": "comments", "areas": ["*"] }', 'install-hooks.py --uninstall']) assert.ok(readme.includes(text), text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('quality README copy instructions produce a passing standalone test suite', async () => {
  const { pythonCommand } = await import('../template/.opencode/plugins/workflow/platform.ts')
  const root = mkdtempSync(join(tmpdir(), 'workflow-quality-copy-'))
  try {
    const readme = readFileSync('optional/quality/README.md', 'utf8')
    const required = readme.match(/^1\. ([\s\S]*?)^2\./m)[1].split('需要调整时')[0]
    const target = join(root, 'scripts/quality')
    for (const name of readdirSync('optional/quality')) {
      if ((name.endsWith('.py') && required.includes('`.py`')) ||
          (name.endsWith('.json') && required.includes(name))) {
        cpSync(join('optional/quality', name), join(target, name))
      }
    }
    const command = readme.split('## 测试')[1].match(/```bash\n([^\n]+)\n```/)[1]
    const [interpreter, ...args] = command.match(/'[^']*'|\S+/g).map(word => word.replace(/^'|'$/g, ''))
    assert.equal(interpreter, 'python3')
    const python = pythonCommand()
    const config = join(root, 'empty-gitconfig')
    writeFileSync(config, '')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    const result = spawnSync(python.command, [...python.args, ...args], {
      // 复制后重跑整个质量测试集，预算不是单项检查器的性能门槛。
      cwd: root, encoding: 'utf8', timeout: 300000,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    })
    assertPythonSuiteComplete(result)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// 接入方启用质量扩展后可以对整个项目运行注释审核，模板和随附脚本自己的注释不应出现在报告里。
test('the template and optional scripts pass the comment review they ship with', async () => {
  const { pythonCommand } = await import('../template/.opencode/plugins/workflow/platform.ts')
  const temp = mkdtempSync(join(tmpdir(), 'workflow-comments-'))
  const root = join(temp, 'repo')
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    for (const [from, to] of [['optional/quality', 'scripts/quality'], ['optional/ci', 'scripts/ci']]) {
      for (const name of readdirSync(from).filter(name => name.endsWith('.py'))) cpSync(join(from, name), join(root, to, name))
    }
    const config = join(temp, 'empty-gitconfig')
    writeFileSync(config, '')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    execFileSync('git', ['init', '-q'], { cwd: root, env })
    const python = pythonCommand()
    const result = spawnSync(python.command, [...python.args, 'scripts/quality/review-comments.py', '--all'], { cwd: root, env, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}${result.error ? '\n' + result.error.message : ''}`)
    assert.ok(Number(result.stdout.match(/注释审核：检查了 (\d+) 个文件，0 处需复核/)?.[1]) > 0, result.stdout)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('quality documentation describes snapshot and format boundaries', () => {
  const readme = readFileSync('optional/quality/README.md', 'utf8')
  for (const text of ['注释审核', '跳过测试检查', '链接检查', '格式检查', '--all --fix', '--staged', '--range', '--hook', '工作区', '快照', '.cmd', '.bat', '只读', '手动', '不会自动暂存', 'ignoreTargets']) {
    assert.ok(readme.includes(text), text)
  }
  assert.doesNotMatch(readme, /不做格式、链接检查|两个脚本的模式一致/)
})

test('format examples load and gofmt wrapper maps results to exits', async () => {
  const { pythonCommand } = await import('../template/.opencode/plugins/workflow/platform.ts')
  const python = pythonCommand()
  const readme = readFileSync('optional/quality/README.md', 'utf8')
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1])).filter(x => x.formats)
  assert.equal(examples.length, 6)
  const source = 'import json,sys; from quality_testing import config_from; '
    + 'print(json.dumps([entry for data in json.load(sys.stdin) for entry in config_from(data)["formats"]]))'
  const entries = JSON.parse(execFileSync(python.command, [...python.args, '-c', source], {
    cwd: 'optional/quality', input: JSON.stringify(examples), encoding: 'utf8',
  }))
  assert.deepEqual(entries.map(x => x.id).sort(), ['black', 'cargo', 'gofmt', 'prettier', 'ruff', 'spotless'])
  assert.equal(entries.find(x => x.id === 'spotless').hook, false)
  assert.deepEqual(entries.find(x => x.id === 'cargo').check, ['cargo', 'fmt', '--check'])
  assert.deepEqual(entries.find(x => x.id === 'prettier').check.slice(0, 3), ['node', 'node_modules/prettier/bin/prettier.cjs', '--check'])
  const wrapper = readme.match(/<!-- gofmt-wrapper -->\s*```python\n([\s\S]*?)\n```/)?.[1]
  assert.ok(wrapper, 'scripts/check-gofmt.py code block')
  for (const [code, stdout, stderr, expectedExit] of [[0, '', '', 0], [0, 'a.go\n', '', 1], [2, '', 'error\n', 2]]) {
    const runner = `import subprocess,sys\nfrom unittest.mock import patch\nsource=${JSON.stringify(wrapper)}\n`
      + `result=subprocess.CompletedProcess(['gofmt'],${code},${JSON.stringify(stdout)}.encode(),${JSON.stringify(stderr)}.encode())\n`
      + `with patch('subprocess.run', return_value=result) as run:\n try:\n  exec(compile(source,'scripts/check-gofmt.py','exec'))\n finally:\n  assert run.call_args.args[0] == ['gofmt','-l','a.go']\n  assert run.call_args.kwargs == {'capture_output': True}\n`
    const r = spawnSync(python.command, [...python.args, '-c', runner, 'a.go'], { encoding: 'utf8' })
    assert.equal(r.status, expectedExit, r.stderr)
    assert.equal(r.stdout, stdout)
    assert.equal(r.stderr, stderr)
  }
})
