import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

function mockPersona() {
  return {
    dir: '/tmp/fake-persona',
    config: {
      name: 'test',
      display_name: 'Test',
      model: 'claude-sonnet-4-6',
      chat: { max_turns: 5 },
      memory: { dir: 'memory/' },
    },
  }
}

function mockSSEClient() {
  const stream = new PassThrough()
  stream.written = []
  const origWrite = stream.write.bind(stream)
  stream.write = (data) => {
    stream.written.push(data)
    return origWrite(data)
  }
  return stream
}

describe('Room keepalive', () => {
  it('starts heartbeat when first client connects', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const client = mockSSEClient()

    room.addClient(client, 'alice')
    assert.ok(room._heartbeatTimer, 'heartbeat timer should be set')

    client.emit('close')
    room.destroy()
  })

  it('stops heartbeat when last client disconnects', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const client = mockSSEClient()

    room.addClient(client, 'alice')
    assert.ok(room._heartbeatTimer)

    client.emit('close')
    assert.equal(room._heartbeatTimer, null, 'heartbeat timer should be cleared')

    room.destroy()
  })

  it('sends heartbeat comments to connected clients', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const client = mockSSEClient()

    room.addClient(client, 'alice')

    // Manually trigger heartbeat write
    for (const c of room.clients) {
      c.write(':heartbeat\n\n')
    }

    const heartbeats = client.written.filter(d => d === ':heartbeat\n\n')
    assert.ok(heartbeats.length > 0, 'should have written heartbeat comment')

    client.emit('close')
    room.destroy()
  })

  it('does not inject join/leave into agent context', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const client = mockSSEClient()

    room.addClient(client, 'bob')
    client.emit('close')

    const presenceMessages = room.messages.filter(m =>
      m.content.includes('has joined') || m.content.includes('has left')
    )
    assert.equal(presenceMessages.length, 0, 'join/leave should not pollute agent context')

    room.destroy()
  })

  it('still broadcasts presence events to SSE clients', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const client = mockSSEClient()

    room.addClient(client, 'carol')

    const presenceEvents = client.written.filter(d => d.includes('"type":"presence"'))
    assert.ok(presenceEvents.length > 0, 'presence should still be broadcast to UI')

    client.emit('close')
    room.destroy()
  })
})
