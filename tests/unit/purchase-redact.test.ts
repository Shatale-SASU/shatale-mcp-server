/**
 * PCI regression: request_purchase must NEVER surface a raw PAN/CVV into the
 * agent reasoning context. The backend purchase response embeds them under
 * payment.card (purchases.go purchaseToJSON); redactPurchaseCard strips them to
 * last4 + constraints before the tool result is returned.
 */
import { createCredentialTools } from '../../src/tools/credentials.js'
import { describe, test, expect } from 'vitest'
import { redactPurchaseCard } from '../../src/tools/purchase.js'
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

// /!\ THESE THREE TESTS USED A STUB CLIENT, AND THAT IS WHY THEY HAD TO CHANGE.
//
// They handed each handler a fake `ShataleClient` and asserted the handler stripped the PAN. That
// measured the HANDLER, which is no longer the layer responsible: the scrub now runs inside
// ShataleClient.request, so every response is clean before any handler sees it (see src/redact.ts
// for why it moved). A stub client makes a test blind to exactly the layer it replaces — the same
// shape that let a missing `.WithAuthSimulator(...)` pass 109 green packages, because the route's
// own tests injected a fake simulator.
//
// So the question moved with the responsibility: not "does this handler scrub?" but "can a PAN
// reach a tool result at all?". That is asserted in
// tests/unit/no-tool-result-carries-a-card.test.ts, which drives every tool through the REAL client
// against an upstream that puts a PAN and a CVV in every response — including the tools that never
// had a scrub call and could not have been covered here.

// The relay password is returned in full, and both credential tools agree about that.
//
// It used to be masked in request_temporary_credentials and returned in cleartext by
// get_credential_status one call away, into the same agent context — so the mask cost a
// round trip and bought a false impression of safety, while making the primary tool's
// result unusable for its stated purpose (an agent cannot register at a merchant with
// `61************M6`). Review proved the pair end to end.
//
// This test exists so the two tools cannot drift apart again: whichever way the product
// decides, they must decide it together.
describe('credential tools agree about the relay password', () => {
  test('request_temporary_credentials returns the password it was given', async () => {
    const secret = '61jBmud4Uh79&bM6'
    const client = {
      requestCredentials: async () => ({ credential_request_id: 'cr_1', generated_password: secret }),
      getCredentialStatus: async () => ({ credential_request_id: 'cr_1', generated_password: secret }),
    } as never

    const mod = createCredentialTools(client, { emailsEnabled: false })
    const issued = await mod.handlers.request_temporary_credentials({
      publisher_user_id: 'pu_1',
      agent_id: 'ag_1',
      merchant_domain: 'example.com',
      purpose: 'register an account to complete a purchase',
    })
    const status = await mod.handlers.get_credential_status({ credential_request_id: 'cr_1' })

    const issuedText = issued.content[0].text as string
    const statusText = status.content[0].text as string

    expect(issuedText).toContain(secret)
    expect(issuedText).not.toContain('***')
    // The point of the test: whatever one returns, so does the other.
    expect(statusText.includes(secret)).toBe(issuedText.includes(secret))
  })
})

/**
 * The redactor used to reach exactly ONE shape — payment.card — while guest.ts told
 * readers a raw PAN is "NEVER returned". Review's call was to widen the redactor
 * rather than narrow the copy: the copy is the promise a reader acts on, and a caller
 * who believes it and finds a PAN has been misled by us.
 *
 * These are the five shapes probed against the real backend. None of them leaks a
 * live PAN today — the sandbox emits the static 4242 test card — which is exactly why
 * it is cheap to make the guarantee true before it has to be.
 */
describe('redactPurchaseCard covers every card-ish shape, not just payment.card', () => {
  const PAN = '4242424242424242'
  const hasSecret = (o: unknown): boolean =>
    JSON.stringify(o).includes(PAN) || /"cvv"|"cvc"|"card_number"/.test(JSON.stringify(o))

  test('top-level card (sandbox_approve_purchase)', () => {
    const out = redactPurchaseCard({ ok: true, card: { number: PAN, cvv: '123', exp_month: 12 } }) as any
    expect(hasSecret(out)).toBe(false)
    expect(out.card.last4).toBe('4242')
    expect(out.card.exp_month).toBe(12)
    expect(out.ok).toBe(true)
  })

  test('issued_card, a different parent name for the same thing', () => {
    const out = redactPurchaseCard({ issued_card: { card_number: PAN, cvc: '999' } }) as any
    expect(hasSecret(out)).toBe(false)
    expect(out.issued_card.last4).toBe('4242')
  })

  test('an array of cards', () => {
    const out = redactPurchaseCard({ cards: [{ number: PAN, cvv: '1' }, { number: '4111111111111111' }] }) as any
    expect(hasSecret(out)).toBe(false)
    expect(out.cards.map((c: any) => c.last4)).toEqual(['4242', '1111'])
  })

  test('nested deeper than the old redactor ever looked', () => {
    const out = redactPurchaseCard({ a: { b: { c: { payment: { card: { number: PAN, cvv: '7' } } } } } }) as any
    expect(hasSecret(out)).toBe(false)
    expect(out.a.b.c.payment.card.last4).toBe('4242')
  })

  test('a payload with no card is returned unharmed', () => {
    const input = { purchase_id: 'p_1', status: 'pending', amount: 2500, meta: { note: 'no card here' } }
    expect(redactPurchaseCard(input)).toEqual(input)
  })

  // A redactor that hangs takes the tool down with it, which is a worse outcome than
  // the leak it was added to prevent.
  test('a self-referential response terminates instead of hanging', () => {
    const cyclic: any = { card: { number: PAN, cvv: '1' } }
    cyclic.self = cyclic
    const out = redactPurchaseCard(cyclic) as any
    expect(out.card.last4).toBe('4242')
    expect(out.card.number).toBeUndefined()
  })
})
