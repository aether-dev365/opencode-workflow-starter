import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdir, rm, link, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fixture, before, context, load } from './fixture.ts'

const staleMapping = async (root: string) => {
  const path = join(root, '.opencode/workflow/scopes.json')
  const existing = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify([...existing, { paths: ['api/**'], instruction: 'api/AGENTS.md' }]))
}

test('invalid configuration keeps the plugin loaded and denies writes with a repair hint', async () => {
  const f = await fixture()
  try {
    await staleMapping(f.root)
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：.*api\/AGENTS\.md/s)
    await f.fire('tool.execute.before', before('read', { path: 'src/file.ts' }))
    await f.fire('tool.execute.before', before('write', { path: 'api/AGENTS.md' }))
    await f.fire('tool.execute.before', before('write', { path: '.opencode/workflow/scopes.json' }))
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => part.text.startsWith('工作流配置无效：')))
    assert.ok(model.system.some(part => part.text.includes('src/AGENTS.md')))
    await mkdir(join(f.root, 'api'))
    await writeFile(join(f.root, 'api/AGENTS.md'), 'API rules for the fixture.\n')
    await f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }))
  } finally { await f.close() }
})

test('a location outside git and an invalid release file do not prevent loading', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, '.opencode/workflow/release.json'), JSON.stringify({ version: 1, enabled: true }))
    await (await load())(f.ctx)
    const release = f.tools.get('workflow_release')
    assert.ok(release)
    await assert.rejects(release.execute({ entry: 'demo' }, { sessionID: 's1', agent: 'build', messageID: 'm', id: 'c' }), /发布配置无效/)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：发布配置无效/)
  } finally { await f.close() }
  const g = await fixture()
  try {
    await rm(join(g.root, '.git'), { recursive: true, force: true })
    await (await load())(g.ctx)
    await assert.rejects(g.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效：未找到 Git 检出根/)
  } finally { await g.close() }
})

test('保护配置可读但正常与修复模式均不得编辑、删除或重命名', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await f.fire('tool.execute.before', before('write', { path: 'safe.txt' })).catch(() => {})
    await f.fire('session.context', context())
    for (const repair of [false, true]) {
      if (repair) await staleMapping(f.root)
      const permission = { action: 'read', resources: ['.opencode/workflow/protection.json'], effect: 'allow', sessionID: 's1' }
      await f.fire('permission.evaluate', permission)
      assert.equal(permission.effect, 'allow')
      for (const [tool, input] of [
        ['write', { path: '.opencode/workflow/protection.json' }],
        ['edit', { file_path: '.opencode/workflow/protection.json', old_string: 'secrets', new_string: 'open' }],
        ['patch', { patchText: '*** Begin Patch\n*** Delete File: .opencode/workflow/protection.json\n*** End Patch' }],
        ['patch', { patchText: '*** Begin Patch\n*** Update File: safe.txt\n*** Move to: .opencode/workflow/protection.json\n@@\n-x\n+y\n*** End Patch' }],
      ] as const) await assert.rejects(f.fire('tool.execute.before', before(tool, input)), /^Error: 保护配置.*OpenCode 之外/)
    }
    await writeFile(join(f.root, '.opencode/workflow/protection.json'), '{')
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: '.opencode/workflow/protection.json' })), /保护配置.*OpenCode 之外/)
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => /protection\.json.*OpenCode 之外/.test(part.text)))
  } finally { await f.close() }
})

test('保护配置的硬链接同样只读', async () => {
  const f = await fixture()
  try {
    await link(join(f.root, '.opencode/workflow/protection.json'), join(f.root, 'policy-alias.json'))
    await (await load())(f.ctx)
    await f.fire('tool.execute.before', before('read', { path: 'policy-alias.json' }))
    await f.fire('session.context', context())
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'policy-alias.json' })), /^Error: 保护配置.*OpenCode 之外/)
  } finally { await f.close() }
})

