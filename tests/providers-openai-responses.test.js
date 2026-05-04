import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { _processResponsesStream } from '../server/lib/providers/openai-responses.js'

async function* eventStream(events) {
  for (const e of events) yield e
}

describe('_processResponsesStream', () => {
  it('throws when stream contains an error event', async () => {
    // Real-world: HTTP 200 response, body streams `event: error` with
    // insufficient_quota. The previous parser silently swallowed this and
    // returned { contentBlocks: [], stopReason: null, usage: 0/0 }, which
    // surfaced as `degenerate idle thought` instead of triggering the
    // orchestrator fallback chain.
    const stream = eventStream([
      { type: 'response.created', response: { id: 'resp_x', status: 'in_progress' } },
      { type: 'response.in_progress', response: { id: 'resp_x', status: 'in_progress' } },
      {
        type: 'error',
        error: {
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      },
    ])

    await assert.rejects(
      _processResponsesStream(stream, () => {}),
      (err) => {
        assert.match(err.message, /quota/i, 'error message should preserve provider detail')
        assert.equal(err.errorType, 'insufficient_quota')
        return true
      },
    )
  })

  it('throws when stream ends with response.failed and no preceding error event', async () => {
    // Defensive: the OpenAI Responses API normally emits both `error` and
    // `response.failed`, but if only the latter arrives we still need to
    // throw rather than return empty.
    const stream = eventStream([
      { type: 'response.created', response: { id: 'resp_x', status: 'in_progress' } },
      {
        type: 'response.failed',
        response: {
          id: 'resp_x',
          status: 'failed',
          error: { code: 'server_error', message: 'Internal server error' },
        },
      },
    ])

    await assert.rejects(
      _processResponsesStream(stream, () => {}),
      (err) => {
        assert.match(err.message, /server error|failed/i)
        assert.equal(err.errorType, 'server_error')
        return true
      },
    )
  })

  it('returns normally on a successful response.completed stream', async () => {
    // Sanity check that the success path is unchanged.
    const stream = eventStream([
      { type: 'response.created', response: { id: 'resp_x', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_x',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 2 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
        },
      },
    ])

    const result = await _processResponsesStream(stream, () => {})

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.usage.input_tokens, 10)
    assert.equal(result.usage.output_tokens, 2)
    assert.equal(result.contentBlocks.length, 1)
    assert.equal(result.contentBlocks[0].type, 'text')
    assert.equal(result.contentBlocks[0].text, 'Hello world')
  })
})
