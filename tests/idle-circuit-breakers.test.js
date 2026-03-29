import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

function makePersona(overrides = {}) {
  return {
    dir: '/tmp/test-persona',
    config: {
      name: 'test-agent',
      display_name: 'Test',
      model: 'test-model',
      ...overrides,
    },
    plugins: [],
  }
}

describe('Idle thought degenerate detection (Fix A)', () => {
  it('returns "degenerate" for trivial output with no tools', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test system prompt'
    room.tools = { definitions: [], execute: async () => ({}) }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    room.chatLog = { append: async () => {} }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: '' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 12 },
            }
          },
        },
      }),
    }
    room.messages = []

    const result = await room._idleThought()
    assert.equal(result, 'degenerate')
    assert.equal(room.messages.length, 0)
    room.destroy()
  })

  it('returns true for substantial output with tool use', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test system prompt'
    room.tools = {
      definitions: [{ name: 'bash', description: 'test' }],
      execute: async () => ({ output: 'result' }),
    }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    room.chatLog = { append: async () => {} }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            onEvent({ type: 'tool_start', name: 'bash' })
            onEvent({ type: 'text_delta', text: 'I checked the status and everything looks good.' })
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: 'I checked the status and everything looks good.' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 80 },
            }
          },
        },
      }),
    }
    room.messages = []

    const result = await room._idleThought()
    assert.equal(result, true)
    assert.ok(room.messages.length > 0)
    room.destroy()
  })

  it('suspends idle timer after 5 consecutive degenerate results', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room._consecutiveDegenerateCount = 4
    room._idleInterval = 1000
    room._destroyed = false

    room._consecutiveDegenerateCount++
    assert.equal(room._consecutiveDegenerateCount, 5)
  })
})

describe('Backoff protection from room messages (Fix B)', () => {
  it('source=user resets idle interval to base', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._consecutiveDegenerateCount = 3
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello', { source: 'user' })

    assert.equal(room._idleInterval, 30 * 60 * 1000)
    assert.equal(room._consecutiveDegenerateCount, 0)
    room.destroy()
  })

  it('source=room preserves idle interval but resets degenerate count', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._consecutiveDegenerateCount = 3
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello', { source: 'room' })

    assert.equal(room._idleInterval, 999999)
    assert.equal(room._consecutiveDegenerateCount, 0)
    room.destroy()
  })

  it('default source is "user" (backward compat)', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello')

    assert.equal(room._idleInterval, 30 * 60 * 1000)
    room.destroy()
  })
})
