import assert from 'node:assert/strict'

export function assertPythonSuiteComplete(result) {
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  const diagnostic = `${output}\n独立测试进程失败：status=${result.status} signal=${result.signal ?? 'none'} error=${result.error?.code ?? 'none'}\n${result.error?.message ?? ''}`
  assert.ok(!result.error && result.signal === null && result.status === 0, diagnostic)
  assert.match(output, /Ran [1-9]\d* tests/)
  assert.match(output, /\bOK\b/)
  assert.doesNotMatch(output, /skipped=[1-9]/)
}
