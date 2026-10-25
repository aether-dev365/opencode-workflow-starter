#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'

const flags = {
  status: [],
  bootstrap: ['scope'],
  plan: ['answers', 'source'],
  apply: ['plan', 'confirm'],
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('接入向导需要 Node.js 24 或更新版本')
  const args = process.argv.slice(2)
  const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  if (!(action in flags)) throw new Error('操作只能是 status、bootstrap、plan 或 apply；运行时验收请在 OpenCode 使用 /workflow-setup')
  const options = {}
  while (args.length) {
    const key = args.shift()
    if (!key.startsWith('--') || !['root', ...flags[action]].includes(key.slice(2))) throw new Error('未知参数；请只使用当前操作支持的选项，不传入凭据或额外正文')
    const name = key.slice(2), value = args.shift()
    if (!value || value.startsWith('--') || name in options) throw new Error(`参数 ${key} 缺少值或重复`)
    options[name] = value
  }
  const root = resolve(options.root ?? '.')
  const { planSetup, applySetup, inspectSetup } = await import('../../.opencode/plugins/workflow/onboarding-files.ts')
  if (action === 'status') return { ...await inspectSetup(root), runtimeVerified: false, next: '在 OpenCode 中运行 /workflow-setup，核对当前会话技能和有效模型' }
  if (action === 'bootstrap') {
    if (!['project', 'global'].includes(options.scope)) throw new Error('必须明确选择 --scope project 或 --scope global；没有选择不会安装')
    return planSetup(root, { kind: 'superpowers', scope: options.scope })
  }
  if (action === 'plan') {
    if (!options.answers) throw new Error('缺少 --answers 选择文件；先解释选项并取得用户选择，不自动使用默认答案')
    const path = resolve(options.answers), info = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1) throw new Error('选择文件必须是独立的常规文件，不接受链接或特殊设备')
    if (info.size > 64 * 1024) throw new Error('选择文件过大，最多接受 64 KiB')
    const bytes = readFileSync(path)
    if (bytes.length > 64 * 1024) throw new Error('选择文件过大，最多接受 64 KiB')
    let text, choices
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('选择文件不是有效 UTF-8；未应用任何配置') }
    try { choices = JSON.parse(text) } catch { throw new Error('选择文件不是有效 JSON；未应用任何配置') }
    return planSetup(root, { kind: 'configure', choices, ...(options.source ? { source: resolve(options.source) } : {}) })
  }
  if (!options.plan || !/^[a-f0-9]{64}$/.test(options.plan) || options.confirm !== options.plan) throw new Error('应用需要 --plan 摘要 与 --confirm 相同摘要；先展示计划并取得明确确认')
  return applySetup(root, options.plan)
}

try {
  console.log(JSON.stringify({ ok: true, ...await main() }, null, 2))
} catch (error) {
  const message = error.code === 'ERR_MODULE_NOT_FOUND' ? '向导模块或依赖不可用；先完整合并模板并运行 node scripts/workflow/setup.mjs' : error.message
  console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  process.exitCode = 2
}
