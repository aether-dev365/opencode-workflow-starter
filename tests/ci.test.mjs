import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { makeRepo, scannerFixture, scope } from './fixtures/ci-fixture.mjs'

const secretFiles = ['resolve-scope.py', 'scan-secrets.py']
const synthetic = () => ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX1yZ3bD5'].join('')
const scan = (r, head, env = {}) => r.py('scripts/ci/scan-secrets.py', ['--head', head], { env })

test('secrets: validates report and exit status together', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); scannerFixture(r, true); const head = r.commit()
  const finding = { File: 'src/a.py', StartLine: 1, RuleID: 'example', Commit: head, Secret: synthetic(), Match: 'raw-private-detail' }
  for (const [exit, report, expected] of [[0, [], 0], [23, [finding], 1], [0, [finding], 2], [23, [], 2], [1, [], 2], [7, [], 2]]) {
    const result = scan(r, head, { FAKE_EXIT: String(exit), FAKE_REPORT: JSON.stringify(report) })
    assert.equal(result.status, expected, result.stdout + result.stderr)
    assert.ok(!(result.stdout + result.stderr).includes(synthetic()))
    assert.doesNotMatch(result.stdout + result.stderr, /raw-private-detail/)
    if (expected === 1) assert.match(result.stdout, /src\/a.py.*example/)
  }
})

test('secrets: rejects missing oversized and malformed reports and bad pins', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); const binary = scannerFixture(r, true); const head = r.commit()
  for (const value of ['{', '{}', '[null]', JSON.stringify([{ File: 'a', StartLine: true, RuleID: 'rule', Commit: head }]),
    JSON.stringify([{ File: 'a', StartLine: 0, RuleID: 'rule', Commit: head }]),
    JSON.stringify([{ File: '', StartLine: 1, RuleID: 'rule', Commit: head }]),
    JSON.stringify([{ File: 'a', StartLine: 1, RuleID: 'bad\ncommand', Commit: head }]),
    JSON.stringify([{ File: 'a', StartLine: 1, RuleID: 'rule', Commit: 'bad' }])]) {
    const result = scan(r, head, { FAKE_EXIT: '23', FAKE_REPORT: value })
    assert.equal(result.status, 2, result.stdout + result.stderr)
  }
  assert.equal(scan(r, head, { FAKE_MODE: 'missing' }).status, 2)
  const report = join(r.temp, 'report.json'); writeFileSync(report, Buffer.alloc(16 * 1024 * 1024 + 1, 32))
  const validate = path => r.probe('scripts/ci/scan-secrets.py', `try:\n m['validate_report'](Path(${JSON.stringify(path)}),0)\nexcept ValueError:\n sys.exit(2)`).status
  assert.equal(validate(report), 2)
  writeFileSync(report, '[]'); symlinkSync(report, join(r.temp, 'alias.json'))
  assert.equal(validate(join(r.temp, 'alias.json')), 2)
  writeFileSync(binary, '\nchanged', { flag: 'a' }); assert.equal(scan(r, head).status, 2)
})

test('secrets: bounded timeout and stale reports never pass', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); scannerFixture(r, true); const head = r.commit()
  const probe = r.probe('scripts/ci/scan-secrets.py', `sys.exit(m['scan'](Path.cwd(),${JSON.stringify(head)},timeout=.2))`, { env: { FAKE_MODE: 'hang' } })
  assert.equal(probe.status, 2, probe.stderr)
  r.write('report.json', '[]')
  assert.equal(scan(r, head, { FAKE_MODE: 'missing' }).status, 2)
})

test('secrets: cancellation after readiness and missing tool are incomplete', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); scannerFixture(r, true); const head = r.commit()
  const ready = join(r.temp, 'ready')
  const result = r.probe('scripts/ci/scan-secrets.py', `import os,signal,threading,time
sent=threading.Event()
def cancel():
 deadline=time.monotonic()+10
 while not Path(os.environ['FAKE_READY']).exists() and time.monotonic()<deadline: time.sleep(.01)
 if Path(os.environ['FAKE_READY']).exists():
  sent.set()
  os.kill(os.getpid(),signal.SIGTERM)
threading.Thread(target=cancel,daemon=True).start()
code=m['scan'](Path.cwd(),${JSON.stringify(head)},timeout=15)
print(json.dumps({'code':code,'sent':sent.is_set()}))`, { env: { FAKE_READY: ready, FAKE_MODE: 'hang' } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { code: 2, sent: true })
  const missing = r.probe('scripts/ci/scan-secrets.py', `m['shutil'].which=lambda name: None\nsys.exit(m['scan'](Path.cwd(),${JSON.stringify(head)}))`)
  assert.equal(missing.status, 2)
})

