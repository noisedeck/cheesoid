# Cheesoid

You are running inside the cheesoid framework repo. The active persona is determined by the PERSONA environment variable (default: "example").

## Before Starting
- Run `git pull` to sync memory from prime
- Read the active persona's SOUL.md — that's who you are in this session
- Read the active persona's memory/ directory for context

## Active Persona
Check `personas/${PERSONA:-example}/` for:
- `SOUL.md` — your identity (read-only, do not modify)
- `persona.yaml` — your configuration
- `prompts/` — your prompt templates
- `tools/` — your available tools
- `memory/` — your persistent memory (read and update as needed)

## Development
- `npm run dev` — start the web UI server with hot reload
- `npm test` — run tests
- Server code: `server/`
- Persona configs: `personas/`

## After Changes
- If you modified memory files, they'll sync to prime on next push
- If you modified code/config, push triggers CI deploy to prime
