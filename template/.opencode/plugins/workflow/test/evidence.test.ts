import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEvidence } from '../evidence.ts'

test('evidence identity and real contained readable files are required', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-evidence-'))
  const outside = mkdtempSync(join(tmpdir(), 'workflow-external-'))
  try {
    writeFileSync(join(root, 'result.log'), 'exit=0\n')
    writeFileSync(join(outside, 'result.log'), 'not in checkout')
    symlinkSync(join(outside, 'result.log'), join(root, 'escape.log'))
    const expected = { base: 'a'.repeat(40), tree: 'b'.repeat(40) }
    const entry = { id: 'tests', units: ['tests'], kind: 'test', command: 'node --test', cwd: '.', exit: 0, inputs: {}, files: ['result.log'] }
    const put = (overrides: object = {}, row: object = {}) => writeFileSync(join(root, 'evidence.json'), JSON.stringify({ version: 1, ...expected, entries: [{ ...entry, ...row }], ...overrides }))
    put()
    assert.deepEqual(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems, [])
    put({ tree: 'c'.repeat(40) })
    assert.ok(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems.length)
    for (const files of [['escape.log'], ['../file'], ['missing.log']]) {
      put({}, { files })
      assert.ok(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems.length)
    }
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git/private'), 'data')
    put({}, { files: ['.git/private'] })
    assert.ok(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems.length)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('non-text evidence needs a readable companion regardless of its extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-evidence-'))
  try {
    writeFileSync(join(root, 'result.log'), 'capture shows the expected screen\n')
    const expected = { base: 'a'.repeat(40), tree: 'b'.repeat(40) }
    const entry = { id: 'device', units: ['tests'], kind: 'manual', command: 'manual capture', cwd: '.', exit: null, inputs: {}, files: ['capture.bin'] }
    const put = (row: object) => writeFileSync(join(root, 'evidence.json'), JSON.stringify({ version: 1, ...expected, entries: [{ ...entry, ...row }] }))
    for (const bytes of [Buffer.from([0xff, 0x00, 0x7f]), Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xff, 0x7f])]) {
      writeFileSync(join(root, 'capture.bin'), bytes)
      put({})
      assert.match(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems.join('\n'), /companion/)
      put({ companion: ['result.log'] })
      assert.deepEqual(validateEvidence(root, 'evidence.json', new Set(['tests']), expected).problems, [])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
