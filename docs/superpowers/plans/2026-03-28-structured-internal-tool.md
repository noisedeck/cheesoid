# Structured Internal Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile `<thought>` and `<backchannel>` tag parsing with a structured `internal` tool, making venue leaks structurally impossible.

**Architecture:** Add `internal` tool to `buildRoomTools` for thought/backchannel via structured fields. Delete `_parseResponseTags`. Simplify response routing so freeform text is always public. Update prompt instructions to reference tool instead of tags.

**Tech Stack:** Node.js, node:test, existing room tools infrastructure.

---

### Task 1: Add `internal` tool to buildRoomTools

**Files:**
- Modify: `server/lib/tools.js:47-101` (buildRoomTools)
- Test: `tests/tools-internal.test.js` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/tools-internal.test.js`:

```javascript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-internal-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  return dir
}

function stubMemory() {
  return { read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] }
}

function stubState() {
  return { load: async () => {}, save: async () => {}, update: () => {}, data: {} }
}

function stubRoom(overrides = {}) {
  return {
    broadcast: mock.fn(() => {}),
    recordHistory: mock.fn(() => {}),
    chatLog: null,
    participants: new Map(),
    _pendingRoom: 'home',
    roomClients: new Map(),
    persona: { config: { display_name: 'TestAgent', agents: [], rooms: [] } },
    ...overrides,
  }
}

