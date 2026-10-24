import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { essentialEnv } from './env.mjs'
import { pythonCommand } from '../../template/.opencode/plugins/workflow/platform.ts'

export function makeRepo(t, { baseTemplate = false, ciFiles = [] } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-ci-')))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = join(temp, '接入 project')
  mkdirSync(root); mkdirSync(join(temp, 'home'))
  writeFileSync(join(temp, 'gitconfig'), '')
  const env = { ...essentialEnv(), PATH: process.env.PATH, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'),
    GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'example', GIT_COMMITTER_NAME: 'example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_EMAIL: 'example@example.invalid',
    PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
  const write = (path, data) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); return file }
  const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options, env: { ...env, ...options.env } })
  const git = (...args) => { const r = run('git', args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim() }
  const python = pythonCommand()
  const py = (script, args = [], options = {}) => run(python.command, [...python.args, script, ...args], options)
  const probe = (script, code, options = {}) => py('-c', [`import runpy,sys,json\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1])\n${code}`, resolve(root, script)], options)
  if (baseTemplate) cpSync('template', root, { recursive: true, filter: p => !p.split(/[\\/]/).some(s => ['node_modules', '__pycache__', '.state'].includes(s)) })
  for (const file of readdirSync('optional/quality').filter(p => p.endsWith('.py') || p === 'quality.example.json')) {
    mkdirSync(join(root, 'scripts/quality'), { recursive: true })
    cpSync(join('optional/quality', file), join(root, 'scripts/quality', file))
  }
  for (const file of ciFiles) if (existsSync(join('optional/ci', file))) {
    mkdirSync(join(root, 'scripts/ci'), { recursive: true }); cpSync(join('optional/ci', file), join(root, 'scripts/ci', file))
  }
  git('init', '-q'); git('symbolic-ref', 'HEAD', 'refs/heads/main')
  const commit = (message = 'change') => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  return { root, temp, env, write, git, commit, run, py, probe }
}

export function scope(r, eventName, event, sha = '', ref = 'refs/heads/main') {
  const eventFile = join(r.temp, 'event.json'), output = join(r.temp, 'outputs')
  writeFileSync(eventFile, typeof event === 'string' ? event : JSON.stringify(event))
  writeFileSync(output, '')
  const result = r.py('scripts/ci/resolve-scope.py', [], { env: {
    GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output, GITHUB_SHA: sha, GITHUB_REF: ref,
  } })
  return { ...result, output }
}
