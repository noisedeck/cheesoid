import { appendFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export class ChatLog {
  constructor(personaDir) {
    this.dir = join(personaDir, 'history')
    this._ready = mkdir(this.dir, { recursive: true })
  }

  async append(entry) {
    await this._ready
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'
    await appendFile(join(this.dir, `${date}.jsonl`), line)
  }

  async search(query, { limit = 50 } = {}) {
    await this._ready
    let files
    try {
      files = (await readdir(this.dir)).filter(f => f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }

    const pattern = query.toLowerCase()
    const results = []

    // Search newest files first
    for (let i = files.length - 1; i >= 0 && results.length < limit; i--) {
      const content = await readFile(join(this.dir, files[i]), 'utf8').catch(() => '')
      const lines = content.trim().split('\n').filter(Boolean)
      for (let j = lines.length - 1; j >= 0 && results.length < limit; j--) {
        try {
          const entry = JSON.parse(lines[j])
          if (entry.text && entry.text.toLowerCase().includes(pattern)) {
            results.push(entry)
          }
        } catch { /* skip malformed lines */ }
      }
    }

    return results
  }

  async recent(limit = 50) {
    await this._ready
    let files
    try {
      files = (await readdir(this.dir)).filter(f => f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }

    // Collect entries from newest files first, then return the last N in chronological order
    const collected = []

    for (let i = files.length - 1; i >= 0 && collected.length < limit; i--) {
      const content = await readFile(join(this.dir, files[i]), 'utf8').catch(() => '')
      const lines = content.trim().split('\n').filter(Boolean)
      for (let j = lines.length - 1; j >= 0 && collected.length < limit; j--) {
        try {
          collected.push(JSON.parse(lines[j]))
        } catch { /* skip malformed lines */ }
      }
    }

    return collected.reverse()
  }
}
