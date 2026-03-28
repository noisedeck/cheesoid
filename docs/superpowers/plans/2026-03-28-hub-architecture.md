# Hub Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform cheesoid from single-room-per-instance to a multi-room hub with sidebar navigation, DMs, and headless mode.

**Architecture:** The hub is a cheesoid persona with `hosted_rooms` config. It initializes multiple Room instances (one per room), serves a sidebar UI with Present/Rooms sections, and routes messages by room/DM context. Headless cheesoids connect via existing RoomClient. All SSE events gain `room`/`from`/`to` fields for multiplexed delivery.

**Tech Stack:** Express.js, SSE, existing Room/RoomClient classes, Handfish CSS

---

### Task 1: Multi-Room Server — RoomManager class

Create a RoomManager that initializes and manages multiple Room instances by name. This replaces the single `app.locals.room` with `app.locals.rooms` (a RoomManager) while keeping backward compatibility for single-room personas.

**Files:**
- Create: `server/lib/room-manager.js`
- Test: `tests/room-manager.test.js`

- [ ] **Step 1: Write the failing test for RoomManager construction**

```javascript
// tests/room-manager.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../server/lib/room-manager.js'

describe('RoomManager', () => {
  it('initializes rooms from hosted_rooms config', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general', '#dev'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)
    assert.deepStrictEqual(manager.roomNames, ['#general', '#dev'])
    assert.ok(manager.get('#general'))
    assert.ok(manager.get('#dev'))
    assert.strictEqual(manager.get('#nonexistent'), undefined)
  })

  it('falls back to single unnamed room when no hosted_rooms', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'solo',
        display_name: 'Solo',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)
    assert.deepStrictEqual(manager.roomNames, [])
    assert.ok(manager.defaultRoom)
  })

  it('isHub returns true when hosted_rooms configured', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)
    assert.strictEqual(manager.isHub, true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/room-manager.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RoomManager**

```javascript
// server/lib/room-manager.js
import { Room } from './chat-session.js'

/**
 * Manages multiple named rooms for hub personas,
 * or a single default room for legacy single-room personas.
 */
export class RoomManager {
  constructor(persona) {
    this.persona = persona
    this._rooms = new Map()
    this._defaultRoom = null

    const hostedRooms = persona.config.hosted_rooms || []
    if (hostedRooms.length > 0) {
      for (const name of hostedRooms) {
        this._rooms.set(name, new Room(persona))
      }
    } else {
      // Legacy single-room mode
      this._defaultRoom = new Room(persona)
    }
  }

  get isHub() {
    return this._rooms.size > 0
  }

  get roomNames() {
    return [...this._rooms.keys()]
  }

  get defaultRoom() {
    return this._defaultRoom
  }

  get(name) {
    return this._rooms.get(name)
  }

  /**
   * Get room by name, falling back to default for legacy mode.
   * For hub mode, returns undefined if room doesn't exist.
   */
  resolve(name) {
    if (this.isHub) {
      return name ? this._rooms.get(name) : this._rooms.values().next().value
    }
    return this._defaultRoom
  }

  async initialize() {
    if (this.isHub) {
      for (const room of this._rooms.values()) {
        await room.initialize()
      }
    } else {
      await this._defaultRoom.initialize()
    }
  }

  /** All rooms as an iterable */
  rooms() {
    if (this.isHub) return this._rooms.values()
    return [this._defaultRoom][Symbol.iterator]()
  }

  /** Aggregated participants across all rooms */
  get allParticipants() {
    const names = new Set()
    for (const room of this.rooms()) {
      for (const name of room.participantList) {
        names.add(name)
      }
    }
    return [...names]
  }

