import { createHash } from 'node:crypto'
import type { AgentChoice } from './onboarding-config.ts'

// 与模板 implementer 代理文件的正文相同，由测试核对；生成的子代理沿用同一协作边界。
export const AGENT_CONTRACT = [
  '先读根规则、相关领域规则和任务卡。核对绝对 Location、基线、写入范围、接口与资源安排；缺影响行为的决定时报告主代理。',
  '只改分配文件，不与其他写入者同时改共享文件。实现和验证真实行为，交付修改列表、验收场景、命令/工作目录/退出码、联动影响及未完成项。已批准设计直接执行。',
  '不暂存、提交、合并、部署或访问生产，不继续派代理；不通过 shell 绕过上述协作边界。主代理负责最终集成和提交。',
].join('\n\n')
const MARKER = /^# 由 \/workflow-setup 生成（sha256:([a-f0-9]{64})）；调整职责或模型请重新运行 \/workflow-setup$/
const normalize = (text: string) => text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export const agentPath = (name: string) => `.opencode/agents/${name}.md`

// frontmatter 完全由这里生成；description 用 JSON 字符串写法，是合法的 YAML 双引号标量。
// 第二行嵌入其余全文的摘要：摘要仍然成立就说明文件是向导生成且未被修改，套件升级改动模板后也能识别。
export function agentText({ description, focus }: Pick<AgentChoice, 'description' | 'focus'>): string {
  const lines = ['---', `description: ${JSON.stringify(description)}`, 'mode: subagent', 'permissions:',
    "  - { action: subagent, resource: '*', effect: deny }", "  - { action: '*-prod_*', resource: '*', effect: deny }", "  - { action: workflow_release, resource: '*', effect: deny }",
    '---', '', focus, '', AGENT_CONTRACT, '']
  const hash = digest(lines.join('\n'))
  return [lines[0], `# 由 /workflow-setup 生成（sha256:${hash}）；调整职责或模型请重新运行 /workflow-setup`, ...lines.slice(1)].join('\n')
}

export function unmodifiedAgent(text: string): boolean {
  const lines = normalize(text).split('\n'), found = lines[1]?.match(MARKER)
  if (lines[0] !== '---' || !found) return false
  return digest([lines[0], ...lines.slice(2)].join('\n')) === found[1]
}
