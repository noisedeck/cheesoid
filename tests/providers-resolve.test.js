import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModel } from '../server/lib/providers/resolve.js'

describe('resolveModel', () => {
  it('parses explicit provider suffix', () => {
    const result = resolveModel('AltFast/Maverick-17B:blueocean')
    assert.deepEqual(result, { modelId: 'AltFast/Maverick-17B', providerName: 'blueocean' })
  })

  it('auto-detects claude models as anthropic', () => {
    const result = resolveModel('claude-sonnet-4-6')
    assert.deepEqual(result, { modelId: 'claude-sonnet-4-6', providerName: 'anthropic' })
  })

  it('auto-detects claude-haiku with explicit anthropic suffix', () => {
    const result = resolveModel('claude-haiku-4-5:anthropic')
    assert.deepEqual(result, { modelId: 'claude-haiku-4-5', providerName: 'anthropic' })
  })

  it('returns null providerName for bare non-claude model', () => {
    const result = resolveModel('AltFast/Llama-3.3-70B')
    assert.deepEqual(result, { modelId: 'AltFast/Llama-3.3-70B', providerName: null })
  })

  it('uses lastIndexOf to handle model names with colons', () => {
    const result = resolveModel('org/model:v2:fireworks')
    assert.deepEqual(result, { modelId: 'org/model:v2', providerName: 'fireworks' })
  })

  it('handles claude-opus with version suffix', () => {
    const result = resolveModel('claude-opus-4-6')
    assert.deepEqual(result, { modelId: 'claude-opus-4-6', providerName: 'anthropic' })
  })
})
