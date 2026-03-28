# Reasoning Model Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow cheesoid agents to voluntarily delegate to a pluggable reasoning model via a `deep_think` tool, and add fallback chains for orchestrator and reasoner models.

**Architecture:** The `deep_think` tool is a framework-level tool registered in `tools.js` when a `reasoner` model is configured. It calls the reasoning model via the provider registry and returns raw text. Orchestrator and reasoner both get fallback chain support mirroring the existing executor pattern.

**Tech Stack:** Node.js, node:test, existing provider registry + provider implementations.

---

### Task 1: Parse reasoner and orchestrator fallback config in persona.js

**Files:**
- Modify: `server/lib/persona.js:77-101` (validateOrchestrator)
- Test: `tests/persona.test.js`

- [ ] **Step 1: Write failing tests for new config fields**

Add to `tests/persona.test.js`:

```javascript
it('parses reasoner model string from config', async () => {
  const dir = await makePersona(`
name: test-reasoner
model: claude-sonnet-4-6
reasoner: o3:openai
`)
  const persona = await loadPersona(dir)
  assert.equal(persona.config.reasoner, 'o3:openai')
})

it('parses reasoner_fallback_models from config', async () => {
  const dir = await makePersona(`
name: test-reasoner-fallback
model: claude-sonnet-4-6
reasoner: o3:openai
reasoner_fallback_models:
  - o4-mini:openai
  - claude-opus-4-6
`)
  const persona = await loadPersona(dir)
  assert.deepEqual(persona.config.reasoner_fallback_models, ['o4-mini:openai', 'claude-opus-4-6'])
})

it('parses orchestrator_fallback_models from config', async () => {
  const dir = await makePersona(`
name: test-orch-fallback
model: claude-sonnet-4-6
orchestrator: claude-opus-4-6
orchestrator_fallback_models:
  - claude-sonnet-4-6
`)
  const persona = await loadPersona(dir)
  assert.equal(persona.config.orchestrator, 'claude-opus-4-6')
  assert.deepEqual(persona.config.orchestrator_fallback_models, ['claude-sonnet-4-6'])
})

it('logs reasoner config when present', async () => {
  const dir = await makePersona(`
name: test-reasoner-log
model: claude-sonnet-4-6
orchestrator: claude-opus-4-6
reasoner: o3:openai
`)
  const persona = await loadPersona(dir)
  assert.equal(persona.config.reasoner, 'o3:openai')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/persona.test.js`
Expected: All new tests PASS (YAML parsing is automatic — `persona.js` just loads the YAML and the fields come through). This confirms the baseline works without code changes.

- [ ] **Step 3: Add validation logging for reasoner config**

In `server/lib/persona.js`, after the `if (config.orchestrator)` block (line 26), add:

```javascript
  if (config.reasoner) {
    validateReasoner(config)
  }
```

Add the `validateReasoner` function after `validateOrchestrator`:

```javascript
function validateReasoner(config) {
  const name = config.name || 'unknown'
  const fallbacks = config.reasoner_fallback_models || []
  console.log(`[${name}] Reasoner: model=${config.reasoner}${fallbacks.length ? `, fallbacks=${fallbacks.join(',')}` : ''}`)
}
```

Also update `validateOrchestrator` to log orchestrator fallbacks when present. At the end of the `typeof orch === 'string'` branch (line 83), change:

```javascript
  if (typeof orch === 'string') {
    const fallbacks = config.orchestrator_fallback_models || []
    console.log(`[${name}] Hybrid mode: orchestrator=${orch}, executor=${config.model}${fallbacks.length ? `, orchestrator_fallbacks=${fallbacks.join(',')}` : ''}`)
    return
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/persona.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/persona.js tests/persona.test.js
git commit -m "feat: parse reasoner and orchestrator fallback config"
```

---

### Task 2: Register deep_think as a framework tool in tools.js

**Files:**
- Modify: `server/lib/tools.js:9` (loadTools signature), add `buildReasonerTools` function
- Modify: `server/lib/chat-session.js:99-100` (pass registry to loadTools)
- Test: `tests/tools-reasoner.test.js` (new file)

