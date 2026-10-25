import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 分发测试与维护者本地的检查脚本共用这套规则，改导出时保持兼容。测试和文档中的合成路径统一使用占位用户名 example。
// 带盘符的 Windows 路径不区分大小写，正斜杠、反斜杠和源码字符串里的转义写法都算；
// 反斜杠形式的 home 路径来自 WSL 的 UNC 路径（\\wsl.localhost\<发行版>\home\<用户>）。
const homes = [
  /\/home\/(?!example\/)[a-z_][\w.-]*\//,
  /\/Users\/(?!example\/)[A-Za-z][\w.-]*\//,
  /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!example\b)[A-Za-z]/i,
  /\\{1,2}home\\{1,2}(?!example\\)[a-z_][\w.-]*\\/,
]
const addresses = ['127.0.0.1', '0.0.0.0']

// 私有名称只写在被忽略的本地文件里，避免禁用词清单本身随仓库公开。
// 清单不存在时返回 null，由调用方决定是否放行；其他读取错误照常抛出。
export function forbiddenPatterns(root) {
  let text
  try { text = readFileSync(join(root, '.verification/forbidden-patterns.txt'), 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  // 存成 UTF-16 或 GBK 的清单按 UTF-8 读不会报错，却匹配不到任何文本：按无效输入拒绝，错误信息不带内容。
  if (/[\u0000�]/.test(text)) throw new Error('.verification/forbidden-patterns.txt 不是 UTF-8 文本')
  return text.split('\n').map(line => line.trim().toLowerCase()).filter(line => line && !line.startsWith('#'))
}

export function leaks(text, forbidden = []) {
  const words = forbidden.map(pattern => pattern.toLowerCase())
  return text.split('\n').flatMap((line, index) => [
    ...homes.flatMap(pattern => line.match(pattern) ?? []).map(match => ({ kind: 'home', match })),
    ...[...line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(([match]) => match).filter(match => !addresses.includes(match)).map(match => ({ kind: 'ipv4', match })),
    ...words.filter(word => line.toLowerCase().includes(word)).map(match => ({ kind: 'forbidden', match })),
  ].map(found => ({ line: index + 1, ...found })))
}