test('文档中由模型运行的 doctor 命令不触及保护配置', async () => {
  // 修改类命令的参数解析到项目根时按保护配置拒绝（如 rm -rf .）；doctor 默认检查当前目录，文档不写 --root .。
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    // 首次修改该领域先注入规则，再重试。
    await assert.rejects(f.fire('tool.execute.before', before('shell', { command: 'node scripts/workflow/doctor.mjs', workdir: f.root })), /上下文/)
    await f.fire('session.context', context())
    for (const command of ['node scripts/workflow/doctor.mjs', 'node scripts/workflow/doctor.mjs --json']) {
      await f.fire('tool.execute.before', before('shell', { command, workdir: f.root }))
    }
    await assert.rejects(f.fire('tool.execute.before', before('shell', { command: 'node scripts/workflow/doctor.mjs --root .', workdir: f.root })), /^Error: 保护配置.*OpenCode 之外/)
  } finally { await f.close() }
})

test('cd 失败以及管道、后台中的 cd 不改变后续命令的目录', async () => {
  // cd 失败时 `;`、`||` 之后的命令仍在原目录执行；管道各段和 & 后台命令在子 shell 中执行。
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const allowed = before('shell', { command: 'cd src && echo x > a.ts', workdir: f.root })
    await assert.rejects(f.fire('tool.execute.before', allowed), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', allowed)
    for (const command of ['cd missing; echo x > .opencode/workflow/protection.json', 'cd missing || echo x > .opencode/workflow/protection.json',
      'cd src | echo x > .opencode/workflow/protection.json', 'cd src & echo x > .opencode/workflow/protection.json',
      '! cd src; echo x > ../.opencode/workflow/protection.json']) {
      await assert.rejects(f.fire('tool.execute.before', before('shell', { command, workdir: f.root })), /保护配置/, command)
    }
  } finally { await f.close() }
})

test('grep 的 path、shell 的 workdir 和原生工具路径按 OpenCode 的方式解析', async () => {
  // OpenCode 把恰为 `~` 或以 `~/` 开头的路径换成主目录（OPENCODE_TEST_HOME，否则系统主目录），再按字面合并 `..`。
  const f = await fixture()
  const previous = process.env.OPENCODE_TEST_HOME
  try {
    process.env.OPENCODE_TEST_HOME = f.root
    await writeFile(join(f.root, 'src/.env'), 'SYNTHETIC=value\n')
    await (await load())(f.ctx)
    for (const path of ['src/missing/..', 'missing/../src', '~/src', '~']) {
      await assert.rejects(f.fire('tool.execute.before', before('grep', { pattern: '.', path })), /文件保护/, path)
    }
    const allowed = before('shell', { command: 'echo x > notes.txt', workdir: '~' })
    await assert.rejects(f.fire('tool.execute.before', allowed), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', allowed)
    await assert.rejects(f.fire('tool.execute.before', before('shell', { command: 'echo x > .opencode/workflow/protection.json', workdir: '~' })), /保护配置/)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: '~/.opencode/workflow/protection.json' })), /保护配置/)
    await assert.rejects(f.fire('shell.create.before', { command: 'cat .env', cwd: '~/src', timeout: 0, shell: '/bin/bash', env: {} }), /文件保护检查拒绝/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = previous
    await f.close()
  }
})

test('符号链接之后的 .. 按内核的方式解析', async t => {
  // 内核先跟随 L 再回到上一级：L/../protection.json 指向保护配置，字面合并却得到项目根下的 protection.json。
  const f = await fixture()
  try {
    await mkdir(join(f.root, '.opencode/workflow/sub'))
    try { await symlink(join(f.root, '.opencode/workflow/sub'), join(f.root, 'L'), 'dir') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('需要创建符号链接的权限'); throw error }
    await (await load())(f.ctx)
    const allowed = before('shell', { command: 'echo x > notes.txt', workdir: f.root })
    await assert.rejects(f.fire('tool.execute.before', allowed), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', allowed)
    await assert.rejects(f.fire('tool.execute.before', before('shell', { command: 'echo x > L/../protection.json', workdir: f.root })), /保护配置/)
  } finally { await f.close() }
})

test('git clean 的路径按 git 的 pathspec 规则检查', async () => {
  // git 按字面合并 ..，并支持 :/、:(top) 等写法；不带 -x 时同样删除未被忽略的未跟踪文件。
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'src/.env'), 'SYNTHETIC=value\n')
    await mkdir(join(f.root, 'build'))
    await (await load())(f.ctx)
    const allowed = before('shell', { command: 'git clean -fdx build', workdir: f.root })
    await assert.rejects(f.fire('tool.execute.before', allowed), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', allowed)
    for (const command of ['git clean -fdx src/missing/..', 'git clean -fdx :/', "git clean -fdx ':(top)src'", 'git clean -fdx -e foo', 'git clean -fd src']) {
      await assert.rejects(f.fire('tool.execute.before', before('shell', { command, workdir: f.root })), /文件保护检查拒绝/, command)
    }
  } finally { await f.close() }
})

