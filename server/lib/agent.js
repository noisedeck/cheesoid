/**
 * Heuristic intent classifier — determines tool vs text without an API call.
 * Returns 'required', 'none', or 'uncertain' (needs LLM classification).
 */
const ACTION_PATTERNS = /\b(run|check|execute|start|stop|restart|deploy|show|look up|find|search|fetch|get|list|read|write|create|delete|update|send|post|curl|ssh|grep|approve|reject|moderate|inspect)\b/i
const CONVERSATION_PATTERNS = /^(thanks|thank you|ok|okay|lol|haha|nice|cool|great|good|got it|understood|sure|yep|yeah|yes|no|nah|hmm|interesting|wow|huh|right|true|fair|agreed)\b/i
const QUESTION_ABOUT_AGENT = /\b(how are you|what do you think|who are you|what are you|how do you feel|tell me about yourself)\b/i

export function classifyIntentHeuristic(lastUserContent) {
  if (!lastUserContent || typeof lastUserContent !== 'string') return 'uncertain'
  const trimmed = lastUserContent.trim()
  if (!trimmed) return 'uncertain'

  // Short acknowledgments → text
  if (trimmed.length < 20 && CONVERSATION_PATTERNS.test(trimmed)) return 'none'

  // Questions about the agent → text
  if (QUESTION_ABOUT_AGENT.test(trimmed)) return 'none'

  // Action verbs → tool
  if (ACTION_PATTERNS.test(trimmed)) return 'required'

  return 'uncertain'
}

/**
 * Attempt to extract a tool call from text that was narrated instead of
 * being emitted as a structured tool_calls response. Returns a tool_use
 * block if found, null otherwise.
 */
export function _rescueNarratedToolCall(text, toolDefs) {
  const trimmed = text.trim()
  const validNames = new Set(toolDefs.map(t => t.name))

  // Strategy 1: try to parse the whole text as JSON
  try {
    const obj = JSON.parse(trimmed)
    if (obj.name && validNames.has(obj.name) && typeof obj.arguments === 'object') {
      return {
        type: 'tool_use',
        id: `toolu_rescued_${Date.now()}`,
        name: obj.name,
        input: obj.arguments,
      }
    }
  } catch {
    // not clean JSON, try extraction
  }

  // Strategy 2: find first JSON object in text using balanced brace matching
  const startIdx = trimmed.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++
    else if (trimmed[i] === '}') depth--
    if (depth === 0) { endIdx = i; break }
  }
  if (endIdx === -1) return null

  try {
    const obj = JSON.parse(trimmed.slice(startIdx, endIdx + 1))
    if (obj.name && validNames.has(obj.name) && typeof obj.arguments === 'object') {
      return {
        type: 'tool_use',
        id: `toolu_rescued_${Date.now()}`,
        name: obj.name,
        input: obj.arguments,
      }
    }
  } catch {
    // couldn't parse
  }

  return null
}

/**
 * Extract the text content of the last user message (for heuristic classification).
 */
function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    // tool_result arrays aren't user text
    if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue
    return null
  }
  return null
}

/**
 * Run the agent loop. Calls onEvent with SSE events as it goes.
 * Delegates streaming to the provider (Anthropic, OpenAI-compat, etc.).
 * Handles tool execution and message assembly.
 */
export async function runAgent(systemPrompt, messages, tools, config, onEvent) {
  const { provider } = config
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  const MAX_CONSECUTIVE_TOOLS = 8
  let consecutiveToolCalls = 0
  let rescueCount = 0
  let totalToolTurns = 0
  let rescueFailed = false // true once rescue rate is too high

  while (iterations < maxTurns) {
    // Intent routing for providers that support it (open models).
    let toolChoice = undefined
    if (provider.supportsIntentRouting && tools.definitions.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (rescueFailed) {
        // Model can't do structured tool calling — text only for rest of run
        toolChoice = 'none'
      } else if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOLS) {
        toolChoice = 'none'
        console.log(`[intent-router] toolChoice=none (forced after ${consecutiveToolCalls} consecutive tool calls)`)
      } else if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        // Tier 1: Heuristic fast-path
        const lastUserText = getLastUserText(messages)
        const heuristic = classifyIntentHeuristic(lastUserText)

        if (heuristic !== 'uncertain') {
          toolChoice = heuristic
          console.log(`[intent-router] toolChoice=${toolChoice} (heuristic) text="${(lastUserText || '').slice(0, 40)}"`)
        } else {
          // Tier 2: LLM classifier
          toolChoice = await provider.classifyIntent({
            model: config.model,
            system: systemPrompt,
            messages,
            tools: tools.definitions,
          })
          console.log(`[intent-router] toolChoice=${toolChoice} (llm-classifier)`)
        }
      }

      if (!rescueFailed && toolChoice !== undefined) {
        console.log(`[intent-router] final=${toolChoice} postToolResult=${isPostToolResult} consecutiveTools=${consecutiveToolCalls}`)
      }
    }

    const result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: toolChoice === 'none' ? [] : tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
        toolChoice: toolChoice === 'none' ? undefined : toolChoice,
      },
      onEvent,
    )

    let { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Rescue narrated tool calls — only when router didn't explicitly say 'none'
    if (stopReason !== 'tool_use' && provider.supportsIntentRouting && toolChoice !== 'none' && !rescueFailed) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
          rescueCount++
          console.log(`[intent-router] rescued narrated tool call: ${rescued.name} (rescue #${rescueCount})`)

          // Check rescue rate — if too high, model can't do tool calling
          if (totalToolTurns >= 4 && rescueCount / totalToolTurns > 0.5) {
            console.log(`[intent-router] rescue rate ${rescueCount}/${totalToolTurns} > 50% — disabling tools for rest of run`)
            rescueFailed = true
          }
        }
      }
    }

    // Finalize content blocks — parse tool input JSON (for providers that return raw strings)
    const assistantContent = contentBlocks.map(block => {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.input === 'string') {
        try {
          return { ...block, input: JSON.parse(block.input || '{}') }
        } catch {
          return { ...block, input: {} }
        }
      }
      return block
    })

    messages.push({ role: 'assistant', content: assistantContent })

    // If no tool use, we're done
    if (stopReason !== 'tool_use') {
      consecutiveToolCalls = 0
      break
    }
    consecutiveToolCalls++
    totalToolTurns++

    // Execute tools
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input)
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })
    }

    // Inject correction feedback after rescue — append to tool results to avoid consecutive user messages
    const wasRescued = contentBlocks.some(b => b.type === 'tool_use' && b.id?.startsWith('toolu_rescued_'))
    if (wasRescued && provider.supportsIntentRouting) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: 'system_correction',
        content: '[system: You narrated a tool call instead of using function calling. The call was executed, but you must use the function calling API directly.]',
      })
    }

    messages.push({ role: 'user', content: toolResults })

    iterations++
  }

  onEvent({ type: 'done', usage: totalUsage })
  return { messages, usage: totalUsage }
}