- [ ] **Step 1: Write failing tests**

Create `tests/tools-reasoner.test.js`:

```javascript
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
    const config = { reasoner: 'o3:openai', memory: { dir: 'memory/', auto_read: [] } }
    const registry = { resolve: () => ({ modelId: 'o3', provider: {} }) }

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
      resolve: (modelStr) => ({ modelId: 'o3', provider: mockProvider }),
    }
    const config = { reasoner: 'o3:openai', memory: { dir: 'memory/', auto_read: [] } }

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
      resolve: () => ({ modelId: 'o3', provider: failingProvider }),
    }
    const config = {
      reasoner: 'o3:openai',
      reasoner_fallback_models: [],
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
        if (modelStr === 'o3:openai') return { modelId: 'o3', provider: failingProvider }
        if (modelStr === 'claude-opus-4-6') return { modelId: 'claude-opus-4-6', provider: workingProvider }
        return { modelId: modelStr, provider: failingProvider }
      },
    }
    const config = {
      reasoner: 'o3:openai',
      reasoner_fallback_models: ['claude-opus-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    }

    const tools = await loadTools(dir, config, stubMemory(), stubState(), stubRoom(), registry)
    const result = await tools.execute('deep_think', { prompt: 'test' })

    assert.equal(result.output, 'Fallback result.')
    assert.equal(failingProvider.streamMessage.mock.callCount(), 1)
    assert.equal(workingProvider.streamMessage.mock.callCount(), 1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tools-reasoner.test.js`
Expected: FAIL — `loadTools` doesn't accept a `registry` parameter yet, and `deep_think` doesn't exist.

- [ ] **Step 3: Implement buildReasonerTools and update loadTools**

In `server/lib/tools.js`, update the `loadTools` function signature and body:

```javascript
export async function loadTools(personaDir, config, memory, state, room, registry) {
  const memoryTools = buildMemoryTools(memory, state)
  const sharedTools = buildSharedWorkspaceTools(process.env.SHARED_WORKSPACE_PATH || '/shared')
  const roomTools = buildRoomTools(room, config)
  const reasonerTools = buildReasonerTools(config, registry)
  let personaTools = { definitions: [], execute: async () => ({ error: 'unknown tool' }) }

  if (config.tools) {
    const toolsPath = join(personaDir, config.tools)
    const toolsUrl = pathToFileURL(toolsPath).href
    const mod = await import(toolsUrl)
    personaTools = {
      definitions: mod.definitions || [],
      execute: mod.execute || (async () => ({ error: 'not implemented' })),
    }
  }

  const allDefinitions = [...memoryTools.definitions, ...sharedTools.definitions, ...roomTools.definitions, ...reasonerTools.definitions, ...personaTools.definitions]

  async function execute(name, input, options) {
    if (memoryTools.handles(name)) {
      return memoryTools.execute(name, input)
    }
    if (sharedTools.handles(name)) {
      return sharedTools.execute(name, input)
    }
    if (roomTools.handles(name)) {
      return roomTools.execute(name, input)
    }
    if (reasonerTools.handles(name)) {
      return reasonerTools.execute(name, input, options)
    }
    return personaTools.execute(name, input)
  }

  return { definitions: allDefinitions, execute }
}
```

Add the `buildReasonerTools` function:

