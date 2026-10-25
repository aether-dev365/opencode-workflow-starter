import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-superpowers-fetch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('Superpowers preparation rejects an archive with the wrong digest before extraction', async t => {
  const { prepareSuperpowers } = await import('../scripts/fetch-superpowers.mjs')
  const root = temporary(t), archive = join(root, 'source.tar.gz'), directory = join(root, 'source')
  writeFileSync(archive, 'not the pinned source')
  await assert.rejects(prepareSuperpowers({ directory, archive }), /SHA-256/)
  assert.equal(existsSync(directory), false)
  assert.equal(readFileSync(archive, 'utf8'), 'not the pinned source')
})

test('Superpowers preparation refuses to overwrite an unverified existing cache', async t => {
  const { prepareSuperpowers } = await import('../scripts/fetch-superpowers.mjs')
  const root = temporary(t), directory = join(root, 'source')
  mkdirSync(directory)
  writeFileSync(join(directory, 'index.js'), 'keep local changes')
  await assert.rejects(prepareSuperpowers({ directory }), /缓存.*不匹配/)
  assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'keep local changes')
})