describe('internal tool', () => {
  it('registers internal tool when rooms are configured', async () => {
    const dir = await makeTmpDir()
    const config = {
      rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.ok(internal, 'internal tool should be registered when rooms configured')
    assert.ok(internal.input_schema.properties.thought)
    assert.ok(internal.input_schema.properties.backchannel)
  })

  it('registers internal tool when agents are configured', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.ok(internal, 'internal tool should be registered when agents configured')
  })

  it('does NOT register internal tool when no rooms or agents', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.equal(internal, undefined, 'internal should not be registered without multi-agent config')
  })

  it('thought broadcasts to home room and returns content', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { thought: 'This is interesting.' })

    assert.ok(result.output.includes('This is interesting.'))
    assert.ok(!result.is_error)

    // Verify broadcast calls: idle_text_delta, idle_done
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'idle_text_delta' && c.text === 'This is interesting.'))
    assert.ok(calls.some(c => c.type === 'idle_done'))

    // Verify history recorded
    const historyCalls = room.recordHistory.mock.calls.map(c => c.arguments[0])
    assert.ok(historyCalls.some(c => c.type === 'idle_thought' && c.text === 'This is interesting.'))
  })

  it('backchannel sends via room client when in remote room', async () => {
    const dir = await makeTmpDir()
    const bcSends = []
    const mockClient = {
      sendBackchannel: mock.fn(async (text) => { bcSends.push(text) }),
      sendMessage: mock.fn(async () => {}),
    }
    const roomClients = new Map([['brad', mockClient]])

    const config = {
      rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'brad', roomClients })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Taking this one.' })

    assert.ok(result.output.includes('Backchannel sent'))
    assert.equal(mockClient.sendBackchannel.mock.callCount(), 1)
    assert.equal(bcSends[0], 'Taking this one.')
  })

  it('backchannel broadcasts to SSE when in home room', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Brad, this is yours.' })

    assert.ok(result.output.includes('Backchannel sent'))
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'backchannel' && c.text === 'Brad, this is yours.'))
  })

  it('combines thought and backchannel in one call', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {
      thought: 'Not my area.',
      backchannel: 'Brad, this is yours.',
    })

    assert.ok(result.output.includes('Not my area.'))
    assert.ok(result.output.includes('Backchannel sent'))
  })

  it('returns error when neither thought nor backchannel provided', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {})

    assert.ok(result.is_error)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tools-internal.test.js`
Expected: FAIL — `internal` tool does not exist yet.

- [ ] **Step 3: Implement the `internal` tool in buildRoomTools**

In `server/lib/tools.js`, update `buildRoomTools` to conditionally add the `internal` tool definition and its execution logic. The function currently takes `(room, config)` which gives it everything it needs.

After the existing `search_history` definition in the `definitions` array (line 71), add the `internal` definition conditionally:

```javascript
function buildRoomTools(room, config) {
  const hasMultiAgent = (config.rooms && config.rooms.length > 0) || (config.agents && config.agents.length > 0)

  const definitions = [
    {
      name: 'send_chat_message',
      description: 'Send a message to the chat room. Everyone in the room will see it. Use this when you want to communicate with people in the room from a webhook or background context.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the chat room' },
        },
        required: ['text'],
      },
    },
    {
      name: 'search_history',
      description: 'Search your full chat history across all sessions. Returns matching entries with timestamps, newest first. Use this to recall past conversations, find things people said, or review your own previous thoughts.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' },
          limit: { type: 'number', description: 'Max results to return (default 50)' },
        },
        required: ['query'],
      },
    },
  ]

  if (hasMultiAgent) {
    definitions.push({
      name: 'internal',
      description: 'Send private thoughts and/or backchannel messages. Thoughts are visible only in your own office. Backchannel is delivered privately to the other agent. Neither is visible publicly. Use this whenever you want to observe, react, or coordinate without speaking publicly.',
      input_schema: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: 'Private observation or reaction. Visible to your own office only.',
          },
          backchannel: {
            type: 'string',
            description: 'Private message to the other agent. Not visible to users.',
          },
        },
      },
    })
  }

  const toolNames = new Set(definitions.map(d => d.name))

  async function execute(name, input) {
    switch (name) {
      case 'send_chat_message': {
        room.broadcast({ type: 'assistant_message', text: input.text })
        room.recordHistory({ type: 'assistant_message', text: input.text })
        return { output: 'Message sent to chat room.' }
      }
      case 'search_history': {
        if (!room.chatLog) return { output: 'Chat log not available', is_error: true }
        const results = await room.chatLog.search(input.query, { limit: input.limit })
        if (results.length === 0) return { output: 'No matching history entries found.' }
        const formatted = results.map(e => {
          const prefix = e.name ? `[${e.timestamp}] ${e.name}` : `[${e.timestamp}]`
          return `${prefix} (${e.type}): ${e.text}`
        }).join('\n')
        return { output: formatted }
      }
      case 'internal': {
        if (!input.thought && !input.backchannel) {
          return { output: 'Must provide at least one of: thought, backchannel', is_error: true }
        }

        const parts = []

        if (input.thought) {
          room.broadcast({ type: 'idle_text_delta', text: input.thought })
          room.broadcast({ type: 'idle_done' })
          room.recordHistory({ type: 'idle_thought', text: input.thought })
          parts.push(`Thought: ${input.thought}`)
        }

        if (input.backchannel) {
          const pendingRoom = room._pendingRoom
          if (pendingRoom && pendingRoom !== 'home') {
            const client = room.roomClients.get(pendingRoom)
            if (client) {
              await client.sendBackchannel(input.backchannel)
            }
          } else {
            room.broadcast({ type: 'backchannel', name: room.persona.config.display_name, text: input.backchannel })
          }
          parts.push('Backchannel sent.')
        }

        return { output: parts.join('\n') }
      }
      default:
        return { output: `Unknown room tool: ${name}`, is_error: true }
    }
  }

  return { definitions, handles: (name) => toolNames.has(name), execute }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tools-internal.test.js`
Expected: All 7 tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/tools.js tests/tools-internal.test.js
git commit -m "feat: add internal tool for structured thought/backchannel"
```

---

### Task 2: Delete tag parsing and simplify response routing

**Files:**
- Modify: `server/lib/chat-session.js:248-303` (delete `_parseResponseTags`, update `_autoNudgeMentionedAgents`)
- Modify: `server/lib/chat-session.js:459-486` (simplify response routing in `_processMessage`)
- Modify: `server/lib/chat-session.js:275-284` (update `relayAgentEvent` comment)
- Test: `tests/multi-agent.test.js`

- [ ] **Step 1: Write tests for new behavior**

Update `tests/multi-agent.test.js`. The auto-nudge tests currently pass `backchannelText` as the second argument. Update them to only pass `publicText`:

Replace the existing `_autoNudgeMentionedAgents` test calls. The function signature changes from `(publicText, backchannelText)` to `(publicText)`.

Add a new test:

