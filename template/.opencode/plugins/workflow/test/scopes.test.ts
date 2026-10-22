import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture } from './fixture.ts'
import { matchingScopes, scopeRoot } from '../scopes.ts'

test('opencode config files without git do not create a checkout root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workflow-home-'))
  try {
    await mkdir(join(home, '.opencode'))
    await writeFile(join(home, '.opencode/opencode.json'), '{}')
    await writeFile(join(home, 'opencode.jsonc'), '{}')
    assert.equal(await scopeRoot(join(home, 'notes.md')), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('nested edits receive both root and domain instructions', async () => {
  const f = await fixture()
  try {
    const found = await matchingScopes(['new.ts'], join(f.root, 'src'))
    assert.deepEqual(found.map(s => s.instruction), [join(f.root, 'AGENTS.md'), join(f.root, 'src/AGENTS.md')])
  } finally { await f.close() }
})

test('the catch-all scope covers dot directories', async () => {
  const f = await fixture()
  try {
    const found = await matchingScopes(['.github/workflows/ci.yml'], f.root)
    assert.ok(found.some(s => s.instruction === join(f.root, 'AGENTS.md')))
  } finally { await f.close() }
})

test('independent nested checkout cannot borrow parent mappings', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'nested/.git'), { recursive: true })
    await assert.rejects(matchingScopes(['file'], join(f.root, 'nested')), /范围/)
    await writeFile(join(f.root, '.opencode/workflow/scopes.json'), '[]')
    await assert.rejects(matchingScopes(['file'], f.root), /范围/)
  } finally { await f.close() }
})
