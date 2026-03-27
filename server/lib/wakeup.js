import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Wakeup scheduler — runs a persona's wakeup prompt on a cron schedule.
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 * Fields support: numbers, '*', comma-separated lists, and step values (star/N).
 */
export class WakeupScheduler {
  constructor(persona, onWakeup) {
    this._persona = persona
    this._onWakeup = onWakeup
    this._timer = null
    this._destroyed = false
  }

  async start() {
    const config = this._persona.config.wakeup
    if (!config || config.mode !== 'cron' || !config.schedule) return

    // Pre-load the prompt to fail fast if it's missing
    const promptPath = config.prompt
    if (!promptPath) {
      console.error(`[${this._persona.config.name}] Wakeup configured but no prompt path`)
      return
    }

    try {
      await readFile(join(this._persona.dir, promptPath), 'utf8')
    } catch (err) {
      console.error(`[${this._persona.config.name}] Wakeup prompt not found: ${promptPath}`)
      return
    }

    this._schedule = parseCron(config.schedule)
    if (!this._schedule) {
      console.error(`[${this._persona.config.name}] Invalid cron schedule: ${config.schedule}`)
      return
    }

    this._promptPath = join(this._persona.dir, promptPath)
    this._scheduleNext()
    console.log(`[${this._persona.config.name}] Wakeup scheduled: ${config.schedule}`)
  }

  _scheduleNext() {
    if (this._destroyed) return

    const now = new Date()
    const next = nextMatch(this._schedule, now)
    const delay = next.getTime() - now.getTime()

    console.log(`[${this._persona.config.name}] Next wakeup: ${next.toISOString()} (${Math.round(delay / 60000)}m)`)

    this._timer = setTimeout(async () => {
      this._timer = null
      if (this._destroyed) return

      try {
        const prompt = await readFile(this._promptPath, 'utf8')
        await this._onWakeup(prompt)
      } catch (err) {
        console.error(`[${this._persona.config.name}] Wakeup error:`, err.message)
      }

      this._scheduleNext()
    }, delay)
  }

  destroy() {
    this._destroyed = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
}

/**
 * Parse a 5-field cron expression into a structured object.
 * Returns { minute, hour, dom, month, dow } where each is a Set of valid values,
 * or null if parsing fails.
 */
export function parseCron(expr) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 6],   // day of week (0=Sunday)
  ]

  const fields = []
  for (let i = 0; i < 5; i++) {
    const values = parseField(parts[i], ranges[i][0], ranges[i][1])
    if (!values) return null
    fields.push(values)
  }

  return {
    minute: fields[0],
    hour: fields[1],
    dom: fields[2],
    month: fields[3],
    dow: fields[4],
  }
}

function parseField(field, min, max) {
  const values = new Set()

  for (const part of field.split(',')) {
    // */N or N
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!stepMatch) return null

    const [, range, stepStr] = stepMatch
    const step = stepStr ? parseInt(stepStr) : 1
    if (step < 1) return null

    let start, end
    if (range === '*') {
      start = min
      end = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      if (isNaN(a) || isNaN(b) || a < min || b > max || a > b) return null
      start = a
      end = b
    } else {
      const n = parseInt(range)
      if (isNaN(n) || n < min || n > max) return null
      if (step === 1) {
        values.add(n)
        continue
      }
      start = n
      end = max
    }

    for (let v = start; v <= end; v += step) {
      values.add(v)
    }
  }

  return values
}

/**
 * Find the next Date after `after` that matches the cron schedule.
 * Searches up to 366 days ahead (safety bound).
 */
export function nextMatch(schedule, after) {
  // Start from the next whole minute
  const candidate = new Date(after)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const limit = 366 * 24 * 60 // max minutes to search
  for (let i = 0; i < limit; i++) {
    const month = candidate.getMonth() + 1 // 1-indexed
    const dom = candidate.getDate()
    const dow = candidate.getDay()
    const hour = candidate.getHours()
    const minute = candidate.getMinutes()

    if (
      schedule.month.has(month) &&
      schedule.dom.has(dom) &&
      schedule.dow.has(dow) &&
      schedule.hour.has(hour) &&
      schedule.minute.has(minute)
    ) {
      return candidate
    }

    candidate.setMinutes(candidate.getMinutes() + 1)
  }

  // Should never happen with valid schedules
  throw new Error('No cron match found within 366 days')
}
