import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Memory } from '../server/lib/memory.js'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Memory', () => {
  async function makeMemoryDir(files = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-mem-'))
    const memDir = join(dir, 'memory')
    await mkdir(memDir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(memDir, name), content)
    }
    return { personaDir: dir, memDir }
  }

  it('loads context from auto-read files', async () => {
    const { personaDir } = await makeMemoryDir({
      'MEMORY.md': 'Core memory content.',
    })
    const mem = new Memory(personaDir, 'memory/')
    const ctx = await mem.loadContext(['MEMORY.md'])
    assert.equal(ctx, 'Core memory content.')
  })

  it('writes a new memory file', async () => {
    const { personaDir, memDir } = await makeMemoryDir()
    const mem = new Memory(personaDir, 'memory/')
    await mem.write('notes.md', 'Some notes.')
    const content = await readFile(join(memDir, 'notes.md'), 'utf8')
    assert.equal(content, 'Some notes.')
  })

  it('appends to an existing memory file', async () => {
    const { personaDir, memDir } = await makeMemoryDir({
      'log.md': 'Line 1.',
    })
    const mem = new Memory(personaDir, 'memory/')
    await mem.append('log.md', 'Line 2.')
    const content = await readFile(join(memDir, 'log.md'), 'utf8')
    assert.equal(content, 'Line 1.\nLine 2.')
  })

  it('lists available memory files', async () => {
    const { personaDir } = await makeMemoryDir({
      'MEMORY.md': 'core',
      'topics.md': 'topics',
    })
    const mem = new Memory(personaDir, 'memory/')
    const files = await mem.list()
    assert.ok(files.includes('MEMORY.md'))
    assert.ok(files.includes('topics.md'))
  })

  it('reads a specific memory file', async () => {
    const { personaDir } = await makeMemoryDir({
      'topics.md': 'Topic content.',
    })
    const mem = new Memory(personaDir, 'memory/')
    const content = await mem.read('topics.md')
    assert.equal(content, 'Topic content.')
  })

  it('returns null for missing files', async () => {
    const { personaDir } = await makeMemoryDir()
    const mem = new Memory(personaDir, 'memory/')
    const content = await mem.read('nope.md')
    assert.equal(content, null)
  })
})
