import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const audit = process.argv[2]
appendFileSync(audit, 'started\n')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result = {}
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } }
  if (request.method === 'tools/list') result = { tools: [{ name: 'read_status', description: 'Read synthetic status only', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  if (request.method === 'tools/call') {
    if (request.params.name !== 'read_status') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unknown fixture action' } }) + '\n')
      continue
    }
    appendFileSync(audit, 'read\n')
    result = { content: [{ type: 'text', text: 'synthetic status ready' }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
