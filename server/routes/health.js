import { Router } from 'express'
import { State } from '../lib/state.js'

const router = Router()

router.get('/up', (req, res) => {
  const checks = req.app.locals.startupCheckResults
  if (checks && !checks.ok) {
    return res.status(503).json({
      status: 'degraded',
      service: 'cheesoid',
      version: process.env.npm_package_version || '0.1.0',
      missing: checks.missing
    })
  }
  res.json({
    status: 'ok',
    service: 'cheesoid',
    version: process.env.npm_package_version || '0.1.0'
  })
})

router.get('/api/health', (req, res) => {
  res.json({ status: 'ok', persona: req.app.locals.persona?.config?.display_name || 'unknown' })
})

router.get('/api/presence', async (req, res) => {
  const { persona, room } = req.app.locals
  const authProxy = !!persona.config.auth_proxy

  // Use the room's state if initialized, otherwise load fresh
  let stateData = {}
  if (room.state) {
    stateData = room.state.data
  } else {
    const state = new State(persona.dir)
    await state.load()
    stateData = state.data
  }

  const result = {
    persona: persona.config.display_name,
    state: stateData,
    participants: room.participantList,
    auth_proxy: authProxy,
  }

  if (authProxy) {
    const email = req.headers['x-gs-user-email']
    if (email) result.user = email.split('@')[0]
  }

  res.json(result)
})

export default router
