# OpenAI-Compatible Provider Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider abstraction so cheesoid personas can target OpenAI-compatible APIs while preserving the same agent loop, streaming, tool calling, and UI.

**Architecture:** Extract `streamOnce()` from `agent.js` into provider modules behind a common interface. A factory in `providers/index.js` returns the right provider based on `persona.yaml` config. `agent.js` calls `provider.streamMessage()` instead of the Anthropic SDK directly.

**Tech Stack:** Built-in `fetch` for OpenAI-compat REST API calls, `node:test` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-25-openai-compatible-provider-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/lib/providers/index.js` | Create | Factory: `getProvider(config)` returns correct provider |
| `server/lib/providers/anthropic.js` | Create | Anthropic provider: wraps `streamOnce` + model fallback |
| `server/lib/providers/openai-compat.js` | Create | OpenAI-compat provider: message/tool translation + streaming |
| `server/lib/providers/translate.js` | Create | Pure functions: Anthropic <-> OpenAI format conversion |
| `server/lib/agent.js` | Modify | Remove `streamOnce`, use `provider.streamMessage()` |
| `server/lib/chat-session.js` | Modify | Create provider in `initialize()`, pass to `runAgent()` |
| `tests/providers-anthropic.test.js` | Create | Tests for Anthropic provider (regression) |
| `tests/providers-translate.test.js` | Create | Tests for format translation functions |
| `tests/providers-openai-compat.test.js` | Create | Tests for OpenAI-compat streaming + tool accumulation |
| `tests/providers-factory.test.js` | Create | Tests for `getProvider()` factory |

---

### Task 1: Create translation functions

Pure functions that convert between Anthropic and OpenAI message/tool formats. No SDK dependency — just data transformation.

**Files:**
- Create: `server/lib/providers/translate.js`
- Create: `tests/providers-translate.test.js`

- [ ] **Step 1: Write failing tests for tool definition translation**

In `tests/providers-translate.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateToolDefs } from '../server/lib/providers/translate.js'

