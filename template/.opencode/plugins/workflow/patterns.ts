export function matchesPattern(path: string, pattern: string): boolean {
  const expression = [...pattern].map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  // 比较完整匹配文本，避免结尾换行被正则的 $ 当成串尾而漏掉。
  return new RegExp('^' + expression + '$', 'su').exec(path)?.[0] === path
}

export function patternProblem(pattern: string): string | undefined {
  if (/[{}]/.test(pattern)) return `不支持花括号，请拆成多条：${pattern}`
}
