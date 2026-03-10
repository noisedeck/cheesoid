/**
 * Auth middleware for groundsquirrel integration and agent bearer tokens.
 *
 * createAuthMiddleware(agents) — factory that returns middleware supporting:
 *   - Bearer token auth for agents (if agents configured)
 *   - X-GS-User-Email header (groundsquirrel proxy)
 *   - Passthrough for dev mode
 *
 * requireAuth — simple backward-compatible middleware (groundsquirrel only)
 */

export function createAuthMiddleware(agents) {
  const secretMap = new Map()
  if (agents && agents.length > 0) {
    for (const { name, secret } of agents) {
      secretMap.set(secret, name)
    }
  }

  return function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization']

    // Check bearer token first
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7)

      if (secretMap.size > 0) {
        const agentName = secretMap.get(token)
        if (agentName) {
          req.userName = agentName
          req.isAgent = true
          return next()
        }
        // Invalid token when agents are configured
        return res.status(401).json({ error: 'Invalid bearer token' })
      }

      // No agents configured — pass through
      req.isAgent = false
      return next()
    }

    // Fall back to groundsquirrel header
    const email = req.headers['x-gs-user-email']
    if (email) {
      req.userName = email.split('@')[0]
      req.userEmail = email
    }
    req.isAgent = false
    next()
  }
}

export function requireAuth(req, res, next) {
  const email = req.headers['x-gs-user-email']
  if (email) {
    req.userName = email.split('@')[0]
    req.userEmail = email
  }
  req.isAgent = false
  next()
}
