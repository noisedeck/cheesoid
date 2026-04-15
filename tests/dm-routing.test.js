// tests/dm-routing.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../server/lib/room-manager.js'

describe('DM routing', () => {
  it('routeDM broadcasts to both participants SSE clients', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: ['claude-sonnet-4-6'],
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)

    const received = { alice: [], bob: [], charlie: [] }
    const makeClient = (name) => ({
      write: (data) => received[name].push(JSON.parse(data.replace('data: ', '').trim())),
    })

    manager.addDMClient(makeClient('alice'), 'alice')
    manager.addDMClient(makeClient('bob'), 'bob')
    manager.addDMClient(makeClient('charlie'), 'charlie')

    manager.routeDM('alice', 'bob', 'hey bob', false)

    assert.strictEqual(received.alice.length, 1)
    assert.strictEqual(received.bob.length, 1)
    assert.strictEqual(received.charlie.length, 0)

    assert.strictEqual(received.alice[0].type, 'user_message')
    assert.strictEqual(received.alice[0].from, 'alice')
    assert.strictEqual(received.alice[0].to, 'bob')
    assert.strictEqual(received.alice[0].text, 'hey bob')
  })

  it('routeDM triggers agent processing when recipient is hub agent', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: ['claude-sonnet-4-6'],
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)

    let triggered = false
    // routeDM dispatches DMs addressed to the host via the default room's
    // processDM, not sendMessage. Stub processDM so the test doesn't attempt
    // a real cognition call (which would hang on missing credentials).
    manager._defaultRoom.processDM = async () => { triggered = true }

    manager.routeDM('alice', 'Hub', 'hey hub', false)
    assert.strictEqual(triggered, true)
  })
})
