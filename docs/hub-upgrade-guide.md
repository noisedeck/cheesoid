# Hub Architecture Upgrade Guide

This guide covers upgrading existing cheesoid instances to use the hub architecture. All changes are additive — existing standalone instances continue to work without any config changes.

## Overview

The hub architecture introduces three modes:

| Mode | Config | Behavior |
|------|--------|----------|
| **Standalone** (default) | No changes | Single-room office, same as before |
| **Hub** | `hosted_rooms` added | Multi-room UI with sidebar, hosts rooms for others |
| **Headless** | `headless: true` added | No UI, connects to a hub as a participant |

## Upgrading a Standalone Instance to Hub

Add `hosted_rooms` to the persona's `persona.yaml`:

```yaml
# Existing config stays exactly the same.
# Just add this:
hosted_rooms:
  - "#general"
  - "#dev"
```

Redeploy. The instance now serves the multi-room UI with a sidebar showing Rooms and Present sections. The agent participates in all hosted rooms.

### What changes for users

- The browser UI gets a sidebar with **Rooms** (clickable to switch) and **Present** (clickable to DM)
- `#general` (first room) is the default view on connect
- The old "office" single-room view is replaced by room-scoped views
- Existing chat history is preserved but won't appear in any room's scrollback (it predates rooms)

### What changes for the agent

- The agent's idle thoughts broadcast to the first room by default
- Messages arrive tagged with room context (e.g. `[#general/alice]`)
- The agent's own message history is tagged by room name in its JSONL logs
- All existing tools, memory, state, and prompt assembly are unchanged

## Converting an Agent to Headless

For agents that should participate in a hub without hosting their own UI:

```yaml
# Existing config stays the same.
# Add these:
headless: true

rooms:
  - url: https://hub.example.com
    name: hub
    domain: hub.example.com
    secret: ${HUB_SECRET}
```

And on the **hub** side, register the headless agent:

```yaml
agents:
  - name: Headless Agent Display Name
    secret: ${HEADLESS_AGENT_SECRET}
```

The headless agent connects to the hub via `RoomClient` (existing pattern). Its messages appear in the hub UI under its display name. It receives messages from all hub rooms.

### What the headless agent keeps

- Its own Express server (health checks at `/up` and `/api/health`)
- Its own agent loop, memory, state, and tools
- Its own chat history (tagged by room name)
- All existing `RoomClient` connections to other instances

### What the headless agent loses

- The `GET /` HTML page and static file serving
- Direct browser access (users interact via the hub UI instead)

## Example: Two-Agent Hub Cluster

### Hub persona (`personas/hub/persona.yaml`)

```yaml
name: hub
display_name: "Hub"
model: claude-sonnet-4-6

hosted_rooms:
  - "#general"
  - "#ops"

agents:
  - name: EHSRE
    secret: ${EHSRE_SECRET}

auth_proxy: true
theme: terminal
data_theme: terminal

chat:
  prompt: prompts/system.md
  max_turns: 20

memory:
  dir: memory/
  auto_read:
    - MEMORY.md
```

### Headless agent (`personas/ehsre/persona.yaml`)

```yaml
name: ehsre
display_name: "Emergency Holographic SRE"
model: claude-sonnet-4-6

headless: true

rooms:
  - url: https://hub.example.com
    name: hub
    domain: hub.example.com
    secret: ${EHSRE_SECRET}

chat:
  prompt: prompts/system.md
  max_turns: 20

memory:
  dir: memory/
  auto_read:
    - MEMORY.md
```

## Rollback

Remove `hosted_rooms` or `headless: true` from the config and redeploy. The instance reverts to standalone office mode immediately.

## Config Reference

### New fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hosted_rooms` | `string[]` | (none) | Room names to host. Enables hub mode. Use IRC-style names (`#general`). |
| `headless` | `boolean` | `false` | Skip UI serving. Agent connects to a hub via `rooms` config. |

### Unchanged fields

All existing fields (`model`, `orchestrator`, `providers`, `tools`, `chat`, `memory`, `agents`, `rooms`, `auth_proxy`, `theme`, etc.) work exactly as before. The `rooms` field (for connecting to remote instances) and `hosted_rooms` (for defining locally hosted rooms) are independent — an instance can use both.

## Deployment Order

No specific order required. Convert instances one at a time:

1. Deploy the hub first (add `hosted_rooms` to an existing persona)
2. Convert agents to headless one at a time (add `headless: true` + hub `rooms` entry)
3. Unconverted agents continue running their own offices independently

There is no flag day. Mixed clusters (some hub, some standalone) work fine.