test('长提交说明和内联脚本的参数不被当作已有路径', async () => {
  // 名字超过文件系统上限的参数不可能是已有文件；整条路径超过系统上限时无法检查而拒绝，原因不整段回显参数。
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'notes.txt' })), /上下文/)
    await f.fire('session.context', context())
    for (const command of [`git commit -m title -m ${'x'.repeat(300)}`, `git commit -m title -m ${'提交说明'.repeat(25)}`, `python3 -c "print('${'x'.repeat(300)}')"`]) {
      await f.fire('tool.execute.before', before('shell', { command, workdir: f.root }))
    }
    const deep = Array(30).fill('a'.repeat(200)).join('/')
    const call = f.fire('tool.execute.before', before('shell', { command: `git commit -m title -m ${deep}`, workdir: f.root }))
    // Windows 对不存在的超长路径报 ENOENT，按不存在放行。
    if (process.platform === 'win32') await call
    else await assert.rejects(call, (error: Error) => /超过系统长度上限/.test(error.message) && !error.message.includes(deep) && error.message.length < 400)
  } finally { await f.close() }
})

test('路径查询出错时拒绝原因只显示路径首尾', async () => {
  // 文件名后面再接路径时 stat 报 ENOTDIR，无法确认而拒绝；原因保留错误码，不整段回显参数。Windows 报 ENOENT，按不存在放行。
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const allowed = before('shell', { command: 'echo x > notes.txt', workdir: f.root })
    await assert.rejects(f.fire('tool.execute.before', allowed), /上下文/)
    await f.fire('session.context', context())
    const tail = 'b'.repeat(200)
    const call = f.fire('tool.execute.before', before('shell', { command: `echo x > AGENTS.md/${'a'.repeat(200)}/${tail}`, workdir: f.root }))
    if (process.platform === 'win32') await call
    else await assert.rejects(call, (error: Error) => /ENOTDIR/.test(error.message) && !error.message.includes(tail) && error.message.length < 400)
  } finally { await f.close() }
})

test('unseen scopes deny once then inject; compaction and child sessions reset visibility', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(p => p.text.includes('src/AGENTS.md')))
    await f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }))
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' }, 'child')), /上下文/)
    await f.fire('session.compaction', { sessionID: 's1' })
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
  } finally { await f.close() }
})

test('native read permission and multi-file patch reject protected paths', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const permission = { action: 'read', resources: ['.env'], effect: 'allow', sessionID: 's1' }
    await f.fire('permission.evaluate', permission)
    assert.equal(permission.effect, 'deny')
    await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText: '*** Begin Patch\n*** Add File: safe\n+x\n*** Add File: vendor/no\n+x\n*** End Patch' })), /第三方/)
  } finally { await f.close() }
})

test('缩进或 CRLF 补丁头不能绕过执行前保护', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'safe.txt' })), /上下文/)
    await f.fire('session.context', context())
    for (const tail of ['  *** Add File: vendor/new.txt\n+x', '\t*** Update File: vendor/a\n@@\n-x\n+y',
      '*** Delete File: vendor/a\r', '*** Update File: a\n*** Move to: vendor/a\r\n@@\n-x\n+y']) {
      const patchText = `*** Begin Patch\n*** Add File: safe.txt\n+x\n${tail}\n*** End Patch`
      await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText })), /第三方/)
    }
  } finally { await f.close() }
})

test('缩进补丁目标仍加载实际领域规则', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const patchText = '*** Begin Patch\n*** Add File: safe.txt\n+x\n  *** Update File: src/file.ts\n@@\n-x\n+y\n*** End Patch'
    await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText })), /上下文/)
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => part.text.includes('src/AGENTS.md')))
    await f.fire('tool.execute.before', before('patch', { patchText }))
  } finally { await f.close() }
})

test('缩进补丁目标不能混入配置修复白名单', async () => {
  const f = await fixture()
  try {
    await staleMapping(f.root)
    await (await load())(f.ctx)
    const patchText = '*** Begin Patch\n*** Add File: .opencode/workflow/repair-marker\n+x\n  *** Update File: src/file.ts\n@@\n-x\n+y\n*** End Patch'
    await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText })), /工作流配置无效/)
  } finally { await f.close() }
})

