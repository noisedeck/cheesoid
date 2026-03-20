# Agent Experience Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four improvements to the Cheesoid agent framework: shared workspace tools, startup volume health checks, jq in container image, and ground truth hierarchy in prompt assembly.

**Architecture:** All changes are additive. Shared workspace adds a new tool module following the memory/room tool pattern. Startup checks add a pre-listen validation pass. Prompt assembler gets one new static section. Dockerfile gets one package.

**Tech Stack:** Node.js 22, Express 4, node:test runner, node:fs/promises

**Spec:** `docs/specs/2026-03-16-agent-experience-improvements.md`

**Working directory:** `/Users/aayars/platform/cheesoid`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `server/lib/shared-workspace.js` | Create | Shared workspace tool module (list, read, write `/shared/`) |
| `server/lib/startup-checks.js` | Create | Validate required paths exist at startup |
| `server/lib/tools.js` | Modify | Wire in shared workspace tools |
| `server/lib/prompt-assembler.js` | Modify | Add source trust hierarchy block |
| `server/routes/health.js` | Modify | Return 503 if startup checks failed |
| `server/index.js` | Modify | Run startup checks before listen |
| `Dockerfile` | Modify | Add jq |
| `tests/shared-workspace.test.js` | Create | Shared workspace tool tests |
| `tests/startup-checks.test.js` | Create | Startup check tests |
| `tests/prompt-assembler.test.js` | Modify | Verify trust hierarchy in prompt |

---

## Chunk 1: Shared Workspace

### Task 1: Shared Workspace Module

**Files:**
- Create: `server/lib/shared-workspace.js`
- Test: `tests/shared-workspace.test.js`

- [ ] **Step 1: Write the tests**

Create `tests/shared-workspace.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSharedWorkspaceTools } from '../server/lib/shared-workspace.js'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SharedWorkspace', () => {
  async function makeSharedDir(files = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-shared-'))
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    return dir
  }

  it('exports definitions for list_shared, read_shared, write_shared', () => {
    const tools = buildSharedWorkspaceTools('/tmp/fake')
    const names = tools.definitions.map(d => d.name)
    assert.deepEqual(names, ['list_shared', 'read_shared', 'write_shared'])
  })

  it('handles() returns true for shared tool names', () => {
    const tools = buildSharedWorkspaceTools('/tmp/fake')
    assert.ok(tools.handles('list_shared'))
    assert.ok(tools.handles('read_shared'))
    assert.ok(tools.handles('write_shared'))
    assert.ok(!tools.handles('bash'))
  })

  it('writes and reads a file', async () => {
    const dir = await makeSharedDir()
    const tools = buildSharedWorkspaceTools(dir)
    const writeResult = await tools.execute('write_shared', { path: 'test.md', content: 'Hello shared.' })
    assert.ok(!writeResult.is_error)
    const readResult = await tools.execute('read_shared', { path: 'test.md' })
    assert.equal(readResult.output, 'Hello shared.')
  })

  it('creates parent directories on write', async () => {
    const dir = await makeSharedDir()
    const tools = buildSharedWorkspaceTools(dir)
    await tools.execute('write_shared', { path: 'sub/dir/file.md', content: 'Nested.' })
    const content = await readFile(join(dir, 'sub/dir/file.md'), 'utf8')
    assert.equal(content, 'Nested.')
  })

  it('lists files in root', async () => {
    const dir = await makeSharedDir({ 'a.md': 'a', 'b.md': 'b' })
    const tools = buildSharedWorkspaceTools(dir)
    const result = await tools.execute('list_shared', {})
    assert.ok(result.output.includes('a.md'))
    assert.ok(result.output.includes('b.md'))
  })

  it('lists files in subdirectory', async () => {
    const dir = await makeSharedDir({ 'sub/c.md': 'c' })
    const tools = buildSharedWorkspaceTools(dir)
    const result = await tools.execute('list_shared', { path: 'sub' })
    assert.ok(result.output.includes('c.md'))
  })

  it('returns error for missing file', async () => {
    const dir = await makeSharedDir()
    const tools = buildSharedWorkspaceTools(dir)
    const result = await tools.execute('read_shared', { path: 'nope.md' })
    assert.ok(result.is_error)
  })

  it('blocks directory traversal', async () => {
    const dir = await makeSharedDir()
    const tools = buildSharedWorkspaceTools(dir)
    const result = await tools.execute('read_shared', { path: '../../etc/passwd' })
    assert.ok(result.is_error)
    assert.ok(result.output.includes('outside'))
  })

  it('blocks traversal on write', async () => {
    const dir = await makeSharedDir()
    const tools = buildSharedWorkspaceTools(dir)
    const result = await tools.execute('write_shared', { path: '../escape.md', content: 'bad' })
    assert.ok(result.is_error)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/shared-workspace.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `server/lib/shared-workspace.js`:

```javascript
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

