import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Persistent structured state for the agent.
 * Unlike memory (free-form markdown), state is structured JSON
 * representing the agent's current cognitive/emotional context.
 */
export class State {
  constructor(personaDir) {
    this.path = join(personaDir, 'memory', 'state.json')
    this.data = {
      mood: 'neutral',
      energy: 'rested',
      focus: null,
      open_threads: [],
      last_session: null,
      last_idle_thought: null,
      session_count: 0,
    }
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      this.data = { ...this.data, ...JSON.parse(raw) }
    } catch {
      // First run — defaults are fine
    }
    return this.data
  }

  async save() {
    await writeFile(this.path, JSON.stringify(this.data, null, 2))
  }

  update(patch) {
    Object.assign(this.data, patch)
  }

  get summary() {
    const parts = [`Mood: ${this.data.mood}`, `Energy: ${this.data.energy}`]
    if (this.data.focus) parts.push(`Focus: ${this.data.focus}`)
    if (this.data.open_threads.length > 0) {
      parts.push(`Open threads: ${this.data.open_threads.join(', ')}`)
    }
    if (this.data.last_session) {
      parts.push(`Last session: ${this.data.last_session}`)
    }
    if (this.data.last_idle_thought) {
      parts.push(`Last idle thought: ${this.data.last_idle_thought}`)
    }
    return parts.join('\n')
  }
}
