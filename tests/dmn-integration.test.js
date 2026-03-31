import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, runHybridAgent } from '../server/lib/agent.js'

function makeProvider({ responses, supportsIntentRouting = false } = {}) {
  let callIndex = 0
  return {
    streamMessage: mock.fn(async (params, onEvent) => {
      const resp = responses[callIndex++] || responses[responses.length - 1]
      for (const block of resp.contentBlocks) {
        if (block.type === 'text') onEvent({ type: 'text', text: block.text })
      }
      return resp
    }),
    classifyIntent: mock.fn(async () => 'auto'),
    supportsIntentRouting,
  }
}

function makeTools(definitions = []) {
  return { definitions, execute: mock.fn(async (name) => ({ output: `result of ${name}` })) }
}

function collectEvents() {
  const events = []
  return { events, onEvent: (e) => events.push(e) }
}

const textResponse = (text) => ({
  contentBlocks: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20 },
})

const dmnResponse = {
  contentBlocks: [{ type: 'text', text: 'SITUATION: Test.\nINTERPRETATION: Greeting.\nAPPROACH: Be brief.' }],
  stopReason: 'end_turn',
  usage: { input_tokens: 50, output_tokens: 30 },
}

describe('DMN in runAgent', () => {
  it('enriches user message when DMN is configured', async () => {
    const dmnProvider = makeProvider({ responses: [dmnResponse] })

    // Capture the user message content at call time (before restoration)
    let capturedUserMsg = null
    const mainProvider = {
      streamMessage: mock.fn(async (params, onEvent) => {
        capturedUserMsg = params.messages[0].content
        onEvent({ type: 'text', text: 'Hello!' })
        return textResponse('Hello!')
      }),
      classifyIntent: mock.fn(async () => 'auto'),
    }

    const messages = [{ role: 'user', content: 'alice: hi there' }]
    const config = {
      provider: mainProvider,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'You are the interpretive layer.',
      displayName: 'Brad',
    }
    const { onEvent } = collectEvents()

    await runAgent('system', messages, makeTools(), config, onEvent)

    // DMN provider should have been called
    assert.equal(dmnProvider.streamMessage.mock.callCount(), 1)

    // Main provider should have seen the enriched message (captured at call time)
    assert.ok(capturedUserMsg.includes("[Brad's read]"))
    assert.ok(capturedUserMsg.includes('SITUATION: Test'))
    assert.ok(capturedUserMsg.includes('[message]'))
    assert.ok(capturedUserMsg.includes('alice: hi there'))

    // After completion, messages should be restored to raw
    const finalUserMsg = messages.find(m => m.role === 'user' && typeof m.content === 'string')
    assert.equal(finalUserMsg.content, 'alice: hi there')
  })

  it('skips DMN when not configured', async () => {
    const mainProvider = makeProvider({ responses: [textResponse('Hello!')] })
    const messages = [{ role: 'user', content: 'alice: hi' }]
    const config = { provider: mainProvider, model: 'sonnet' }
    const { onEvent } = collectEvents()

    await runAgent('system', messages, makeTools(), config, onEvent)

    const mainCall = mainProvider.streamMessage.mock.calls[0]
    const userMsg = mainCall.arguments[0].messages[0].content
    assert.equal(userMsg, 'alice: hi')
  })

  it('continues without enrichment when DMN fails', async () => {
    const dmnProvider = {
      streamMessage: mock.fn(async () => { throw new Error('overloaded') }),
    }
    const mainProvider = makeProvider({ responses: [textResponse('Hello!')] })

    const messages = [{ role: 'user', content: 'alice: hi' }]
    const config = {
      provider: mainProvider,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'prompt',
      displayName: 'Brad',
    }
    const { onEvent } = collectEvents()

    await runAgent('system', messages, makeTools(), config, onEvent)

    // Main provider should still have been called with raw message
    const mainCall = mainProvider.streamMessage.mock.calls[0]
    assert.equal(mainCall.arguments[0].messages[0].content, 'alice: hi')
  })
})

describe('DMN in runHybridAgent', () => {
  it('runs DMN in cognition mode', async () => {
    const dmnProvider = makeProvider({ responses: [dmnResponse] })

    // Capture the user message content at call time (before restoration)
    let capturedUserMsg = null
    const orchestrator = {
      streamMessage: mock.fn(async (params, onEvent) => {
        capturedUserMsg = params.messages[0].content
        const resp = textResponse('Thoughtful response.')
        onEvent({ type: 'text', text: 'Thoughtful response.' })
        return resp
      }),
      classifyIntent: mock.fn(async () => 'auto'),
    }

    const messages = [{ role: 'user', content: 'alice: what do you think about this?' }]
    const config = {
      provider: orchestrator,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'You are the interpretive layer.',
      displayName: 'Brad',
      modality: { mode: 'cognition' },
    }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', messages, makeTools(), config, onEvent)

    assert.equal(dmnProvider.streamMessage.mock.callCount(), 1)

    // Orchestrator should see enriched message (captured at call time)
    assert.ok(capturedUserMsg.includes("[Brad's read]"))
  })

  it('skips DMN in attention mode', async () => {
    const dmnProvider = makeProvider({ responses: [dmnResponse] })
    const orchestrator = makeProvider({ responses: [textResponse('Quick ack.')] })

    const messages = [{ role: 'user', content: 'alice: ok' }]
    const config = {
      provider: orchestrator,
      model: 'haiku',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'prompt',
      displayName: 'Brad',
      modality: { mode: 'attention' },
    }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', messages, makeTools(), config, onEvent)

    assert.equal(dmnProvider.streamMessage.mock.callCount(), 0)
  })

  it('runs DMN for non-modal personas (no modality)', async () => {
    const dmnProvider = makeProvider({ responses: [dmnResponse] })
    const orchestrator = makeProvider({ responses: [textResponse('Response.')] })

    const messages = [{ role: 'user', content: 'alice: hello' }]
    const config = {
      provider: orchestrator,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'prompt',
      displayName: 'EHSRE',
    }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', messages, makeTools(), config, onEvent)

    assert.equal(dmnProvider.streamMessage.mock.callCount(), 1)
  })

  it('includes DMN usage in done event total', async () => {
    const dmnProvider = makeProvider({ responses: [{
      contentBlocks: [{ type: 'text', text: 'assessment' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 150, output_tokens: 40 },
    }] })
    const orchestrator = makeProvider({ responses: [textResponse('Hi')] })

    const messages = [{ role: 'user', content: 'alice: hi' }]
    const config = {
      provider: orchestrator,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'prompt',
      displayName: 'Brad',
    }
    const { events, onEvent } = collectEvents()

    await runHybridAgent('system', messages, makeTools(), config, onEvent)

    const done = events.find(e => e.type === 'done')
    // Total should include DMN (150+40) + orchestrator (100+20)
    assert.equal(done.usage.input_tokens, 250)
    assert.equal(done.usage.output_tokens, 60)
  })

  it('restores raw message after completion', async () => {
    const dmnProvider = makeProvider({ responses: [dmnResponse] })
    const orchestrator = makeProvider({ responses: [textResponse('Response.')] })

    const messages = [{ role: 'user', content: 'alice: original message' }]
    const config = {
      provider: orchestrator,
      model: 'sonnet',
      dmnProvider,
      dmnModel: 'haiku',
      dmnPrompt: 'prompt',
      displayName: 'Brad',
    }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', messages, makeTools(), config, onEvent)

    const userMsg = messages.find(m => m.role === 'user' && typeof m.content === 'string')
    assert.equal(userMsg.content, 'alice: original message')
  })
})
