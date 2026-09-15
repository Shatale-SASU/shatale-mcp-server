/**
 * PCI regression: no raw PAN/CVV reaches the agent reasoning context from a path we have not
 * deliberately allowed.
 *
 * 🔴 THE HEADER THAT STOOD HERE, AND THE FIXTURE UNDER IT, DESCRIBED A RESPONSE THAT NO LONGER
 * EXISTS (SHAT-3346). It said the backend purchase response "embeds them under payment.card
 * (purchases.go purchaseToJSON)", and the fixture modelled that block as
 * `{number, exp_month, exp_year, cvv}` with `constraints.merchant_locked`.
 *
 * Measured on apps/api origin/main, 2026-09-15: that block is `last4`, plus `card_ref` when the
 * issued_cards row exists. The raw card was taken off this response by SHAT B-1; `merchant_locked`
 * was removed by SHAT-2710. FOUR of the five names in the old fixture are not sent, and the fifth
 * was deleted.
 *
 * ⚠️ AND THE TEST WAS GREEN THROUGHOUT, WHICH IS THE POINT. It checked the redactor against its OWN
 * fixture, so it could not notice that the fixture had stopped describing anything: a test whose
 * input is an invention certifies the invention, and does it for ever. A fixture is a claim about
 * ANOTHER system, and only that system can check it — apps/api holds
 * TestThePurchaseCardBlockCarriesOnlyAReferenceAndLast4, which pins the block's key set where the
 * block is written.
 *
 * ⇒ SO THE TWO CASES ARE NOW SEPARATE, because they are different claims:
 *
 *   CONTRACT_PURCHASE  — what the API actually returns today. The redactor must pass it through
 *                        UNCHANGED: there is nothing to cut, and over-redaction would take away the
 *                        last4 an agent needs to tell two cards apart.
 *   HYPOTHETICAL_CARD  — a card-ish shape this API does NOT send, kept because the defence exists
 *                        for the day something does. It is labelled a hypothesis rather than dressed
 *                        up as a response, which is the whole difference between a fixture and a
 *                        claim.
 */
import { createCredentialTools } from '../../src/tools/credentials.js'
import { describe, test, expect } from 'vitest'
import { redactPurchaseCard } from '../../src/tools/purchase.js'
import type { ShataleClient } from '../../src/client.js'

// What apps/api returns today (purchases.go, the `resp.Card != nil` branch): a reference and last4,
// and constraints that actually hold. Kept in this shape ON PURPOSE — if it drifts from the backend
// again, the guard named in the header is what should catch it, not a comment here.
const CONTRACT_PURCHASE = {
  purchase_id: 'p_1',
  status: 'payment_ready',
  payment: {
    type: 'virtual_card',
    card: { last4: '4242', card_ref: 'ic_01H8' },
    constraints: { amount_limit: 250, currency: 'EUR', single_use: true },
  },
}

// NOT a response this API sends. A card-ish shape the redactor must still handle, because the
// defence exists for a path or a build that starts carrying one. Named as a hypothesis so nobody
// reads it as a contract — which is precisely how the old fixture misled every reader it had.
const HYPOTHETICAL_CARD = {
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
    constraints: { amount_limit: 250, currency: 'EUR', single_use: true },
  },
}

describe('redactPurchaseCard', () => {
  test('removes raw PAN and CVV, keeps last4', () => {
    const out = redactPurchaseCard(HYPOTHETICAL_CARD) as any
    const card = out.payment.card
    expect(card.number).toBeUndefined()
    expect(card.cvv).toBeUndefined()
    expect(card.last4).toBe('4242')
    expect(card.exp_month).toBe('12')
    expect(card._note).toMatch(/withheld/i)
  })

  test('never leaks the full PAN anywhere in the serialized result', () => {
    const out = redactPurchaseCard(HYPOTHETICAL_CARD)
    expect(JSON.stringify(out)).not.toContain('4111111111114242')
    expect(JSON.stringify(out)).not.toContain('123')
  })

  test('preserves constraints and top-level fields', () => {
    const out = redactPurchaseCard(HYPOTHETICAL_CARD) as any
    expect(out.purchase_id).toBe('p_1')
    expect(out.status).toBe('payment_ready')
    expect(out.payment.constraints.amount_limit).toBe(250)
  })

  // 🔴 THE CASE THAT WAS MISSING ENTIRELY, AND IT IS THE ONE THAT HAPPENS. Every test above drives a
  // shape the API does not send; none of them asked what the redactor does to the RESPONSE IT
  // ACTUALLY MEETS. The answer must be "nothing": there is no PAN to cut, and taking last4 or
  // card_ref away would remove the only handles an agent has for telling two cards apart and for
  // joining this purchase to the issued card.
  //
  // ⚠️ And `toEqual` on the whole object rather than a field check, deliberately: a redactor that
  // added `_note` to a block with nothing sensitive in it would still pass a per-field assertion,
  // while telling the agent its clean response had been censored.
  test('passes the REAL purchase response through untouched', () => {
    expect(redactPurchaseCard(CONTRACT_PURCHASE)).toEqual(CONTRACT_PURCHASE)
  })

  // And the same response on the reveal path, which is allowlisted: the two must agree, or the
  // behaviour would depend on which door a clean body came through.
  test('the real response is untouched on an allowlisted path too', () => {
    const out = redactPurchaseCard(CONTRACT_PURCHASE, '/v1/purchases/p_1/card-credentials')
    expect(out).toEqual(CONTRACT_PURCHASE)
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
