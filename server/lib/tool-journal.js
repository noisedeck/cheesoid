import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_ENTRIES = 50
const JOURNAL_FILE = 'tool-journal.jsonl'

// Internal/bookkeeping tools that don't need journaling
const SKIP_TOOLS = new Set([
  'get_state', 'update_state', 'read_memory', 'write_memory',
  'append_memory', 'list_memory', 'search_history', 'internal',
  'step_up', 'step_down', 'deep_think',
])

/**
 * Persistent journal of recent tool use, stored as JSONL in the persona's
 * memory directory. Loaded into agent context on session start so agents
 * have awareness of their recent actions across session boundaries.
 */
export class ToolJournal {
  constructor(personaDir, memorySubdir = 'memory/') {
    this.path = join(personaDir, memorySubdir, JOURNAL_FILE)
  }

  /**
   * Record a tool use event. Called after each tool_result.
   */
  async record(name, input, result) {
    if (SKIP_TOOLS.has(name)) return

    const entry = {
      ts: new Date().toISOString(),
      tool: name,
      summary: summarize(name, input, result),
    }

    // Append + rotate
    const entries = await this._load()
    entries.push(entry)
    const trimmed = entries.slice(-MAX_ENTRIES)
    await writeFile(this.path, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  /**
   * Get recent tool use as a formatted string for injection into context.
   * Returns null if no entries.
   */
  async getContextBlock(limit = 20) {
    const entries = await this._load()
    if (entries.length === 0) return null

    const recent = entries.slice(-limit)
    const lines = recent.map(e => `[${e.ts}] ${e.tool}: ${e.summary}`)
    return `## Recent Tool Use (last ${recent.length} actions)\n\n${lines.join('\n')}`
  }

  async _load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {
      return []
    }
  }
}

function summarize(name, input, result) {
  const output = typeof result === 'string' ? result
    : result?.output || result?.error || ''
  const isError = result?.is_error
  const fail = isError ? ' [FAILED]' : ''

  switch (name) {
    case 'bash':
      return `$ ${truncate(input.command, 100)} → ${truncate(output, 200)}${fail}`
    case 'send_mail':
      return `sent to ${input.to}: "${input.subject}"${fail}`
    case 'check_mail':
      return `inbox: ${truncate(output, 300)}`
    case 'check_sent':
      return `outbox: ${truncate(output, 300)}`
    case 'read_mail':
      return `read mail ${input.id}: ${truncate(output, 300)}${fail}`
    case 'read_sent':
      return `read sent ${input.id}: ${truncate(output, 300)}${fail}`
    case 'read_file':
      return `read ${input.path}: ${truncate(output, 300)}${fail}`
    case 'send_chat_message':
      return `said in chat: ${truncate(input.text, 200)}`
    case 'read_shared':
      return `read shared ${input.filename || ''}: ${truncate(output, 300)}${fail}`
    case 'list_shared':
      return `listed shared: ${truncate(output, 200)}`
    case 'write_shared':
      return `wrote shared ${input.filename || ''} (${(input.content || '').length} chars)${fail}`
    default:
      return `${truncate(JSON.stringify(input), 80)} → ${truncate(output, 200)}${fail}`
  }
}

function truncate(str, max = 150) {
  if (!str) return ''
  const clean = str.replace(/\n/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}
