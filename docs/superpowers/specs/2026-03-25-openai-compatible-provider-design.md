# OpenAI-Compatible Provider Layer

## Summary

Add an abstraction layer so cheesoid personas can target OpenAI-compatible APIs (Together, Groq, Fireworks, OpenRouter, etc.) while preserving the same agent loop, tool calling, streaming UI, and multi-agent coordination.

## Motivation

Currently cheesoid is hard-wired to the Anthropic SDK. Hosted providers offering OpenAI-compatible endpoints (e.g. Together with DeepSeek-R1) cannot be used. A provider abstraction lets each persona choose its backend while the rest of the framework stays unchanged.

## Design

### Provider Interface

A provider is a module that exports a single function:

```javascript
async function streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget }, onEvent)
```

**Parameters:**
- `model` — model identifier string (provider-specific)
- `maxTokens` — max output tokens (hardcoded to 16384 in `agent.js`, passed through to provider)
- `system` — system prompt string
- `messages` — conversation history in cheesoid's internal format (Anthropic-shaped: `{ role, content }` with content blocks)
- `tools` — array of tool definitions (cheesoid format, Anthropic-shaped)
- `serverTools` — array of server tool configs (Anthropic-specific, ignored by other providers)
- `thinkingBudget` — token budget for extended thinking/reasoning (null if disabled)

**onEvent callback** receives normalized events:

| Event | Shape | Source |
|-------|-------|--------|
| `text_delta` | `{ type, text }` | Incremental assistant text |
| `thinking_delta` | `{ type, text }` | Reasoning output (Anthropic thinking / OpenAI reasoning_content) |
| `tool_start` | `{ type, name, server? }` | Tool call initiated |
| `model_fallback` | `{ type, from, to }` | Model unavailable, switched |
| `error` | `{ type, error }` | Stream error |

**Return value:** `{ contentBlocks, stopReason, usage }`
- `contentBlocks` — array of content blocks in Anthropic format (`text`, `tool_use`, `thinking`)
- `stopReason` — normalized to `"end_turn"`, `"tool_use"`, `"max_tokens"`
- `usage` — `{ input_tokens, output_tokens }`

This is the same signature and return shape as the current `streamOnce()` function in `agent.js`. The refactor extracts `streamOnce` into provider modules.

**Event responsibility:** `tool_result` and `done` events remain the responsibility of `agent.js`, not providers. Providers only emit streaming events (`text_delta`, `thinking_delta`, `tool_start`, `model_fallback`, `error`). The agent loop handles tool execution and emits `tool_result` after running each tool, and `done` when the loop completes.

### Provider Implementations

#### `server/lib/providers/anthropic.js`

Wraps the current `streamOnce()` logic from `agent.js`:
- Uses `@anthropic-ai/sdk` client
- Handles `content_block_start`, `content_block_delta`, `message_delta` events
- Supports thinking blocks, server tools, signature deltas
- Implements opus-to-sonnet fallback on 529/503/404

