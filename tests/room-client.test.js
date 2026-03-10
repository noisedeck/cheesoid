import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomClient } from '../server/lib/room-client.js'

describe('RoomClient', () => {
  it('constructs with config', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: () => {},
    })
    assert.equal(client.roomName, 'test-room')
    assert.equal(client.url, 'http://localhost:3001')
    assert.equal(client.connected, false)
  })

  it('parses SSE data lines', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: () => {},
    })
    const event = client._parseSSE('data: {"type":"user_message","name":"alice","text":"hello"}')
    assert.deepEqual(event, { type: 'user_message', name: 'alice', text: 'hello' })
  })

  it('returns null for non-data SSE lines', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: () => {},
    })
    assert.equal(client._parseSSE(''), null)
    assert.equal(client._parseSSE(':comment'), null)
    assert.equal(client._parseSSE('event: ping'), null)
  })

  it('filters echo messages (own name)', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'hello' })
    client._handleEvent({ type: 'user_message', name: 'Brad', text: 'my own echo' })
    assert.equal(received.length, 1)
    assert.equal(received[0].name, 'alice')
    assert.equal(received[0].room, 'test-room')
  })

  it('tags events with room name', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'hello' })
    assert.equal(received[0].room, 'test-room')
  })

  it('processes scrollback messages and tags them as scrollback', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({
      type: 'scrollback',
      messages: [
        { type: 'user_message', name: 'alice', text: 'earlier' },
        { type: 'assistant_message', text: 'response' },
        { type: 'user_message', name: 'Brad', text: 'my echo' },
      ],
    })
    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'user_message')
    assert.equal(received[0].scrollback, true)
    assert.equal(received[1].type, 'assistant_message')
    assert.equal(received[1].scrollback, true)
  })

  it('tags live events as non-scrollback', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'live' })
    assert.equal(received[0].scrollback, false)
  })

  it('ignores presence/reset/error events from remote rooms', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Brad',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'presence', participants: ['alice'] })
    client._handleEvent({ type: 'reset' })
    client._handleEvent({ type: 'error', message: 'something' })
    assert.equal(received.length, 0)
  })
})
