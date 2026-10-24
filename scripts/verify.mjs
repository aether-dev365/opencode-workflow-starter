#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, '.verification')
const windows = process.platform === 'win32'
// Windows 子集：原生 OpenCode 夹具和分发测试的替身只支持 POSIX；守卫中依赖 bash 与目录符号链接、质量扩展中需要符号链接的用例会跳过。
const subset = process.argv.includes('--windows')
if (windows && !subset) {
  console.error('完整验收需要 Linux 或 macOS（原生 OpenCode 夹具与依赖 bash 的守卫用例）；Windows 上运行 node scripts/verify.mjs --windows 执行 Windows 子集。')
  process.exit(1)
}
mkdirSync(directory, { recursive: true })
const checks = 'template/.opencode/workflow/checks'
// 直接运行 Python：Windows 上的 bash 可能是 WSL 启动器，不能用来跑 run-tests.sh。解释器选择与插件一致。
const [python, ...pythonArgs] = process.env.WORKFLOW_PYTHON ? [process.env.WORKFLOW_PYTHON] : windows ? ['py', '-3'] : ['python3']
const all = [
  ['typecheck', 'npm', ['--prefix', 'template/.opencode/plugins/workflow', 'run', 'typecheck']],
  ['plugin', 'npm', ['--prefix', 'template/.opencode/plugins/workflow', 'test']],
  ['guards', python, [...pythonArgs, '-m', 'unittest', 'discover', '-s', checks, '-t', checks, '-p', 'test_*.py']],
  ['quality', python, [...pythonArgs, '-m', 'unittest', 'discover', '-v', '-s', 'optional/quality', '-t', 'optional/quality', '-p', 'test_*.py']],
  ['distribution', process.execPath, ['--test', 'tests/doctor.test.mjs', 'tests/distribution.test.mjs', 'tests/verify.test.mjs', 'tests/fetch.test.mjs', 'tests/ci.test.mjs']],
  ['adoption', process.execPath, ['--test', 'tests/adoption.test.mjs', 'tests/setup.test.mjs']],
  ['native', process.execPath, ['--test', 'tests/native.test.mjs']],
]
const stages = subset ? all.filter(([id]) => ['typecheck', 'plugin', 'guards', 'quality', 'adoption'].includes(id)) : all
const mode = subset ? 'windows' : 'full'
// 质量扩展在 Windows 子集中只允许因缺少符号链接权限而跳过：-v 输出的每条跳过原因都要是它，条数与汇总一致。
// 该阶段以 UTF-8 输出；否则非 UTF-8 代码页下中文原因会变成转义序列或乱码。
const symlinkSkipsOnly = output => {
  const reasons = [...output.matchAll(/ \.\.\. skipped '([^'\n]*)'$/gm)].map(match => match[1])
  return reasons.length === Number(output.match(/skipped=(\d+)/)?.[1] ?? 0) && reasons.every(reason => reason === '需要创建符号链接的权限')
}
// 单阶段上限 15 分钟：Windows runner 上进程启动和依赖安装都慢，接入阶段可达 5 分钟。
const report = []
for (const [id, command, args] of stages) {
  console.log(`Running ${id}: ${command} ${args.join(' ')}`)
  // Windows 上 npm 是 .cmd 启动器，只能经 shell 启动；这里的参数都是固定字面量，无需转义。
  const shell = windows && command === 'npm'
  const result = spawnSync(shell ? [command, ...args].join(' ') : command, shell ? [] : args, { cwd: root, env: id === 'quality' ? { ...process.env, PYTHONIOENCODING: 'utf-8' } : process.env, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024, shell })
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? '\n' + result.error.message : '')
  writeFileSync(resolve(directory, id + '.log'), output)
  const empty = id !== 'typecheck' && !/(?:tests\s+[1-9]\d*|Ran [1-9]\d* tests?)/.test(output)
  const skipped = /(?:skipped\s+[1-9]|skipped=[1-9])/.test(output) && !(subset && (id === 'guards' || (id === 'quality' && symlinkSkipsOnly(output))))
  const ok = result.status === 0 && !empty && !skipped
  report.push({ id, command, args, cwd: root, exit: result.status, ok, log: `.verification/${id}.log` })
  const complete = report.length === stages.length
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify({ updatedAt: new Date().toISOString(), mode, complete, ok: complete && report.every(r => r.ok), stages: report }, null, 2))
  console.log(output.trim().split('\n').slice(-12).join('\n'))
  if (!ok) { console.error(`Verification failed: ${id}${empty ? ' (empty test run)' : ''}`); process.exit(1) }
}
console.log(subset ? 'Windows 子集全部通过；原生 OpenCode 验收与分发测试需在 Linux 上运行。' : 'All verification stages passed.')