Messages and tool definitions pass through as-is (they're already in Anthropic format).

#### `server/lib/providers/openai-compat.js`

Uses `fetch` (built into Node.js) to call the OpenAI-compatible REST API directly:

**Message translation (Anthropic -> OpenAI):**
- System prompt: `{ role: "system", content: systemPrompt }`
- User messages with string content: pass through
- User messages with content blocks: translate `tool_result` blocks to OpenAI `tool` role messages
- Assistant messages with content blocks: translate `tool_use` blocks to `tool_calls`, `thinking` blocks to metadata, `text` to `content`
- Anthropic-specific block types in history (`server_tool_use`, `web_search_tool_result`) are stripped during translation — they have no OpenAI equivalent and would cause errors if passed through

**Tool definition translation:**
- Anthropic `{ name, description, input_schema }` -> OpenAI `{ type: "function", function: { name, description, parameters } }`
- `serverTools` are skipped (Anthropic-specific; no OpenAI equivalent)

**Response translation (OpenAI -> Anthropic content blocks):**
- `choices[0].delta.content` -> `text` content block + `text_delta` event
- `choices[0].delta.reasoning_content` -> `thinking` content block + `thinking_delta` event (for R1 and similar)
- `choices[0].delta.tool_calls` -> `tool_use` content blocks + `tool_start` events
- `choices[0].finish_reason`: `"stop"` -> `"end_turn"`, `"tool_calls"` -> `"tool_use"`, `"length"` -> `"max_tokens"`

**Tool call streaming accumulation:**
OpenAI streams tool calls with an `index` field that identifies which tool call a delta belongs to. Multiple tool calls can be interleaved in a single response. The provider must:
1. Track an array of in-progress tool calls, keyed by `index`
2. When `delta.tool_calls[i]` arrives with a new `index` and `function.name`, create a new tool call entry and emit `tool_start`
3. Accumulate `function.arguments` string fragments per-index
4. On stream end, JSON-parse each accumulated arguments string and emit as `tool_use` content blocks with generated IDs (format: `toolu_oai_{index}_{timestamp}`)

**Token usage:**
- From `usage` object in final chunk or response: `prompt_tokens` -> `input_tokens`, `completion_tokens` -> `output_tokens`

**Thinking/reasoning:**
- No request-side reasoning parameter is sent. `thinkingBudget` is ignored for request construction in openai-compat.
- Reasoning tokens are captured opportunistically: if the model emits `reasoning_content` deltas (as DeepSeek R1 does automatically), they are captured as `thinking` content blocks and emitted as `thinking_delta` events.
- Models that don't emit `reasoning_content` simply produce no thinking blocks.

**Model fallback:**
- No automatic fallback. The OpenAI-compat provider does not assume anything about model availability hierarchies. If the model is unavailable, the error propagates.

#### `server/lib/providers/index.js`

Factory that returns the correct provider based on persona config:

```javascript
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

Both providers use a factory pattern for consistency. Each factory returns an object with a `streamMessage` method. The Anthropic factory reads `ANTHROPIC_API_KEY` from env; the OpenAI-compat factory reads `api_key` and `base_url` from persona config (already resolved by `persona.js` env var substitution). Both validate at creation time (missing keys throw immediately).

### Persona Configuration

New fields in `persona.yaml`:

```yaml
# Default (current behavior, no changes needed):
model: claude-sonnet-4-6

# OpenAI-compatible provider:
provider: openai-compat
base_url: https://api.together.xyz/v1
api_key: ${TOGETHER_API_KEY}
model: deepseek-ai/DeepSeek-R1
```

`api_key` uses the existing `${ENV_VAR}` substitution in `persona.js` — consistent with how agent secrets and other env-dependent values already work throughout persona config.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider` | No | `"anthropic"` | Provider type |
| `base_url` | If openai-compat | — | OpenAI-compatible API base URL |
| `api_key` | If openai-compat | — | API key (use `${ENV_VAR}` syntax) |
| `model` | Yes | — | Model identifier (provider-specific) |

### Changes to Existing Files

#### `server/lib/agent.js`

Refactored to use the provider interface:

1. Remove `import { getClient } from './ai-client.js'`
2. Remove `streamOnce()` function (moved to providers)
3. Remove `isOpusModel()`, `isUnavailableError()`, `SONNET_FALLBACK` (moved to anthropic provider)
4. `runAgent()` accepts a `provider` in its config and calls `provider.streamMessage()` instead of `streamOnce()`
5. The agent loop (tool execution, message assembly, iteration) stays in `agent.js` — only the streaming call is delegated

#### `server/lib/chat-session.js`

Minimal changes:
1. Import `getProvider` from `providers/index.js`
2. In `Room` constructor or `init()`, create the provider once: `this.provider = getProvider(persona.config)`
3. Pass `provider` in the config object to `runAgent()`
4. Add `provider` field to persona config (already read from YAML)

#### `server/lib/ai-client.js`

Retained as-is for the Anthropic provider. Not imported by `agent.js` anymore — only by `providers/anthropic.js`.

### No New Dependencies

The OpenAI-compat provider uses Node.js built-in `fetch` to call the REST API directly and parses SSE responses manually. No new npm packages required.

### What Doesn't Change

- `chat-session.js` event handling and broadcasting
- `prompt-assembler.js` — system prompt assembly
- `tools.js` — tool definitions and execution
- `room-client.js` — multi-agent coordination
- Client-side JS — SSE event types are unchanged
- Memory, state, chat log systems
- Auth layer
- All routes

### Feature Mapping

| Feature | Anthropic | OpenAI-compat |
|---------|-----------|---------------|
| Streaming | Native SDK streaming | `stream: true`, SSE chunks |
| Tool calling | Anthropic tool_use format | OpenAI function calling format (translated) |
| Extended thinking | `thinking` param, thinking blocks | `reasoning_content` in deltas (if supported) |
| Server tools (web_search) | Native | Skipped (not available) |
| Model fallback | opus -> sonnet | None (error propagates) |
| Signatures | Captured in thinking blocks | N/A |

### Error Handling

- Provider connection failures surface as `error` events to the UI, same as today
- Invalid `provider` in persona config throws at startup
- Missing `base_url` or `api_key` for openai-compat throws at startup

### Testing

- Existing test suite continues to pass (Anthropic path unchanged)
- New unit tests for message/tool translation functions (Anthropic <-> OpenAI format)
- Integration test with a mock OpenAI-compatible server to verify streaming and tool calling round-trip