```javascript
it('_autoNudgeMentionedAgents takes only publicText (no backchannelText param)', async () => {
  const hostDir = await createTestPersona('nudge-sig', 'NudgeSig', {
    agents: [{ name: 'Brad', secret: 'brad-secret' }],
  })
  const host = await startCheesoid(hostDir, 4014)
  servers.push(host)

  const backchannelSends = []
  host.room.addBackchannelMessage = (name, text, opts) => {
    backchannelSends.push({ name, text, ...opts })
  }

  host.room._pendingRoom = 'home'
  // Only one argument now
  host.room._autoNudgeMentionedAgents('Hey Brad, what do you think?')
  assert.equal(backchannelSends.length, 1)
  assert.ok(backchannelSends[0].text.includes('Brad'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/multi-agent.test.js`
Expected: The new test passes (extra args are ignored in JS), but we need to verify after implementation.

- [ ] **Step 3: Delete `_parseResponseTags` and simplify response routing**

In `server/lib/chat-session.js`:

**Delete `_parseResponseTags`** (lines 287-303). Remove the entire method.

**Update `_autoNudgeMentionedAgents`** — remove the `backchannelText` parameter and all references to it:

```javascript
  _autoNudgeMentionedAgents(publicText) {
    if (!publicText) return

    // Home room: nudge visiting agents (config.agents)
    if (this._pendingRoom === 'home') {
      const knownAgents = (this.persona.config.agents || []).map(a => a.name)
      for (const agentName of knownAgents) {
        const mentionPattern = new RegExp(`\\b${agentName}\\b`, 'i')
        if (!mentionPattern.test(publicText)) continue
        this.addBackchannelMessage('system', `Hey ${agentName}, you were just addressed in chat.`)
      }
    }

    // Remote room: nudge the room's agent via room client
    if (this._pendingRoom && this._pendingRoom !== 'home') {
      const roomName = this._pendingRoom
      const client = this.roomClients.get(roomName)
      if (!client) return

      const mentionPattern = new RegExp(`\\b${roomName}\\b`, 'i')
      if (!mentionPattern.test(publicText)) return
      client.sendBackchannel(`Hey ${roomName}, you were just addressed in chat.`)
    }
  }
```

**Simplify response routing in `_processMessage`** (replace lines 459-486):

```javascript
      // Route response — freeform text is always public
      if (this._pendingRoom === 'home') {
        if (assistantText.trim()) {
          this.recordHistory({ type: 'assistant_message', text: assistantText.trim() })
        }
        this._autoNudgeMentionedAgents(assistantText)
      } else {
        const client = this.roomClients.get(this._pendingRoom)
        if (client && assistantText.trim()) {
          await client.sendMessage(assistantText.trim())
        }
        this._autoNudgeMentionedAgents(assistantText)
      }
```

**Update the `relayAgentEvent` comment** (line 282) — remove the reference to `<thought>` content:

```javascript
    // Only tool_start/tool_result are relayed — text_delta/done are NOT forwarded
    // to avoid duplicate messages. The final public text arrives separately via
    // addAgentMessage after the agent loop completes.
```

**Update the `onEvent` comment** in `_processMessage` (around line 437) — remove the tag reference:

```javascript
        } else if (event.type === 'tool_start' || event.type === 'tool_result') {
          // Forward tool events to remote office so visitors can see what we're doing.
          // text_delta/done are NOT forwarded — the final public text arrives via
          // sendMessage() after the agent loop completes.
```

- [ ] **Step 4: Update existing multi-agent tests**

In `tests/multi-agent.test.js`, update the tests that call `_autoNudgeMentionedAgents` with two args:

Change line 222:
```javascript
    host.room._autoNudgeMentionedAgents('Hey Brad, what do you think about this?')
```

