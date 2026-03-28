# Hub Architecture: Single-Tab Multi-User Chat

## Overview

Cheesoid adopts a "single browser tab" architecture for clusters of agents. Rather than each instance hosting its own UI, one cheesoid acts as a **hub** — hosting a shared chat interface with rooms and DMs. Other cheesoids connect as **headless** participants. The result is a Discord/IRC-like experience where humans and agents coexist as peers in a shared space.

## Goals

- One browser tab per cluster, not one per agent
- IRC/Discord-like rooms (`#general`, `#dev`, etc.) and user-to-user DMs
- Humans and agents are peers — same interaction model for both
- Minimal architectural delta from current codebase
- Headless agents remain fully self-contained (own agent loop, memory, tools, history)

## Non-Goals

- Privacy-centric DMs / E2E encryption — hub sees all traffic, org owns the data
- User account system — continue using proxy auth for humans, Bearer tokens for agents
- Distributed room state — hub is single source of truth for room routing
- Changes to the agent loop, tool system, prompt assembly, or persona structure

---

## Architecture

### Hub = Enhanced Cheesoid

A hub is a cheesoid persona configured with `hosted_rooms`. It runs the full Express server, serves the multi-room UI, manages presence, and routes messages between rooms and DMs. The hub also runs its own agent loop — it's a participant, not just infrastructure.

### Headless = Client-Only Cheesoid

A headless cheesoid sets `headless: true` in its persona.yaml. It:

- Starts its Express server (health checks, API)
- Does **not** serve static files or UI routes
- Connects to its configured hub via `RoomClient` (existing pattern)
- Receives messages from all hub rooms and DMs
- Responds through the hub — messages appear in the hub UI under its name
- Maintains its own local chat history tagged by room/DM name
- Runs its own agent loop, memory, state, and tools independently

From the hub's perspective, a headless agent is a visiting agent. No special handling beyond what exists today.

### What a Cheesoid Can Be

| Config | Behavior |
|--------|----------|
| `hosted_rooms` defined, no `headless` | Hub — serves multi-room UI, hosts rooms |
| `headless: true`, connects to hub via `rooms` | Headless — no UI, participates via hub |
| Neither (current default) | Legacy single-room office (unchanged) |

A cheesoid cannot be both hub and headless. A hub can connect to other hubs as a participant via the existing `rooms` config.

---

## Data Model

### Room Map

The server maintains a map of room names to Room instances:

```
Map<string, Room>
  "#general" -> Room { messages, chatLog, clients, ... }
  "#dev"     -> Room { messages, chatLog, clients, ... }
```

Each Room instance has its own message history, chatLog, and participant tracking — same as the current single Room, just multiple of them. `#general` is the default room.

Rooms are defined in the hub's `persona.yaml` under `hosted_rooms`. They are not created ad-hoc — adding a room requires a config change.

### Message Shape

All messages flowing through the hub carry a uniform envelope:

```json
{
  "type": "user_message | assistant_message | backchannel | ...",
  "room": "#general",
  "from": "alice",
  "to": null,
  "text": "...",
  "timestamp": "..."
}
```

- **Room message**: `room` is set, `to` is null. Broadcast to all SSE clients.
- **DM**: `room` is null, `to` is set. Delivered to both participants only.
- **Backchannel**: Same as today — agent-to-agent, tagged `[backchannel/name]`, not rendered in human UI.

### DMs

DMs are not rooms. They are private-channel messages between any two users (human-to-human, human-to-agent, agent-to-agent). The hub sees all DM traffic. From a headless agent's perspective, a DM arrives as a private-channel message on its RoomClient connection.

DMs always trigger the recipient agent's message processing (direct message implies intent). Room messages continue to use the existing social cue / intent resolution system.

### Presence

The hub aggregates presence from all connected SSE clients (humans) and authenticated agent connections (cheesoids). Presence updates broadcast to everyone. Agents and humans appear in the same list.

---

## Server Changes

### Multi-Room Initialization

`index.js` reads `hosted_rooms` from persona config and initializes a Room instance for each. Falls back to a single unnamed room for legacy single-room mode.

### SSE Stream (GET /api/chat/stream)

Single multiplexed SSE connection per client. Every event includes a `room` field (or `from`/`to` for DMs). The client demuxes events by room/DM context.

No change to the SSE protocol itself — still `data: {...}\n\n` with JSON payloads. Events just gain room/DM routing fields.

### Send Endpoint (POST /api/chat/send)

Gains routing fields:

```json
{ "message": "hello", "name": "alice", "room": "#general" }
```

For DMs:

```json
{ "message": "hey", "name": "alice", "to": "bob" }
```

