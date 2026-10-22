import { OpenCode } from '../../template/.opencode/plugins/workflow/node_modules/@opencode/client/dist/promise/index.js'
import { readJson } from '../../template/.opencode/plugins/workflow/config.ts'
import { fakeModel } from './fake-model.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
export function runtimeBinary() {
  const bundled = join(root, '.verification/runtime/package/bin/opencode')
  const path = process.env.WORKFLOW_OPENCODE_BIN || (existsSync(bundled) ? bundled : 'opencode')
  const version = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim()
  assert.match(version, /\bv?2\.1\.1$/, 'native tests require OpenCode 2.1.1; run node scripts/fetch-opencode.mjs or set WORKFLOW_OPENCODE_BIN')
  return path
}
export const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
export const git = (h, args) => execFileSync('git', ['-C', h.directory, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const batches = h => {
  const dir = join(h.directory, '.git/workflow/reviews/batches')
  return existsSync(dir) ? readdirSync(dir).filter(p => p.endsWith('.json')).map(p => JSON.parse(readFileSync(join(dir, p), 'utf8'))).sort((a, b) => b.createdAt - a.createdAt) : []
}
export async function until(check, label, milliseconds = 60000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(50) }
  throw new Error('Timed out: ' + label)
}

export async function start(options = {}) {
  const binary = runtimeBinary()
  const temp = mkdtempSync(join(tmpdir(), 'workflow-native-'))
  const directory = join(temp, 'repo')
  const model = await fakeModel()
  const h = { temp, directory, model }
  let child, logs = '', password, exit
  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    }
    await model.close()
    put(join(root, '.verification/native-server.log'), logs.replaceAll(password || '\0', '[redacted]'))
    rmSync(temp, { recursive: true, force: true })
  }
  try {
    cpSync(join(root, 'template'), directory, { recursive: true, filter: p => !['node_modules', '.state', '__pycache__'].includes(p.split('/').at(-1)) })
    cpSync(join(root, 'template/.opencode/plugins/workflow/node_modules'), join(directory, '.opencode/plugins/workflow/node_modules'), { recursive: true })
    cpSync(join(root, 'tests/fixtures/fake-mcp.mjs'), join(temp, 'fake-mcp.mjs'))
    const baseConfig = await readJson(join(directory, 'opencode.jsonc'))
    const providers = { openai: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: model.url }, models: { 'gpt-fixture': { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 100000, output: 4096 } } } } }
    const policies = [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'openai', effect: 'allow' }]
    const mcp = { servers: {
      fixture: { type: 'local', command: [process.execPath, join(temp, 'fake-mcp.mjs'), join(temp, 'mcp.log')], codemode: false },
      'operations-prod': { type: 'local', command: [process.execPath, join(temp, 'fake-mcp.mjs'), join(temp, 'disabled-mcp.log')], disabled: true, codemode: false },
    } }
    put(join(directory, 'opencode.jsonc'), JSON.stringify({ ...baseConfig, snapshots: false, model: 'openai/gpt-fixture', providers, policies, permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*publish.mjs*', effect: 'deny' }, ...baseConfig.permissions], agents: Object.fromEntries(['build', 'reviewer', 'implementer', 'explore'].map(a => [a, { model: 'openai/gpt-fixture' }])), mcp }))
    put(join(directory, 'src/AGENTS.md'), '# NATIVE_DOMAIN_RULE\nUse the local fixture only.\n')
    put(join(directory, '.opencode/workflow/scopes.json'), JSON.stringify([{ paths: ['**'], instruction: 'AGENTS.md' }, { paths: ['src/**'], instruction: 'src/AGENTS.md' }]))
    put(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(7)"' } }))
    put(join(directory, 'publish.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync(".opencode/workflow/.state/deployed", "released\\n")')
    put(join(directory, '.opencode/workflow/release.json'), JSON.stringify({ version: 1, enabled: true, tagPattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+$', scope: { include: ['**'], exclude: [] }, entries: [{ id: 'demo', argv: [process.execPath, 'publish.mjs'], artifacts: [] }] }))
    options.prepare?.(directory)
    git(h, ['init', '-qb', 'main'])
    git(h, ['config', 'user.name', 'Native Fixture'])
    git(h, ['config', 'user.email', 'fixture@example.invalid'])
    git(h, ['add', '.']); git(h, ['commit', '-qm', 'baseline'])
    const base = git(h, ['rev-parse', 'HEAD'])
    for (const folder of ['home', 'config/opencode', 'data', 'state', 'cache']) mkdirSync(join(temp, folder), { recursive: true })
    put(join(temp, 'config/opencode/opencode.json'), JSON.stringify({ update: 'disable', model: 'openai/gpt-fixture', providers, policies }))
    const elsewhere = join(temp, 'elsewhere')
    mkdirSync(elsewhere)
    git({ directory: elsewhere }, ['init', '-q'])
    put(join(temp, 'home/.opencode/opencode.json'), '{}')
    const env = { PATH: process.env.PATH, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config'), XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'), XDG_CACHE_HOME: join(temp, 'cache'), OPENCODE_DB: join(temp, 'db.sqlite'), OPENAI_API_KEY: 'fixture-only', OPENCODE_DISABLE_AUTOUPDATE: 'true', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    // An independently installed scanner is required even though fixtures contain no real secrets.
    execFileSync('python3', [join(directory, '.opencode/secret-scan/install.py'), '--bin-dir', join(temp, 'bin')], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    env.PATH = join(temp, 'bin') + ':' + env.PATH
    child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: elsewhere, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', error => { exit = String(error) })
    child.on('exit', (code, signal) => { exit = `${code}/${signal}` })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk.toString() })
    const endpoint = await until(() => {
      if (exit) throw new Error('Server exited: ' + exit)
      password = logs.match(/server password\s+(\S+)/i)?.[1]
      return password && logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    }, 'server endpoint')
    const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    const client = OpenCode.make({ baseUrl: endpoint, headers: { authorization, 'x-opencode-directory': encodeURIComponent(directory) } })
    const location = { directory }
    await until(async () => {
      const plugins = (await client.plugin.list({ location })).data
      const failed = plugins.find(p => p.state.status === 'failed')
      if (failed) throw new Error(JSON.stringify(failed))
      return plugins.some(p => p.state.status === 'active' && JSON.stringify(p).includes('workflow.starter') && JSON.stringify(p).includes(directory))
    }, 'correct plugin source active')
    await client.location.reload()
    await until(async () => (await client.model.list({ location })).data.some(m => m.id === 'gpt-fixture' && m.enabled), 'fake model enabled')
    await until(async () => (await client.mcp.list({ location })).data.some(s => s.status.status === 'connected'), 'fake MCP connected')
    return { ...h, client, location, base, close }
  } catch (error) {
    await close()
    throw new Error(`${error.message}\n${logs.replaceAll(password || '\0', '[redacted]').slice(-4000)}`, { cause: error })
  }
}

export async function runCase(h, calls, { agent = 'build', replies = [] } = {}) {
  const session = await h.client.session.create({ agent, model: { providerID: 'openai', id: 'gpt-fixture' }, location: h.location })
  const id = randomUUID().replaceAll('-', ''), begin = h.model.requests.length
  h.model.enqueue(id, calls, agent !== 'build')
  const permissions = [], seen = new Set()
  try {
    await h.client.session.prompt({ sessionID: session.id, text: 'RUNTIME_CASE:' + id })
    let done = false, error
    const wait = h.client.session.wait({ sessionID: session.id }).then(() => { done = true }, e => { done = true; error = e })
    await until(async () => {
      for (const request of await h.client.permission.list({ sessionID: session.id })) {
        if (seen.has(request.id)) continue
        seen.add(request.id); permissions.push(request)
        const decision = replies[permissions.length - 1]
        if (!decision) { await h.client.session.interrupt({ sessionID: session.id }); throw new Error('Unexpected permission: ' + JSON.stringify(request)) }
        await h.client.permission.reply({ sessionID: session.id, requestID: request.id, decision })
      }
      return done
    }, 'native session completion')
    await wait
    if (error) throw error
    const requests = h.model.requests.slice(begin)
    assert.equal(h.model.remaining(id), 0, 'all scripted calls must actually run')
    return { requests, permissions, toolResults: requests.flatMap(r => (r.messages ?? []).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n') }
  } finally { await h.client.session.remove({ sessionID: session.id }) }
}
