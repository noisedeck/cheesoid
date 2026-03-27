import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Room } from '../server/lib/chat-session.js'
import { loadPersona } from '../server/lib/persona.js'

async function createTestPersona(name, displayName, extras = {}) {
  const dir = await mkdtemp(join(tmpdir(), `cheesoid-${name}-`))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), `You are ${displayName}.`)
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
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

describe('Venue-aware message tags', () => {
  const rooms = []
  after(() => rooms.forEach(r => r.destroy()))

  it('home message tag includes @domain from office_url', async () => {
    const dir = await createTestPersona('ehsre', 'EHSRE', {
      office_url: 'https://ehsre.noisefactor.io',
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    await room._processMessage('home', 'alex', 'hello')

    const msg = room.messages[0].content
    assert.match(msg, /\[home\/alex@ehsre\.noisefactor\.io\]/)
  })

  it('home message tag has no domain when office_url not set', async () => {
    const dir = await createTestPersona('basic', 'Basic')
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    await room._processMessage('home', 'alex', 'hello')

    const msg = room.messages[0].content
    assert.match(msg, /\[home\/alex\]/)
    assert.ok(!msg.includes('@'))
  })

  it('remote room message tag includes @domain from room config', async () => {
    const dir = await createTestPersona('visitor', 'Visitor', {
      rooms: [
        { url: 'http://brad:3000', name: 'brad', domain: 'brad.noisefactor.io', secret: 'test' },
      ],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    room.busy = false
    await room._processMessage('brad', 'alex', 'hey brad')

    const msg = room.messages[0].content
    assert.match(msg, /\[brad\/alex@brad\.noisefactor\.io\]/)
  })

  it('remote room tag has no domain when room config lacks domain', async () => {
    const dir = await createTestPersona('visitor2', 'Visitor2', {
      rooms: [
        { url: 'http://brad:3000', name: 'brad', secret: 'test' },
      ],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    room.busy = false
    await room._processMessage('brad', 'alex', 'hey')

    const msg = room.messages[0].content
    assert.match(msg, /\[brad\/alex\]/)
    assert.ok(!msg.includes('@'))
  })

  it('scrollback from remote room includes @domain', async () => {
    const dir = await createTestPersona('scroll', 'Scroll', {
      rooms: [
        { url: 'http://brad:3000', name: 'brad', domain: 'brad.noisefactor.io', secret: 'test' },
      ],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    room._handleRemoteEvent({
      type: 'user_message',
      room: 'brad',
      name: 'alex',
      text: 'scrollback msg',
      scrollback: true,
    })

    const msg = room.messages[0].content
    assert.match(msg, /\[brad\/alex@brad\.noisefactor\.io\]/)
  })

  it('assistant message from remote room includes @domain', async () => {
    const dir = await createTestPersona('assist', 'Assist', {
      rooms: [
        { url: 'http://brad:3000', name: 'brad', domain: 'brad.noisefactor.io', secret: 'test' },
      ],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    room._handleRemoteEvent({
      type: 'assistant_message',
      room: 'brad',
      name: 'Brad',
      text: 'response',
    })

    const msg = room.messages[0].content
    assert.match(msg, /\[brad\/assistant@brad\.noisefactor\.io\]/)
  })

  it('backchannel from remote room includes @domain', async () => {
    const dir = await createTestPersona('bc', 'BC', {
      rooms: [
        { url: 'http://brad:3000', name: 'brad', domain: 'brad.noisefactor.io', secret: 'test' },
      ],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    room._handleRemoteEvent({
      type: 'backchannel',
      room: 'brad',
      name: 'Brad',
      text: 'private coordination',
    })

    const msg = room.messages[0].content
    assert.match(msg, /\[backchannel\/brad\/Brad@brad\.noisefactor\.io\]/)
  })

  it('strips protocol and port from office_url for domain', async () => {
    const dir = await createTestPersona('strip', 'Strip', {
      office_url: 'https://ehsre.yip.computer:443',
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)
    rooms.push(room)
    await room.initialize()

    room.messages = []
    await room._processMessage('home', 'alex', 'test')

    const msg = room.messages[0].content
    assert.match(msg, /\[home\/alex@ehsre\.yip\.computer\]/)
    assert.ok(!msg.includes(':443'))
  })
})
