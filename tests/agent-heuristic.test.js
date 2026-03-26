import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyIntentHeuristic } from '../server/lib/agent.js'

describe('classifyIntentHeuristic', () => {
  // Action patterns → required
  it('classifies "run the backup" as required', () => {
    assert.equal(classifyIntentHeuristic('run the backup'), 'required')
  })

  it('classifies "check server health" as required', () => {
    assert.equal(classifyIntentHeuristic('check server health'), 'required')
  })

  it('classifies "show me the logs" as required', () => {
    assert.equal(classifyIntentHeuristic('show me the logs'), 'required')
  })

  it('classifies "find pending applications" as required', () => {
    assert.equal(classifyIntentHeuristic('find pending applications'), 'required')
  })

  it('classifies "restart sidekiq" as required', () => {
    assert.equal(classifyIntentHeuristic('restart sidekiq'), 'required')
  })

  it('classifies "deploy the new version" as required', () => {
    assert.equal(classifyIntentHeuristic('deploy the new version'), 'required')
  })

  it('classifies "approve the application" as required', () => {
    assert.equal(classifyIntentHeuristic('approve the application'), 'required')
  })

  // Conversation patterns → none
  it('classifies "thanks" as none', () => {
    assert.equal(classifyIntentHeuristic('thanks'), 'none')
  })

  it('classifies "ok" as none', () => {
    assert.equal(classifyIntentHeuristic('ok'), 'none')
  })

  it('classifies "lol" as none', () => {
    assert.equal(classifyIntentHeuristic('lol'), 'none')
  })

  it('classifies "nice" as none', () => {
    assert.equal(classifyIntentHeuristic('nice'), 'none')
  })

  it('classifies "got it" as none', () => {
    assert.equal(classifyIntentHeuristic('got it'), 'none')
  })

  // Questions about agent → none
  it('classifies "how are you" as none', () => {
    assert.equal(classifyIntentHeuristic('how are you'), 'none')
  })

  it('classifies "what do you think about that" as none', () => {
    assert.equal(classifyIntentHeuristic('what do you think about that'), 'none')
  })

  // Short conversation patterns only match when short
  it('classifies long message starting with "ok" as uncertain', () => {
    assert.equal(classifyIntentHeuristic('ok but can you also tell me about the architecture of this system'), 'uncertain')
  })

  // Ambiguous → uncertain
  it('classifies "the timeline is quiet tonight" as uncertain', () => {
    assert.equal(classifyIntentHeuristic('the timeline is quiet tonight'), 'uncertain')
  })

  it('classifies "what happened yesterday" as uncertain', () => {
    assert.equal(classifyIntentHeuristic('what happened yesterday'), 'uncertain')
  })

  // Edge cases
  it('returns uncertain for null', () => {
    assert.equal(classifyIntentHeuristic(null), 'uncertain')
  })

  it('returns uncertain for empty string', () => {
    assert.equal(classifyIntentHeuristic(''), 'uncertain')
  })

  it('returns uncertain for non-string', () => {
    assert.equal(classifyIntentHeuristic(42), 'uncertain')
  })
})