test('补丁路径内部分隔字符不能让保护目标从执行前检查中消失', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'safe.txt' })), /上下文/)
    await f.fire('session.context', context())
    for (const separator of ['\r', '\u2028', '\u2029']) {
      const patchText = `*** Begin Patch\n*** Add File: safe.txt\n+x\n*** Add File: vendor/x${separator}y.txt\n+x\n*** End Patch`
      await assert.rejects(f.fire('tool.execute.before', before('patch', { patchText })), /第三方/)
    }
  } finally { await f.close() }
})

test('native grep checks the actual search path for build and reviewer', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, '.env'), 'SYNTHETIC=value\n')
    await writeFile(join(f.root, 'src/public.txt'), 'public\n')
    await (await load())(f.ctx)
    for (const agent of ['build', 'reviewer']) {
      for (const path of ['.env', '.', undefined]) {
        await assert.rejects(f.fire('tool.execute.before', { ...before('grep', { pattern: '.', ...(path ? { path } : {}) }), agent }), /文件保护/)
      }
      const call = { ...before('grep', { pattern: '.env', path: 'src' }), agent }
      await f.fire('tool.execute.before', call)
      const permission = { action: 'grep', resources: ['.env'], effect: 'allow', sessionID: call.sessionID, agent,
        source: { type: 'tool', id: call.id, messageID: call.messageID } }
      await f.fire('permission.evaluate', permission)
      assert.equal(permission.effect, 'allow')
      await writeFile(join(f.root, 'src/.env'), 'SYNTHETIC=value\n')
      await f.fire('permission.evaluate', permission)
      assert.equal(permission.effect, 'deny')
      await rm(join(f.root, 'src/.env'))
    }
    const unverified = { action: 'grep', resources: ['.'], effect: 'allow', sessionID: 's1' }
    await f.fire('permission.evaluate', unverified)
    assert.equal(unverified.effect, 'deny')
  } finally { await f.close() }
})

test('native grep refuses a search when the path guard cannot run', async () => {
  const f = await fixture()
  const previous = process.env.WORKFLOW_PYTHON
  try {
    await (await load())(f.ctx)
    process.env.WORKFLOW_PYTHON = join(f.root, 'missing-python')
    await assert.rejects(f.fire('tool.execute.before', before('grep', { pattern: '.', path: 'src' })), /WORKFLOW_PYTHON/)
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PYTHON
    else process.env.WORKFLOW_PYTHON = previous
    await f.close()
  }
})

test('moving a session clears rules from the previous checkout', async () => {
  const f = await fixture()
  const next = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })))
    await f.fire('session.context', context())
    f.move(next.root)
    const model = context()
    await f.fire('session.context', model)
    assert.equal(model.system.length, 0)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
  } finally { await f.close(); await next.close() }
})

test('a permission check that cannot run states the cause', async () => {
  const f = await fixture()
  const previous = process.env.WORKFLOW_PYTHON
  process.env.WORKFLOW_PYTHON = join(f.root, 'missing-python')
  try {
    await (await load())(f.ctx)
    const permission = { action: 'read', resources: ['README.md'], effect: 'allow', sessionID: 's1', message: '' }
    await f.fire('permission.evaluate', permission)
    assert.equal(permission.effect, 'deny')
    assert.match(permission.message, /WORKFLOW_PYTHON/)
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PYTHON
    else process.env.WORKFLOW_PYTHON = previous
    await f.close()
  }
})

test('shell creation resolves a relative cwd against the location', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    // OpenCode 在 create.before 之后才把工具的相对 workdir 解析为绝对路径。
    await f.fire('shell.create.before', { command: 'ls', cwd: 'src', timeout: 0, shell: '/bin/bash', env: {} })
    await assert.rejects(f.fire('shell.create.before', { command: 'cat .env', cwd: 'src', timeout: 0, shell: '/bin/bash', env: {} }), /文件保护检查拒绝/)
  } finally { await f.close() }
})

test('PowerShell and cmd shells are refused with guidance', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe']) {
      await assert.rejects(f.fire('shell.create.before', { command: 'ls', cwd: f.root, timeout: 0, shell, env: {} }), /"shell": "bash"/)
    }
  } finally { await f.close() }
})

