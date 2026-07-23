import { describe, test, expect } from 'vitest'
import { createCheckoutTools } from '../../src/tools/checkout.js'

// The two checkout-identity tools split one backend response into the cardholder half and the buyer
// half, so the agent fills each into the right merchant field. These are pure handler tests over a
// fake client — no network.

const identityFixture = {
  billing_identity: {
    name: 'Shatale SASU',
    address_line: '623 Rue du Devois',
    city: 'Saint-Drézéry',
    postal_code: '34160',
    country: 'FR',
  },
  merchant_customer_identity: {
    name: 'Sergey Solskiy',
    first_name: 'Sergey',
    last_name: 'Solskiy',
    email: 'sergey@example.com',
  },
}

function fakeClient(getCheckoutIdentity?: (id: string) => Promise<unknown>) {
  return { getCheckoutIdentity: getCheckoutIdentity ?? (async () => identityFixture) } as unknown as import('../../src/client.js').ShataleClient
}

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text)

describe('checkout identity tools', () => {
  test('exposes exactly the two split methods', () => {
    const mod = createCheckoutTools(fakeClient())
    expect(mod.tools.map(t => t.name).sort()).toEqual(['get_checkout_cardholder', 'get_checkout_customer'])
  })

  // D6 (Fable): no description may steer an LLM to the old, deleted `get_checkout_card` name (which
  // would resolve to Unknown tool). `get_checkout_cardholder` is fine — the negative lookahead lets it pass.
  test('no tool description references the deleted get_checkout_card name', () => {
    const mod = createCheckoutTools(fakeClient())
    for (const t of mod.tools) {
      expect(t.description).not.toMatch(/get_checkout_card(?!holder)/)
    }
  })

  test('get_checkout_cardholder returns ONLY the cardholder/billing identity — no buyer, no card secrets', async () => {
    const mod = createCheckoutTools(fakeClient())
    const res = await mod.handlers.get_checkout_cardholder({ purchase_id: 'p1' })
    const body = parse(res)
    expect(body.billing_identity.name).toBe('Shatale SASU')
    expect(body.billing_identity.country).toBe('FR')
    expect(body.merchant_customer_identity).toBeUndefined()
    // The cardholder/billing object carries NO card secrets — only identity fields. (The human-facing
    // _note may mention CVV in prose; assert on the structured billing object, not the whole string.)
    expect(JSON.stringify(body.billing_identity)).not.toMatch(/pan|cvv|card_number|"number"/i)
  })

  test('get_checkout_customer returns ONLY the buyer identity — not the cardholder', async () => {
    const mod = createCheckoutTools(fakeClient())
    const res = await mod.handlers.get_checkout_customer({ purchase_id: 'p1' })
    const body = parse(res)
    expect(body.merchant_customer_identity.first_name).toBe('Sergey')
    expect(body.merchant_customer_identity.email).toBe('sergey@example.com')
    expect(body.billing_identity).toBeUndefined()
  })

  test('missing purchase_id is a validation error and never calls the backend', async () => {
    let called = false
    const mod = createCheckoutTools(fakeClient(async () => { called = true; return identityFixture }))
    const res = await mod.handlers.get_checkout_cardholder({})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/purchase_id/i)
    expect(called).toBe(false)
  })

  test('a backend error maps to a structured error and does not leak the raw message', async () => {
    const mod = createCheckoutTools(fakeClient(async () => { throw new Error('HTTP 404 leaked-secret@x.com') }))
    const res = await mod.handlers.get_checkout_customer({ purchase_id: 'p1' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).not.toContain('leaked-secret@x.com')
  })

  // D1 (Fable): a 200 that is missing the requested half must FAIL, not return an empty-but-successful
  // identity — an agent handed `{}` at a live merchant form would hallucinate values into real fields.
  test('a missing half is a loud error, never an empty success', async () => {
    const mod = createCheckoutTools(fakeClient(async () => ({ billing_identity: identityFixture.billing_identity })))
    const res = await mod.handlers.get_checkout_customer({ purchase_id: 'p1' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/unavailable/i)
    expect(res.content[0].text).toMatch(/payment_ready/i)
  })

  test('an empty half object is also treated as unavailable', async () => {
    const mod = createCheckoutTools(fakeClient(async () => ({ billing_identity: {}, merchant_customer_identity: {} })))
    const card = await mod.handlers.get_checkout_cardholder({ purchase_id: 'p1' })
    expect(card.isError).toBe(true)
    const cust = await mod.handlers.get_checkout_customer({ purchase_id: 'p1' })
    expect(cust.isError).toBe(true)
  })
})
