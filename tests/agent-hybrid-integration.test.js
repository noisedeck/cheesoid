import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'

function makeTools(definitions = [], executeResults = {}) {
  const executeFn = mock.fn(async (name, input) => {
    // Look up by command if it's a bash call, otherwise by name
    if (name === 'bash' && input.command && executeResults[input.command]) {
      return executeResults[input.command]
    }
    if (executeResults[name]) {
      return executeResults[name]
    }
    return { output: `result of ${name}` }
  })
  return {
    definitions,
    execute: executeFn,
  }
}

function makeProvider({ responses, supportsIntentRouting = false, classifyIntentResult = 'auto' } = {}) {
  let callIndex = 0
  const streamMessageFn = mock.fn(async (params, onEvent) => {
    const resp = responses[callIndex++] || responses[responses.length - 1]
    for (const block of resp.contentBlocks) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', text: block.text })
      } else if (block.type === 'tool_use') {
        onEvent({ type: 'tool_start', name: block.name })
      }
    }
    return resp
  })

  const classifyIntentFn = mock.fn(async () => classifyIntentResult)

  const provider = {
    streamMessage: streamMessageFn,
    classifyIntent: classifyIntentFn,
  }

  if (supportsIntentRouting) {
    provider.supportsIntentRouting = true
  }

  return provider
}

function collectEvents() {
  const events = []
  return { events, onEvent: (e) => events.push(e) }
}

describe('runHybridAgent integration', () => {
  it('multi-step tool chain: 3 tool calls then final text (wakeup round simulation)', async () => {
    // Four orchestrator turns:
    //   Turn 1: bash curl -s notifications
    //   Turn 2: bash curl -X POST statuses -d "reply"
    //   Turn 3: bash curl -s timeline
    //   Turn 4: text "Round complete."
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'curl -s notifications' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'curl -X POST statuses -d "reply"' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 120, output_tokens: 25 },
        },
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_3', name: 'bash', input: { command: 'curl -s timeline' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 140, output_tokens: 30 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Round complete.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 160, output_tokens: 15 },
        },
      ],
    })

    const executeResults = {
      'curl -s notifications': { output: '[{"id":"1","type":"mention"}]' },
      'curl -X POST statuses -d "reply"': { output: '{"id":"99","text":"reply"}' },
      'curl -s timeline': { output: '[{"id":"10"},{"id":"11"}]' },
    }

    const tools = makeTools([{ name: 'bash', description: 'Run a shell command' }], executeResults)
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent(
      'You are an SRE bot.',
      [{ role: 'user', content: 'Check notifications and post a reply, then fetch timeline.' }],
      tools,
      config,
      onEvent,
    )

    // Orchestrator was called 4 times
    assert.equal(provider.streamMessage.mock.callCount(), 4, 'orchestrator should be called 4 times')

    // 3 tool_result events emitted
    const toolResultEvents = events.filter(e => e.type === 'tool_result')
    assert.equal(toolResultEvents.length, 3, 'should have 3 tool_result events')
    assert.equal(toolResultEvents[0].name, 'bash')
    assert.equal(toolResultEvents[1].name, 'bash')
    assert.equal(toolResultEvents[2].name, 'bash')

    // tool_result events have the right inputs
    assert.equal(toolResultEvents[0].input.command, 'curl -s notifications')
    assert.equal(toolResultEvents[1].input.command, 'curl -X POST statuses -d "reply"')
    assert.equal(toolResultEvents[2].input.command, 'curl -s timeline')

    // tools.execute was called 3 times
    assert.equal(tools.execute.mock.callCount(), 3, 'tools.execute should be called 3 times')

    // final text_delta event for "Round complete."
    const textEvents = events.filter(e => e.type === 'text_delta')
    assert.equal(textEvents.length, 1, 'should have 1 text_delta event')
    assert.equal(textEvents[0].text, 'Round complete.')

    // usage summed across all 4 turns
    assert.equal(result.usage.input_tokens, 100 + 120 + 140 + 160, 'input_tokens should be summed')
    assert.equal(result.usage.output_tokens, 20 + 25 + 30 + 15, 'output_tokens should be summed')

    // done event carries summed usage
    const doneEvent = events.find(e => e.type === 'done')
    assert.ok(doneEvent, 'done event should be emitted')
    assert.equal(doneEvent.usage.input_tokens, 520)
    assert.equal(doneEvent.usage.output_tokens, 90)
  })

  it('intent routing fires for openai-compat orchestrator on ambiguous message', async () => {
    // Message "do something complex" won't match heuristic action verbs or conversation patterns,
    // so it should fall through to LLM classifier.
    const provider = makeProvider({
      supportsIntentRouting: true,
      classifyIntentResult: 'auto',
      responses: [
        {
          contentBlocks: [{ type: 'text', text: 'Sure, I can help with that.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 15 },
        },
      ],
    })

    const tools = makeTools([{ name: 'bash', description: 'Run a shell command' }])
    const config = { provider, model: 'gpt-4o' }
    const { onEvent } = collectEvents()

    await runHybridAgent(
      'You are a helpful agent.',
      [{ role: 'user', content: 'do something complex' }],
      tools,
      config,
      onEvent,
    )

    // classifyIntent must have been called because heuristic returns 'uncertain'
    assert.equal(provider.classifyIntent.mock.callCount(), 1, 'classifyIntent should be called for uncertain heuristic')

    // it should have been called with the right shape of args
    const callArgs = provider.classifyIntent.mock.calls[0].arguments[0]
    assert.ok(callArgs.model, 'classifyIntent call should include model')
    assert.ok(callArgs.messages, 'classifyIntent call should include messages')
    assert.ok(callArgs.tools, 'classifyIntent call should include tools')
  })

  it('no intent routing for anthropic orchestrator (supportsIntentRouting absent)', async () => {
    // Provider WITHOUT supportsIntentRouting — classifyIntent must never be called.
    const provider = makeProvider({
      supportsIntentRouting: false,
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'curl -s notifications' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'All done.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 10 },
        },
      ],
    })

    const tools = makeTools(
      [{ name: 'bash', description: 'Run a shell command' }],
      { 'curl -s notifications': { output: '[]' } },
    )
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent(
      'You are a helpful agent.',
      [{ role: 'user', content: 'do something complex' }],
      tools,
      config,
      onEvent,
    )

    // classifyIntent must never be called for non-intent-routing providers
    assert.equal(provider.classifyIntent.mock.callCount(), 0, 'classifyIntent must not be called for anthropic orchestrator')

    // Agent still works correctly — tool was executed
    assert.equal(tools.execute.mock.callCount(), 1, 'tool should still be executed')
    assert.equal(provider.streamMessage.mock.callCount(), 2, 'orchestrator should be called twice (tool + final)')

    // Final state is correct
    const doneEvent = events.find(e => e.type === 'done')
    assert.ok(doneEvent, 'done event should be emitted')
    assert.equal(result.usage.input_tokens, 220)
    assert.equal(result.usage.output_tokens, 30)
  })
})
