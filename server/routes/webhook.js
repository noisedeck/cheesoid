import { Router } from 'express'
import { runAgent } from '../lib/agent.js'

const router = Router()

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Generic webhook — the agent receives arbitrary JSON and decides what to do
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

  if (room.busy) {
    return res.status(503).json({ status: 'busy', message: 'Agent is currently processing' })
  }

  res.json({ status: 'received' })

  // Process autonomously — not in the chat room
  room.busy = true
  try {
    if (!room.systemPrompt) await room.initialize()

    const webhookPrompt = `You have received a webhook. Process it autonomously — decide what to do based on your memory, state, and persona.

Source: ${source}
Timestamp: ${new Date().toISOString()}

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

    const messages = [{ role: 'user', content: webhookPrompt }]
    const config = {
      model: room.persona.config.model,
      maxTurns: req.body.max_turns || 10,
      thinkingBudget: room.persona.config.chat?.thinking_budget || null,
    }

    const noop = () => {}
    await runAgent(room.systemPrompt, messages, room.tools, config, noop)

    console.log(`[${room.persona.config.name}] Webhook processed from ${source}`)
  } catch (err) {
    console.error(`[${room.persona.config.name}] Webhook error:`, err.message)
  } finally {
    room.busy = false
  }
})

export default router
