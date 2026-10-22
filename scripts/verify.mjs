#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, '.verification')
mkdirSync(directory, { recursive: true })
const stages = [
  ['typecheck', 'npm', ['--prefix', 'template/.opencode/plugins/workflow', 'run', 'typecheck']],
  ['plugin', 'npm', ['--prefix', 'template/.opencode/plugins/workflow', 'test']],
  ['guards', 'bash', ['template/.opencode/workflow/checks/run-tests.sh']],
  ['distribution', process.execPath, ['--test', 'tests/doctor.test.mjs', 'tests/distribution.test.mjs', 'tests/verify.test.mjs', 'tests/fetch.test.mjs']],
  ['adoption', process.execPath, ['--test', 'tests/adoption.test.mjs']],
  ['native', process.execPath, ['--test', 'tests/native.test.mjs']],
]
const report = []
for (const [id, command, args] of stages) {
  console.log(`Running ${id}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 })
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? '\n' + result.error.message : '')
  writeFileSync(resolve(directory, id + '.log'), output)
  const empty = id !== 'typecheck' && !/(?:tests\s+[1-9]\d*|Ran [1-9]\d* tests?)/.test(output)
  const ok = result.status === 0 && !empty && !/(?:skipped\s+[1-9]|skipped=[1-9])/.test(output)
  report.push({ id, command, args, cwd: root, exit: result.status, ok, log: `.verification/${id}.log` })
  const complete = report.length === stages.length
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify({ updatedAt: new Date().toISOString(), complete, ok: complete && report.every(r => r.ok), stages: report }, null, 2))
  console.log(output.trim().split('\n').slice(-12).join('\n'))
  if (!ok) { console.error(`Verification failed: ${id}${empty ? ' (empty test run)' : ''}`); process.exit(1) }
}
console.log('All verification stages passed.')
