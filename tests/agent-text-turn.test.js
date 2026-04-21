// Regression test for history persistence in the single-model runAgent path.
//
// Bug fixed alongside this test: runAgent streamed text deltas to clients but
// never emitted `assistant_text_turn` / `assistant_thought_turn` events at the
// end of each iteration. chat-session.js only writes assistant messages to
// durable history from inside those events (see _handleAssistantTextTurn in
// chat-session.js — the in-code comment near the home-room branch of
// _processMessage explicitly notes "no post-loop history write needed" because
// text is flushed per-turn). Without the events, live replies showed in the
// UI via text_delta but disappeared on refresh because nothing ever recorded
// them to this.history or the on-disk jsonl.
//
// These tests mock a provider and assert that the agent loop emits the
// per-turn events with the expected text and model attribution.

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from '../server/lib/agent.js'

function makeTools(definitions = []) {
  const executeFn = mock.fn(async (name) => ({ output: `result of ${name}` }))
  return { definitions, execute: executeFn }
}

function makeProvider({ responses }) {
  let callIndex = 0
  const streamMessageFn = mock.fn(async (_params, _onEvent) => {
    return responses[callIndex++] || responses[responses.length - 1]
  })
  return { streamMessage: streamMessageFn }
}

function collectEvents() {
  const events = []
  return { events, onEvent: (e) => events.push(e) }
}

describe('runAgent — per-turn event emission', () => {
  it('emits assistant_text_turn for a text-only response', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'Hello there!' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }],
    })
    const tools = makeTools([])
    const config = { provider, model: 'test-model-1' }
    const { events, onEvent } = collectEvents()

    await runAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    const turns = events.filter(e => e.type === 'assistant_text_turn')
    assert.equal(turns.length, 1, 'exactly one assistant_text_turn event')
    assert.equal(turns[0].text, 'Hello there!')
    assert.equal(turns[0].model, 'test-model-1')
  })

  it('emits assistant_text_turn before tool execution when a turn has both text and tool_use', async () => {
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [
            { type: 'text', text: 'Let me check that.' },
            { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Done.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'test-model-2' }
    const { events, onEvent } = collectEvents()

    await runAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    const turns = events.filter(e => e.type === 'assistant_text_turn')
    assert.equal(turns.length, 2, 'one text turn per iteration that produced text')
    assert.equal(turns[0].text, 'Let me check that.')
    assert.equal(turns[1].text, 'Done.')

    // The first text turn must be emitted before the tool executes, so a UI
    // refresh mid-tool still sees the preamble.
    const firstTurnIdx = events.findIndex(e => e.type === 'assistant_text_turn')
    const toolResultIdx = events.findIndex(e => e.type === 'tool_result')
    assert.ok(firstTurnIdx < toolResultIdx, 'text turn precedes tool_result')
  })

  it('does not emit assistant_text_turn when a turn has no text content', async () => {
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Finished.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'test-model-3' }
    const { events, onEvent } = collectEvents()

    await runAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    const turns = events.filter(e => e.type === 'assistant_text_turn')
    assert.equal(turns.length, 1, 'only the turn with text emits assistant_text_turn')
    assert.equal(turns[0].text, 'Finished.')
  })

  it('emits assistant_thought_turn for provider-native thinking blocks', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [
          { type: 'thinking', thinking: 'Hmm, weighing options...' },
          { type: 'text', text: 'Go with option A.' },
        ],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }],
    })
    const tools = makeTools([])
    const config = { provider, model: 'test-model-4' }
    const { events, onEvent } = collectEvents()

    await runAgent('system', [{ role: 'user', content: 'which option?' }], tools, config, onEvent)

    const textTurns = events.filter(e => e.type === 'assistant_text_turn')
    assert.equal(textTurns.length, 1)
    assert.equal(textTurns[0].text, 'Go with option A.')

    const thoughtTurns = events.filter(e => e.type === 'assistant_thought_turn')
    assert.equal(thoughtTurns.length, 1)
    assert.equal(thoughtTurns[0].text, 'Hmm, weighing options...')
    assert.equal(thoughtTurns[0].model, 'test-model-4')
  })
})
