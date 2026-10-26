import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AGENT_CONTRACT, agentPath, agentText, unmodifiedAgent } from '../onboarding-agents.ts'

const implementer = fileURLToPath(new URL('../../../agents/implementer.md', import.meta.url))
const choice = { description: '负责 "web" 前端：组件 #1 \\ 样式', focus: '先读 web/AGENTS.md。\n---\n只改 web/ 下的文件。' }

test('generated agent text has fixed frontmatter, escaped description, focus and the implementer contract', () => {
  const text = agentText(choice), lines = text.split('\n')
  assert.equal(lines[0], '---')
  assert.match(lines[1], /^# 由 \/workflow-setup 生成（sha256:[a-f0-9]{64}）；调整职责或模型请重新运行 \/workflow-setup$/)
  assert.equal(lines[2], 'description: "负责 \\"web\\" 前端：组件 #1 \\\\ 样式"')
  assert.deepEqual(lines.slice(3, 8), ['mode: subagent', 'permissions:', "  - { action: subagent, resource: '*', effect: deny }", "  - { action: '*-prod_*', resource: '*', effect: deny }", "  - { action: workflow_release, resource: '*', effect: deny }"])
  assert.ok(text.includes('---\n\n先读 web/AGENTS.md。\n---\n只改 web/ 下的文件。\n\n'))
  assert.ok(text.endsWith(AGENT_CONTRACT + '\n'))
  assert.equal(agentPath('web-implementer'), '.opencode/agents/web-implementer.md')
})

test('AGENT_CONTRACT matches the implementer agent body', async () => {
  const body = (await readFile(implementer, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  assert.equal(AGENT_CONTRACT, body)
})

test('unmodified detection survives CRLF and BOM but rejects edits, forged digests and hand-written agents', async () => {
  const text = agentText(choice)
  assert.equal(unmodifiedAgent(text), true)
  assert.equal(unmodifiedAgent('\uFEFF' + text.replaceAll('\n', '\r\n')), true)
  assert.equal(unmodifiedAgent(text.replace('只改', '可以改')), false)
  assert.equal(unmodifiedAgent(text.replace(/sha256:[a-f0-9]{64}/, 'sha256:' + '0'.repeat(64))), false)
  assert.equal(unmodifiedAgent(await readFile(implementer, 'utf8')), false)
})
