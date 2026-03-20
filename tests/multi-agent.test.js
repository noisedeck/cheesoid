import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Room } from '../server/lib/chat-session.js'
import { loadPersona } from '../server/lib/persona.js'
import { createAuthMiddleware } from '../server/lib/auth.js'
import chatRouter from '../server/routes/chat.js'

async function createTestPersona(name, displayName, extras = {}) {
  const dir = await mkdtemp(join(tmpdir(), `cheesoid-${name}-`))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), `You are ${displayName}.`)

  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'You are in a chat room. Be brief.')

  const config = {
    name,
    display_name: displayName,
    model: 'claude-sonnet-4-6',
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    ...extras,
  }

  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)

  return dir
}

async function startCheesoid(personaDir, port) {
  const persona = await loadPersona(personaDir)
  const app = express()
  app.use(express.json())
  app.locals.persona = persona
  app.locals.room = new Room(persona)
  app.locals.authMiddleware = createAuthMiddleware(persona.config.agents || null)
  app.use(chatRouter)
  const server = app.listen(port)
  return { app, server, room: app.locals.room }
}

describe('Multi-agent room', () => {
  const servers = []

  after(() => {
    for (const s of servers) {
      s.room.destroy()
      s.server.close()
    }
  })

  it('agent receives messages from remote room via addAgentMessage', async () => {
    // Host room on port 4001 that accepts agent connections
    const hostDir = await createTestPersona('host', 'Host', {
      agents: [{ name: 'Guest', secret: 'test-secret' }],
    })
    const host = await startCheesoid(hostDir, 4001)
    servers.push(host)

    // Simulate an agent posting via bearer auth
    const res = await fetch('http://localhost:4001/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret',
      },
      body: JSON.stringify({ message: 'hello from guest', name: 'Guest' }),
    })
    const body = await res.json()
    assert.equal(body.status, 'sent')

    // Verify the message was added to the room's conversation history
    // but did NOT trigger the agent (no assistant response)
    await new Promise(r => setTimeout(r, 100))
    const lastMsg = host.room.messages[host.room.messages.length - 1]
    assert.equal(lastMsg.role, 'user')
    assert.ok(lastMsg.content.includes('Guest'))
    assert.ok(lastMsg.content.includes('hello from guest'))
  })

  it('relayAgentEvent tracks visitor streams', async () => {
    const host = servers[0]
    host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'thinking...' })

    assert.ok(host.room._visitorStreams instanceof Map)
    assert.ok(host.room._visitorStreams.has('Brad'))
    assert.equal(host.room._visitorStreams.get('Brad').text, 'thinking...')

    // Clean up
    host.room.relayAgentEvent('Brad', { type: 'done' })
  })

  it('relayAgentEvent records history with tool summary on done', async () => {
    const host = servers[0]
    host.room.relayAgentEvent('Brad', { type: 'tool_start', name: 'read_memory' })
    host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'I checked ' })
    host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'the memory.' })
    host.room.relayAgentEvent('Brad', { type: 'done' })

    const lastHistory = host.room.history[host.room.history.length - 1]
    assert.equal(lastHistory.type, 'assistant_message')
    assert.equal(lastHistory.name, 'Brad')
    assert.equal(lastHistory.text, 'I checked the memory.')
    assert.deepEqual(lastHistory.tools, ['read_memory'])
  })

  it('POST /api/chat/event relays visitor streaming events', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret',
      },
      body: JSON.stringify({
        name: 'Guest',
        event: { type: 'text_delta', text: 'hello' },
      }),
    })
    const body = await res.json()
    assert.equal(body.status, 'relayed')
  })

  it('POST /api/chat/event rejects invalid token', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
      body: JSON.stringify({
        name: 'Intruder',
        event: { type: 'text_delta', text: 'nope' },
      }),
    })
    assert.equal(res.status, 401)
  })

  it('POST /api/chat/event requires agent auth', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'anon',
        event: { type: 'text_delta', text: 'nope' },
      }),
    })
    assert.equal(res.status, 403)
  })

  it('rejects invalid agent token', async () => {
    const res = await fetch('http://localhost:4001/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
      body: JSON.stringify({ message: 'should fail', name: 'Intruder' }),
    })
    assert.equal(res.status, 401)
  })
})
