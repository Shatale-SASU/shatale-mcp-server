/**
 * PCI regression: request_purchase must NEVER surface a raw PAN/CVV into the
 * agent reasoning context. The backend purchase response embeds them under
 * payment.card (purchases.go purchaseToJSON); redactPurchaseCard strips them to
 * last4 + constraints before the tool result is returned.
 */
import { describe, test, expect } from 'vitest'
import { redactPurchaseCard, createPurchaseTools } from '../../src/tools/purchase.js'
import type { ShataleClient } from '../../src/client.js'

const withCard = {
  purchase_id: 'p_1',
  status: 'payment_ready',
  payment: {
    type: 'virtual_card',
    card: {
      number: '4111111111114242',
      exp_month: '12',
      exp_year: '2030',
      cvv: '123',
    },
    constraints: { merchant_locked: true, amount_limit: 250, single_use: true },
  },
}

describe('redactPurchaseCard', () => {
  test('removes raw PAN and CVV, keeps last4', () => {
    const out = redactPurchaseCard(withCard) as any
    const card = out.payment.card
    expect(card.number).toBeUndefined()
    expect(card.cvv).toBeUndefined()
    expect(card.last4).toBe('4242')
    expect(card.exp_month).toBe('12')
    expect(card._note).toMatch(/withheld/i)
  })

  test('never leaks the full PAN anywhere in the serialized result', () => {
    const out = redactPurchaseCard(withCard)
    expect(JSON.stringify(out)).not.toContain('4111111111114242')
    expect(JSON.stringify(out)).not.toContain('123')
  })

  test('preserves constraints and top-level fields', () => {
    const out = redactPurchaseCard(withCard) as any
    expect(out.purchase_id).toBe('p_1')
    expect(out.status).toBe('payment_ready')
    expect(out.payment.constraints.amount_limit).toBe(250)
  })

  test('passes through a response with no card (onboarding_required / blocked)', () => {
    const noCard = { purchase_id: 'p_2', status: 'onboarding_required', onboarding_url: 'https://x' }
    expect(redactPurchaseCard(noCard)).toEqual(noCard)
  })

  test('is safe on null / non-object', () => {
    expect(redactPurchaseCard(null)).toBeNull()
    expect(redactPurchaseCard('x')).toBe('x')
  })
})

// Every purchase handler that can surface a card must apply the redaction —
// not just request_purchase. get_purchase_status is the important one:
// GET /v1/purchases/{id} advances the state machine and can mint a card.
describe('purchase handlers redact card credentials', () => {
  const stubClient = {
    requestPurchase: async () => structuredClone(withCard),
    getPurchaseStatus: async () => structuredClone(withCard),
    cancelPurchase: async () => structuredClone(withCard),
  } as unknown as ShataleClient

  const { handlers } = createPurchaseTools(stubClient, { isSandbox: false })
  const text = (r: any) => r.content[0].text as string

  test('request_purchase never emits the raw PAN', async () => {
    const r = await handlers.request_purchase({
      publisher_user_id: 'u', agent_id: 'a', merchant: 'm', amount: 2.5, currency: 'EUR', description: 'd',
    })
    expect(text(r)).not.toContain('4111111111114242')
    expect(text(r)).toContain('4242')
  })

  test('get_purchase_status never emits the raw PAN', async () => {
    const r = await handlers.get_purchase_status({ purchase_id: 'p_1' })
    expect(text(r)).not.toContain('4111111111114242')
    expect(text(r)).not.toContain('"cvv"')
  })

  test('cancel_purchase never emits the raw PAN', async () => {
    const r = await handlers.cancel_purchase({ purchase_id: 'p_1' })
    expect(text(r)).not.toContain('4111111111114242')
  })
})
