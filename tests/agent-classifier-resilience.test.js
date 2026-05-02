import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, runHybridAgent } from '../server/lib/agent.js'

function makeTools(definitions = []) {
  return {
    definitions,
    execute: mock.fn(async (name) => ({ output: `result of ${name}` })),
  }
}

function makeProvider({ responses, classifyIntentImpl }) {
  let callIndex = 0
  const streamMessage = mock.fn(async (params) => {
    const resp = responses[callIndex++] || responses[responses.length - 1]
    return resp
  })
  return {
    streamMessage,
    classifyIntent: mock.fn(classifyIntentImpl),
    supportsIntentRouting: true,
  }
}

describe('classifyIntent resilience', () => {
  // Use a user message whose heuristic returns 'uncertain' so classifyIntent
  // is actually invoked. Empty/short ambiguous text qualifies.
  const ambiguousUser = 'what happened yesterday'

  it('runHybridAgent defaults to "auto" when classifyIntent throws', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'OK.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 5 },
      }],
      classifyIntentImpl: async () => {
        const err = new Error('Gemini server error 503: high demand')
        err.status = 503
        throw err
      },
    })
    const tools = makeTools([{ name: 'bash', description: 'bash' }])
    const config = { provider, model: 'gemini-2.5-pro' }
    const onEvent = () => {}

    // Must NOT throw — graceful degradation.
    await runHybridAgent('system', [{ role: 'user', content: ambiguousUser }], tools, config, onEvent)

    // classifyIntent was attempted.
    assert.equal(provider.classifyIntent.mock.callCount(), 1)
    // streamMessage was still called (loop survived the classifier failure).
    assert.equal(provider.streamMessage.mock.callCount(), 1)
    // The streamMessage call received toolChoice 'auto' (the default).
    const params = provider.streamMessage.mock.calls[0].arguments[0]
    assert.equal(params.toolChoice, 'auto')
  })

  it('runHybridAgent uses classifier result when it succeeds', async () => {
    // Sanity check that the success path is unchanged.
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'OK.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 5 },
      }],
      classifyIntentImpl: async () => 'required',
    })
    const tools = makeTools([{ name: 'bash', description: 'bash' }])
    const config = { provider, model: 'gemini-2.5-pro' }
    const onEvent = () => {}

    await runHybridAgent('system', [{ role: 'user', content: ambiguousUser }], tools, config, onEvent)

    const params = provider.streamMessage.mock.calls[0].arguments[0]
    assert.equal(params.toolChoice, 'required')
  })

  it('runAgent defaults to "auto" when classifyIntent throws', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'OK.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 5 },
      }],
      classifyIntentImpl: async () => {
        throw new Error('classifier blew up')
      },
    })
    const tools = makeTools([{ name: 'bash', description: 'bash' }])
    const config = { provider, model: 'gemini-2.5-pro' }
    const onEvent = () => {}

    await runAgent('system', [{ role: 'user', content: ambiguousUser }], tools, config, onEvent)

    assert.equal(provider.classifyIntent.mock.callCount(), 1)
    assert.equal(provider.streamMessage.mock.callCount(), 1)
    const params = provider.streamMessage.mock.calls[0].arguments[0]
    assert.equal(params.toolChoice, 'auto')
  })

  it('runAgent uses classifier result when it succeeds', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'OK.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 5 },
      }],
      classifyIntentImpl: async () => 'none',
    })
    const tools = makeTools([{ name: 'bash', description: 'bash' }])
    const config = { provider, model: 'gemini-2.5-pro' }
    const onEvent = () => {}

    await runAgent('system', [{ role: 'user', content: ambiguousUser }], tools, config, onEvent)

    const params = provider.streamMessage.mock.calls[0].arguments[0]
    // toolChoice 'none' is mapped to undefined in the agent (and the tools list is emptied).
    // Either is acceptable; assert the pre-mapping value isn't 'auto'.
    assert.notEqual(params.toolChoice, 'auto')
  })
})
