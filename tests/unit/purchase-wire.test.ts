/**
 * SHAT-1448: Golden contract test for the purchase wire body.
 *
 * The LLM-facing tool schema uses `merchant` + decimal `amount`, but the
 * backend (apps/api/api/v1/purchases.go) decodes `merchant_ref` + integer
 * `amount_cents`. `toPurchaseWireBody` is the single translation point — pin
 * its output so the schema can never silently drift from the wire contract.
 */
import { describe, test, expect } from 'vitest'
import { toPurchaseWireBody } from '../../src/client.js'
import type { PurchaseInput } from '../../src/types.js'

const base: PurchaseInput = {
  publisher_user_id: 'pub-1',
  agent_id: 'agent-1',
  merchant: 'amazon.com',
  amount: 49.99,
  currency: 'EUR',
  description: 'Test purchase',
}

describe('toPurchaseWireBody', () => {
  test('translates merchant→merchant_ref and amount→amount_cents (rounded)', () => {
    const body = toPurchaseWireBody({ ...base, idempotency_key: 'idem-1' }, false)
    expect(body).toEqual({
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant_ref: 'amazon.com',
      amount_cents: 4999,
      currency: 'EUR',
      description: 'Test purchase',
      idempotency_key: 'idem-1',
    })
  })

  test('amount_cents is an integer for amounts with float imprecision', () => {
    const body = toPurchaseWireBody({ ...base, amount: 15.0, idempotency_key: 'k' }, false)
    expect(body.amount_cents).toBe(1500)
    expect(Number.isInteger(body.amount_cents)).toBe(true)
  })

  test('never emits the LLM-facing keys on the wire', () => {
    const body = toPurchaseWireBody({ ...base, idempotency_key: 'k' }, false)
    expect(body).not.toHaveProperty('merchant')
    expect(body).not.toHaveProperty('amount')
  })

  test('generates an idempotency_key when missing and generation requested', () => {
    const body = toPurchaseWireBody(base, true)
    expect(typeof body.idempotency_key).toBe('string')
    expect((body.idempotency_key as string).length).toBeGreaterThan(0)
  })

  test('omits idempotency_key when missing and generation not requested', () => {
    const body = toPurchaseWireBody(base, false)
    expect(body).not.toHaveProperty('idempotency_key')
  })

  test('forwards user_hint only when present', () => {
    const withHint = toPurchaseWireBody(
      { ...base, idempotency_key: 'k', user_hint: { email: 'a@b.com' } },
      false,
    )
    expect(withHint.user_hint).toEqual({ email: 'a@b.com' })
    const withoutHint = toPurchaseWireBody({ ...base, idempotency_key: 'k' }, false)
    expect(withoutHint).not.toHaveProperty('user_hint')
  })
})