test('an oversized rule warns instead of breaking context assembly', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /上下文/)
    await writeFile(join(f.root, 'src/AGENTS.md'), 'x'.repeat(40_001))
    const model = context()
    await f.fire('session.context', model)
    assert.ok(model.system.some(part => part.text.includes('src/AGENTS.md') && part.text.includes('40000')))
    assert.ok(!model.system.some(part => part.text.includes('x'.repeat(100))))
    await assert.rejects(f.fire('tool.execute.before', before('write', { path: 'src/file.ts' })), /工作流配置无效/)
    await f.fire('tool.execute.before', before('write', { path: 'src/AGENTS.md' }))
  } finally { await f.close() }
})

test('a shell command approved by the tool hook is not checked twice', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const shell = (command: string) => ({ command, cwd: f.root, timeout: 0, shell: '/bin/bash', env: {} })
    await f.fire('tool.execute.before', before('shell', { command: 'cat README.md', workdir: f.root }))
    // 保护配置损坏后，任何重新执行的守卫都会拒绝；能放行说明这次没有重复检查。
    await writeFile(join(f.root, '.opencode/workflow/protection.json'), '{')
    await f.fire('shell.create.before', shell('cat README.md'))
    await assert.rejects(f.fire('shell.create.before', shell('cat README.md')), /文件保护检查拒绝/)
    await assert.rejects(f.fire('shell.create.before', shell('ls')), /文件保护检查拒绝/)
  } finally { await f.close() }
})

test('工具审批缓存不能放行未知或缺失的宿主 shell', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const command = 'cat README.md'
    await f.fire('tool.execute.before', before('shell', { command, workdir: f.root }))
    await writeFile(join(f.root, '.opencode/workflow/protection.json'), '{')
    for (const shell of ['/usr/bin/fish', '/usr/bin/nu', '/bin/zsh', '/bin/sh', '', undefined]) {
      await assert.rejects(f.fire('shell.create.before', { command, cwd: f.root, timeout: 0, shell, env: {} }), /"shell": "bash"/)
    }
    await f.fire('shell.create.before', { command, cwd: f.root, timeout: 0, shell: '/bin/bash', env: {} })
  } finally { await f.close() }
})

test('a commit approved by the tool hook is scanned again when the shell starts', async () => {
  // 工具钩子扫描通过后，并行会话又暂存了新内容：shell 创建时必须按当时的暂存区重新扫描。
  const f = await fixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  try {
    await (await load())(f.ctx)
    await writeFile(join(f.root, 'safe.txt'), 'safe\n')
    git('add', 'safe.txt')
    await f.fire('tool.execute.before', before('shell', { command: 'git commit -m safe', workdir: f.root }))
    await writeFile(join(f.root, 'leak.txt'), `access_token = "${'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}"\n`)
    git('add', 'leak.txt')
    await assert.rejects(f.fire('shell.create.before', { command: 'git commit -m safe', cwd: f.root, timeout: 0, shell: '/bin/bash', env: {} }), /凭据/)
  } finally { await f.close() }
})

test('a recursive delete approved by the tool hook is checked again when the shell starts', async () => {
  // 递归删除的结论取决于目标目录里有没有凭据文件；工具钩子之后新出现的凭据文件也要拦住。
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    await mkdir(join(f.root, 'build'))
    await writeFile(join(f.root, 'build/out.js'), 'x\n')
    const remove = before('shell', { command: 'rm -rf build', workdir: f.root })
    // 首次修改该领域先注入规则，再重试；重试通过即得到工具钩子的放行。
    await assert.rejects(f.fire('tool.execute.before', remove), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', before('shell', { command: 'rm -rf build', workdir: f.root }))
    await writeFile(join(f.root, 'build/.env'), 'TOKEN=synthetic\n')
    await assert.rejects(f.fire('shell.create.before', { command: 'rm -rf build', cwd: f.root, timeout: 0, shell: '/bin/bash', env: {} }), /文件保护检查拒绝/)
  } finally { await f.close() }
})

test('shell redirects that write files load domain rules and stop on an invalid configuration', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const write = () => before('shell', { command: 'echo hi > src/file.ts', workdir: f.root })
    await assert.rejects(f.fire('tool.execute.before', write()), /上下文/)
    await f.fire('session.context', context())
    await f.fire('tool.execute.before', write())
    await staleMapping(f.root)
    await assert.rejects(f.fire('tool.execute.before', write()), /工作流配置无效/)
  } finally { await f.close() }
})

