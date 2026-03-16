import { existsSync } from 'node:fs'

/**
 * Check that required filesystem paths exist at startup.
 * @param {string[]|undefined|null} requiredPaths - Array of absolute paths to verify
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function runStartupChecks(requiredPaths) {
  if (!requiredPaths || requiredPaths.length === 0) {
    return { ok: true, missing: [] }
  }

  const missing = []
  for (const path of requiredPaths) {
    if (!existsSync(path)) {
      console.error(`STARTUP CHECK FAILED: missing ${path}`)
      missing.push(path)
    }
  }

  return { ok: missing.length === 0, missing }
}