```javascript
const REASONER_SYSTEM = 'You are a reasoning assistant. Analyze the given problem carefully and thoroughly. Provide your conclusion.'

function buildReasonerTools(config, registry) {
  if (!config.reasoner || !registry) {
    return { definitions: [], handles: () => false, execute: async () => ({ error: 'unknown tool' }) }
  }

  const definitions = [
    {
      name: 'deep_think',
      description: 'Delegate a problem to a reasoning model for deep analysis. Use when a question requires careful multi-step reasoning, complex analysis, or strategic thinking that benefits from extended deliberation. Pass a self-contained prompt with all necessary context.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The question or problem to reason about, including any relevant context needed to think it through.',
          },
        },
        required: ['prompt'],
      },
    },
  ]

  async function execute(name, input, options) {
    const onEvent = options?.onEvent || (() => {})
    const models = [config.reasoner, ...(config.reasoner_fallback_models || [])]
    let lastErr

    for (const modelString of models) {
      const { modelId, provider } = registry.resolve(modelString)
      try {
        const result = await provider.streamMessage(
          {
            model: modelId,
            maxTokens: 16384,
            system: REASONER_SYSTEM,
            messages: [{ role: 'user', content: input.prompt }],
            tools: [],
            serverTools: [],
            thinkingBudget: config.chat?.thinking_budget || null,
          },
          onEvent,
        )

        const text = result.contentBlocks
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')

        return { output: text, _usage: result.usage, _model: modelId }
      } catch (err) {
        lastErr = err
        console.log(`[reasoner] ${modelId} failed: ${err.message}, trying next`)
      }
    }

    return { output: `Reasoning failed: ${lastErr?.message || 'all models unavailable'}`, is_error: true }
  }

  return { definitions, handles: (name) => name === 'deep_think', execute }
}
```

- [ ] **Step 4: Update chat-session.js to pass registry to loadTools**

In `server/lib/chat-session.js`, swap the order of lines 99-100 so registry is created before loadTools, and pass it:

```javascript
    this.registry = new ProviderRegistry(config)
    this.tools = await loadTools(dir, config, this.memory, this.state, this, this.registry)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/tools-reasoner.test.js`
Expected: All 5 tests PASS.

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All existing tests PASS. The extra `registry` parameter to `loadTools` is optional so existing call sites that don't pass it (none besides chat-session.js, but just in case) still work.

- [ ] **Step 7: Commit**

```bash
git add server/lib/tools.js server/lib/chat-session.js tests/tools-reasoner.test.js
git commit -m "feat: register deep_think tool when reasoner model configured"
```

---

### Task 3: Add orchestrator fallback support in agent.js

**Files:**
- Modify: `server/lib/agent.js:399-470` (runHybridAgent orchestrator call)
- Modify: `server/lib/chat-session.js:414-425` (pass orchestrator fallback config)
- Test: `tests/agent-hybrid.test.js`

- [ ] **Step 1: Write failing test for orchestrator fallback**

Add to `tests/agent-hybrid.test.js`:

```javascript
it('falls back to next orchestrator model on failure', async () => {
  const failingOrchestrator = {
    streamMessage: mock.fn(async () => {
      const err = new Error('overloaded')
      err.status = 529
      throw err
    }),
  }
  const workingOrchestrator = makeProvider({
    responses: [{
      contentBlocks: [{ type: 'text', text: 'Fallback response.' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    }],
  })

  const mockRegistry = {
    resolve(modelString) {
      if (modelString === 'claude-sonnet-4-6') return { modelId: 'claude-sonnet-4-6', provider: workingOrchestrator }
      return { modelId: modelString, provider: failingOrchestrator }
    },
  }

  const tools = makeTools([])
  const config = {
    provider: failingOrchestrator,
    model: 'claude-opus-4-6',
    orchestratorFallbackModels: ['claude-sonnet-4-6'],
    registry: mockRegistry,
  }
  const { events, onEvent } = collectEvents()

  const result = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

  assert.equal(failingOrchestrator.streamMessage.mock.callCount(), 1)
  assert.ok(workingOrchestrator.streamMessage.mock.callCount() >= 1)
  assert.ok(events.find(e => e.type === 'done'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-hybrid.test.js`
Expected: FAIL — no orchestrator fallback logic exists yet; the error propagates.

- [ ] **Step 3: Implement callOrchestratorWithFallback**

In `server/lib/agent.js`, add `callOrchestratorWithFallback` after the existing `callExecutorWithFallback` function (around line 384):

