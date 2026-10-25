import type { Plugin } from '@opencode/plugin'
import type { AgentInfo, ModelInfo, PluginInfo } from '@opencode/client'
import { mkdtemp, mkdir, writeFile, rm, cp, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const disposers = new WeakMap<Plugin.Context, Set<() => Promise<void>>>()

export async function fixture() {
  // 新机器上不存在 opencode 子目录；realpath 统一 macOS /private 前缀和 Windows 8.3 短路径。
  const parent = join(tmpdir(), 'opencode')
  await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'workflow-')))
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-qb', 'main', root], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  const source = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'workflow/checks/fixtures/protection.json')
  await mkdir(resolve(root, '.opencode/workflow'), { recursive: true })
  await cp(source, resolve(root, '.opencode/workflow/protection.json'))
  await writeFile(resolve(root, '.opencode/workflow/watchdog.json'), JSON.stringify({ stallSeconds: 600, toolSeconds: 1800, checkSeconds: 30 }))
  await mkdir(resolve(root, '.opencode/workflow/review/checklists'), { recursive: true })
  const catalog = { core: { group: 'core', checklist: 'core.md' }, tests: { group: 'core', checklist: 'tests.md' }, workflow: { group: 'workflow', checklist: 'workflow.md' } }
  await writeFile(resolve(root, '.opencode/workflow/review/catalog.json'), JSON.stringify(catalog))
  for (const id of Object.keys(catalog)) await writeFile(resolve(root, '.opencode/workflow/review/checklists', id + '.md'), `Check ${id} behavior and evidence.\n`)
  await writeFile(resolve(root, '.opencode/workflow/review/routing.json'), JSON.stringify({ version: 1, areas: [{ id: 'workflow', paths: ['.opencode/**'] }], units: [{ id: 'core', areas: ['*'] }, { id: 'tests', areas: ['*'] }, { id: 'workflow', areas: ['workflow'] }] }))
  for (const path of ['AGENTS.md', 'src/AGENTS.md']) {
    await mkdir(resolve(root, path, '..'), { recursive: true })
    await writeFile(resolve(root, path), `REAL DOMAIN RULES ${path}: must obey this fixture.\n`)
  }
  await writeFile(resolve(root, '.opencode/workflow/scopes.json'), JSON.stringify([{ paths: ['**'], instruction: 'AGENTS.md' }, { paths: ['src/**'], instruction: 'src/AGENTS.md' }]))
  const callbacks = new Map<string, (value: any) => Promise<void> | void>()
  const handlers = new Map<string, Set<(value: any) => Promise<void> | void>>()
  let directory = root
  const register = (domain: string) => async (name: string, callback: (value: any) => Promise<void> | void) => {
    const key = `${domain}.${name}`
    const registered = handlers.get(key) || new Set()
    registered.add(callback); handlers.set(key, registered)
    callbacks.set(key, async value => { for (const handler of registered) await handler(value) })
    return { dispose: async () => { registered.delete(callback); if (!registered.size) { handlers.delete(key); callbacks.delete(key) } } }
  }
  const data = new Map<string, unknown>()
  let permissionHandler = async (_input: unknown) => {}
  const plugins: PluginInfo[] = []
  const models: ModelInfo[] = [{ id: 'fixture', modelID: 'fixture', providerID: 'fake', name: 'Fixture', enabled: true,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', limit: { context: 32768, output: 4096 } }]
  const childSessions = new Map<string, unknown>()
  const synthetic: { sessionID: string; text: string; resume?: boolean }[] = []
  const tools = new Map<string, any>()
  const skills = new Map<string, { id: string; name: string; path: string; content: string; description?: string }>()
  const agents = new Map<string, Pick<AgentInfo, 'id'> & Partial<AgentInfo>>()
  const subscribers = new Set<{ queue: any[]; wake?: () => void }>()
  const storage = { get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) }, remove: async (key: string) => { data.delete(key) } }
  const ctx = {
    app: { version: '2.1.4' }, location: { directory: root }, options: {},
    rpc: { register: async () => ({ dispose: async () => {} }) },
    tool: { hook: register('tool'), transform: async (callback: (editor: any) => void) => {
      const added: string[] = []
      callback({ list: () => [], add: (tool: any) => { tools.set(tool.name, tool); added.push(tool.name) } })
      return { dispose: async () => { for (const name of added) tools.delete(name) } }
    } }, shell: { hook: register('shell') },
    permission: { hook: register('permission'), assert: async (input: unknown) => permissionHandler(input) },
    session: { hook: register('session'), synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => { synthetic.push(input) }, get: async ({ sessionID }: { sessionID: string }) => childSessions.get(sessionID) ||
      ({ id: sessionID, agent: 'build', model: { providerID: 'fake', id: 'fixture' }, location: { directory } }) },
    skill: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: [...skills.values()] }) },
    agent: { get: async ({ agentID, location }: { agentID: string; location: { directory: string } }) =>
      ({ location, data: agents.get(agentID) ?? { id: agentID } }) },
    plugin: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: structuredClone(plugins) }) },
    model: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: structuredClone(models) }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      const listener: { queue: any[]; wake?: () => void } = { queue: [] }
      const abort = () => listener.wake?.()
      subscribers.add(listener); signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          if (listener.queue.length) yield listener.queue.shift()
          else await new Promise<void>(done => { listener.wake = done })
        }
      } finally { subscribers.delete(listener); signal.removeEventListener('abort', abort) }
    } },
    storage,
  } as unknown as Plugin.Context
  return { root, ctx, callbacks, childSessions, synthetic, tools, storage, skills, agents, plugins, models,
    onPermission: (handler: (input: any) => Promise<void>) => { permissionHandler = handler },
    emit: (event: unknown) => { for (const listener of subscribers) { listener.queue.push(event); listener.wake?.() } },
    move: (to: string) => { directory = to },
    fire: async (name: string, event: unknown) => {
      const callback = callbacks.get(name)
      if (!callback) throw new Error(`Missing native registration ${name}`)
      await callback(event)
    },
    close: async () => {
      for (const dispose of [...disposers.get(ctx) ?? []]) await dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export const before = <T>(tool: string, input: T, sessionID = 's1') =>
  ({ tool, input, sessionID, id: randomUUID(), messageID: 'msg', agent: 'build' })
export const context = (sessionID = 's1') =>
  ({ sessionID, system: [] as { type: string; text: string }[], messages: [], tools: {}, options: {}, agent: 'build', model: { providerID: 'fake', id: 'fixture' } })

export async function load() {
  const url = new URL('../index.ts', import.meta.url)
  const { registerWorkflow } = await import(url.href)
  if (typeof registerWorkflow !== 'function') throw new Error('Native registerWorkflow is missing')
  return async (ctx: Plugin.Context) => {
    const cleanup = await registerWorkflow(ctx)
    const owned = disposers.get(ctx) ?? new Set<() => Promise<void>>()
    disposers.set(ctx, owned)
    const dispose = async () => {
      if (!owned.delete(dispose)) return
      await cleanup()
    }
    owned.add(dispose)
    return dispose
  }
}