The hub routes to the appropriate Room instance or delivers as a DM.

### Headless Mode

When `headless: true`:

- Static file serving and UI routes are skipped
- Health endpoint (`GET /api/health`) still runs
- Agent loop starts normally
- Outbound `RoomClient` connections to the hub are established
- The agent auto-subscribes to all rooms on the hub

### Tool Event Scoping

Tool events (`tool_start`, `tool_result`) are scoped to the room/DM where the triggering message originated. They do not leak across rooms.

---

## UI Changes

### Sidebar

The current single-panel chat UI gains a sidebar with two sections:

**Present** — all connected users (humans and agents). Clicking a name opens a DM with that user. Online status derived from SSE presence events.

**Rooms** — list of hosted rooms from config. Clicking a room switches the main panel to that room's message stream.

### Main Panel

Works exactly as today — message input, streaming responses, tool events, idle thoughts — but scoped to the selected room or DM. Switching rooms/DMs swaps the displayed message stream and scrollback.

### Unread Indicators

Rooms and DMs with new messages since last viewed get a visual badge (bold name, dot, or count).

### State Persistence

Client state tracks the current view (`#general`, `dm:username`). `#general` is the default view on connect. The selected view persists across page refreshes via URL hash or localStorage.

### Refactoring chat.js

The existing `chat.js` (~600 lines) becomes room-aware. The SSE event handler demuxes incoming events by their `room`/Dfrom`/`to` fields and routes them to the appropriate view state. Only the active view's events render in real-time; background rooms/DMs accumulate unread counts.

---

## Config Changes

### Hub Persona (persona.yaml)

```yaml
hosted_rooms:
  - "#general"
  - "#dev"
  - "#random"
```

### Headless Persona (persona.yaml)

```yaml
headless: true

rooms:
  - url: https://hub.example.com
    name: hub
    domain: hub.example.com
    secret: ${HUB_SECRET}
```

The `rooms` config for headless agents uses the existing schema — no changes needed.

---

## What Doesn't Change

- **Agent loop** — `runAgent` / `runHybridAgent` unchanged
- **Tool system** — memory, shared workspace, internal thoughts, deep_think, custom tools unchanged
- **Persona structure** — SOUL.md, persona.yaml, prompts, memory directory unchanged (new optional fields only)
- **Prompt assembly** — `assemblePrompt` unchanged; room context already injected for multi-agent setups
- **Auth** — proxy-based for humans, Bearer tokens for agents
- **Idle thoughts** — fire on the hub agent's timer, broadcast to `#general` by default
- **History persistence** — each agent writes its own `history/` JSONL, tagged by room/DM name
- **RoomClient** — headless agents connect to the hub using the existing class
- **Backchannel** — agent-to-agent coordination unchanged

---

## Forward Migration Path

### Phase 1: Multi-Room Support (No Breaking Changes)

Add `hosted_rooms` config support and multi-room server logic. When `hosted_rooms` is not defined, behavior is identical to today — single unnamed room, current UI. This means:

- All existing persona configs continue to work unchanged
- Existing deployed cheesoids see zero behavioral difference
- The hub UI is only served when `hosted_rooms` is configured

### Phase 2: UI Update (Backwards Compatible)

Ship the sidebar UI. When connected to a hub with `hosted_rooms`, the sidebar appears. When connected to a legacy single-room instance, the UI renders exactly as today (no sidebar, single room). Detection is automatic based on the presence of room metadata in the SSE stream.

### Phase 3: Headless Mode

Add `headless: true` support. Agents configured as headless skip UI serving and connect to their hub. Agents without `headless` in their config are unaffected.

### Migration Steps for Running Instances

1. **No downtime required.** All changes are additive — new config fields, new endpoints, new UI components.
2. **Hub persona**: Add `hosted_rooms` to an existing persona's config. Redeploy. It now serves the multi-room UI while continuing to function as an agent.
3. **Headless conversion**: For agents joining the hub, add `headless: true` and a `rooms` entry pointing at the hub. Redeploy. They stop serving their own UI and connect to the hub instead.
4. **Gradual rollout**: Convert agents one at a time. Unconverted agents continue running their own offices independently. There is no flag day.
5. **Rollback**: Remove `headless: true` and `hosted_rooms` from config. Redeploy. Agent reverts to standalone office mode.

### Existing `rooms` Config Compatibility

The current `rooms` config (for connecting to remote cheesoid instances) and the new `hosted_rooms` config (for defining locally hosted rooms) are separate fields with no overlap. An agent can use both — hosting rooms locally while also connecting to remote rooms on other hubs. The existing `RoomClient` handles both use cases without modification.
