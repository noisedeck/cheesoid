/**
 * Parse a model string into modelId and providerName.
 *
 * Resolution rules (in order):
 * 1. Explicit suffix: "model:provider" — split on last colon
 * 2. Auto-detect: model starts with "claude" → anthropic
 * 3. Default: providerName = null (caller uses default provider)
 */
export function resolveModel(modelString) {
  const lastColon = modelString.lastIndexOf(':')

  if (lastColon > 0) {
    const suffix = modelString.slice(lastColon + 1)
    // Only treat as provider suffix if it looks like a name (no slashes, no dots)
    if (suffix && !suffix.includes('/') && !suffix.includes('.')) {
      return {
        modelId: modelString.slice(0, lastColon),
        providerName: suffix,
      }
    }
  }

  if (modelString.startsWith('claude')) {
    return { modelId: modelString, providerName: 'anthropic' }
  }

  return { modelId: modelString, providerName: null }
}
