import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseline = JSON.parse(readFileSync('template/.opencode/plugins/workflow/package.json', 'utf8')).dependencies['@opencode/plugin']

test('doctor reports missing configuration as structured failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, false)
    assert.ok(report.checks.some(c => c.id === 'config' && c.status === 'fail'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports missing plugin dependencies instead of crashing', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const result = spawnSync(process.execPath, [join(root, 'scripts/workflow/doctor.mjs'), '--root', root, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    const checks = Object.fromEntries(JSON.parse(result.stdout).checks.map(c => [c.id, c]))
    assert.equal(checks.dependencies.status, 'fail')
    assert.match(checks.dependencies.message, /npm --prefix \.opencode\/plugins\/workflow ci --ignore-scripts/)
    assert.equal(checks.config.status, 'fail')
    assert.match(checks.config.message, /依赖/)
    assert.equal(checks['native-runtime'].status, 'unverified')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor detects active placeholders without rewriting commented config or uncommitted work', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc')
    const original = '// retain this comment\n' + readFileSync(config, 'utf8').replace('"worktree":', '"model": "REPLACE_ME_MODEL", "worktree":')
    writeFileSync(config, original)
    writeFileSync(join(root, 'uncommitted.txt'), 'user work\n')
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    const report = JSON.parse(result.stdout)
    assert.equal(report.checks.find(c => c.id === 'placeholders')?.status, 'fail')
    assert.equal(readFileSync(config, 'utf8'), original)
    assert.equal(readFileSync(join(root, 'uncommitted.txt'), 'utf8'), 'user work\n')
    assert.equal(report.checks.find(c => c.id === 'native-runtime')?.status, 'unverified')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor flags shell settings the guards cannot parse', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc')
    const original = readFileSync(config, 'utf8')
    const shell = () => JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout).checks.find(c => c.id === 'shell')
    assert.equal(shell()?.status, 'pass')
    writeFileSync(config, original.replace(/\n\s*"shell": "bash",/, ''))
    assert.equal(shell()?.status, 'warn')
    writeFileSync(config, original.replace('"shell": "bash"', '"shell": "pwsh"'))
    assert.equal(shell()?.status, 'fail')
    for (const name of ['fish', 'nu', 'zsh', 'sh', 'unknown-shell', '']) {
      writeFileSync(config, original.replace('"shell": "bash"', `"shell": "${name}"`))
      assert.equal(shell()?.status, 'fail', name)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor prints the native permission block for protection.json', () => {
  const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', 'template', '--print-permissions'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const block = JSON.parse(result.stdout)
  assert.deepEqual(block[0], { action: 'read', resource: '*.env', effect: 'deny' })
  const native = JSON.parse(readFileSync('template/opencode.jsonc', 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n'))
  assert.deepEqual(native.permissions.slice(-block.length), block)
})

test('doctor warns about tracked files hidden by credential rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/app.env.ts'), 'export const mode = "dev"\n')
    spawnSync('git', ['-C', root, 'add', 'src/app.env.ts'])
    const report = JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout)
    const check = report.checks.find(c => c.id === 'tracked-protected')
    assert.equal(check?.status, 'warn')
    assert.match(check.message, /src\/app\.env\.ts/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor gives actionable OpenCode installation guidance for unavailable or non-V2 executables', async t => {
  for (const [name, script, reason] of [
    ['missing executable', null, /未找到/],
    ['V1 executable', 'echo "opencode v1.18.31"', /需要 OpenCode V2.*1\.18\.31/],
    ['failed version command', 'exit 7', /无法执行.*--version/],
    ['unrecognized version', 'echo "unknown-version"', /无法识别.*unknown-version/],
  ]) {
    await t.test(name, () => {
      const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
      try {
        const binary = join(root, 'opencode-test')
        if (script) writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'],
          { env: { ...process.env, WORKFLOW_OPENCODE_BIN: binary }, encoding: 'utf8' })
        assert.equal(result.status, 1)
        const check = JSON.parse(result.stdout).checks.find(c => c.id === 'opencode-version')
        assert.equal(check.status, 'fail')
        assert.match(check.message, reason)
        assert.ok(check.message.includes(`npm install -g @opencode/cli@${baseline}`), check.message)
        assert.match(check.message, /https:\/\/opencode\.ai\/v2\/docs\//)
        assert.match(check.message, /docs\/workflow\/opencode-install\.md/)
        assert.match(check.message, /WORKFLOW_OPENCODE_BIN/)
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
})

test('policy CLI returns denied paths and rejects invalid requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-policy-'))
  try {
    mkdirSync(join(root, '.opencode/workflow'), { recursive: true })
    cpSync('template/.opencode/workflow/checks/fixtures/protection.json', join(root, '.opencode/workflow/protection.json'))
    const run = input => spawnSync('python3', ['template/.opencode/workflow/checks/policy.py'], { input: JSON.stringify(input), encoding: 'utf8' })
    const result = run({ root, action: 'read', paths: ['src/app.env.ts', 'README.md', '.env.example'] })
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout), { denied: ['src/app.env.ts'] })
    for (const input of [{ root: 'relative', action: 'read', paths: [] }, { root, action: 'shell', paths: [] }, { root, action: 'read', paths: [42] }]) {
      const invalid = run(input)
      assert.equal(invalid.status, 2)
      assert.ok(JSON.parse(invalid.stdout).error)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor asks for an explicit reviewer model', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc'), agent = join(root, '.opencode/agents/reviewer.md')
    const [originalConfig, originalAgent] = [readFileSync(config, 'utf8'), readFileSync(agent, 'utf8')]
    const reviewer = () => JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout).checks.find(c => c.id === 'reviewer-model')
    const inherited = reviewer()
    assert.equal(inherited?.status, 'warn')
    assert.match(inherited.message, /agents\.reviewer\.model/)
    for (const model of ['"openai/gpt-fixture"', '{ "providerID": "openai", "model": "gpt-fixture" }']) {
      writeFileSync(config, originalConfig.replace('"worktree":', `"agents": { "reviewer": { "model": ${model} } }, "worktree":`))
      assert.equal(reviewer()?.status, 'pass', model)
    }
    writeFileSync(config, originalConfig)
    const yaml = originalAgent.replace('mode: subagent', 'mode: subagent\nmodel: openai/gpt-fixture')
    const json = '---\n{\n  "description": "只读审核员",\n  "mode": "subagent",\n  "model": "openai/gpt-fixture"\n}\n---\n只读审核。\n'
    // OpenCode 解析 frontmatter 时去掉 BOM，分隔行带尾随空白也照常识别。
    const lenient = ['\uFEFF' + yaml, yaml.replace(/^---\n/, '---  \n').replace(/\n---\n/, '\n--- \t\n')]
    for (const text of [yaml, yaml.replaceAll('\n', '\r\n'), json, ...lenient]) {
      writeFileSync(agent, text)
      assert.equal(reviewer()?.status, 'pass', JSON.stringify(text.slice(0, 60)))
    }
    // 正文里出现 model: 不算指定模型。
    writeFileSync(agent, originalAgent + '\nmodel: openai/gpt-fixture\n')
    assert.equal(reviewer()?.status, 'warn')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor distinguishes chosen inheritance from missing or conflicting reviewer settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-onboarding-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc'), original = readFileSync(config, 'utf8')
    const choices = { version: 1, mode: 'basic', superpowers: 'none', models: { implementer: { mode: 'inherit' }, reviewer: { mode: 'inherit' } }, components: { quality: 'off', ci: false, release: false, mcp: false } }
    writeFileSync(join(root, '.opencode/workflow/onboarding.json'), JSON.stringify(choices))
    const report = () => JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout)
    const inherited = report().checks.find(c => c.id === 'reviewer-model')
    assert.equal(inherited.status, 'pass')
    assert.match(inherited.message, /明确选择.*继承/)
    writeFileSync(config, original.replace('"worktree":', '"agents": { "reviewer": { "model": "openai/gpt-fixture" } }, "worktree":'))
    const conflict = report().checks.find(c => c.id === 'reviewer-model')
    assert.equal(conflict.status, 'warn')
    assert.match(conflict.message, /继承.*冲突|冲突.*继承/)
    writeFileSync(config, original)
    writeFileSync(join(root, '.opencode/workflow/onboarding.json'), JSON.stringify({ ...choices, mode: 'full', superpowers: 'existing' }))
    const runtime = report().checks.find(c => c.id === 'onboarding')
    assert.equal(runtime.status, 'unverified')
    assert.match(runtime.message, /workflow_setup/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor rejects a dangling onboarding profile instead of reporting it as absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-onboarding-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    symlinkSync('missing-profile.json', join(root, '.opencode/workflow/onboarding.json'))
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    const check = JSON.parse(result.stdout).checks.find(c => c.id === 'onboarding')
    assert.equal(check?.status, 'fail')
    assert.match(check.message, /符号链接/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor rejects an invalid saved onboarding choice instead of suppressing model warnings', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-onboarding-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    writeFileSync(join(root, '.opencode/workflow/onboarding.json'), '{"version":1,"models":{"reviewer":{"mode":"inherit"}}}')
    const result = spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' })
    const check = JSON.parse(result.stdout).checks.find(c => c.id === 'onboarding')
    assert.equal(check?.status, 'fail')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor warns about rule files over half the injection limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const ruleSize = () => JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout).checks.find(c => c.id === 'rule-size')
    assert.equal(ruleSize()?.status, 'pass')
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(20000))
    assert.equal(ruleSize()?.status, 'pass')
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(20001))
    writeFileSync(join(root, '.opencode/workflow/scopes.json'), JSON.stringify([{ paths: ['**'], instruction: 'AGENTS.md' }, { paths: ['docs/**'], instruction: './AGENTS.md' }]))
    const check = ruleSize()
    assert.equal(check?.status, 'warn')
    assert.equal(check.message.match(/AGENTS\.md：20001 个字符/g)?.length, 1)
    assert.match(check.message, /插件上限 40000/)
    // 任何一份规则超限都会让插件拒绝整个检出的修改，不只是该规则所在的领域。
    assert.match(check.message, /本检出的所有修改都会被拒绝/)
    // POSIX 上反斜杠是文件名的一部分，去重不能把它改成目录分隔符。
    if (process.platform !== 'win32') {
      writeFileSync(join(root, 'rules\\big.md'), 'x'.repeat(20001))
      writeFileSync(join(root, '.opencode/workflow/scopes.json'), JSON.stringify([{ paths: ['**'], instruction: 'AGENTS.md' }, { paths: ['docs/**'], instruction: 'rules\\big.md' }]))
      const named = ruleSize()
      assert.equal(named?.status, 'warn', named?.message)
      assert.match(named.message, /rules\\big\.md：20001 个字符/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports the rule size as unverified when the plugin exports no limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    cpSync('template/.opencode/plugins/workflow/node_modules', join(root, '.opencode/plugins/workflow/node_modules'), { recursive: true })
    spawnSync('git', ['init', '-q', root])
    // 早期插件没有导出规则上限：常量只在模块内部使用。
    const plugin = join(root, '.opencode/plugins/workflow')
    const edit = (name, from, to) => writeFileSync(join(plugin, name), readFileSync(join(plugin, name), 'utf8').replace(from, to))
    edit('config.ts', 'export const SCOPE_TEXT_LIMIT', 'const SCOPE_TEXT_LIMIT')
    edit('scopes.ts', "import { containedFile, SCOPE_TEXT_LIMIT } from './config.ts'", "import { containedFile } from './config.ts'\nconst SCOPE_TEXT_LIMIT = 40_000")
    const result = spawnSync(process.execPath, [join(root, 'scripts/workflow/doctor.mjs'), '--root', root, '--json'], { encoding: 'utf8' })
    const check = JSON.parse(result.stdout).checks.find(c => c.id === 'rule-size')
    assert.equal(check?.status, 'unverified', result.stderr)
    assert.match(check.message, /规则上限/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor treats empty reviewer model values as unspecified', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-doctor-'))
  try {
    cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
    spawnSync('git', ['init', '-q', root])
    const config = join(root, 'opencode.jsonc'), agent = join(root, '.opencode/agents/reviewer.md')
    const [originalConfig, originalAgent] = [readFileSync(config, 'utf8'), readFileSync(agent, 'utf8')]
    const reviewer = () => JSON.parse(spawnSync(process.execPath, ['template/scripts/workflow/doctor.mjs', '--root', root, '--json'], { encoding: 'utf8' }).stdout).checks.find(c => c.id === 'reviewer-model')
    const withConfigModel = model => originalConfig.replace('"worktree":', `"agents": { "reviewer": { "model": ${model} } }, "worktree":`)
    for (const model of ['"   "', 'null', '{}', '[]']) {
      writeFileSync(config, withConfigModel(model))
      assert.equal(reviewer()?.status, 'warn', model)
    }
    // OpenCode 会忽略 model 为空的整个代理文件，连同其中的只读权限；opencode.jsonc 已指定模型时也要提示。
    writeFileSync(config, withConfigModel('"openai/gpt-fixture"'))
    for (const value of ['""', "''", '"   "', 'null', '~', '# 待定', '']) {
      writeFileSync(agent, originalAgent.replace('mode: subagent', `model: ${value}\nmode: subagent`))
      const check = reviewer()
      assert.equal(check?.status, 'warn', value)
      assert.match(check.message, /reviewer\.md/, value)
    }
    writeFileSync(agent, '---\n{\n  "mode": "subagent",\n  "model": "  "\n}\n---\n只读审核。\n')
    assert.equal(reviewer()?.status, 'warn')
    // 写在下一行缩进块里的对象形式不是空值。
    writeFileSync(config, originalConfig)
    writeFileSync(agent, originalAgent.replace('mode: subagent', 'mode: subagent\nmodel:\n  providerID: openai\n  model: gpt-fixture'))
    assert.equal(reviewer()?.status, 'pass')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
