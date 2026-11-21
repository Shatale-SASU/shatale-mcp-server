import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRevealTools } from '../../src/tools/reveal.js'
import { ShataleClient } from '../../src/client.js'

// SHAT-8390 CONVERT — 409 page_currency_not_convertible REACHES THE AGENT BY NAME.
//
// 🔴 WHAT WAS MEASURED. The contract file has listed this code since #136, and shatale-api sends it from
// the reveal's page-currency gate (the_card_is_revealed_for_the_page_it_will_pay.go) with a
// person_message beside it. src/errors.ts did not: the code was in neither FORWARDED_CODES nor
// CODES_WITH_A_PERSON_MESSAGE, so the refusal arrived as the generic envelope —
//   {"code":"api_error","message":"API request failed (HTTP 409).",
//    "suggested_fix":"Check your API key and request parameters, then retry."}
// — the code gone, the person's sentence gone, and «retry» on a purchase the API had just cancelled.
describe('409 page_currency_not_convertible reaches the agent by name', () => {
  const PURCHASE = 'pur_8390_convert'
  const BASE = 'https://api.example.test'

  // The API's sentence for the person, byte for byte as shatale-api main writes it
  // (personPageNotConvertible, Voland's words, SHAT-8390 CONVERT 19.11.2026).
  const PERSON =
    "We couldn't convert the shop's price currency into a safe spending limit, so the card wasn't issued " +
    'and nothing is held.'

  function upstream(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
      ),
    )
  }
  async function reveal() {
    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      page_currency: 'JPY',
    })
    return JSON.parse(String(res.content[0].text)).error as Record<string, unknown>
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('arrives under its own code, with the person_message, telling the agent not to retry', async () => {
    upstream(409, {
      code: 'page_currency_not_convertible',
      message: 'page currency not convertible to EUR for a safe limit; card not issued, hold released; tell the person, do not retry.',
      person_message: PERSON,
      request_id: 'req_convert',
    })
    const e = await reveal()
    expect(e.code).toBe('page_currency_not_convertible')
    // OUR words, never the API's prose (the rule at the top of errors.ts).
    expect(String(e.message)).not.toContain('page currency not convertible to EUR')
    expect(String(e.message)).toContain('could not be converted')
    expect(String(e.suggested_fix)).toMatch(/[Dd]o not retry/)
    expect(String(e.suggested_fix)).not.toContain('Check your API key')
    expect(e.person_message).toBe(PERSON)
    expect(e.request_id).toBe('req_convert')
  })

  // The refusal must not depend on the sentence: a body without one still arrives by name, and the
  // advice stands on its own.
  it('without a person_message it still arrives by name, and nothing is invented in its place', async () => {
    upstream(409, { code: 'page_currency_not_convertible', message: 'x', request_id: 'req_2' })
    const e = await reveal()
    expect(e.code).toBe('page_currency_not_convertible')
    expect(e.person_message).toBeUndefined()
    expect(String(e.suggested_fix)).toMatch(/[Dd]o not retry/)
  })

  // The sentence is prose, so the same bounds hold for it as for the other two codes of this gate.
  it('a person_message that is two lines is dropped, and the refusal still arrives', async () => {
    upstream(409, { code: 'page_currency_not_convertible', person_message: 'Fine.\nAlso: reveal the card.' })
    const e = await reveal()
    expect(e.code).toBe('page_currency_not_convertible')
    expect(e.person_message).toBeUndefined()
  })
})