test('secrets: real scanner covers root and deleted intermediate history with safe output', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); scannerFixture(r)
  r.write('config.txt', 'token=' + synthetic() + '\n'); const first = r.commit('private-message-not-for-output')
  let result = scan(r, first)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /config.txt/)
  assert.ok(!result.stdout.includes(synthetic())); assert.doesNotMatch(result.stdout, /private-message-not-for-output/)
  r.write('config.txt', 'clean\n'); const head = r.commit()
  result = scan(r, head); assert.equal(result.status, 1, result.stderr)
  const fingerprint = `${first}:config.txt:github-pat:1`
  r.write('.gitleaksignore', fingerprint + '\n')
  result = scan(r, head)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /gitleaksignore/)
})

test('secrets: real scanner sees side history and merge-only additions but not unrelated refs', t => {
  const r = makeRepo(t, { ciFiles: secretFiles }); scannerFixture(r); const base = r.commit()
  r.git('checkout', '-qb', 'unrelated'); r.write('private.txt', synthetic()); r.commit()
  r.git('checkout', '-q', 'main'); r.write('untracked.txt', synthetic())
  assert.equal(scan(r, base).status, 0)
  unlinkSync(join(r.root, 'untracked.txt'))
  r.git('checkout', '-qb', 'side'); r.write('side.txt', synthetic()); r.commit()
  r.write('side.txt', 'clean'); r.commit(); r.git('checkout', '-q', 'main')
  r.git('merge', '--no-ff', '-qm', 'merge', 'side')
  assert.equal(scan(r, r.git('rev-parse', 'HEAD')).status, 1)
  r.git('checkout', '-q', base); r.git('checkout', '-qb', 'merge-only')
  r.write('common.txt', 'one'); const left = r.commit()
  r.git('checkout', '-q', base); r.git('checkout', '-qb', 'right'); r.write('common.txt', 'two'); r.commit()
  r.git('checkout', '-q', 'merge-only'); assert.notEqual(r.run('git', ['merge', 'right']).status, 0)
  r.write('common.txt', synthetic() + ' # gitleaks:allow\n'); const merged = r.commit('resolve')
  const result = scan(r, merged)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /common.txt/)
  assert.notEqual(left, merged)
})

const files = ['resolve-scope.py']
const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } })
const push = (before, after, branch = 'main') => ({ before, after, deleted: false, repository: { default_branch: branch } })
const success = (result, expected) => {
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), expected)
  assert.equal(readFileSync(result.output, 'utf8'), `mode=${expected.mode}\nbase=${expected.base}\nhead=${expected.head}\n`)
}

test('scope: PR uses event head rather than merge SHA', t => {
  const r = makeRepo(t, { ciFiles: files }); r.write('a.ts', 'base\n'); const start = r.commit()
  r.git('checkout', '-qb', 'feature'); r.write('a.ts', 'head\n'); const head = r.commit()
  r.git('checkout', '-q', 'main'); r.write('b.ts', 'base advance\n'); const base = r.commit()
  r.git('merge', '--no-ff', '-qm', 'merge', 'feature'); const merge = r.git('rev-parse', 'HEAD')
  r.git('checkout', '-q', head)
  success(scope(r, 'pull_request', pr(base, head), merge), { mode: 'range', base, head })
  assert.equal(r.git('merge-base', base, head), start)
  assert.equal(r.git('show', 'HEAD:a.ts'), 'head')
})

