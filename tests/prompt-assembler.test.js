import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePrompt } from '../server/lib/prompt-assembler.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('assemblePrompt', () => {
  async function makePersona(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-test-'))
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    return dir
  }

  it('assembles identity + SOUL + system prompt + memory in order', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the soul.',
      'prompts/system.md': 'System context here.',
      'memory/MEMORY.md': 'I remember things.',
    })

    const result = await assemblePrompt(dir, {
      display_name: 'Test Agent',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('Your name is Test Agent.'))
    assert.ok(result.includes('I am the soul.'))
    assert.ok(result.includes('System context here.'))
    assert.ok(result.includes('I remember things.'))

    // Order: identity → SOUL → system → memory
    const nameIdx = result.indexOf('Your name is Test Agent.')
    const soulIdx = result.indexOf('I am the soul.')
    const systemIdx = result.indexOf('System context here.')
    const memoryIdx = result.indexOf('I remember things.')
    assert.ok(nameIdx < soulIdx)
    assert.ok(soulIdx < systemIdx)
    assert.ok(systemIdx < memoryIdx)
  })

  it('works when memory files are missing', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the soul.',
      'prompts/system.md': 'System context.',
    })
    await mkdir(join(dir, 'memory'), { recursive: true })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('I am the soul.'))
    assert.ok(result.includes('System context.'))
  })

  it('reads multiple memory files', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Core memory.',
      'memory/topics.md': 'Topic notes.',
    })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md', 'topics.md'] },
    })

    assert.ok(result.includes('Core memory.'))
    assert.ok(result.includes('Topic notes.'))
  })
})