```javascript
function isOrchestratorRetryable(err) {
  if (err.status === 529 || err.status === 503 || err.status === 404) return true
  if (err.errorType === 'overloaded_error' || err.errorType === 'api_error') return true
  return false
}

async function callOrchestratorWithFallback(config, params, onEvent) {
  try {
    return await config.provider.streamMessage(params, onEvent)
  } catch (err) {
    if (!isOrchestratorRetryable(err) || !config.orchestratorFallbackModels?.length) {
      throw err
    }
    console.log(`[hybrid] orchestrator ${params.model} failed: ${err.message}, trying fallbacks`)

    for (const modelString of config.orchestratorFallbackModels) {
      const { modelId, provider } = config.registry.resolve(modelString)
      try {
        onEvent({ type: 'model_fallback', from: params.model, to: modelId })
        return await provider.streamMessage({ ...params, model: modelId }, onEvent)
      } catch (fallbackErr) {
        console.log(`[hybrid] orchestrator fallback ${modelId} failed: ${fallbackErr.message}`)
      }
    }
    throw err
  }
}
```

Then in `runHybridAgent`, replace the orchestrator `streamMessage` call (around line 455):

Change:
```javascript
    const result = await orchestrator.streamMessage(
      {
        model: config.model,
        ...
      },
      onEvent,
    )
```

To:
```javascript
    const result = await callOrchestratorWithFallback(
      config,
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: toolChoice === 'none' ? [] : tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
        toolChoice: toolChoice === 'none' ? undefined : toolChoice,
      },
      onEvent,
    )
```

- [ ] **Step 4: Pass orchestratorFallbackModels in chat-session.js**

In `server/lib/chat-session.js`, update the `agentConfig` object (around line 414):

Add this field to `agentConfig`:
```javascript
        orchestratorFallbackModels: hasOrchestrator ? (this.persona.config.orchestrator_fallback_models || []) : [],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agent-hybrid.test.js`
Expected: All tests PASS, including the new fallback test.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/lib/agent.js server/lib/chat-session.js tests/agent-hybrid.test.js
git commit -m "feat: orchestrator fallback chain support"
```

---

### Task 4: Track reasoner usage in agent.js

**Files:**
- Modify: `server/lib/agent.js:399-631` (runHybridAgent — usage tracking)
- Modify: `server/lib/agent.js:100-249` (runAgent — usage tracking for non-hybrid mode)
- Test: `tests/agent-hybrid.test.js`

- [ ] **Step 1: Write failing test for reasoner usage tracking**

Add to `tests/agent-hybrid.test.js`:

```javascript
it('tracks reasoner usage separately when deep_think is called', async () => {
  const provider = makeProvider({
    responses: [
      {
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'deep_think', input: JSON.stringify({ prompt: 'analyze this' }) }],
        stopReason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      {
        contentBlocks: [{ type: 'text', text: 'Based on my analysis...' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 40 },
      },
    ],
  })

  const deepThinkResult = { output: 'Deep reasoning result.', _usage: { input_tokens: 500, output_tokens: 200 }, _model: 'o3' }
  const tools = makeTools([{ name: 'deep_think', description: 'Reason deeply' }])
  tools.execute = mock.fn(async (name, input, options) => deepThinkResult)

  const config = { provider, model: 'claude-sonnet-4-6' }
  const { events, onEvent } = collectEvents()

  await runHybridAgent('system', [{ role: 'user', content: 'think hard' }], tools, config, onEvent)

  const doneEvent = events.find(e => e.type === 'done')
  assert.ok(doneEvent)
  // Total should include reasoner usage: 100+200+500=800 in, 20+40+200=260 out
  assert.equal(doneEvent.usage.input_tokens, 800)
  assert.equal(doneEvent.usage.output_tokens, 260)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-hybrid.test.js`
Expected: FAIL — currently, `tools.execute` is called with 2 args (no `options`), and `_usage` from the result isn't tracked.

- [ ] **Step 3: Implement reasoner usage tracking**

In `server/lib/agent.js`, in `runHybridAgent`, add a `reasonerUsage` tracker (after the existing `executorUsage` declaration around line 408):

```javascript
  let reasonerUsage = { input_tokens: 0, output_tokens: 0 }
```

Update the tool execution loop in `runHybridAgent` (around line 518) to pass `onEvent` and capture `_usage`:

```javascript
    let toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let toolResult
      try {
        toolResult = await tools.execute(block.name, block.input, { onEvent })
      } catch (err) {
        toolResult = { output: `Tool error: ${err.message}`, is_error: true }
      }
      if (toolResult._usage) {
        reasonerUsage.input_tokens += toolResult._usage.input_tokens
        reasonerUsage.output_tokens += toolResult._usage.output_tokens
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result: toolResult })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult),
      })
    }