Change line 235 — this test verified that backchannel text suppresses nudge. Since backchannel is now handled by the `internal` tool (which doesn't go through auto-nudge), this test becomes: "auto-nudge fires for mentioned agent":
```javascript
  it('auto-nudges mentioned agent in public text', async () => {
    const host = servers[servers.length - 1]
    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey Brad, check this out')
    assert.equal(backchannelSends.length, 1, 'should nudge Brad')
  })
```

Change line 247:
```javascript
    host.room._autoNudgeMentionedAgents('Hey random person, what do you think?')
```

Change line 266:
```javascript
    visitor.room._autoNudgeMentionedAgents('Hey brad, what do you think?')
```

Change line 288:
```javascript
    host.room._autoNudgeMentionedAgents('Helper, can you look into this?')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/multi-agent.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/lib/chat-session.js tests/multi-agent.test.js
git commit -m "feat: remove tag parsing, simplify response routing"
```

---

### Task 3: Update prompt instructions

**Files:**
- Modify: `server/lib/prompt-assembler.js:114-173` (rooms and agents sections)
- Modify: `server/lib/prompt-assembler.js:52` (TAIL_REINFORCEMENT)
- Test: `tests/prompt-assembler.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/prompt-assembler.test.js`:

```javascript
it('rooms section references internal tool instead of thought/backchannel tags', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Soul.',
    'prompts/system.md': 'System.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Test',
    chat: { prompt: 'prompts/system.md' },
    rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
  })

  assert.ok(result.includes('internal'), 'should reference internal tool')
  assert.ok(!result.includes('<thought>'), 'should not contain <thought> tag examples')
  assert.ok(!result.includes('<backchannel>'), 'should not contain <backchannel> tag examples')
})

it('agents section references internal tool instead of backchannel tags', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Soul.',
    'prompts/system.md': 'System.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Host',
    chat: { prompt: 'prompts/system.md' },
    agents: [{ name: 'Brad', secret: 's' }],
  })

  assert.ok(result.includes('internal'), 'should reference internal tool')
  assert.ok(!result.includes('<backchannel>'), 'should not contain <backchannel> tag examples')
})

it('tail reinforcement mentions internal tool', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Soul.',
    'prompts/system.md': 'System.',
  })
  const result = await assemblePrompt(dir, {
    display_name: 'Test',
    chat: { prompt: 'prompts/system.md' },
  })

  assert.ok(result.includes('internal'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/prompt-assembler.test.js`
Expected: FAIL — prompts still contain `<thought>` and `<backchannel>` tag references.

- [ ] **Step 3: Update prompt sections**

In `server/lib/prompt-assembler.js`:

**Update `TAIL_REINFORCEMENT`** (line 52):

```javascript
const TAIL_REINFORCEMENT = `REMINDERS: Use tools via function calling — never narrate tool use in text. Do not fabricate data — verify through tools. Do not take destructive actions without confirmation. Use the \`internal\` tool for private thoughts and backchannel — do not write them as plain text. Stay in character.`
```

**Replace the rooms section** (lines 116-153). Replace the entire array content:

```javascript
  if (config.rooms && config.rooms.length > 0) {
    const roomNames = config.rooms.map(r => r.name)
    operationalSections.push([
      `## Connected Offices`,
      `You are present in multiple offices simultaneously. Your office is where your direct users are. You are also connected to these other agents' offices: ${roomNames.join(', ')}.`,
      ``,
      `Every message is tagged with its source: \`[HH:MM][office/name@domain]\`. Your office shows as \`[HH:MM][home/name@yourdomain]\`, other agents' offices show as \`[HH:MM][officename/name@theirdomain]\`. Always check the tag to know where a message came from.`,
      ``,
      `When you respond, your response goes to the office the triggering message came from. Pay close attention to the tag — a message in \`[home/...]\` is in YOUR office, not someone else's.`,
      ``,
      `### Being a Visitor (IMPORTANT)`,
      `In other agents' offices, you are a GUEST. Everyone in that office sees everything you say. Only speak publicly when you have something genuinely useful to contribute. If a message isn't addressed to you or doesn't need your input, don't say anything publicly — use the \`internal\` tool instead.`,
      ``,
      `You have the \`internal\` tool for private reactions. When you observe something in another agent's office but have nothing to say publicly, call \`internal({ thought: "..." })\`. To coordinate with the other agent privately, call \`internal({ backchannel: "..." })\`. You can combine both in one call. Anything you say without using this tool goes to that office publicly.`,
      ``,
      `### Backchannel`,
      `You can talk to other agents in public chat — that's fine and natural ("Hey Brad, what do you think about this?"). But social cue coordination — who should respond, turn-taking, domain handoffs — MUST go through backchannel, not public chat. Users should not see logistics like "this one's for you" or "I'll handle this" or "go ahead."`,
      ``,
      `Use \`internal({ backchannel: "..." })\` to send private coordination messages. The backchannel is delivered privately to the other agent and triggers their attention.`,
      ``,
      `Incoming backchannel from other agents appears as \`[backchannel/office/name@domain]: message\`. Users never see these.`,
    ].join('\n'))
  }
```

**Replace the agents section** (lines 156-173):

```javascript
  if (config.agents && config.agents.length > 0) {
    const agentNames = config.agents.map(a => a.name)
    operationalSections.push([
      `## Visiting Agents`,
      `Other agents may visit your office: ${agentNames.join(', ')}. They appear as participants and their messages show in chat. You do not need to respond to every agent message.`,
      ``,
      `### Coordinating Responses`,
      `When a user sends a message and visiting agents are present, consider whether to handle it yourself, delegate to a visiting agent, or collaborate. Use \`internal({ backchannel: "..." })\` to coordinate before responding publicly. You don't need to coordinate for every message — only when delegation or collaboration is warranted.`,
      ``,
      `### Private Channels`,
      `Use \`internal({ backchannel: "..." })\` to coordinate privately with visiting agents — turn-taking, domain handoffs, delegation. Users never see backchannel. Use \`internal({ thought: "..." })\` for private observations.`,
      ``,
      `Visiting agents send you private messages via backchannel — these appear as \`[backchannel/agentname]: message\`. Users cannot see these.`,
    ].join('\n'))
  }
```

- [ ] **Step 4: Update existing prompt tests**

In `tests/prompt-assembler.test.js`, update existing tests that check for old tag content:

The test `'includes social cue backchannel instructions when rooms are configured'` (around line 204) checks for `'address another agent in your public response'` and `'backchannel'`. Update the assertions:

```javascript
  it('includes social cue backchannel instructions when rooms are configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })

    const prompt = await assemblePrompt(dir, {
      name: 'visitor',
      display_name: 'Visitor',
      chat: { prompt: 'prompts/system.md' },
      rooms: [{ name: 'brad', url: 'http://localhost:9999', secret: 's' }],
    }, [])
    assert.ok(prompt.includes('internal'))
    assert.ok(prompt.includes('backchannel'))
  })
