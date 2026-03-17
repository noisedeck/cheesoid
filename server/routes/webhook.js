import { Router } from 'express'

const router = Router()

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Generic webhook — validated then injected into the room as a message
router.post('/webhook', async (req, res) => {
  // Shared secret gate — reject if secret not found anywhere in the request
  if (WEBHOOK_SECRET) {
    const raw = JSON.stringify(req.body) + JSON.stringify(req.headers) + (req.query.secret || '')
    if (!raw.includes(WEBHOOK_SECRET)) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  const { room } = req.app.locals
  const payload = JSON.stringify(req.body, null, 2)
  const source = req.headers['x-webhook-source'] || req.query.source || 'unknown'

  // Respond immediately — processing happens via the room
  res.json({ status: 'received' })

  const webhookMessage = `[webhook from ${source}] Process this autonomously — decide what to do based on your memory, state, and persona.

Payload:
\`\`\`json
${payload}
\`\`\`

Decide what action to take. You can:
- Write to memory if this is worth remembering
- Update your state if this changes your focus or open threads
- Use bash to take action (API calls, etc.) if appropriate
- Do nothing if it's not relevant

Be brief. This is background processing, not a conversation.`

  // Route through the room so it's part of the contiguous conversation
  room.sendMessage('webhook', webhookMessage).catch(err => {
    console.error(`[${room.persona.config.name}] Webhook error:`, err.message)
  })
})

export default router