```

Update the log line at the end of `runHybridAgent` (around line 628):

```javascript
  console.log(`[hybrid] orchestrator: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out | executor: ${executorUsage.input_tokens} in / ${executorUsage.output_tokens} out | reasoner: ${reasonerUsage.input_tokens} in / ${reasonerUsage.output_tokens} out | tools: ${totalToolTurns}`)
  onEvent({ type: 'done', usage: { input_tokens: totalUsage.input_tokens + executorUsage.input_tokens + reasonerUsage.input_tokens, output_tokens: totalUsage.output_tokens + executorUsage.output_tokens + reasonerUsage.output_tokens } })
```

Also apply the same `options` passthrough in `runAgent` (around line 215) for non-hybrid mode — change `tools.execute(block.name, block.input)` to `tools.execute(block.name, block.input, { onEvent })` and add the same `_usage` tracking. Add `reasonerUsage` tracking there too:

After the existing `totalUsage` declaration in `runAgent` (around line 107):
```javascript
  let reasonerUsage = { input_tokens: 0, output_tokens: 0 }
```

In the tool execution loop in `runAgent` (around line 215):
```javascript
      try {
        result = await tools.execute(block.name, block.input, { onEvent })
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      if (result._usage) {
        reasonerUsage.input_tokens += result._usage.input_tokens
        reasonerUsage.output_tokens += result._usage.output_tokens
      }
```

Update the done event in `runAgent` to include reasoner usage in the total.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agent-hybrid.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS. The extra `options` arg to `tools.execute` is optional, so existing mock tools in other tests still work.

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent.js tests/agent-hybrid.test.js
git commit -m "feat: track reasoner usage and pass onEvent to tool execution"
```

---

### Task 5: Add conditional deep_think guidance to system prompt

**Files:**
- Modify: `server/lib/prompt-assembler.js:240-257` (Anthropic prompt assembly)
- Modify: `server/lib/prompt-assembler.js:207-237` (OpenAI prompt assembly)
- Test: `tests/prompt-assembler.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/prompt-assembler.test.js`:

```javascript
it('includes deep_think guidance when reasoner is configured', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Test soul.',
    'prompts/system.md': 'System prompt.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Test',
    chat: { prompt: 'prompts/system.md' },
    reasoner: 'o3:openai',
    memory: { dir: 'memory/', auto_read: [] },
  })

  assert.ok(result.includes('deep_think'))
  assert.ok(result.includes('reasoning'))
})

it('excludes deep_think guidance when no reasoner configured', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Test soul.',
    'prompts/system.md': 'System prompt.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Test',
    chat: { prompt: 'prompts/system.md' },
    memory: { dir: 'memory/', auto_read: [] },
  })

  assert.ok(!result.includes('deep_think'))
})

it('includes deep_think guidance in openai-compat mode when reasoner configured', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Test soul.',
    'prompts/system.md': 'System prompt.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Test',
    provider: 'openai-compat',
    chat: { prompt: 'prompts/system.md' },
    reasoner: 'o3:openai',
    memory: { dir: 'memory/', auto_read: [] },
  })

  // OpenAI returns array of system messages
  assert.ok(Array.isArray(result))
  const allContent = result.map(s => s.content).join('\n')
  assert.ok(allContent.includes('deep_think'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/prompt-assembler.test.js`
Expected: FAIL — the `deep_think` text is not in any prompt yet.

- [ ] **Step 3: Add conditional deep_think guidance**

In `server/lib/prompt-assembler.js`, add the guidance constant near the other constants (around line 52):

```javascript
const REASONER_GUIDANCE = `## Deep Reasoning
You have access to \`deep_think\` for problems requiring careful multi-step reasoning or complex analysis. Use it when a question would benefit from extended deliberation — don't use it for simple lookups or straightforward responses. Pass a self-contained prompt with all necessary context.`
```

In the Anthropic assembly section (around line 250, after the hybrid tool discipline injection):

```javascript
  if (config.reasoner || config.reasoner_fallback_models?.length) {
    sections.push(REASONER_GUIDANCE)
  }
```

In the OpenAI-compat assembly section, add to the `layer1Parts` (around line 211, after the thinking approximation block):

```javascript
    if (config.reasoner || config.reasoner_fallback_models?.length) {
      layer1Parts.push(REASONER_GUIDANCE)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/prompt-assembler.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/prompt-assembler.js tests/prompt-assembler.test.js
git commit -m "feat: conditional deep_think guidance in system prompt"
```

---

### Task 6: Integration test — full reasoning delegation flow

**Files:**
- Test: `tests/agent-hybrid.test.js` (add integration-style test)

- [ ] **Step 1: Write integration test**

Add to `tests/agent-hybrid.test.js`:

```javascript
it('full reasoning flow: orchestrator calls deep_think, gets result, responds', async () => {
  const orchestrator = makeProvider({
    responses: [
      {
        // Orchestrator decides to think deeply
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'deep_think', input: { prompt: 'Is P=NP?' } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 50 },
      },
      {
        // Orchestrator uses reasoning result to respond
        contentBlocks: [{ type: 'text', text: 'After careful analysis, probably not.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 400, output_tokens: 80 },
      },
    ],
  })

  // Mock reasoning provider
  const reasoningProvider = {
    streamMessage: mock.fn(async (params, onEvent) => {
      onEvent({ type: 'thinking_delta', text: 'Let me consider the implications...' })
      onEvent({ type: 'text_delta', text: 'Analysis suggests P≠NP based on...' })
      return {
        contentBlocks: [{ type: 'text', text: 'Analysis suggests P≠NP based on...' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 150 },
      }
    }),
  }

  const mockRegistry = {
    resolve(modelString) {
      if (modelString === 'o3:openai') return { modelId: 'o3', provider: reasoningProvider }
      return { modelId: modelString, provider: orchestrator }
    },
  }

  // Build tools with deep_think via the actual loadTools path
  // (simulating what chat-session does)
  const deepThinkExecute = async (name, input, options) => {
    const onEvent = options?.onEvent || (() => {})
    const { modelId, provider } = mockRegistry.resolve('o3:openai')
    const result = await provider.streamMessage(
      { model: modelId, maxTokens: 16384, system: 'You are a reasoning assistant.', messages: [{ role: 'user', content: input.prompt }], tools: [], serverTools: [], thinkingBudget: null },
      onEvent,
    )
    const text = result.contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
    return { output: text, _usage: result.usage, _model: modelId }
  }

  const tools = {
    definitions: [{ name: 'deep_think', description: 'Reason deeply', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }],
    execute: mock.fn(async (name, input, options) => {
      if (name === 'deep_think') return deepThinkExecute(name, input, options)
      return { output: `result of ${name}` }
    }),
  }

  const config = { provider: orchestrator, model: 'claude-opus-4-6', registry: mockRegistry }
  const { events, onEvent } = collectEvents()

  const result = await runHybridAgent('system', [{ role: 'user', content: 'Is P=NP?' }], tools, config, onEvent)

  // Reasoning provider was called
  assert.equal(reasoningProvider.streamMessage.mock.callCount(), 1)

  // Thinking deltas were forwarded
  assert.ok(events.some(e => e.type === 'thinking_delta'))

  // Final response came from orchestrator
  const lastAssistant = result.messages[result.messages.length - 1]
  assert.equal(lastAssistant.role, 'assistant')
  assert.ok(lastAssistant.content.some(b => b.type === 'text' && b.text.includes('probably not')))

  // Done event includes all usage (orchestrator + reasoner)
  const doneEvent = events.find(e => e.type === 'done')
  assert.equal(doneEvent.usage.input_tokens, 200 + 400 + 300)
  assert.equal(doneEvent.usage.output_tokens, 50 + 80 + 150)
})
```

- [ ] **Step 2: Run the integration test**

Run: `node --test tests/agent-hybrid.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/agent-hybrid.test.js
git commit -m "test: integration test for full reasoning delegation flow"
```