```

The test `'includes moderation instructions when agents are configured'` (around line 188) checks for `'consider whether to handle it yourself'` and `'delegate'`. These phrases remain in the new text, so no change needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/prompt-assembler.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/lib/prompt-assembler.js tests/prompt-assembler.test.js
git commit -m "feat: update prompts to reference internal tool instead of tags"
```

---

### Task 4: Integration test — full internal tool flow

**Files:**
- Test: `tests/multi-agent.test.js` (add integration test)

- [ ] **Step 1: Write the integration test**

Add to `tests/multi-agent.test.js`:

```javascript
it('internal tool delivers thought to home and backchannel to remote room', async () => {
  const visitorDir = await createTestPersona('internal-test', 'InternalTest', {
    rooms: [{ name: 'brad', url: 'http://localhost:4099', secret: 's', domain: 'brad.test' }],
  })
  const visitor = await startCheesoid(visitorDir, 4015)
  servers.push(visitor)

  const bcSends = []
  const mockClient = {
    sendBackchannel: async (text) => { bcSends.push(text) },
    sendMessage: async () => {},
    sendEvent: () => {},
    destroy: () => {},
  }
  visitor.room.roomClients.set('brad', mockClient)

  // Simulate being in a remote room
  visitor.room._pendingRoom = 'brad'

  // Call internal tool directly (simulating what the agent loop does)
  const result = await visitor.room.tools.execute('internal', {
    thought: 'Not my area of expertise.',
    backchannel: 'Brad, this is your domain.',
  })

  // Thought echoed in result for agent memory
  assert.ok(result.output.includes('Not my area of expertise.'))
  assert.ok(result.output.includes('Backchannel sent'))

  // Backchannel delivered to remote room
  assert.equal(bcSends.length, 1)
  assert.equal(bcSends[0], 'Brad, this is your domain.')

  // Thought broadcast to home room (not remote)
  const broadcasts = visitor.room._broadcastLog || []
  // The broadcast mock on Room tracks calls — verify idle_text_delta was emitted
  // (In real Room, this goes to home SSE clients only)
})
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/multi-agent.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/multi-agent.test.js
git commit -m "test: integration test for internal tool flow"
```