  destroy() {
    for (const room of this.rooms()) {
      room.destroy()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/room-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/room-manager.js tests/room-manager.test.js
git commit -m "feat: add RoomManager for multi-room support"
```

---

### Task 2: Wire RoomManager into server/index.js

Replace `app.locals.room` with `app.locals.rooms` (a RoomManager). Keep `app.locals.room` as a getter alias for backward compatibility during migration.

**Files:**
- Modify: `server/index.js:44-47`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/room-manager-integration.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'

async function createTestPersona(name, extras = {}) {
  const dir = await mkdtemp(join(tmpdir(), `cheesoid-${name}-`))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), `You are ${name}.`)
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name,
    display_name: name,
    model: 'claude-sonnet-4-6',
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    ...extras,
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('RoomManager integration', () => {
  it('hub persona creates multiple rooms', async () => {
    const dir = await createTestPersona('hub-test', {
      hosted_rooms: ['#general', '#dev'],
    })
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    assert.strictEqual(rooms.isHub, true)
    assert.deepStrictEqual(rooms.roomNames, ['#general', '#dev'])
  })

  it('legacy persona creates single default room', async () => {
    const dir = await createTestPersona('legacy-test')
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    assert.strictEqual(rooms.isHub, false)
    assert.ok(rooms.defaultRoom)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (tests RoomManager with real persona loading)**

Run: `node --test tests/room-manager-integration.test.js`
Expected: PASS (RoomManager already implemented)

- [ ] **Step 3: Update server/index.js**

Replace lines 44-47 in `server/index.js`:

```javascript
// OLD:
// Single room per persona
app.locals.persona = persona
app.locals.room = new Room(persona)
await app.locals.room.initialize()

// NEW:
import { RoomManager } from './lib/room-manager.js'

// Initialize rooms — hub personas get multiple, legacy get one
app.locals.persona = persona
app.locals.rooms = new RoomManager(persona)
await app.locals.rooms.initialize()
// Backward compat: legacy code accessing app.locals.room gets the default/first room
Object.defineProperty(app.locals, 'room', {
  get() { return app.locals.rooms.resolve() },
})
```

Also update the import at top of index.js — remove `Room` import, add `RoomManager`:

```javascript
// OLD:
import { Room } from './lib/chat-session.js'

// NEW:
import { RoomManager } from './lib/room-manager.js'
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All existing tests PASS — `app.locals.room` compat shim keeps everything working

- [ ] **Step 5: Commit**

```bash
git add server/index.js tests/room-manager-integration.test.js
git commit -m "feat: wire RoomManager into server, backward-compat room getter"
```

---

### Task 3: Route-level room resolution in chat.js

Update the chat routes to resolve rooms by name from query/body params. Hub mode routes to named rooms; legacy mode routes to the default room.

**Files:**
- Modify: `server/routes/chat.js`
- Test: `tests/chat-routes-hub.test.js`

- [ ] **Step 1: Write failing test for room-scoped message send**

```javascript
// tests/chat-routes-hub.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'
import { createAuthMiddleware } from '../server/lib/auth.js'
import chatRouter from '../server/routes/chat.js'

async function createHubPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-hub-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Hub.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'hub',
    display_name: 'Hub',
    model: 'claude-sonnet-4-6',
    hosted_rooms: ['#general', '#dev'],
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Chat routes — hub mode', () => {
  let server, rooms

  after(() => {
    if (server) server.close()
    if (rooms) rooms.destroy()
  })

  it('POST /api/chat/send with room field routes to correct room', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    rooms = new RoomManager(persona)
    // Don't initialize (would try to load tools/make API calls) — just test routing
    // Manually set up enough state for the route to work
    const generalRoom = rooms.get('#general')
    generalRoom.systemPrompt = 'test' // mark as "initialized enough"
    generalRoom.tools = { definitions: [], execute: async () => ({}) }

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    server = app.listen(0)
    const port = server.address().port

    // Send to #general
    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice', room: '#general' }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.status, 'sent')
  })

  it('POST /api/chat/send without room field uses default (first) room in hub mode', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    rooms = new RoomManager(persona)
    const generalRoom = rooms.get('#general')
    generalRoom.systemPrompt = 'test'
    generalRoom.tools = { definitions: [], execute: async () => ({}) }

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice' }),
    })
    assert.strictEqual(res.status, 200)
  })

  it('POST /api/chat/send returns 404 for unknown room', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice', room: '#nonexistent' }),
    })
    assert.strictEqual(res.status, 404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-routes-hub.test.js`
Expected: FAIL — routes don't handle `room` field yet

- [ ] **Step 3: Update chat routes to resolve rooms**

Replace `server/routes/chat.js` with:

```javascript
import { Router } from 'express'

const router = Router()

router.use((req, res, next) => {
  const auth = req.app.locals.authMiddleware
  if (auth) return auth(req, res, next)
  next()
})

/**
 * Resolve the target room from request params.
 * Hub mode: look up by room name (query or body). Legacy mode: use default room.
 * Returns null if room not found (caller should 404).
 */
function resolveRoom(req, roomName) {
  const { rooms } = req.app.locals
  if (!rooms) return req.app.locals.room // deep legacy fallback

  if (rooms.isHub && roomName) {
    return rooms.get(roomName)
  }
  return rooms.resolve(roomName)
}

// SSE stream — client connects and receives events from a room
router.get('/api/chat/stream', (req, res) => {
  const name = req.userName || req.query.name || null
  const room = resolveRoom(req, req.query.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  room.addClient(res, name, req.isAgent)
})

// Send a message to a room or DM
router.post('/api/chat/send', async (req, res) => {
  const { message, to } = req.body
  const name = req.userName || req.body.name
  if (!message) return res.status(400).json({ error: 'message required' })
  if (!name) return res.status(400).json({ error: 'name required' })

  // DM handling — route to both participants
  if (to) {
    const { rooms } = req.app.locals
    if (rooms && rooms.isHub) {
      rooms.routeDM(name, to, message, req.isAgent)
      return res.json({ status: 'sent' })
    }
  }

  const room = resolveRoom(req, req.body.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  res.json({ status: 'sent' })

  if (req.isAgent && req.body.backchannel) {
    room.addBackchannelMessage(name, message, { trigger: req.body.trigger })
  } else if (req.isAgent) {
    room.addAgentMessage(name, message)
  } else {
    room.sendMessage(name, message).catch(err => {
      console.error('sendMessage error:', err.message)
    })
  }
})

// Relay streaming events from visiting agents
router.post('/api/chat/event', (req, res) => {
  if (!req.isAgent) return res.status(403).json({ error: 'agent auth required' })

  const { name, event } = req.body
  if (!name || !event || !event.type) {
    return res.status(400).json({ error: 'name and event with type required' })
  }

  const room = resolveRoom(req, req.body.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  room.relayAgentEvent(name, event)
  res.json({ status: 'relayed' })
})

export default router
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/chat-routes-hub.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify backward compat**

Run: `npm test`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/chat.js tests/chat-routes-hub.test.js
git commit -m "feat: room-scoped routing in chat endpoints"
```

---

### Task 4: DM routing in RoomManager

Add DM support to RoomManager. DMs are delivered to both participants' SSE streams. If the recipient is an agent connected via RoomClient, the message is forwarded as a private-channel message.

**Files:**
- Modify: `server/lib/room-manager.js`
- Test: `tests/dm-routing.test.js`

- [ ] **Step 1: Write failing test for DM routing**

```javascript
// tests/dm-routing.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../server/lib/room-manager.js'

describe('DM routing', () => {
  it('routeDM broadcasts to both participants SSE clients', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)

    // Simulate SSE clients
    const received = { alice: [], bob: [], charlie: [] }
    const makeClient = (name) => ({
      write: (data) => received[name].push(JSON.parse(data.replace('data: ', '').trim())),
    })

    manager.addDMClient(makeClient('alice'), 'alice')
    manager.addDMClient(makeClient('bob'), 'bob')
    manager.addDMClient(makeClient('charlie'), 'charlie')

    manager.routeDM('alice', 'bob', 'hey bob', false)

    // Alice and bob should both get the DM event
    assert.strictEqual(received.alice.length, 1)
    assert.strictEqual(received.bob.length, 1)
    assert.strictEqual(received.charlie.length, 0)

    assert.strictEqual(received.alice[0].type, 'user_message')
    assert.strictEqual(received.alice[0].from, 'alice')
    assert.strictEqual(received.alice[0].to, 'bob')
    assert.strictEqual(received.alice[0].text, 'hey bob')
  })

  it('routeDM triggers agent processing when recipient is hub agent', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)

    // DM to the hub's own agent should trigger sendMessage on the default room
    let triggered = false
    const firstRoom = manager.get('#general')
    firstRoom.sendMessage = async () => { triggered = true }

    manager.routeDM('alice', 'Hub', 'hey hub', false)
    assert.strictEqual(triggered, true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dm-routing.test.js`
Expected: FAIL — `routeDM` and `addDMClient` not defined

- [ ] **Step 3: Add DM support to RoomManager**

Add these methods to the RoomManager class in `server/lib/room-manager.js`:

```javascript
  constructor(persona) {
    // ... existing constructor code ...
    this._dmClients = new Map() // name → Set<res>
  }

  /**
   * Register an SSE client for DM delivery.
   * Called alongside room.addClient() — the same client gets both room events and DMs.
   */
  addDMClient(res, name) {
    if (!name) return
    if (!this._dmClients.has(name)) {
      this._dmClients.set(name, new Set())
    }
    this._dmClients.get(name).add(res)
    // Clean up on disconnect
    if (res.on) {
      res.on('close', () => {
        const clients = this._dmClients.get(name)
        if (clients) {
          clients.delete(res)
          if (clients.size === 0) this._dmClients.delete(name)
        }
      })
    }
  }

  /**
   * Route a DM between two users. Delivers to both participants' SSE streams.
   * If recipient matches the hub persona's display_name, triggers agent processing.
   */
  routeDM(from, to, text, isAgent) {
    const event = {
      type: 'user_message',
      from,
      to,
      text,
      timestamp: Date.now(),
    }
    const data = `data: ${JSON.stringify(event)}\n\n`

    // Deliver to both participants' SSE clients
    for (const name of [from, to]) {
      const clients = this._dmClients.get(name)
      if (clients) {
        for (const client of clients) {
          client.write(data)
        }
      }
    }

    // If recipient is the hub's own agent, trigger processing
    const agentName = this.persona.config.display_name
    if (to === agentName) {
      // Route to first room's agent loop (hub agent is shared)
      const room = this.isHub
        ? this._rooms.values().next().value
        : this._defaultRoom
      if (room) {
        room.sendMessage(from, text).catch(err => {
          console.error(`[${this.persona.config.name}] DM processing error:`, err.message)
        })
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dm-routing.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/room-manager.js tests/dm-routing.test.js
git commit -m "feat: DM routing in RoomManager"
```

---

### Task 5: Multiplexed SSE — room tags on events

Update Room.broadcast() and Room.addClient() so all emitted events include a `room` field identifying which room they belong to. Update the SSE stream endpoint to register the client for DMs as well.

**Files:**
- Modify: `server/lib/chat-session.js:46-88` (constructor — accept room name)
- Modify: `server/lib/chat-session.js:207-212` (broadcast — tag events)
- Modify: `server/routes/chat.js` (SSE endpoint — register DM client)
- Test: `tests/room-broadcast-tags.test.js`

- [ ] **Step 1: Write failing test for room-tagged broadcasts**

```javascript
// tests/room-broadcast-tags.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

describe('Room broadcast tagging', () => {
  it('broadcast includes room name when set', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const room = new Room(persona, { roomName: '#general' })
    const received = []
    const mockClient = { write: (data) => received.push(JSON.parse(data.replace('data: ', '').trim())) }
    room.clients.add(mockClient)

    room.broadcast({ type: 'system', text: 'hello' })

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].room, '#general')
    assert.strictEqual(received[0].type, 'system')
  })

  it('broadcast omits room tag when no room name (legacy)', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'solo',
        display_name: 'Solo',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const room = new Room(persona)
    const received = []
    const mockClient = { write: (data) => received.push(JSON.parse(data.replace('data: ', '').trim())) }
    room.clients.add(mockClient)

    room.broadcast({ type: 'system', text: 'hello' })

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].room, undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/room-broadcast-tags.test.js`
Expected: FAIL — Room constructor doesn't accept options

- [ ] **Step 3: Update Room constructor to accept room name**

In `server/lib/chat-session.js`, update the constructor signature:

```javascript
// OLD (line 47):
constructor(persona) {

// NEW:
constructor(persona, options = {}) {
```

Add after line 48 (`this.persona = persona`):

```javascript
    this.roomName = options.roomName || null
```

- [ ] **Step 4: Update Room.broadcast to tag events**

In `server/lib/chat-session.js`, update broadcast (lines 207-212):

```javascript
  // OLD:
  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) {
      client.write(data)
    }
  }

  // NEW:
  broadcast(event) {
    const tagged = this.roomName ? { ...event, room: this.roomName } : event
    const data = `data: ${JSON.stringify(tagged)}\n\n`
    for (const client of this.clients) {
      client.write(data)
    }
  }
```

- [ ] **Step 5: Update RoomManager to pass room name to Room constructor**

In `server/lib/room-manager.js`, update the room creation:

```javascript
// OLD:
this._rooms.set(name, new Room(persona))

// NEW:
this._rooms.set(name, new Room(persona, { roomName: name }))
```

- [ ] **Step 6: Update SSE route to also register DM client**

In `server/routes/chat.js`, update the stream handler:

```javascript
// In the GET /api/chat/stream handler, after room.addClient:
router.get('/api/chat/stream', (req, res) => {
  const name = req.userName || req.query.name || null
  const room = resolveRoom(req, req.query.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  room.addClient(res, name, req.isAgent)

  // Also register for DM delivery in hub mode
  const { rooms } = req.app.locals
  if (rooms && rooms.isHub) {
    rooms.addDMClient(res, name)
  }
})
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test tests/room-broadcast-tags.test.js`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All PASS — legacy rooms have no `roomName` so broadcast is unchanged

- [ ] **Step 9: Commit**

```bash
git add server/lib/chat-session.js server/lib/room-manager.js server/routes/chat.js tests/room-broadcast-tags.test.js
git commit -m "feat: room-tagged SSE events for multiplexed delivery"
```

---

### Task 6: Hub presence endpoint

Update the health/presence route to return hub-aware data: room list, aggregated participants, and per-room metadata.

**Files:**
- Modify: `server/routes/health.js:27-54`
- Test: `tests/hub-presence.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/hub-presence.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'
import healthRouter from '../server/routes/health.js'

async function createHubPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-hub-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Hub.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'hub',
    display_name: 'Hub',
    model: 'claude-sonnet-4-6',
    hosted_rooms: ['#general', '#dev'],
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: [] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Hub presence endpoint', () => {
  let server

  after(() => { if (server) server.close() })

  it('returns rooms list in hub mode', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.use(healthRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/presence`)
    const data = await res.json()

    assert.strictEqual(data.persona, 'Hub')
    assert.ok(data.hosted_rooms)
    assert.deepStrictEqual(data.hosted_rooms, ['#general', '#dev'])
    assert.ok(Array.isArray(data.participants))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hub-presence.test.js`
Expected: FAIL — no `hosted_rooms` in response

- [ ] **Step 3: Update presence endpoint**

In `server/routes/health.js`, update the `/api/presence` handler:

```javascript
router.get('/api/presence', async (req, res) => {
  const { persona, rooms } = req.app.locals
  // Backward compat: use rooms manager if available, else legacy room
  const room = req.app.locals.room
  const authProxy = !!persona.config.auth_proxy

  let stateData = {}
  if (room && room.state) {
    stateData = room.state.data
  } else {
    const state = new State(persona.dir)
    await state.load()
    stateData = state.data
  }

  const result = {
    persona: persona.config.display_name,
    state: stateData,
    participants: rooms ? rooms.allParticipants : room.participantList,
    auth_proxy: authProxy,
  }

  // Hub-specific fields
  if (rooms && rooms.isHub) {
    result.hosted_rooms = rooms.roomNames
  }

  if (authProxy) {
    const email = req.headers['x-gs-user-email']
    if (email) result.user = email.split('@')[0]
  }

  res.json(result)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hub-presence.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/health.js tests/hub-presence.test.js
git commit -m "feat: hub-aware presence endpoint with room list"
```

---

### Task 7: Headless mode — skip UI serving

Add `headless: true` support to persona config. When headless, skip static file serving and the `GET /` route.

**Files:**
- Modify: `server/index.js:18-28`

- [ ] **Step 1: Write failing test**

```javascript
// tests/headless-mode.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import healthRouter from '../server/routes/health.js'

async function createHeadlessPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-headless-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Headless.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'headless',
    display_name: 'Headless',
    model: 'claude-sonnet-4-6',
    headless: true,
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Headless mode', () => {
  let server

  after(() => { if (server) server.close() })

  it('health endpoint works in headless mode', async () => {
    const dir = await createHeadlessPersona()
    const persona = await loadPersona(dir)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.startupCheckResults = { ok: true }
    app.use(healthRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/health`)
    const data = await res.json()
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(data.persona, 'Headless')
  })

  it('headless persona config has headless: true', async () => {
    const dir = await createHeadlessPersona()
    const persona = await loadPersona(dir)
    assert.strictEqual(persona.config.headless, true)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (headless is just a config flag)**

Run: `node --test tests/headless-mode.test.js`
Expected: PASS — tests validate the config flag and that health works without UI

- [ ] **Step 3: Update server/index.js to conditionally serve UI**

In `server/index.js`, wrap the UI routes in a headless check:

```javascript
// OLD (lines 18-28):
app.get('/', async (req, res) => {
  const theme = app.locals.persona.config.theme || 'terminal'
  const dataTheme = app.locals.persona.config.data_theme || theme
  const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8')
  res.type('html').send(
    html.replace('{{THEME}}', theme).replace('{{DATA_THEME}}', dataTheme)
  )
})

app.use(express.static(join(__dirname, 'public'), { index: false }))

// NEW:
if (!persona.config.headless) {
  app.get('/', async (req, res) => {
    const theme = app.locals.persona.config.theme || 'terminal'
    const dataTheme = app.locals.persona.config.data_theme || theme
    const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8')
    res.type('html').send(
      html.replace('{{THEME}}', theme).replace('{{DATA_THEME}}', dataTheme)
    )
  })

  app.use(express.static(join(__dirname, 'public'), { index: false }))
}
```

Note: The persona variable is available here because `loadPersona` runs before route registration (line 33).

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.js tests/headless-mode.test.js
git commit -m "feat: headless mode skips UI serving"
```

---

### Task 8: Hub UI — sidebar with rooms and present sections

Update `index.html` and `chat.js` to render a sidebar with **Rooms** and **Present** sections when connected to a hub. The sidebar appears only when the presence endpoint returns `hosted_rooms`.

**Files:**
- Modify: `server/public/index.html:68-79` (sidebar structure)
- Modify: `server/public/js/chat.js` (room switching, DM opening, unread badges)
- Modify: `server/public/css/style.css` (sidebar room/DM styles)

- [ ] **Step 1: Update index.html sidebar structure**

Replace the sidebar content in `server/public/index.html` (lines 68-79):

```html
      <aside id="sidebar">
        <div id="sidebar-header" class="hf-border-bottom hf-p-4">
          <svg id="sidebar-logo" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,600) scale(0.1,-0.1)" fill="currentColor" stroke="none"><path d="M2274 5116 c-95 -67 -122 -451 -44 -606 37 -73 69 -93 101 -64 25 23 21 53 -21 141 -28 58 -30 70 -30 177 0 108 2 122 35 208 41 109 42 122 13 142 -27 19 -29 19 -54 2z"/><path d="M3759 5112 l-22 -19 41 -114 c39 -105 42 -122 42 -213 0 -93 -2 -103 -41 -192 -43 -97 -44 -128 -8 -139 37 -12 59 6 97 78 l37 72 0 185 0 185 -33 76 c-23 53 -41 80 -58 88 -31 14 -28 14 -55 -7z"/><path d="M2956 5015 c-57 -16 -120 -71 -147 -130 -12 -27 -19 -63 -19 -109 0 -100 24 -144 115 -211 41 -30 75 -64 79 -77 10 -40 7 -276 -5 -301 -6 -14 -21 -30 -33 -36 -14 -7 -156 -12 -426 -13 l-405 -3 -68 -33 c-91 -44 -151 -101 -195 -187 l-37 -70 -2 -325 -3 -325 -26 -22 c-24 -22 -33 -23 -194 -23 -148 0 -176 -3 -226 -21 -79 -30 -126 -76 -160 -157 -27 -63 -28 -77 -34 -263 -3 -142 -9 -200 -18 -212 -8 -9 -34 -26 -60 -38 -69 -34 -120 -85 -158 -161 -29 -57 -34 -78 -34 -136 0 -59 5 -78 34 -133 39 -74 73 -104 105 -94 36 11 37 51 4 114 -17 31 -34 71 -38 89 -14 69 53 190 126 228 37 19 161 19 198 0 42 -22 98 -90 110 -133 18 -64 13 -114 -19 -181 -36 -77 -38 -99 -5 -114 37 -17 67 9 109 93 46 93 48 148 6 250 -35 86 -85 142 -157 174 -81 36 -87 53 -91 235 -3 96 1 175 8 208 14 65 58 118 108 132 20 5 112 10 203 10 160 0 166 -1 187 -23 l22 -23 0 -598 0 -597 -25 -24 c-21 -22 -33 -25 -99 -25 -68 0 -81 -4 -164 -45 -109 -55 -149 -97 -206 -214 -39 -82 -41 -90 -41 -181 0 -89 2 -100 37 -173 67 -140 170 -223 327 -263 57 -14 197 -15 1415 -11 l1351 4 85 22 c103 28 123 38 199 101 47 39 68 67 101 132 l41 83 -3 115 c-3 108 -5 119 -38 185 -45 91 -96 140 -197 193 -68 35 -95 44 -169 51 -136 14 -124 -50 -124 647 l0 591 25 28 26 27 132 -4 c119 -3 135 -5 165 -26 18 -13 42 -42 55 -65 20 -39 22 -55 22 -224 0 -209 -3 -217 -91 -265 -63 -34 -140 -111 -153 -151 -37 -119 -33 -228 12 -310 37 -66 92 -83 118 -36 10 20 9 24 -35 104 -10 20 -16 54 -16 101 0 60 4 76 29 116 42 67 83 92 158 96 98 7 129 -3 183 -57 86 -86 96 -169 31 -273 -36 -58 -38 -81 -11 -108 27 -27 41 -25 72 8 80 82 104 246 52 349 -31 64 -93 127 -154 158 -86 44 -84 39 -90 284 -5 214 -5 218 -31 257 -38 57 -85 101 -133 126 -34 18 -65 23 -178 27 -125 6 -139 8 -161 29 l-25 23 -4 332 c-3 321 -4 333 -26 379 -33 67 -113 143 -195 186 l-72 37 -437 3 -437 3 -21 26 c-18 23 -20 40 -20 173 0 166 6 182 80 220 22 11 50 34 63 52 38 52 70 137 64 172 -10 61 -51 152 -82 182 -51 52 -171 74 -259 49z m137 -99 c55 -23 87 -69 87 -127 0 -92 -49 -150 -132 -157 -62 -4 -106 19 -146 78 -31 45 -26 105 13 156 45 59 112 78 178 50z m702 -911 l25 -24 0 -1089 c0 -1058 -1 -1090 -19 -1113 l-19 -24 -912 0 -912 0 -24 28 -24 28 0 989 0 989 31 64 c37 78 88 129 154 155 48 19 80 20 863 21 l813 1 24 -25z m278 -2375 c95 -39 138 -76 189 -163 41 -68 43 -75 43 -152 0 -70 -4 -87 -33 -142 -59 -114 -140 -174 -259 -192 -112 -17 -2300 -15 -2373 2 -69 17 -134 57 -188 119 -32 35 -82 162 -82 207 0 120 97 257 225 317 l70 33 1168 0 1168 1 72 -30z"/><path d="M2183 3585 c-18 -8 -42 -29 -53 -47 -19 -32 -20 -50 -20 -434 0 -399 0 -401 23 -434 12 -18 35 -43 50 -54 28 -21 38 -21 583 -24 385 -2 568 1 596 9 23 6 57 26 75 44 l33 33 0 417 c0 400 -1 418 -20 445 -44 61 -32 60 -662 60 -469 -1 -579 -3 -605 -15z m1192 -80 l25 -24 0 -381 0 -381 -25 -24 -24 -25 -555 0 c-391 0 -562 3 -580 11 -45 21 -47 42 -44 433 l3 368 28 24 28 24 560 0 560 0 24 -25z"/><path d="M2380 3252 c-54 -30 -75 -74 -75 -157 0 -83 17 -113 83 -146 82 -41 205 -1 238 76 29 70 7 162 -50 215 -37 34 -144 41 -196 12z m168 -88 c15 -17 22 -38 22 -65 0 -118 -174 -137 -196 -22 -8 43 16 99 48 113 37 16 100 3 126 -26z"/><path d="M3013 3251 c-51 -32 -66 -71 -61 -163 3 -75 5 -82 35 -108 68 -61 178 -63 241 -5 l37 33 0 91 0 91 -37 36 c-34 35 -41 37 -110 41 -61 4 -78 1 -105 -16z m142 -65 c43 -18 59 -48 52 -100 -11 -78 -99 -114 -160 -66 -51 40 -44 135 12 165 33 18 54 18 96 1z"/><path d="M2157 2303 c-13 -12 -7 -41 9 -47 25 -9 1247 -7 1262 3 8 5 12 17 10 27 -3 18 -26 19 -639 22 -349 1 -639 -1 -642 -5z"/><path d="M2147 2083 c-13 -12 -7 -41 9 -47 9 -3 298 -6 644 -6 543 0 629 2 640 15 7 8 10 22 6 30 -5 13 -84 15 -649 15 -354 0 -647 -3 -650 -7z"/><path d="M1811 1505 c-88 -28 -157 -123 -149 -206 6 -60 59 -137 112 -163 56 -28 156 -26 199 4 92 63 121 187 66 276 -24 40 -102 91 -149 98 -19 3 -55 -1 -79 -9z m155 -99 c38 -38 44 -49 44 -86 0 -52 -29 -102 -78 -135 -51 -35 -91 -32 -144 8 -71 54 -85 132 -35 204 28 42 50 51 116 52 50 1 56 -2 97 -43z"/><path d="M3676 1505 c-52 -18 -84 -43 -123 -94 -101 -131 40 -324 212 -292 50 9 73 22 107 58 35 36 48 73 48 132 0 89 -43 150 -135 192 -48 22 -58 22 -109 4z m131 -73 c34 -27 63 -84 63 -123 0 -67 -83 -149 -150 -149 -38 0 -90 31 -116 69 -43 63 -28 140 36 195 26 21 41 26 88 26 39 0 64 -6 79 -18z"/><path d="M2405 1491 c-130 -59 -159 -230 -56 -324 87 -78 204 -75 281 9 91 99 70 230 -48 305 -55 35 -116 38 -177 10z m152 -61 c96 -58 95 -189 -2 -245 -69 -41 -123 -29 -184 40 -49 56 -41 136 21 191 12 12 30 24 38 27 34 12 96 6 127 -13z"/><path d="M3025 1491 c-47 -22 -99 -74 -114 -114 -40 -105 47 -245 162 -262 118 -18 237 80 237 195 0 139 -159 240 -285 181z m176 -79 c71 -66 62 -161 -22 -221 -51 -37 -93 -40 -140 -8 -92 62 -104 164 -27 233 30 28 43 32 101 33 42 1 53 -4 88 -37z"/><path d="M2497 4981 c-18 -22 -29 -55 -41 -121 -16 -84 -16 -97 -1 -178 9 -48 23 -97 30 -109 21 -31 52 -38 76 -17 23 21 24 40 4 87 -23 55 -20 210 5 266 23 50 25 72 8 89 -21 21 -55 13 -81 -17z"/><path d="M3522 4998 c-18 -18 -15 -54 8 -98 30 -58 28 -202 -2 -265 -23 -48 -20 -67 15 -89 24 -15 68 21 86 70 22 58 20 266 -3 319 -30 69 -72 95 -104 63z"/></g></svg>
          <div id="sidebar-identity">
            <h1 id="persona-name" class="hf-text-md hf-font-semibold hf-text-bright">Cheesoid</h1>
            <span id="presence-status" class="hf-text-xs hf-text-dim"></span>
          </div>
        </div>
        <div id="sidebar-rooms" class="hidden">
          <div class="sidebar-section-label hf-label">Rooms</div>
          <ul id="rooms-list" class="hf-scrollbar"></ul>
        </div>
        <div id="sidebar-present">
          <div class="sidebar-section-label hf-label">Present</div>
          <ul id="participants" class="hf-scrollbar"></ul>
        </div>
        <button id="sidebar-toggle" class="hf-btn hf-btn-ghost" title="Collapse sidebar"><span class="hf-icon">chevron_left</span></button>
      </aside>
```

- [ ] **Step 2: Update chat.js — hub detection and room switching**

Add hub-aware state and room switching to `server/public/js/chat.js`. Add these variables near the top (after line 26):

```javascript
let hubMode = false
let hostedRooms = []
let currentView = null  // '#general', 'dm:username', or null (legacy)
const roomBuffers = new Map()  // room/dm → { messages: [], unread: 0 }
```

Update `enterRoom()` to detect hub mode and populate sidebar:

```javascript
async function enterRoom(presenceData) {
  namePrompt.classList.add('hidden')
  chat.classList.remove('hidden')

  try {
    const data = presenceData || await fetch('/api/presence').then(r => r.json())
    personaLabel = data.persona || 'Cheesoid'
    personaName.textContent = personaLabel
    document.title = personaLabel

    const s = data.state
    if (s.mood && s.mood !== 'neutral') {
      presenceStatus.textContent = s.mood
      presenceStatus.className = 'active'
    } else {
      presenceStatus.textContent = 'present'
      presenceStatus.className = 'active'
    }

    // Hub mode detection
    if (data.hosted_rooms && data.hosted_rooms.length > 0) {
      hubMode = true
      hostedRooms = data.hosted_rooms
      currentView = data.hosted_rooms[0] // default to first room (#general)
      document.getElementById('sidebar-rooms').classList.remove('hidden')
      renderRoomsList(data.hosted_rooms)
      document.getElementById('channel-name').textContent = currentView
    } else {
      document.getElementById('channel-name').textContent = (data.persona || 'cheesoid') + "'s office"
    }

    if (data.participants) updateParticipants(data.participants)
  } catch {}

  connectSSE()
}
```

Add room list rendering:

```javascript
function renderRoomsList(rooms) {
  const roomsList = document.getElementById('rooms-list')
  roomsList.innerHTML = ''
  for (const room of rooms) {
    const li = document.createElement('li')
    li.className = 'room-item'
    if (room === currentView) li.classList.add('active')
    li.dataset.room = room
    li.textContent = room
    li.addEventListener('click', () => switchView(room))
    roomsList.appendChild(li)
  }
}

function switchView(view) {
  if (view === currentView) return
  currentView = view
  messages.innerHTML = ''
  lastSender = null
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null

  // Update active states in sidebar
  for (const li of document.querySelectorAll('.room-item')) {
    li.classList.toggle('active', li.dataset.room === view)
  }
  for (const li of document.querySelectorAll('.participant-item')) {
    li.classList.toggle('active', 'dm:' + li.dataset.name === view)
  }

  // Update channel name
  const channelName = document.getElementById('channel-name')
  if (view.startsWith('dm:')) {
    channelName.textContent = view.replace('dm:', '')
  } else {
    channelName.textContent = view
  }

  // Clear unread for this view
  const buf = roomBuffers.get(view)
  if (buf) {
    buf.unread = 0
    updateUnreadBadges()
  }

  // Reconnect SSE to get scrollback for the new room
  connectSSE()
}
```

- [ ] **Step 3: Update connectSSE to include room param**

```javascript
function connectSSE() {
  if (evtSource) evtSource.close()
  let url = `/api/chat/stream?name=${encodeURIComponent(myName)}`
  if (hubMode && currentView && !currentView.startsWith('dm:')) {
    url += `&room=${encodeURIComponent(currentView)}`
  }
  evtSource = new EventSource(url)
  evtSource.onmessage = handleEvent
  evtSource.onerror = () => {
    if (evtSource) evtSource.close()
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSSE()
    }, 3000)
  }
  input.focus()
}
```

- [ ] **Step 4: Update handleEvent to filter by current view**

In `handleEvent()`, add filtering at the top for hub mode:

```javascript
function handleEvent(e) {
  const event = JSON.parse(e.data)

  // In hub mode, route events to correct view
  if (hubMode) {
    const eventView = event.to
      ? (event.from === myName ? `dm:${event.to}` : `dm:${event.from}`)
      : event.room

    // Track unread for background views
    if (eventView && eventView !== currentView && event.type === 'user_message') {
      if (!roomBuffers.has(eventView)) roomBuffers.set(eventView, { unread: 0 })
      roomBuffers.get(eventView).unread++
      updateUnreadBadges()
    }

    // Only render events for current view (or unscoped events like presence)
    if (eventView && eventView !== currentView) return
  }

  // ... rest of existing switch statement ...
}
```

- [ ] **Step 5: Update send() to include room/DM context**

```javascript
async function send() {
  const text = input.value.trim()
  if (!text || sending) return

  sending = true
  inputHistory.push(text)
  historyIndex = -1
  input.value = ''
  input.style.height = 'auto'
  sendBtn.disabled = true

  try {
    const body = { message: text, name: myName }
    if (hubMode && currentView) {
      if (currentView.startsWith('dm:')) {
        body.to = currentView.replace('dm:', '')
      } else {
        body.room = currentView
      }
    }
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const el = document.createElement('div')
    el.className = 'message error'
    el.textContent = `Send failed: ${err.message}`
    messages.appendChild(el)
  }

  sending = false
  sendBtn.disabled = false
  input.focus()
}
```

- [ ] **Step 6: Update updateParticipants to support DM clicks**

```javascript
function updateParticipants(names) {
  participantsEl.innerHTML = ''
  for (const name of names) {
    const li = document.createElement('li')
    li.className = 'participant-item'
    if (hubMode && currentView === `dm:${name}`) li.classList.add('active')
    li.dataset.name = name
    const dot = document.createElement('span')
    dot.className = 'participant-dot'
    li.appendChild(dot)
    li.appendChild(document.createTextNode(name))
    if (hubMode) {
      li.style.cursor = 'pointer'
      li.addEventListener('click', () => switchView(`dm:${name}`))
    }
    participantsEl.appendChild(li)
  }
}
```

- [ ] **Step 7: Add unread badge rendering**

```javascript
function updateUnreadBadges() {
  // Room badges
  for (const li of document.querySelectorAll('.room-item')) {
    const room = li.dataset.room
    const buf = roomBuffers.get(room)
    let badge = li.querySelector('.unread-badge')
    if (buf && buf.unread > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'unread-badge'
        li.appendChild(badge)
      }
      badge.textContent = buf.unread
    } else if (badge) {
      badge.remove()
    }
  }
  // Participant DM badges
  for (const li of document.querySelectorAll('.participant-item')) {
    const dmView = `dm:${li.dataset.name}`
    const buf = roomBuffers.get(dmView)
    let badge = li.querySelector('.unread-badge')
    if (buf && buf.unread > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'unread-badge'
        li.appendChild(badge)
      }
      badge.textContent = buf.unread
    } else if (badge) {
      badge.remove()
    }
  }
}
```

- [ ] **Step 8: Add CSS for room list and unread badges**

Append to `server/public/css/style.css`:

```css
/* Room list */
.room-item {
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.room-item:hover,
.participant-item:hover {
  background: var(--surface-2, rgba(255, 255, 255, 0.05));
}

.room-item.active,
.participant-item.active {
  background: var(--surface-3, rgba(255, 255, 255, 0.1));
  font-weight: 600;
}

/* Unread badge */
.unread-badge {
  background: var(--accent, #5865F2);
  color: white;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  min-width: 1.2rem;
  text-align: center;
}

/* Sidebar sections */
.sidebar-section-label {
  padding: 0.75rem 0.75rem 0.25rem;
}
```

- [ ] **Step 9: Test manually**

Run: `npm run dev` (with a persona that has `hosted_rooms: ['#general', '#dev']`)
Expected: Sidebar shows Rooms and Present sections. Clicking rooms switches view. Clicking participants opens DM view.

- [ ] **Step 10: Commit**

```bash
git add server/public/index.html server/public/js/chat.js server/public/css/style.css
git commit -m "feat: hub UI with room sidebar, DMs, and unread badges"
```

---

### Task 9: Hub SSE — connect to all rooms simultaneously

In hub mode, the client needs events from ALL rooms (for unread counts), not just the current one. Update the SSE connection strategy: connect once without a room filter, and the server delivers all events tagged with their room.

**Files:**
- Modify: `server/routes/chat.js` (hub SSE connects client to all rooms)
- Modify: `server/public/js/chat.js` (remove room param from SSE URL, rely on event.room filtering)

- [ ] **Step 1: Update SSE route for hub all-rooms subscription**

In `server/routes/chat.js`, update the stream handler:

```javascript
router.get('/api/chat/stream', (req, res) => {
  const name = req.userName || req.query.name || null
  const { rooms } = req.app.locals

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (rooms && rooms.isHub) {
    // Hub mode: subscribe to all rooms + DMs
    for (const room of rooms.rooms()) {
      room.addClient(res, name, req.isAgent)
    }
    rooms.addDMClient(res, name)
  } else {
    // Legacy single-room mode
    const room = resolveRoom(req, req.query.room)
    if (!room) return res.status(404).json({ error: 'room not found' })
    room.addClient(res, name, req.isAgent)
  }
})
```

- [ ] **Step 2: Update client SSE URL — no room param in hub mode**

In `server/public/js/chat.js`, simplify `connectSSE()`:

```javascript
function connectSSE() {
  if (evtSource) evtSource.close()
  const url = `/api/chat/stream?name=${encodeURIComponent(myName)}`
  evtSource = new EventSource(url)
  evtSource.onmessage = handleEvent
  evtSource.onerror = () => {
    if (evtSource) evtSource.close()
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSSE()
    }, 3000)
  }
  input.focus()
}
```

And remove the `connectSSE()` call from `switchView()` — view switching is now purely client-side filtering:

```javascript
function switchView(view) {
  if (view === currentView) return
  currentView = view
  messages.innerHTML = ''
  lastSender = null
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null

  // Update active states
  for (const li of document.querySelectorAll('.room-item')) {
    li.classList.toggle('active', li.dataset.room === view)
  }
  for (const li of document.querySelectorAll('.participant-item')) {
    li.classList.toggle('active', 'dm:' + li.dataset.name === view)
  }

  const channelName = document.getElementById('channel-name')
  if (view.startsWith('dm:')) {
    channelName.textContent = view.replace('dm:', '')
  } else {
    channelName.textContent = view
  }

  // Clear unread
  const buf = roomBuffers.get(view)
  if (buf) {
    buf.unread = 0
    updateUnreadBadges()
  }

  // TODO: Request scrollback for new view (will be addressed in scrollback task)
}
```

- [ ] **Step 3: Handle duplicate presence from multi-room subscription**

When a hub client connects to all rooms, each room calls `addClient` which broadcasts `presence`. The client may get multiple presence events. Update `handleEvent` to merge presence from hub:

In the `case 'presence':` handler:

```javascript
    case 'presence':
      // In hub mode, presence may arrive per-room — merge into global list
      if (hubMode && event.room) {
        // Re-fetch aggregated presence
        refreshPresence()
      } else {
        updateParticipants(event.participants)
      }
      break
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Test manually**

Run: `npm run dev` with hub persona
Expected: Single SSE connection, events tagged by room, unread badges work across rooms

- [ ] **Step 6: Commit**

```bash
git add server/routes/chat.js server/public/js/chat.js
git commit -m "feat: hub SSE subscribes to all rooms, client-side view filtering"
```

---

### Task 10: Scrollback per room/DM

When switching views in hub mode, request scrollback for the target room. Add a new endpoint or use the existing scrollback mechanism scoped by room.

**Files:**
- Modify: `server/routes/chat.js` (add scrollback endpoint)
- Modify: `server/public/js/chat.js` (request scrollback on view switch)

- [ ] **Step 1: Add scrollback endpoint**

In `server/routes/chat.js`, add:

```javascript
// Request scrollback for a specific room
router.get('/api/chat/scrollback', (req, res) => {
  const room = resolveRoom(req, req.query.room)
  if (!room) return res.status(404).json({ error: 'room not found' })
  res.json({ messages: room.getScrollback() })
})
```

- [ ] **Step 2: Update switchView to fetch scrollback**

In `server/public/js/chat.js`, update `switchView()`:

```javascript
async function switchView(view) {
  if (view === currentView) return
  currentView = view
  messages.innerHTML = ''
  lastSender = null
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null

  for (const li of document.querySelectorAll('.room-item')) {
    li.classList.toggle('active', li.dataset.room === view)
  }
  for (const li of document.querySelectorAll('.participant-item')) {
    li.classList.toggle('active', 'dm:' + li.dataset.name === view)
  }

  const channelName = document.getElementById('channel-name')
  channelName.textContent = view.startsWith('dm:') ? view.replace('dm:', '') : view

  const buf = roomBuffers.get(view)
  if (buf) {
    buf.unread = 0
    updateUnreadBadges()
  }

  // Fetch scrollback for the new view
  if (!view.startsWith('dm:')) {
    try {
      const res = await fetch(`/api/chat/scrollback?room=${encodeURIComponent(view)}`)
      const data = await res.json()
      if (data.messages) {
        handleEvent({ data: JSON.stringify({ type: 'scrollback', messages: data.messages }) })
      }
    } catch {}
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add server/routes/chat.js server/public/js/chat.js
git commit -m "feat: per-room scrollback for hub view switching"
```

---

### Task 11: Integration test — full hub flow

End-to-end test: create a hub persona with two rooms, verify room-scoped messaging, DM routing, and presence aggregation.

**Files:**
- Create: `tests/hub-integration.test.js`

- [ ] **Step 1: Write integration test**

```javascript
// tests/hub-integration.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'
import { createAuthMiddleware } from '../server/lib/auth.js'
import chatRouter from '../server/routes/chat.js'
import healthRouter from '../server/routes/health.js'

async function createHubPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-hub-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Hub.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'hub',
    display_name: 'Hub',
    model: 'claude-sonnet-4-6',
    hosted_rooms: ['#general', '#dev'],
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Hub integration', () => {
  let server, rooms

  after(() => {
    if (rooms) rooms.destroy()
    if (server) server.close()
  })

  it('presence returns hosted_rooms list', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    app.use(healthRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/presence`)
    const data = await res.json()
    assert.deepStrictEqual(data.hosted_rooms, ['#general', '#dev'])
  })

  it('messages to different rooms are isolated', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    app.use(healthRouter)
    server = app.listen(0)
    const port = server.address().port

    // Collect events from #general
    const generalEvents = []
    const generalStream = await fetch(`http://localhost:${port}/api/chat/stream?name=alice&room=%23general`)
    // Note: In a real test we'd parse the SSE stream, but for unit testing
    // we verify via the room's history

    // Send to #general
    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello general', name: 'alice', room: '#general' }),
    })

    // Send to #dev
    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello dev', name: 'bob', room: '#dev' }),
    })

    // Wait for processing
    await new Promise(r => setTimeout(r, 100))

    // Check room histories are isolated
    const generalHistory = rooms.get('#general').getScrollback()
    const devHistory = rooms.get('#dev').getScrollback()

    // General should have alice's message but not bob's
    const generalTexts = generalHistory.map(h => h.text)
    assert.ok(generalTexts.includes('hello general'))
    assert.ok(!generalTexts.includes('hello dev'))

    // Dev should have bob's message but not alice's
    const devTexts = devHistory.map(h => h.text)
    assert.ok(devTexts.includes('hello dev'))
    assert.ok(!devTexts.includes('hello general'))
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `node --test tests/hub-integration.test.js`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/hub-integration.test.js
git commit -m "test: hub integration test for room isolation and presence"
```
