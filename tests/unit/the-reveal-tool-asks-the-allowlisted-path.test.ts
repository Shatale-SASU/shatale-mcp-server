import { describe, it, expect, vi, afterEach } from 'vitest'
import { redactPurchaseCard, pathReturnsOurCard } from '../../src/redact.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { ShataleClient } from '../../src/client.js'
import type { ShataleClient as ShataleClientType } from '../../src/client.js'

// SHAT-3023. The redaction allowlist has held `/v1/purchases/{id}/card-credentials` open since
// SHAT-2610, with the comment "for when the client learns to call it" (redact.ts:71). This is the
// client learning — and this file pins the ONE thing that arrival can get wrong.
//
// ⚠️ THE BOUNDARY IS ALREADY TESTED, AND NOT HERE. `our-card-is-the-tool-we-issued.test.ts` asserts
// both halves of the scrub: our card comes through on an allowlisted path, a customer's card is
// stripped on every other. Repeating that here would add a second opinion about a decided question.
//
// ⚠️ WHAT IS NEW IS THE LINK, AND IT IS THE HALF NEITHER SIDE COVERS ALONE. The scrub decides by the
// path the CLIENT used. The tool never sees the path; the allowlist never sees the tool. So a tool
// wired to a neighbouring URL — `/card`, `/credentials`, `/card-credential` — compiles, returns 200,
// passes every test about the allowlist, and hands the agent a REDACTED body. Nothing says why. The
// failure mode of this feature is not a leak; it is a tool that silently returns nothing usable.
//
// ⚠️ AND A TEST THAT ONLY ASSERTED "reveal_card RETURNS A CARD" WOULD BE GREEN ON THE OPPOSITE DEFECT
// TOO: it stays green if the allowlist is widened to everything, because then every path reveals. So
// the negative case is asserted in the same breath — the neighbouring path must NOT come through.

const PURCHASE = 'pur_3023'
const REVEAL = `/v1/purchases/${PURCHASE}/card-credentials`

// Published scheme test numbers only — never a real PAN, in a fixture or anywhere else.
const revealed = {
  purchase_id: PURCHASE,
  card: { number: '4242424242424242', cvv: '123', exp_month: '12', exp_year: '27' },
}

const BASE = 'https://api.example.test'

// ⚠️ THE DOUBLE MUST NOT BE THE SUBJECT. A fake client that BUILDS the path itself and hands it back
// tests the fake: point the real method at a neighbouring URL and such a test stays green. Measured —
// the first version of this file did exactly that, and the mutant survived it. So the real client runs
// and `fetch` is what gets stubbed, because the URL that reaches fetch is the only URL that exists.
function captureFetch() {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(revealed), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const pathOf = (fn: ReturnType<typeof captureFetch>, i = 0) =>
  new URL(String(fn.mock.calls[i][0])).pathname

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the reveal tool asks the path the allowlist was holding open', () => {
  it('the URL that reaches fetch is one the scrub lets through', async () => {
    const fn = captureFetch()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')

    await createRevealTools(client).handlers.reveal_card({ purchase_id: PURCHASE })

    expect(fn).toHaveBeenCalledTimes(1)
    // Not "the string looks right" but "the scrub would let this through" — the same predicate the
    // client itself consults, asked of the URL that actually went out.
    expect(pathOf(fn)).toBe(REVEAL)
    expect(pathReturnsOurCard(pathOf(fn))).toBe(true)
  })

  it('a body from that path keeps the card the agent was given to pay with', () => {
    const out = redactPurchaseCard(structuredClone(revealed), REVEAL) as typeof revealed
    expect(out.card.number).toBe('4242424242424242')
    expect(out.card.cvv).toBe('123')
  })

  it('the SAME body from a neighbouring path is stripped — the URL is what decides', () => {
    for (const near of [
      `/v1/purchases/${PURCHASE}/card`,
      `/v1/purchases/${PURCHASE}/credentials`,
      `/v1/purchases/${PURCHASE}/card-credential`,
      `/v1/purchases/${PURCHASE}/card-credentials/extra`,
    ]) {
      expect(pathReturnsOurCard(near)).toBe(false)
      const out = redactPurchaseCard(structuredClone(revealed), near) as Record<string, unknown>
      expect(JSON.stringify(out)).not.toContain('4242424242424242')
    }
  })

  it('an empty reveal is refused rather than returned as a success', async () => {
    const client = { getCardCredentials: async () => ({}) } as unknown as ShataleClientType
    const res = await createRevealTools(client).handlers.reveal_card({ purchase_id: PURCHASE })
    expect(JSON.stringify(res)).toContain('card_credentials_unavailable')
  })

  it('the tool is declared once, and its name is the one the epic asked for', () => {
    const client = { getCardCredentials: async () => revealed } as unknown as ShataleClientType
    const names = createRevealTools(client).tools.map((t) => t.name)
    expect(names).toEqual(['reveal_card'])
  })
})