describe('translateToolDefs', () => {
  it('converts Anthropic tool defs to OpenAI function format', () => {
    const anthropic = [
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ]
    const result = translateToolDefs(anthropic)
    assert.deepEqual(result, [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ])
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(translateToolDefs([]), [])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-translate.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write failing tests for message translation**

Append to `tests/providers-translate.test.js`:

```javascript
import { translateMessages } from '../server/lib/providers/translate.js'

describe('translateMessages', () => {
  it('passes through simple user string messages', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const result = translateMessages('You are helpful.', messages)
    assert.deepEqual(result, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('translates assistant tool_use blocks to tool_calls', () => {
    const messages = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/x' } },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'Let me read that.')
    assert.equal(assistant.tool_calls.length, 1)
    assert.equal(assistant.tool_calls[0].id, 'toolu_1')
    assert.equal(assistant.tool_calls[0].function.name, 'read_file')
    assert.equal(assistant.tool_calls[0].function.arguments, '{"path":"/tmp/x"}')
  })

  it('translates user tool_result blocks to tool role messages', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"output":"file contents"}' },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const toolMsg = result.find(m => m.role === 'tool')
    assert.equal(toolMsg.tool_call_id, 'toolu_1')
    assert.equal(toolMsg.content, '{"output":"file contents"}')
  })

  it('strips server_tool_use and web_search_tool_result blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is what I found.' },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', search_results: [] },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'Here is what I found.')
    assert.equal(assistant.tool_calls, undefined)
  })

  it('strips thinking blocks from assistant messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'The answer.' },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'The answer.')
    assert.equal(assistant.tool_calls, undefined)
  })
})
```

- [ ] **Step 4: Implement translate.js**

Create `server/lib/providers/translate.js`:

```javascript
/**
 * Pure translation functions between Anthropic and OpenAI message/tool formats.
 */

/**
 * Convert Anthropic tool definitions to OpenAI function calling format.
 */
export function translateToolDefs(anthropicTools) {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

/**
 * Convert Anthropic-format conversation history to OpenAI message format.
 * Prepends system prompt as a system message.
 */
export function translateMessages(systemPrompt, messages) {
  const result = [{ role: 'system', content: systemPrompt }]

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // Content blocks — tool_result blocks become tool role messages
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            })
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = []
        const toolCalls = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
          // Skip: thinking, server_tool_use, web_search_tool_result, signature
        }

        const assistantMsg = { role: 'assistant', content: textParts.join('') || null }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        result.push(assistantMsg)
      }
    }
  }

  return result
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/providers-translate.test.js`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add server/lib/providers/translate.js tests/providers-translate.test.js
git commit -m "feat: add Anthropic <-> OpenAI format translation functions"
```

---

### Task 3: Create Anthropic provider

Extract `streamOnce()` and its helpers from `agent.js` into the Anthropic provider module.

**Files:**
- Create: `server/lib/providers/anthropic.js`
- Create: `tests/providers-anthropic.test.js`

- [ ] **Step 1: Write failing test for Anthropic provider creation**

In `tests/providers-anthropic.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicProvider } from '../server/lib/providers/anthropic.js'

describe('createAnthropicProvider', () => {
  it('throws when ANTHROPIC_API_KEY is not set', () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      assert.throws(() => createAnthropicProvider({}), /ANTHROPIC_API_KEY/)
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('returns an object with streamMessage method', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = createAnthropicProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-anthropic.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement anthropic.js**

Create `server/lib/providers/anthropic.js`. This is a direct extraction of `streamOnce`, `isOpusModel`, `isUnavailableError`, and `SONNET_FALLBACK` from `agent.js`:

```javascript
import { getClient } from '../ai-client.js'

const SONNET_FALLBACK = 'claude-sonnet-4-6'

function isOpusModel(model) {
  return model && model.includes('opus')
}

function isUnavailableError(err) {
  if (err.status === 529 || err.status === 503 || err.status === 404) return true
  if (err.errorType === 'overloaded_error' || err.errorType === 'api_error') return true
  return false
}

async function streamOnce(client, params, onEvent) {
  const stream = client.messages.stream(params)
  const contentBlocks = []
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'text') {
        contentBlocks.push({ type: 'text', text: '' })
      } else if (block.type === 'tool_use') {
        contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: '' })
        onEvent({ type: 'tool_start', name: block.name })
      } else if (block.type === 'server_tool_use') {
        contentBlocks.push({ type: 'server_tool_use', id: block.id, name: block.name, input: '' })
        onEvent({ type: 'tool_start', name: block.name, server: true })
      } else if (block.type === 'web_search_tool_result') {
        contentBlocks.push(block)
      } else if (block.type === 'thinking') {
        contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
      }
    } else if (event.type === 'content_block_delta') {
      const current = contentBlocks[contentBlocks.length - 1]
      if (!current) continue
      if (event.delta.type === 'text_delta') {
        current.text += event.delta.text
        onEvent({ type: 'text_delta', text: event.delta.text })
      } else if (event.delta.type === 'input_json_delta') {
        current.input += event.delta.partial_json
      } else if (event.delta.type === 'thinking_delta') {
        current.thinking += event.delta.thinking
        onEvent({ type: 'thinking_delta', text: event.delta.thinking })
      } else if (event.delta.type === 'signature_delta') {
        current.signature += event.delta.signature
      }
    } else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason
      if (event.usage) {
        usage.input_tokens += event.usage.input_tokens || 0
        usage.output_tokens += event.usage.output_tokens || 0
      }
    } else if (event.type === 'message_start' && event.message?.usage) {
      usage.input_tokens += event.message.usage.input_tokens || 0
      usage.output_tokens += event.message.usage.output_tokens || 0
    } else if (event.type === 'error') {
      const err = new Error(event.error?.message || 'Stream error')
      err.status = event.error?.type === 'overloaded_error' ? 529 : 500
      err.errorType = event.error?.type
      throw err
    }
  }

  return { contentBlocks, stopReason, usage }
}

export function createAnthropicProvider(_config) {
  const client = getClient()

  return {
    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget }, onEvent) {
      let activeModel = model

      const params = {
        model: activeModel,
        max_tokens: maxTokens,
        system,
        messages,
        tools: [...tools, ...(serverTools || [])],
        stream: true,
      }

      if (thinkingBudget && isOpusModel(activeModel)) {
        params.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
      }

      try {
        return await streamOnce(client, params, onEvent)
      } catch (err) {
        if (isOpusModel(activeModel) && isUnavailableError(err)) {
          console.warn(`[anthropic] ${activeModel} unavailable (${err.status}), falling back to ${SONNET_FALLBACK}`)
          onEvent({ type: 'model_fallback', from: activeModel, to: SONNET_FALLBACK })
          params.model = SONNET_FALLBACK
          delete params.thinking
          return await streamOnce(client, params, onEvent)
        }
        throw err
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/providers-anthropic.test.js`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/providers/anthropic.js tests/providers-anthropic.test.js
git commit -m "feat: extract Anthropic provider from agent.js"
```

---

### Task 4: Create OpenAI-compat provider

The core new functionality: streaming, tool call accumulation, reasoning capture.

**Files:**
- Create: `server/lib/providers/openai-compat.js`
- Create: `tests/providers-openai-compat.test.js`

- [ ] **Step 1: Write failing tests for provider creation and validation**

In `tests/providers-openai-compat.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatProvider } from '../server/lib/providers/openai-compat.js'

describe('createOpenAICompatProvider', () => {
  it('throws when base_url is missing', () => {
    assert.throws(
      () => createOpenAICompatProvider({ api_key: 'key' }),
      /base_url/,
    )
  })

  it('throws when api_key is missing', () => {
    assert.throws(
      () => createOpenAICompatProvider({ base_url: 'http://localhost' }),
      /api_key/,
    )
  })

  it('returns an object with streamMessage method', () => {
    const provider = createOpenAICompatProvider({
      base_url: 'http://localhost:8080/v1',
      api_key: 'test-key',
    })
    assert.equal(typeof provider.streamMessage, 'function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-openai-compat.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write failing tests for streaming text and reasoning**

Append to `tests/providers-openai-compat.test.js`. These tests use a helper that creates an async iterable simulating OpenAI SSE chunks:

```javascript
import { _processStream } from '../server/lib/providers/openai-compat.js'

function makeChunks(deltas) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield { choices: [{ delta, finish_reason: null }] }
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
  }
}

describe('_processStream', () => {
  it('accumulates text deltas', async () => {
    const events = []
    const stream = makeChunks([
      { content: 'Hello' },
      { content: ' world' },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 1)
    assert.equal(result.contentBlocks[0].type, 'text')
    assert.equal(result.contentBlocks[0].text, 'Hello world')
    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 })
    assert.deepEqual(events, [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ])
  })

  it('captures reasoning_content as thinking blocks', async () => {
    const events = []
    const stream = makeChunks([
      { reasoning_content: 'Let me think...' },
      { reasoning_content: ' yes.' },
      { content: 'The answer.' },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 2)
    assert.equal(result.contentBlocks[0].type, 'thinking')
    assert.equal(result.contentBlocks[0].thinking, 'Let me think... yes.')
    assert.equal(result.contentBlocks[1].type, 'text')
    assert.equal(result.contentBlocks[1].text, 'The answer.')
  })
})
```

- [ ] **Step 4: Write failing tests for tool call accumulation**

Append to `tests/providers-openai-compat.test.js`:

```javascript
function makeToolChunks(toolDeltas) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of toolDeltas) {
        yield { choices: [{ delta, finish_reason: null }] }
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
  }
}

describe('_processStream tool calls', () => {
  it('accumulates a single tool call across deltas', async () => {
    const events = []
    const stream = makeToolChunks([
      { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] },
      { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }] },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 1)
    assert.equal(result.contentBlocks[0].type, 'tool_use')
    assert.equal(result.contentBlocks[0].name, 'read_file')
    assert.deepEqual(result.contentBlocks[0].input, { path: '/tmp/x' })
    assert.equal(result.stopReason, 'tool_use')
    assert.deepEqual(events[0], { type: 'tool_start', name: 'read_file' })
  })

  it('handles multiple interleaved tool calls', async () => {
    const events = []
    const stream = makeToolChunks([
      { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] },
      { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'bash', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path":"/a"}' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '{"cmd":"ls"}' } }] },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 2)
    assert.equal(result.contentBlocks[0].name, 'read_file')
    assert.deepEqual(result.contentBlocks[0].input, { path: '/a' })
    assert.equal(result.contentBlocks[1].name, 'bash')
    assert.deepEqual(result.contentBlocks[1].input, { cmd: 'ls' })
  })
})
```

- [ ] **Step 5: Implement openai-compat.js**

Create `server/lib/providers/openai-compat.js`:

```javascript
import { translateMessages, translateToolDefs } from './translate.js'

const FINISH_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
}

/**
 * Process parsed SSE chunks into normalized content blocks.
 * Accepts an async iterable of parsed JSON objects (one per SSE data line).
 * Exported for testing — not part of the public provider interface.
 */
export async function _processStream(stream, onEvent) {
  const contentBlocks = []
  const toolCalls = new Map() // index -> { id, name, arguments }
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }
  let hasText = false
  let hasThinking = false

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    if (!choice) {
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens || 0
        usage.output_tokens = chunk.usage.completion_tokens || 0
      }
      continue
    }

    const delta = choice.delta || {}

    // Text content
    if (delta.content) {
      if (!hasText) {
        contentBlocks.push({ type: 'text', text: '' })
        hasText = true
      }
      const textBlock = contentBlocks.find(b => b.type === 'text')
      textBlock.text += delta.content
      onEvent({ type: 'text_delta', text: delta.content })
    }

    // Reasoning content (DeepSeek R1, etc.)
    if (delta.reasoning_content) {
      if (!hasThinking) {
        contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
        hasThinking = true
      }
      const thinkingBlock = contentBlocks.find(b => b.type === 'thinking')
      thinkingBlock.thinking += delta.reasoning_content
      onEvent({ type: 'thinking_delta', text: delta.reasoning_content })
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            id: tc.id || `toolu_oai_${idx}_${Date.now()}`,
            name: tc.function?.name || '',
            arguments: '',
          })
          if (tc.function?.name) {
            onEvent({ type: 'tool_start', name: tc.function.name })
          }
        }
        const entry = toolCalls.get(idx)
        if (tc.function?.arguments) {
          entry.arguments += tc.function.arguments
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      stopReason = FINISH_REASON_MAP[choice.finish_reason] || 'end_turn'
    }

    // Usage (may arrive in final chunk)
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens || 0
      usage.output_tokens = chunk.usage.completion_tokens || 0
    }
  }

  // Finalize tool calls into content blocks
  for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {}
    try {
      input = JSON.parse(tc.arguments || '{}')
    } catch {
      // leave as empty object
    }
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input,
    })
  }

  return { contentBlocks, stopReason, usage }
}

/**
 * Parse an SSE response body into an async iterable of parsed JSON chunks.
 * Handles the `data: [DONE]` sentinel and ignores empty/comment lines.
 * Exported for testing.
 */
export async function* _parseSSE(body) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data)
      } catch {
        // skip unparseable lines
      }
    }
  }
}

export function createOpenAICompatProvider(config) {
  if (!config.base_url) throw new Error('openai-compat provider requires base_url in persona config')
  if (!config.api_key) throw new Error('openai-compat provider requires api_key in persona config')

  const baseUrl = config.base_url.replace(/\/$/, '')
  const apiKey = config.api_key

  return {
    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget }, onEvent) {
      const openaiMessages = translateMessages(system, messages)
      const openaiTools = translateToolDefs(tools)

      const body = {
        model,
        max_tokens: maxTokens,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }

      if (openaiTools.length > 0) {
        body.tools = openaiTools
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`OpenAI-compat API error ${response.status}: ${text}`)
      }

      const stream = _parseSSE(response.body)
      return _processStream(stream, onEvent)
    },
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/providers-openai-compat.test.js`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add server/lib/providers/openai-compat.js tests/providers-openai-compat.test.js
git commit -m "feat: add OpenAI-compatible provider with streaming and tool support"
```

---

### Task 5: Create provider factory

**Files:**
- Create: `server/lib/providers/index.js`
- Create: `tests/providers-factory.test.js`

- [ ] **Step 1: Write failing tests for the factory**

In `tests/providers-factory.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider } from '../server/lib/providers/index.js'

describe('getProvider', () => {
  it('returns anthropic provider by default', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = getProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('returns anthropic provider when provider is "anthropic"', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = getProvider({ provider: 'anthropic' })
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('returns openai-compat provider when configured', () => {
    const provider = getProvider({
      provider: 'openai-compat',
      base_url: 'http://localhost:8080/v1',
      api_key: 'test-key',
    })
    assert.equal(typeof provider.streamMessage, 'function')
  })

  it('throws for unknown provider', () => {
    assert.throws(() => getProvider({ provider: 'nope' }), /Unknown provider/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-factory.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement index.js**

Create `server/lib/providers/index.js`:

```javascript
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatProvider } from './openai-compat.js'

export function getProvider(personaConfig) {
  const providerType = personaConfig.provider || 'anthropic'

  switch (providerType) {
    case 'anthropic':
      return createAnthropicProvider(personaConfig)
    case 'openai-compat':
      return createOpenAICompatProvider(personaConfig)
    default:
      throw new Error(`Unknown provider: ${providerType}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/providers-factory.test.js`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/providers/index.js tests/providers-factory.test.js
git commit -m "feat: add provider factory for selecting Anthropic or OpenAI-compat"
```

---

### Task 6: Refactor agent.js to use provider interface

Replace direct Anthropic SDK usage with the provider abstraction.

**Files:**
- Modify: `server/lib/agent.js`

- [ ] **Step 1: Rewrite agent.js**

Replace the entire contents of `server/lib/agent.js` with:

```javascript
/**
 * Run the agent loop. Calls onEvent with SSE events as it goes.
 * Delegates streaming to the provider (Anthropic, OpenAI-compat, etc.).
 * Handles tool execution and message assembly.
 */
export async function runAgent(systemPrompt, messages, tools, config, onEvent) {
  const { provider } = config
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  while (iterations < maxTurns) {
    const result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
      },
      onEvent,
    )

    const { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Finalize content blocks — parse tool input JSON (for providers that return raw strings)
    const assistantContent = contentBlocks.map(block => {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.input === 'string') {
        try {
          return { ...block, input: JSON.parse(block.input || '{}') }
        } catch {
          return { ...block, input: {} }
        }
      }
      return block
    })

    messages.push({ role: 'assistant', content: assistantContent })

    // If no tool use, we're done
    if (stopReason !== 'tool_use') break

    // Execute tools — always produce a tool_result for every tool_use,
    // even on error, to keep message history valid for the API
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input)
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })
    }

    messages.push({ role: 'user', content: toolResults })
    iterations++
  }

  onEvent({ type: 'done', usage: totalUsage })
  return { messages, usage: totalUsage }
}
```

- [ ] **Step 2: Run existing test suite to check for regressions**

Run: `npm test`
Expected: All existing tests pass. (Tests that don't depend on `agent.js` internals should be unaffected. If any test imported `streamOnce` or `getClient` from `agent.js`, it will need updating — but based on the test file list, none do.)

- [ ] **Step 3: Commit**

```bash
git add server/lib/agent.js
git commit -m "refactor: agent.js uses provider interface instead of direct Anthropic SDK"
```

---

### Task 7: Wire provider into chat-session.js

Connect the provider factory to the Room, so `runAgent` receives the provider.

**Files:**
- Modify: `server/lib/chat-session.js`

- [ ] **Step 1: Add provider import and initialization**

In `server/lib/chat-session.js`, add the import at the top (after the existing imports):

```javascript
import { getProvider } from './providers/index.js'
```

In the `initialize()` method, after the line `this.tools = await loadTools(dir, config, this.memory, this.state, this)`, add:

```javascript
    this.provider = getProvider(config)
```

- [ ] **Step 2: Pass provider in config objects**

Find the two `const config = {` blocks in `chat-session.js` (one in `_processMessage` around line 298, one in `_idleThought` around line 415). Add `provider: this.provider` to each:

In `_processMessage`:
```javascript
      const config = {
        model: this.persona.config.model,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: this.provider,
      }
```

In `_idleThought`:
```javascript
      const config = {
        model: this.persona.config.model,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: this.provider,
      }
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server/lib/chat-session.js
git commit -m "feat: wire provider factory into Room initialization and agent calls"
```

---

### Task 8: Update startup key check

The startup check in `server/index.js` currently validates `ANTHROPIC_API_KEY`. With the provider layer, this should only be required when the persona uses the Anthropic provider (or no provider, which defaults to Anthropic). Personas using `openai-compat` don't need it.

**Files:**
- Modify: `server/index.js` (or `server/lib/startup-checks.js` — check which validates the key)

- [ ] **Step 1: Update startup key validation**

In `server/index.js`, the `ANTHROPIC_API_KEY` check is at lines 30-33, *before* `loadPersona()` at line 38. Move the check after persona loading and make it conditional on provider type. Replace lines 30-33:

```javascript
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set')
  process.exit(1)
}
```

with nothing (delete those lines). Then, after line 39 (`console.log(...)`) and before the Room creation, add:

```javascript
const providerType = persona.config.provider || 'anthropic'
if (providerType === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set')
  process.exit(1)
}
```

This ensures the persona is loaded first so we can check its provider type.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "fix: make ANTHROPIC_API_KEY check conditional on provider type"
```

---

### Task 9: Manual integration test

Verify the full flow works end-to-end with both providers.

**Files:** None (manual verification)

- [ ] **Step 1: Test Anthropic path (regression)**

Start the dev server with the example persona (default Anthropic provider):

Run: `ANTHROPIC_API_KEY=<your-key> PERSONA=example npm run dev`

Open the web UI and send a message. Verify:
- Streaming text appears
- Tool calls work (try asking it to read a file)
- No console errors

- [ ] **Step 2: Test OpenAI-compat path**

Create a test persona config or modify `example/persona.yaml` temporarily to use an OpenAI-compatible provider. For example, using Together:

```yaml
provider: openai-compat
base_url: https://api.together.xyz/v1
api_key: ${TOGETHER_API_KEY}
model: meta-llama/Llama-3-70b-chat-hf
```

Start the server and send a message. Verify:
- Streaming text appears
- Tool calls work (if the model supports them)
- Reasoning output appears (if using a reasoning model like R1)

- [ ] **Step 3: Run full test suite one final time**

Run: `npm test`
Expected: All tests pass
