import { createServer } from 'node:http'

// 本地确定性的 OpenAI 兼容流式服务：按消息里最后一个 RUNTIME_CASE 标记回放预设工具调用，从不转发请求，
// 用例因此不依赖真实模型的输出，也不产生调用费用。
export async function fakeModel() {
  const queues = new Map()
  const requests = []
  const failures = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text || '{}')
    requests.push(body)
    const input = JSON.stringify((body.messages || []).filter(message => message.role === 'user'))
    const marker = [...input.matchAll(/RUNTIME_CASE:([a-zA-Z0-9_-]+)/g)].at(-1)?.[1]
    const script = marker && queues.get(marker)
    const next = body.tools?.length && script?.calls.length ? script.calls.shift() : undefined
    const calls = typeof next === 'function' ? await next(body) : next
    // 预设调用必须命中真实工具目录与入参 schema；否则工具报错不能算守卫拦截。
    for (const call of calls || []) {
      const tool = body.tools.find(tool => tool.function.name === call.name)
      if (!tool && !script?.allowHidden) failures.push({ marker, error: `Target not in actual catalog: ${call.name}`, catalog: body.tools.map(t => t.function.name) })
      if (tool) {
        const schema = tool.function.parameters
        for (const name of schema.required || []) if (!(name in call.input)) failures.push({ marker, error: `Missing native tool input: ${call.name}.${name}` })
        for (const [name, value] of Object.entries(call.input)) {
          const type = schema.properties?.[name]?.type
          if (type && ['string', 'boolean', 'number'].includes(type) && typeof value !== type) failures.push({ marker, error: `Invalid native tool input: ${call.name}.${name}` })
        }
      }
    }
    const tool_calls = calls?.map((call, index) => ({ index, id: `call_${marker}_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }))
    const finish = script?.finish ?? 'Fixture complete'
    const delta = tool_calls ? { role: 'assistant', tool_calls } : { role: 'assistant', content: typeof finish === 'function' ? await finish(body) : finish }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, failures,
    enqueue(id, calls, allowHidden = false, finish = 'Fixture complete') { queues.set(id, { calls, allowHidden, finish }) },
    remaining(id) { return queues.get(id)?.calls.length },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }),
  }
}
