import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-tools-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  return dir
}

function stubMemory() {
  return { read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] }
}

function stubState() {
  return { load: async () => {}, save: async () => {}, update: () => {}, data: {} }
}

function stubRoom() {
  return { broadcast: () => {}, recordHistory: () => {}, chatLog: null, participants: new Map() }
}

describe('deep_think tool registration', () => {
  it('registers deep_think when reasoner is configured', async () => {
    const dir = await makeTmpDir()
    const config = { reasoner: ['claude-opus-4-6'], memory: { dir: 'memory/', auto_read: [] } }
    const registry = { resolve: () => ({ modelId: 'claude-opus-4-6', provider: {} }) }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), registry)

    const deepThink = tools.definitions.find(d => d.name === 'deep_think')
    assert.ok(deepThink, 'deep_think tool should be registered')
    assert.ok(deepThink.input_schema.properties.prompt, 'should have prompt property')
  })

  it('does NOT register deep_think when reasoner is not configured', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), null)

    const deepThink = tools.definitions.find(d => d.name === 'deep_think')
    assert.equal(deepThink, undefined, 'deep_think should not be registered without reasoner config')
  })

  it('deep_think calls reasoning model and returns text result', async () => {
    const dir = await makeTmpDir()
    const mockProvider = {
      streamMessage: mock.fn(async (params, onEvent) => {
        onEvent({ type: 'thinking_delta', text: 'reasoning...' })
        onEvent({ type: 'text_delta', text: 'The answer is 42.' })
        return {
          contentBlocks: [{ type: 'text', text: 'The answer is 42.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 100 },
        }
      }),
    }
    const registry = {
      resolve: (modelStr) => ({ modelId: 'claude-opus-4-6', provider: mockProvider }),
    }
    const config = { reasoner: ['claude-opus-4-6'], memory: { dir: 'memory/', auto_read: [] } }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), registry)
    const result = await tools.execute('deep_think', { prompt: 'What is the meaning of life?' })

    assert.ok(result.output.includes('The answer is 42.'))
    assert.equal(mockProvider.streamMessage.mock.callCount(), 1)

    // Verify it was called with minimal system prompt and no tools
    const callArgs = mockProvider.streamMessage.mock.calls[0].arguments[0]
    assert.ok(callArgs.system.includes('reasoning assistant'))
    assert.deepEqual(callArgs.tools, [])
    assert.equal(callArgs.messages.length, 1)
    assert.equal(callArgs.messages[0].role, 'user')
    assert.equal(callArgs.messages[0].content, 'What is the meaning of life?')
  })

  it('deep_think returns error result on provider failure', async () => {
    const dir = await makeTmpDir()
    const failingProvider = {
      streamMessage: mock.fn(async () => { throw new Error('model unavailable') }),
    }
    const registry = {
      resolve: () => ({ modelId: 'claude-opus-4-6', provider: failingProvider }),
    }
    const config = {
      reasoner: ['claude-opus-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), registry)
    const result = await tools.execute('deep_think', { prompt: 'test' })

    assert.ok(result.is_error)
    assert.ok(result.output.includes('model unavailable'))
  })

  it('deep_think tries fallback models on failure', async () => {
    const dir = await makeTmpDir()
    const failingProvider = {
      streamMessage: mock.fn(async () => { throw new Error('unavailable') }),
    }
    const workingProvider = {
      streamMessage: mock.fn(async (params, onEvent) => ({
        contentBlocks: [{ type: 'text', text: 'Fallback result.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      })),
    }
    const registry = {
      resolve: (modelStr) => {
        if (modelStr === 'claude-opus-4-6') return { modelId: 'claude-opus-4-6', provider: failingProvider }
        if (modelStr === 'claude-sonnet-4-6') return { modelId: 'claude-sonnet-4-6', provider: workingProvider }
        return { modelId: modelStr, provider: failingProvider }
      },
    }
    const config = {
      reasoner: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), registry)
    const result = await tools.execute('deep_think', { prompt: 'test' })

    assert.equal(result.output, 'Fallback result.')
    assert.equal(failingProvider.streamMessage.mock.callCount(), 1)
    assert.equal(workingProvider.streamMessage.mock.callCount(), 1)
  })
})