/**
 * Run the hybrid agent loop. Same structure as runAgent, but intended for
 * configurations where the orchestrator (smart model) handles both reasoning
 * and tool dispatch — tools execute directly via tools.execute() with no
 * separate executor LLM call.
 */
export async function runHybridAgent(systemPrompt, messages, tools, config, onEvent) {
  const { provider } = config
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  const MAX_CONSECUTIVE_TOOLS = 8
  let consecutiveToolCalls = 0
  let rescueCount = 0
  let totalToolTurns = 0
  let rescueFailed = false

  while (iterations < maxTurns) {
    // Intent routing for providers that support it (open models).
    let toolChoice = undefined
    if (provider.supportsIntentRouting && tools.definitions.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (rescueFailed) {
        toolChoice = 'none'
      } else if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOLS) {
        toolChoice = 'none'
        console.log(`[hybrid] toolChoice=none (forced after ${consecutiveToolCalls} consecutive tool calls)`)
      } else if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        const lastUserText = getLastUserText(messages)
        const heuristic = classifyIntentHeuristic(lastUserText)

        if (heuristic !== 'uncertain') {
          toolChoice = heuristic
          console.log(`[hybrid] toolChoice=${toolChoice} (heuristic) text="${(lastUserText || '').slice(0, 40)}"`)
        } else {
          toolChoice = await provider.classifyIntent({
            model: config.model,
            system: systemPrompt,
            messages,
            tools: tools.definitions,
          })
          console.log(`[hybrid] toolChoice=${toolChoice} (llm-classifier)`)
        }
      }

      if (!rescueFailed && toolChoice !== undefined) {
        console.log(`[hybrid] final=${toolChoice} postToolResult=${isPostToolResult} consecutiveTools=${consecutiveToolCalls}`)
      }
    }

    const result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: toolChoice === 'none' ? [] : tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
        toolChoice: toolChoice === 'none' ? undefined : toolChoice,
      },
      onEvent,
    )

    let { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Rescue narrated tool calls
    if (stopReason !== 'tool_use' && provider.supportsIntentRouting && toolChoice !== 'none' && !rescueFailed) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
          rescueCount++
          console.log(`[hybrid] rescued narrated tool call: ${rescued.name} (rescue #${rescueCount})`)

          if (totalToolTurns >= 4 && rescueCount / totalToolTurns > 0.5) {
            console.log(`[hybrid] rescue rate ${rescueCount}/${totalToolTurns} > 50% — disabling tools for rest of run`)
            rescueFailed = true
          }
        }
      }
    }

    // Finalize content blocks
    const assistantContent = contentBlocks.map(block => {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.input === 'string') {
        try {
          return { ...block, input: JSON.parse(block.input || '{}') }
        } catch {
          return { ...block, input: {} }
        }
      }
      return block
    })

    messages.push({ role: 'assistant', content: assistantContent })

    if (stopReason !== 'tool_use') {
      consecutiveToolCalls = 0
      break
    }
    consecutiveToolCalls++
    totalToolTurns++

    // Execute tools directly (no executor LLM)
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input)
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })
    }

    // Correction feedback after rescue
    const wasRescued = contentBlocks.some(b => b.type === 'tool_use' && b.id?.startsWith('toolu_rescued_'))
    if (wasRescued && provider.supportsIntentRouting) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: 'system_correction',
        content: '[system: You narrated a tool call instead of using function calling. The call was executed, but you must use the function calling API directly.]',
      })
    }

    messages.push({ role: 'user', content: toolResults })

    iterations++
  }

  console.log(`[hybrid] orchestrator: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out | tools executed: ${totalToolTurns} (direct)`)
  onEvent({ type: 'done', usage: totalUsage })
  return { messages, usage: totalUsage }
}
