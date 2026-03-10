import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPersona } from '../server/lib/persona.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadPersona', () => {
  async function makePersona(yaml) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-persona-'))
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'persona.yaml'), yaml)
    await writeFile(join(dir, 'SOUL.md'), 'Test soul.')
    return dir
  }

  it('loads and parses persona.yaml', async () => {
    const dir = await makePersona(`
name: test
display_name: "Test Agent"
model: claude-sonnet-4-6
max_budget_usd: 3

chat:
  prompt: prompts/system.md
  thinking_budget: 8000
  max_turns: 10
  idle_timeout_minutes: 15

memory:
  dir: memory/
  auto_read:
    - MEMORY.md
`)

    const persona = await loadPersona(dir)
    assert.equal(persona.config.name, 'test')
    assert.equal(persona.config.model, 'claude-sonnet-4-6')
    assert.equal(persona.config.chat.thinking_budget, 8000)
    assert.equal(persona.dir, dir)
  })

  it('resolves ${ENV_VAR} references in config values', async () => {
    process.env.TEST_SECRET = 'my-secret-value'
    const dir = await makePersona(`
name: test
agents:
  - name: Brad
    secret: \${TEST_SECRET}
rooms:
  - url: http://localhost:3001
    secret: \${TEST_SECRET}
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.agents[0].secret, 'my-secret-value')
    assert.equal(persona.config.rooms[0].secret, 'my-secret-value')
    delete process.env.TEST_SECRET
  })

  it('throws on missing persona.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-empty-'))
    await assert.rejects(() => loadPersona(dir), /persona\.yaml/)
  })
})