export function buildSharedWorkspaceTools(sharedRoot) {
  const definitions = [
    {
      name: 'list_shared',
      description: 'List files and directories in the shared workspace at /shared/. All agents can read and write here.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Subdirectory path (optional, defaults to root)' },
        },
      },
    },
    {
      name: 'read_shared',
      description: 'Read a file from the shared workspace at /shared/.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to /shared/' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_shared',
      description: 'Write a file to the shared workspace at /shared/. Creates parent directories if needed. Other agents can immediately read this file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to /shared/' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  ]

  const toolNames = new Set(definitions.map(d => d.name))

  function safePath(userPath) {
    const resolved = resolve(sharedRoot, userPath || '')
    const rel = relative(sharedRoot, resolved)
    if (rel.startsWith('..') || resolve(sharedRoot, rel) !== resolved) {
      return null
    }
    return resolved
  }

  async function execute(name, input) {
    switch (name) {
      case 'list_shared': {
        const target = safePath(input.path || '')
        if (!target) return { output: 'Path outside shared workspace.', is_error: true }
        try {
          const entries = await readdir(target, { withFileTypes: true })
          const listing = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name)
          return { output: listing.length > 0 ? listing.join('\n') : '(empty)' }
        } catch {
          return { output: `Directory not found: ${input.path || '/'}`, is_error: true }
        }
      }
      case 'read_shared': {
        const target = safePath(input.path)
        if (!target) return { output: 'Path outside shared workspace.', is_error: true }
        try {
          const content = await readFile(target, 'utf8')
          return { output: content }
        } catch {
          return { output: `File not found: ${input.path}`, is_error: true }
        }
      }
      case 'write_shared': {
        const target = safePath(input.path)
        if (!target) return { output: 'Path outside shared workspace.', is_error: true }
        try {
          await mkdir(join(target, '..'), { recursive: true })
          await writeFile(target, input.content)
          return { output: `Written: ${input.path}` }
        } catch (err) {
          return { output: `Write failed: ${err.message}`, is_error: true }
        }
      }
      default:
        return { output: `Unknown shared tool: ${name}`, is_error: true }
    }
  }

  return { definitions, handles: (name) => toolNames.has(name), execute }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/shared-workspace.test.js`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add server/lib/shared-workspace.js tests/shared-workspace.test.js
git commit -m "feat: add shared workspace tools (list/read/write /shared/)"
```

### Task 2: Wire Shared Workspace into Tool Loader

**Files:**
- Modify: `server/lib/tools.js`

- [ ] **Step 1: Add import and integrate shared workspace tools**

In `server/lib/tools.js`, add at line 2:

```javascript
import { buildSharedWorkspaceTools } from './shared-workspace.js'
```

In the `loadTools` function, after `const roomTools = buildRoomTools(room, config)` (line 10), add:

```javascript
  const sharedTools = buildSharedWorkspaceTools(process.env.SHARED_WORKSPACE_PATH || '/shared')
```

Change line 23 to include shared tools:

```javascript
  const allDefinitions = [...memoryTools.definitions, ...sharedTools.definitions, ...roomTools.definitions, ...personaTools.definitions]
```

In the `execute` function, add after the `memoryTools.handles` check (after line 28):