test('reviewer sessions may only read and submit verdicts', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    for (const action of ['edit', 'shell', 'subagent', 'workflow_review', 'workflow_release', 'svc_query']) {
      const permission = { action, resources: ['*'], effect: 'allow', sessionID: 'r1', agent: 'reviewer', message: '' }
      await f.fire('permission.evaluate', permission)
      assert.equal(permission.effect, 'deny', action)
      assert.match(permission.message, /审核员只读/, action)
    }
    for (const action of ['read', 'glob', 'workflow_review_submit']) {
      const permission = { action, resources: ['README.md'], effect: 'allow', sessionID: 'r1', agent: 'reviewer' }
      await f.fire('permission.evaluate', permission)
      assert.equal(permission.effect, 'allow', action)
    }
    const secret = { action: 'read', resources: ['.env'], effect: 'allow', sessionID: 'r1', agent: 'reviewer' }
    await f.fire('permission.evaluate', secret)
    assert.equal(secret.effect, 'deny')
    const build = { action: 'edit', resources: ['src/file.ts'], effect: 'allow', sessionID: 's1', agent: 'build' }
    await f.fire('permission.evaluate', build)
    assert.equal(build.effect, 'allow')
  } finally { await f.close() }
})

test('the session agent decides reviewer restrictions when the event omits it', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    f.childSessions.set('r2', { id: 'r2', agent: 'reviewer', location: { directory: f.root } })
    const edit = { action: 'edit', resources: ['src/file.ts'], effect: 'allow', sessionID: 'r2', message: '' }
    await f.fire('permission.evaluate', edit)
    assert.equal(edit.effect, 'deny')
    assert.match(edit.message, /审核员只读/)
    ;(f.ctx as any).session.get = async () => { throw new Error('session gone') }
    const unknown = { action: 'glob', resources: ['*'], effect: 'allow', sessionID: 'gone', message: '' }
    await f.fire('permission.evaluate', unknown)
    assert.equal(unknown.effect, 'deny')
    assert.match(unknown.message, /无法确认会话代理/)
  } finally { await f.close() }
})

test('an event without an agent that resolves to build keeps path checks with one session lookup', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    const get = (f.ctx as any).session.get
    let lookups = 0
    ;(f.ctx as any).session.get = async (input: { sessionID: string }) => { lookups++; return get(input) }
    const edit = { action: 'edit', resources: ['src/file.ts'], effect: 'allow', sessionID: 's1', message: '' }
    await f.fire('permission.evaluate', edit)
    assert.equal(edit.effect, 'allow')
    assert.equal(lookups, 1)
    const secret = { action: 'read', resources: ['.env'], effect: 'allow', sessionID: 's1', message: '' }
    await f.fire('permission.evaluate', secret)
    assert.equal(secret.effect, 'deny')
    assert.doesNotMatch(secret.message, /审核员只读/)
    const shell = { action: 'shell', resources: ['ls'], effect: 'allow', sessionID: 's1', message: '' }
    await f.fire('permission.evaluate', shell)
    assert.equal(shell.effect, 'allow')
  } finally { await f.close() }
})

test('reviewer tool calls outside the read-only set are refused before they run', async () => {
  const f = await fixture()
  try {
    await (await load())(f.ctx)
    // OpenCode 只在工具自己请求权限时才做判定：没有命令的 shell 语句和插件工具都不会经过 permission.evaluate。
    const asReviewer = (tool: string, input: unknown) => ({ ...before(tool, input, 'r1'), agent: 'reviewer' })
    const calls: [string, unknown][] = [
      ['shell', { command: '> reviewer-redirect.txt' }],
      ['workflow_review', { action: 'status' }],
      ['svc_query', {}],
      ['patch', { patchText: '*** Begin Patch\n*** Add File: probe.txt\n+x\n*** End Patch' }],
    ]
    for (const [tool, input] of calls) await assert.rejects(f.fire('tool.execute.before', asReviewer(tool, input)), /审核员只读/, tool)
    await f.fire('tool.execute.before', asReviewer('read', { path: 'README.md' }))
    await f.fire('tool.execute.before', before('workflow_review', { action: 'status' }))
  } finally { await f.close() }
})
