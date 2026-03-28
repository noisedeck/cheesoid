# Reasoning Model Delegation

Extend the cheesoid orchestration system to support voluntary delegation to a reasoning model for deeply analytical turns, mirroring the existing executor model pattern for tool use.

## Configuration

New fields in `persona.yaml`:

```yaml
model: claude-sonnet-4-6                # executor / main model
orchestrator: claude-opus-4-6           # orchestrator (hybrid mode)
orchestrator_fallback_models:            # NEW — fallback chain for orchestrator
  - claude-sonnet-4-6

reasoner: o3:openai                      # NEW — reasoning model (optional)
reasoner_fallback_models:                # NEW — fallback chain for reasoner
  - o4-mini:openai
  - claude-opus-4-6
```

All model strings resolve via the existing provider registry. The `reasoner` and `reasoner_fallback_models` fields are optional — when absent, the `deep_think` tool is not registered and no reasoning guidance appears in the system prompt.

The `orchestrator_fallback_models` field adds fallback support for the orchestrator, following the same pattern as the existing executor `fallback_models`.

## Tool Definition

When a reasoner is configured, the framework registers `deep_think` as a built-in tool alongside memory and room tools in `tools.js`:

```javascript
{
  name: 'deep_think',
  description: 'Delegate a problem to a reasoning model for deep analysis. Use when a question requires careful multi-step reasoning, complex analysis, or strategic thinking that benefits from extended deliberation. Pass a self-contained prompt with all necessary context.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The question or problem to reason about, including any relevant context needed to think it through.'
      }
    },
    required: ['prompt']
  }
}
```

The tool is a framework-level tool registered in `tools.js`, not a persona plugin. It receives the provider registry at construction time (same pattern as room tools getting the `room` object). The `onEvent` callback is per-request, so `tools.execute()` gains an optional second parameter: `tools.execute(name, input, { onEvent })`. The agent loop already has `onEvent` in scope and passes it through. When `onEvent` is not provided (e.g. in tests), thinking deltas are silently dropped.

## Execution Flow

When the orchestrator calls `deep_think(prompt)`:

1. Resolve the `reasoner` model string via registry (provider + modelId).
2. Call `provider.streamMessage()` with:
   - `model`: resolved modelId
   - `system`: `"You are a reasoning assistant. Analyze the given problem carefully and thoroughly. Provide your conclusion."`
   - `messages`: single user message containing the prompt from the tool input
   - `tools`: empty array (reasoner does not get tools)
   - `thinkingBudget`: from `chat.thinking_budget` (shared with orchestrator)
3. Stream `thinking_delta` events to the UI (collapsed by default in the frontend).
4. Return the final text response as the tool result string.
5. Track usage in a separate `reasonerUsage` bucket.

On failure: try each model in `reasoner_fallback_models` in order. If all fail, return an error result — the orchestrator continues without reasoning, same as any failed tool call.

## Orchestrator Fallback

Add `callOrchestratorWithFallback()` in `agent.js`, mirroring the existing `callExecutorWithFallback()`. On unavailability errors (529, 503, 404, overloaded), try the next model in `orchestrator_fallback_models`. Resolved via registry.

## System Prompt

The reasoner gets a minimal, fixed system prompt — no persona identity, no memory, no tool discipline. It is a thinking tool, not an actor.

When a reasoner is configured, the orchestrator's system prompt (assembled in `prompt-assembler.js`) includes guidance in the tool discipline section:

> You have access to `deep_think` for problems requiring careful multi-step reasoning or complex analysis. Use it when a question would benefit from extended deliberation — don't use it for simple lookups or straightforward responses.

This guidance is conditional — only present when `reasoner` or `reasoner_fallback_models` is defined in the persona config.

## Usage Tracking & Logging

Add a `reasonerUsage` bucket alongside `totalUsage` (orchestrator) and `executorUsage`:

```
[hybrid] orchestrator: 5000 in / 800 out | executor: 200 in / 50 out | reasoner: 3000 in / 1200 out | tools: 4
```

Reasoner usage rolls into the total reported in the `done` event so the UI's token counter stays accurate.

## Files Changed

| File | Change |
|------|--------|
| `server/lib/tools.js` | Register `deep_think` as framework tool when reasoner configured; pass registry + onEvent |
| `server/lib/agent.js` | `callOrchestratorWithFallback()`; reasoner usage tracking; updated log line |
| `server/lib/prompt-assembler.js` | Conditional deep_think guidance when reasoner configured |
| `server/lib/persona.js` | Parse `reasoner`, `reasoner_fallback_models`, `orchestrator_fallback_models` from config |

No provider changes needed — existing providers already support everything required.
