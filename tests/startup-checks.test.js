import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runStartupChecks } from '../server/lib/startup-checks.js'

describe('runStartupChecks', () => {
  it('returns ok when all paths exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-startup-'))
    const file = join(dir, 'test-file.txt')
    await writeFile(file, 'exists')

    const result = runStartupChecks([dir, file])
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('returns missing paths that do not exist', async () => {
    const missing = '/this/path/does/not/exist/at/all'
    const result = runStartupChecks([missing])
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [missing])
  })

  it('returns ok with empty required paths', () => {
    const result = runStartupChecks([])
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('returns ok when called with undefined', () => {
    const result = runStartupChecks(undefined)
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('reports multiple missing paths', () => {
    const missing1 = '/no/such/path/one'
    const missing2 = '/no/such/path/two'
    const result = runStartupChecks([missing1, missing2])
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [missing1, missing2])
  })
})
