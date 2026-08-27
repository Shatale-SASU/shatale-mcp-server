import { describe, it, expect } from 'vitest'
import { redactPurchaseCard, pathReturnsOurCard } from '../../src/redact.js'

// SHAT-2610. The scrub was SHAPE-BASED — `isCardish` fires on anything carrying number/cvv — so it
// treated two opposite subjects identically:
//
//   THE CARD WE ISSUE is a tool we handed the agent so it could pay. Capped, ours, minted for that
//   purchase. Withholding its digits removes the only way to use the thing we gave it for.
//
//   THE CUSTOMER'S CARD is their real instrument. Never ours to show, in any mode, ever.
//
// ⚠️ AND THE DISCRIMINATOR CANNOT BE A FIELD IN THE BODY. The sandbox approval answers
// `merchant_locked: true`, and the request we send the issuer carries no such field at all —
// measured. A response that misdescribes itself must not be what decides whether a PAN is revealed.
// Provenance is what we know for certain, so revealing is an allowlist of paths.
//
// ⚠️ A TEST THAT ONLY CHECKS "OUR CARD IS VISIBLE" IS GREEN ON A CUSTOMER-CARD LEAK. Both halves are
// asserted here, and the second is the one that matters.

const ourCardResponse = {
  purchase_id: 'pur_1',
  status: 'payment_ready',
  card: { number: '4242424242424242', cvv: '123', exp_month: '12', exp_year: '27' },
  is_sandbox: true,
}

// A customer's funding instrument, in the shape a funding/payment-method response would carry it.
const customerCardResponse = {
  funding_source: {
    type: 'card_on_file',
    card: { number: '5555555555554444', cvv: '999', exp_month: '01', exp_year: '30' },
  },
}

const APPROVE = '/v1/sandbox/purchases/pur_1/approve'

describe('the card we issued reaches the agent; the customer\'s never does', () => {
  it('the allowlist recognises the paths that return our card', () => {
    expect(pathReturnsOurCard(APPROVE)).toBe(true)
    expect(pathReturnsOurCard('/v1/purchases/pur_1/card-credentials')).toBe(true)
    // Positive control on the other side: an ordinary path is NOT on the list.
    expect(pathReturnsOurCard('/v1/purchases/pur_1')).toBe(false)
  })

  it('our issued card comes through whole, so the agent can fill the form', () => {
    const out = redactPurchaseCard(ourCardResponse, APPROVE) as typeof ourCardResponse
    expect(out.card.number).toBe('4242424242424242')
    expect(out.card.cvv).toBe('123')
    expect(out.card.exp_month).toBe('12')
    expect(out.card.exp_year).toBe('27')
  })

  // ⚠️ THE NEGATIVE CONTROL ALBUS REQUIRED, AND THE REASON THE ALLOWLIST IS BY PATH. A
  // customer-shaped card arriving on a path that is not on the list stays scrubbed — including on
  // shapes nobody has seen yet, because the default is refusal.
  it('a customer card on any other path is still stripped', () => {
    const out = redactPurchaseCard(customerCardResponse, '/v1/me/funding-source') as Record<string, any>
    expect(JSON.stringify(out)).not.toContain('5555555555554444')
    expect(JSON.stringify(out)).not.toContain('999')
    expect(out.funding_source.card.last4).toBe('4444')
  })

  // ⚠️ AND EVEN ON AN ALLOWLISTED PATH, ONLY WHAT THAT PATH RETURNS IS OURS. If a customer
  // instrument ever appeared beside our card in the same body, this test says plainly that the
  // current design would reveal it — recorded rather than assumed away, because the allowlist trusts
  // the ENDPOINT, not the field.
  it('the allowlist trusts the endpoint, and that limit is written down', () => {
    const mixed = { ...ourCardResponse, funding_source: customerCardResponse.funding_source }
    const out = redactPurchaseCard(mixed, APPROVE) as Record<string, any>
    expect(out.funding_source.card.number).toBe('5555555555554444')
    // If this ever becomes a real response shape, the allowlist must become field-aware. It is not
    // one today: no endpoint on the list returns a customer instrument.
  })

  it('without a path, nothing is revealed — the default is the old behaviour', () => {
    const out = redactPurchaseCard(ourCardResponse) as Record<string, any>
    expect(out.card.number).toBeUndefined()
    expect(out.card.last4).toBe('4242')
  })
})
