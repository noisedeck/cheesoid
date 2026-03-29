import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker, CircuitOpenError } from '../server/lib/circuit-breaker.js'

describe('CircuitBreaker', () => {
  let breaker

  beforeEach(() => {
    breaker = new CircuitBreaker({ threshold: 3, initialCooldown: 100, maxCooldown: 1000 })
  })

  it('starts in CLOSED state — requests allowed', () => {
    assert.equal(breaker.isOpen('http://example.com'), false)
  })

  it('opens after N consecutive failures', () => {
    const url = 'http://dead.provider'
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), false)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
  })

  it('throws CircuitOpenError with remaining cooldown', () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining > 0)
    assert.ok(remaining <= 100)
  })

  it('success resets failure count', () => {
    const url = 'http://flaky.provider'
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    breaker.recordSuccess(url)
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), false) // only 2 consecutive, not 3
  })

  it('transitions OPEN -> HALF_OPEN after cooldown expires', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(breaker.isOpen(url), false) // HALF_OPEN allows one through
  })

  it('HALF_OPEN probe success closes the circuit', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    breaker.recordSuccess(url)
    assert.equal(breaker.isOpen(url), false)
    assert.equal(breaker.isOpen(url), false)
    assert.equal(breaker.isOpen(url), false)
  })

  it('HALF_OPEN probe failure re-opens with doubled cooldown', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(breaker.isOpen(url), false)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining > 100)
    assert.ok(remaining <= 200)
  })

  it('cooldown caps at maxCooldown', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    for (let round = 0; round < 5; round++) {
      await new Promise(r => setTimeout(r, 1100))
      breaker.recordFailure(url)
    }
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining <= 1000)
  })

  it('success after HALF_OPEN resets cooldown to initial value', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 220))
    breaker.recordSuccess(url)
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining <= 100)
  })

  it('CircuitOpenError has expected properties', () => {
    const err = new CircuitOpenError('http://dead.provider', 30)
    assert.ok(err instanceof Error)
    assert.ok(err.message.includes('http://dead.provider'))
    assert.ok(err.message.includes('circuit open'))
    assert.equal(err.isCircuitOpen, true)
  })

  it('tracks endpoints independently', () => {
    const url1 = 'http://provider-a.com'
    const url2 = 'http://provider-b.com'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url1)
    assert.equal(breaker.isOpen(url1), true)
    assert.equal(breaker.isOpen(url2), false)
  })

  it('HALF_OPEN allows exactly one request', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(breaker.isOpen(url), false)
    assert.equal(breaker.isOpen(url), true)
  })
})
