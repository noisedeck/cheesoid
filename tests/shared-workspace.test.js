import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSharedWorkspaceTools } from '../server/lib/shared-workspace.js'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('buildSharedWorkspaceTools', () => {
  async function makeSharedRoot(files = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-shared-'))
    for (const [name, content] of Object.entries(files)) {
      const fullPath = join(dir, name)
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, content)
    }
    return dir
  }

  it('exports correct definitions', async () => {
    const sharedRoot = await makeSharedRoot()
    const { definitions } = buildSharedWorkspaceTools(sharedRoot)
    const names = definitions.map(d => d.name)
    assert.ok(names.includes('list_shared'))
    assert.ok(names.includes('read_shared'))
    assert.ok(names.includes('write_shared'))
    assert.equal(definitions.length, 3)
  })

  it('handles() returns true for shared tool names, false for others', async () => {
    const sharedRoot = await makeSharedRoot()
    const { handles } = buildSharedWorkspaceTools(sharedRoot)
    assert.equal(handles('list_shared'), true)
    assert.equal(handles('read_shared'), true)
    assert.equal(handles('write_shared'), true)
    assert.equal(handles('read_memory'), false)
    assert.equal(handles('send_chat_message'), false)
    assert.equal(handles('unknown_tool'), false)
  })

  it('writes and reads a file', async () => {
    const sharedRoot = await makeSharedRoot()
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const writeResult = await execute('write_shared', { path: 'hello.txt', content: 'Hello, world!' })
    assert.equal(writeResult.is_error, undefined)
    const readResult = await execute('read_shared', { path: 'hello.txt' })
    assert.equal(readResult.output, 'Hello, world!')
  })

  it('creates parent directories on write', async () => {
    const sharedRoot = await makeSharedRoot()
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('write_shared', { path: 'deep/nested/dir/file.txt', content: 'nested content' })
    assert.equal(result.is_error, undefined)
    const content = await readFile(join(sharedRoot, 'deep/nested/dir/file.txt'), 'utf8')
    assert.equal(content, 'nested content')
  })

  it('lists files in root', async () => {
    const sharedRoot = await makeSharedRoot({
      'alpha.txt': 'a',
      'beta.txt': 'b',
    })
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('list_shared', {})
    assert.ok(result.output.includes('alpha.txt'))
    assert.ok(result.output.includes('beta.txt'))
  })

  it('lists files in subdirectory', async () => {
    const sharedRoot = await makeSharedRoot({
      'sub/one.txt': 'one',
      'sub/two.txt': 'two',
    })
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('list_shared', { path: 'sub' })
    assert.ok(result.output.includes('one.txt'))
    assert.ok(result.output.includes('two.txt'))
  })

  it('lists directories with trailing slash', async () => {
    const sharedRoot = await makeSharedRoot({
      'mydir/file.txt': 'x',
    })
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('list_shared', {})
    assert.ok(result.output.includes('mydir/'))
  })

  it('returns error for missing file', async () => {
    const sharedRoot = await makeSharedRoot()
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('read_shared', { path: 'nonexistent.txt' })
    assert.equal(result.is_error, true)
  })

  it('blocks directory traversal on read', async () => {
    const sharedRoot = await makeSharedRoot()
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('read_shared', { path: '../etc/passwd' })
    assert.equal(result.is_error, true)
    assert.ok(result.output.includes('outside'))
  })

  it('blocks directory traversal on write', async () => {
    const sharedRoot = await makeSharedRoot()
    const { execute } = buildSharedWorkspaceTools(sharedRoot)
    const result = await execute('write_shared', { path: '../../tmp/evil.txt', content: 'evil' })
    assert.equal(result.is_error, true)
    assert.ok(result.output.includes('outside'))
  })
})
