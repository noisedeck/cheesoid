/**
 * Pure translation functions between Anthropic and OpenAI message/tool formats.
 */

/**
 * Convert Anthropic tool definitions to OpenAI function calling format.
 */
export function translateToolDefs(anthropicTools) {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

/**
 * Convert Anthropic-format conversation history to OpenAI message format.
 * System prompt can be a string (single system message) or an array of
 * {role: 'system', content: '...'} objects (hierarchical multi-message).
 */
export function translateMessages(systemPrompt, messages) {
  const result = []

  // System prompt: string → single message, array → multiple system messages
  if (Array.isArray(systemPrompt)) {
    for (const msg of systemPrompt) {
      result.push({ role: 'system', content: msg.content || msg })
    }
  } else {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // Content blocks — tool_result blocks become tool role messages
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            })
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = []
        const toolCalls = []
        let reasoning = ''

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          } else if (block.type === 'thinking' && block.thinking) {
            // Preserve reasoning for round-trip — model sees its own chain of thought
            reasoning = block.thinking
          }
          // Skip: server_tool_use, web_search_tool_result, signature
        }

        // Build assistant content with reasoning preamble if present
        let content = textParts.join('') || null
        if (reasoning) {
          const preamble = `[internal reasoning: ${reasoning}]`
          content = content ? `${preamble}\n\n${content}` : preamble
        }

        const assistantMsg = { role: 'assistant', content }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        result.push(assistantMsg)
      }
    }
  }

  return result
}
