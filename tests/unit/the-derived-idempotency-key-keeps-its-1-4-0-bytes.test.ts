import { describe, it, expect } from 'vitest'
import { deriveIdempotencyKey, toPurchaseWireBody } from '../../src/client.js'

// SHAT-6291. requires_shipping joined the derivation in 1.5.0, and the promise is that a call which does
// not ask for shipping derives the SAME key it derived in 1.4.0. A retry across an upgrade then still
// de-duplicates instead of creating a second purchase.
//
// The golden values were computed with the 1.4.0 algorithm (dd0e177, src/client.ts deriveIdempotencyKey):
//   'mcp-' + sha256(JSON.stringify([publisher_user_id, agent_id, merchant, amount_cents, currency,
//   description])).hex.slice(0, 32)
// They are hard-coded on purpose: recomputing them with the code under test would agree with any mutation.
const INPUT = {
  publisher_user_id: 'usr_pin',
  agent_id: 'agt_pin',
  merchant: 'shop.example',
  amount: 49.99,
  currency: 'EUR',
  description: 'pinned purchase',
}
const GOLDEN_1_4_0 = 'mcp-589911b42869a23817c88b9cb61d4d9b'
const GOLDEN_WITH_SHIPPING = 'mcp-fda6d0d2aea58b13dde1c6ab3fb4a36c'

describe('the derived idempotency key keeps its 1.4.0 bytes', () => {
  it('without requires_shipping, the key is the 1.4.0 key', () => {
    expect(deriveIdempotencyKey(INPUT, 4999)).toBe(GOLDEN_1_4_0)
    expect(toPurchaseWireBody(INPUT, true).idempotency_key).toBe(GOLDEN_1_4_0)
  })

  it('with requires_shipping: false, the key is still the 1.4.0 key', () => {
    const input = { ...INPUT, requires_shipping: false }
    expect(deriveIdempotencyKey(input, 4999)).toBe(GOLDEN_1_4_0)
    expect(toPurchaseWireBody(input, true).idempotency_key).toBe(GOLDEN_1_4_0)
  })

  it('with requires_shipping: true, the key differs (and is stable)', () => {
    const input = { ...INPUT, requires_shipping: true }
    expect(deriveIdempotencyKey(input, 4999)).not.toBe(GOLDEN_1_4_0)
    expect(deriveIdempotencyKey(input, 4999)).toBe(GOLDEN_WITH_SHIPPING)
  })
})
