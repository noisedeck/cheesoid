import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicProvider, toAnthropicToolChoice } from '../server/lib/providers/anthropic.js'

describe('toAnthropicToolChoice', () => {
  // Cheesoid's canonical toolChoice value meaning "must call a tool" is
  // 'required' (OpenAI/Vertex convention). Anthropic's API only accepts
  // 'auto' | 'any' | 'tool' | 'none', and 'any' is the equivalent of
  // 'required'. Other providers (gemini, openai-*) handle this mapping
  // already; this function is the Anthropic side.
  it("maps 'required' to 'any'", () => {
    assert.equal(toAnthropicToolChoice('required'), 'any')
  })

  it("passes 'auto' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('auto'), 'auto')
  })

  it("passes 'none' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('none'), 'none')
  })

  it("passes 'tool' through unchanged", () => {
    assert.equal(toAnthropicToolChoice('tool'), 'tool')
  })

  it('passes undefined through unchanged', () => {
    assert.equal(toAnthropicToolChoice(undefined), undefined)
  })
})

describe('createAnthropicProvider', () => {
  it('throws when ANTHROPIC_API_KEY is not set on first streamMessage call', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const provider = createAnthropicProvider({})
      // Creation succeeds (lazy) — but streaming throws
      assert.equal(typeof provider.streamMessage, 'function')
      await assert.rejects(
        () => provider.streamMessage({ model: 'test', maxTokens: 1, system: '', messages: [], tools: [] }, () => {}),
        /ANTHROPIC_API_KEY/,
      )
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('returns an object with streamMessage method', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = createAnthropicProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })
})