```javascript
    if (sharedTools.handles(name)) {
      return sharedTools.execute(name, input)
    }
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/aayars/platform/cheesoid && npm test`
Expected: All tests pass (shared workspace tools don't need room/memory fixtures)

- [ ] **Step 3: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add server/lib/tools.js
git commit -m "feat: register shared workspace tools in tool loader"
```

---

## Chunk 2: Startup Health Checks

### Task 3: Startup Checks Module

**Files:**
- Create: `server/lib/startup-checks.js`
- Test: `tests/startup-checks.test.js`

- [ ] **Step 1: Write the tests**

Create `tests/startup-checks.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runStartupChecks } from '../server/lib/startup-checks.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('startupChecks', () => {
  it('returns ok when all paths exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-sc-'))
    await writeFile(join(dir, 'file.txt'), 'exists')
    const result = runStartupChecks([join(dir, 'file.txt')])
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('returns missing paths that do not exist', () => {
    const result = runStartupChecks(['/nonexistent/path/xyz'])
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, ['/nonexistent/path/xyz'])
  })

  it('returns ok with empty required paths', () => {
    const result = runStartupChecks([])
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('returns ok when config has no startup_checks', () => {
    const result = runStartupChecks(undefined)
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
  })

  it('reports multiple missing paths', () => {
    const result = runStartupChecks(['/no/a', '/no/b'])
    assert.equal(result.ok, false)
    assert.equal(result.missing.length, 2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/startup-checks.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `server/lib/startup-checks.js`:

```javascript
import { existsSync } from 'node:fs'

/**
 * Check that required filesystem paths exist.
 * Returns { ok: boolean, missing: string[] }
 */
export function runStartupChecks(requiredPaths) {
  if (!requiredPaths || requiredPaths.length === 0) {
    return { ok: true, missing: [] }
  }

  const missing = requiredPaths.filter(p => !existsSync(p))

  for (const p of missing) {
    console.error(`STARTUP CHECK FAILED: missing ${p}`)
  }

  return { ok: missing.length === 0, missing }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/startup-checks.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add server/lib/startup-checks.js tests/startup-checks.test.js
git commit -m "feat: add startup path verification module"
```

### Task 4: Wire Startup Checks into Server + Health Endpoint

**Files:**
- Modify: `server/index.js`
- Modify: `server/routes/health.js`

- [ ] **Step 1: Add startup checks to server/index.js**

Add import at line 6 (after Room import):

```javascript
import { runStartupChecks } from './lib/startup-checks.js'
```

After line 27 (`app.locals.authMiddleware = ...`), add:

```javascript
// Startup checks
const requiredPaths = persona.config.startup_checks?.required_paths || []
app.locals.startupCheckResults = runStartupChecks(requiredPaths)
```

- [ ] **Step 2: Update health endpoint in server/routes/health.js**

Replace the `/up` route (lines 6-12) with:

```javascript
router.get('/up', (req, res) => {
  const checks = req.app.locals.startupCheckResults
  if (checks && !checks.ok) {
    return res.status(503).json({
      status: 'degraded',
      service: 'cheesoid',
      version: process.env.npm_package_version || '0.1.0',
      missing: checks.missing,
    })
  }
  res.json({
    status: 'ok',
    service: 'cheesoid',
    version: process.env.npm_package_version || '0.1.0',
  })
})
```

- [ ] **Step 3: Run all tests**

Run: `cd /Users/aayars/platform/cheesoid && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add server/index.js server/routes/health.js
git commit -m "feat: gate /up health check on startup volume verification"
```

---

## Chunk 3: Prompt Assembler + Dockerfile

### Task 5: Ground Truth Hierarchy in Prompt Assembler

**Files:**
- Modify: `server/lib/prompt-assembler.js`
- Modify: `tests/prompt-assembler.test.js`

- [ ] **Step 1: Add test for trust hierarchy**

Append to `tests/prompt-assembler.test.js`, inside the `describe` block:

```javascript
  it('includes source trust hierarchy before memory', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Memory content.',
    })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('Source Trust Hierarchy'))
    assert.ok(result.includes('Live data'))
    assert.ok(result.includes('Repository documentation'))

    // Trust hierarchy comes before memory
    const trustIdx = result.indexOf('Source Trust Hierarchy')
    const memoryIdx = result.indexOf('Memory content.')
    assert.ok(trustIdx < memoryIdx)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/prompt-assembler.test.js`
Expected: FAIL — "Source Trust Hierarchy" not found

- [ ] **Step 3: Add trust hierarchy to prompt assembler**

In `server/lib/prompt-assembler.js`, add after line 1:

```javascript
const SOURCE_TRUST_HIERARCHY = `## Source Trust Hierarchy
When sources conflict, trust in this order:
1. Live data (API responses, database queries, health checks)
2. Agent memory (your own verified observations)
3. Repository documentation (may be stale)
If you find a conflict, surface it explicitly rather than silently picking one source.`
```

In the `assemblePrompt` function, add before the memory section comment (before line 90 `// 4. Memory files`):

```javascript
  // Source trust guidance — always present, before memory
  sections.push(SOURCE_TRUST_HIERARCHY)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/aayars/platform/cheesoid && node --test tests/prompt-assembler.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add server/lib/prompt-assembler.js tests/prompt-assembler.test.js
git commit -m "feat: inject source trust hierarchy into all agent prompts"
```

### Task 6: Add jq to Dockerfile

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Update apt-get install line**

Change line 3 of `Dockerfile` from:

```dockerfile
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
```

to:

```dockerfile
RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Verify Dockerfile builds**

Run: `cd /Users/aayars/platform/cheesoid && docker build -t cheesoid-test . 2>&1 | tail -5`
Expected: Build completes successfully

- [ ] **Step 3: Verify jq is available**

Run: `docker run --rm cheesoid-test jq --version`
Expected: `jq-1.x` version string

- [ ] **Step 4: Commit**

```bash
cd /Users/aayars/platform/cheesoid
git add Dockerfile
git commit -m "feat: add jq to container image"
```

---

## Chunk 4: Final Verification + Squash

### Task 7: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `cd /Users/aayars/platform/cheesoid && npm test`
Expected: All tests pass (including new shared-workspace and startup-checks tests)

- [ ] **Step 2: Squash commits and push**

```bash
cd /Users/aayars/platform/cheesoid
git rebase -i HEAD~6
# Squash all into one commit:
# "feat: agent experience improvements (shared workspace, startup checks, jq, source trust hierarchy)"
git push origin main
```

### Task 8: Infrastructure — Shared Volume + Dispatch Workflow

This task updates the scaffold repo to mount the shared volume in all agent containers.

- [ ] **Step 1: Create shared Docker volume on ops server**

```bash
ssh ops@172.105.109.25 'docker volume create cheesoid-shared'
```

- [ ] **Step 2: Update dispatch-cheesoid-deploy.yml**

In `/Users/aayars/platform/scaffold/.github/workflows/dispatch-cheesoid-deploy.yml`, add `-v cheesoid-shared:/shared` to each agent's `docker run` block:

**Brad block** (after the existing `-v` lines, before `--restart`):
```bash
              -v cheesoid-shared:/shared \
```

**EHSRE block** (after `-v /home/ops/secrets:/secrets:ro`):
```bash
              -v cheesoid-shared:/shared \
```

**Yip Yip EHSRE block** (after `-v /home/ops/secrets/.yipyip-ehsre:/secrets:ro`):
```bash
              -v cheesoid-shared:/shared \
```

**Margo block** (after `-v /home/ops/margo/secrets:/secrets:ro`):
```bash
              -v cheesoid-shared:/shared \
```

- [ ] **Step 3: Commit scaffold changes**

```bash
cd /Users/aayars/platform/scaffold
git add .github/workflows/dispatch-cheesoid-deploy.yml
git commit -m "feat: mount shared workspace volume in all cheesoid containers"
git push
```

- [ ] **Step 4: Recreate running containers with shared volume**

Restart each agent container with the shared volume added (one at a time to avoid downtime):

```bash
# Brad
ssh ops@172.105.109.25 'docker stop brad && docker rm brad'
# Re-run with -v cheesoid-shared:/shared (same docker run as dispatch workflow)

# Margo
ssh ops@172.105.109.25 'docker stop margo && docker rm margo'
# Re-run with -v cheesoid-shared:/shared

# EHSRE
ssh ops@172.105.109.25 'docker stop ehsre && docker rm ehsre'
# Re-run with -v cheesoid-shared:/shared
```

Note: The exact `docker run` commands depend on each agent's current env vars. The dispatch workflow will handle this correctly on next cheesoid image update (every 5 min poll). For immediate deployment, trigger manually: `gh workflow run dispatch-cheesoid-deploy.yml --repo noisedeck/scaffold -f force=true`

- [ ] **Step 5: Verify shared workspace works**

```bash
# Write from one container, read from another
ssh ops@172.105.109.25 'docker exec brad bash -c "echo hello > /shared/test.txt"'
ssh ops@172.105.109.25 'docker exec margo bash -c "cat /shared/test.txt"'
# Expected: "hello"
ssh ops@172.105.109.25 'docker exec brad bash -c "rm /shared/test.txt"'
```

### Task 9: Comment on Issue

- [ ] **Step 1: Post implementation summary on issue #2**

Using the EHSRE GitHub App, comment on https://github.com/noisedeck/cheesoid/issues/2 with a summary of what was implemented and what remains as process/convention items (not framework code).