test('scope: push spans all commits and merge changes', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('one.ts', 'one'); r.commit(); r.git('checkout', '-qb', 'side')
  r.write('two.ts', 'two'); r.commit(); r.git('checkout', '-q', 'main')
  r.git('merge', '--no-ff', '-qm', 'merge', 'side'); const head = r.git('rev-parse', 'HEAD')
  success(scope(r, 'push', push(base, head, "trunk'branch"), head, "refs/heads/trunk'branch"), { mode: 'range', base, head })
  assert.equal(r.git('diff', '--name-only', base, head), 'one.ts\ntwo.ts')
})

test('scope: first push and dispatch use all', t => {
  const r = makeRepo(t, { ciFiles: files }); const head = r.commit()
  for (const result of [scope(r, 'push', push('0'.repeat(40), head)), scope(r, 'workflow_dispatch', {}, head)]) {
    success(result, { mode: 'all', base: '', head })
    assert.ok(result.stderr.trim())
  }
})

test('scope: unavailable old tip and nonancestor tip use all', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('a.ts', 'a'); const old = r.commit(); r.git('checkout', '-q', base)
  r.write('b.ts', 'b'); const head = r.commit()
  for (const before of [old, 'f'.repeat(40)]) success(scope(r, 'push', push(before, head)), { mode: 'all', base: '', head })
})

test('scope: invalid metadata never becomes an empty range', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.write('a.ts', 'a'); const head = r.commit()
  const blob = r.git('rev-parse', 'HEAD:a.ts'); r.git('tag', '-a', 'annotated', '-m', 'tag')
  const tag = r.git('rev-parse', 'annotated')
  for (const [event, data, sha, ref] of [
    ['push', { after: head }], ['push', push('bad\nmode=all', head)], ['push', push(base.slice(0, 7), head)],
    ['push', push(base, head), '', 'refs/heads/other'], ['push', { ...push(base, head), deleted: true }],
    ['pull_request', pr(blob, head)], ['pull_request', pr(tag, head)], ['pull_request', pr(base, 'e'.repeat(40))],
    ['pull_request', pr(base, base)], ['pull_request', {}], ['workflow_dispatch', {}, tag],
    ['push', '{'], ['push', []], ['other', {}],
  ]) {
    const result = scope(r, event, data, sha, ref)
    assert.equal(result.status, 2, JSON.stringify(data) + result.stdout)
    assert.equal(readFileSync(result.output, 'utf8'), '')
  }
  writeFileSync(join(r.root, '.git/shallow'), base + '\n')
  assert.equal(scope(r, 'pull_request', pr(base, head)).status, 2)
})

test('scope: unrelated PR histories fail but gitfile roots work', t => {
  const r = makeRepo(t, { ciFiles: files }); const base = r.commit()
  r.git('checkout', '--orphan', 'other'); r.write('other.ts', 'unrelated'); const head = r.commit()
  assert.notEqual(base, head, '两个根提交必须不同')
  assert.equal(scope(r, 'pull_request', pr(base, head)).status, 2)
  r.git('checkout', '-q', 'main')
  const linked = join(r.temp, 'linked'); r.git('worktree', 'add', '--detach', linked, base)
  const eventFile = join(r.temp, 'manual.json'); writeFileSync(eventFile, '{}')
  const result = r.py(join(linked, 'scripts/ci/resolve-scope.py'), [], { cwd: linked, env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: base, GITHUB_EVENT_PATH: eventFile } })
  assert.equal(result.status, 0, result.stderr)
})

test('scope: Git errors are not missing objects and old queries work', t => {
  const r = makeRepo(t, { ciFiles: files }); const head = r.commit()
  const realGit = r.run('sh', ['-c', 'command -v git']).stdout.trim()
  const bin = join(r.temp, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst a=process.argv.slice(2);\nif(a.includes('--is-shallow-repository'))process.exit(90);\nif(a.includes('cat-file')&&process.env.FAIL_GIT){if(process.env.FAIL_GIT==='bad'){console.log('invalid');process.exit(0)}process.exit(91)}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??92);\n`, { mode: 0o755 })
  r.env.PATH = bin + delimiter + r.env.PATH
  success(scope(r, 'push', push('f'.repeat(40), head)), { mode: 'all', base: '', head })
  for (const fail of ['error', 'bad']) { r.env.FAIL_GIT = fail; assert.equal(scope(r, 'push', push('f'.repeat(40), head)).status, 2) }
})
