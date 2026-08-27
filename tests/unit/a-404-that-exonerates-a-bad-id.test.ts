/**
 * SHAT-2678 — a 404 must not exonerate a request that carries the thing most likely to be wrong.
 *
 * `mapHttpError` decided who to blame for a 404 by looking at the SHAPE of the path:
 *
 *     const creating = method.toUpperCase() === 'POST' && !/\/[^/]*_?id[^/]*$/i.test(path)
 *
 * and a `creating` request was told, verbatim, "nothing in your request is wrong". That reads the
 * tail of the path, and two of the routes this client actually calls carry a caller-supplied id in
 * the MIDDLE and end in a verb:
 *
 *     POST /v1/sandbox/purchases/{purchaseId}/approve
 *     POST /v1/sandbox/users/{userId}/onboarding
 *
 * Both classified as creates. A 404 on either means the id is wrong — absent, another publisher's,
 * or from the other environment (apps/api api/v1/sandbox.go answers all three with one 404) — and
 * the agent was told its request was blameless and pointed at SHATALE_API_URL. It then stops
 * examining the one thing it can fix and reports a misconfiguration to its user.
 *
 * /!\ AND THE PENDULUM MUST NOT SWING BACK, which is why the second half of the headline test
 * matters as much as the first. The text before the guess blamed an id on EVERY 404, which is
 * nonsense for a genuine create: POST /v1/purchases has no id in it to check. A fix that makes
 * every 404 blame the caller passes the first assertion and re-opens the defect that heuristic was
 * introduced to close. Both halves, or neither.
 *
 * The tests below are written against the CLIENT, not against `mapHttpError`'s signature, on
 * purpose: they must run unchanged on the old code to show it red. A signature-coupled test would
 * have failed to compile instead, which proves nothing about behaviour.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { ShataleApiError } from '../../src/errors.js'

const BASE = 'http://127.0.0.1:9'

/** The sentence that says the caller is blameless. It may appear ONLY where that is established. */
const EXONERATES = 'nothing in your request is wrong'

/**
 * The advice that sends the caller to check an id. Matched loosely (a phrase, not the whole
 * sentence) so this test measures WHO IS BLAMED and not how the sentence was worded — the old text
 * said "Verify the id exists", the new one "Verify the id in the path", and neither wording is the
 * subject here.
 */
const BLAMES_THE_ID = /verify the id/i

function stub404() {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

/** The suggested_fix an agent would actually read, from a call that 404s. */
async function fixFor(call: () => Promise<unknown>): Promise<string> {
  stub404()
  try {
    await call()
  } catch (err) {
    expect(err).toBeInstanceOf(ShataleApiError)
    return (err as ShataleApiError).suggested_fix
  }
  throw new Error('expected the 404 to reject, but the call resolved')
}

afterEach(() => vi.unstubAllGlobals())

const client = () => new ShataleClient(BASE, 'sk_sandbox_test')

describe('SHAT-2678: a 404 blames the id only where the request carries one', () => {
  // ---- the defect ----

  test('POST /v1/sandbox/purchases/{id}/approve — a 404 does NOT exonerate the request', async () => {
    const fix = await fixFor(() => client().sandboxApprovePurchase('pur_never_existed'))
    expect(fix).not.toContain(EXONERATES)
    expect(fix).toMatch(BLAMES_THE_ID)
  })

  test('POST /v1/sandbox/users/{id}/onboarding — a 404 does NOT exonerate the request', async () => {
    const fix = await fixFor(() => client().sandboxCompleteOnboarding('usr_never_existed'))
    expect(fix).not.toContain(EXONERATES)
    expect(fix).toMatch(BLAMES_THE_ID)
  })

  // ---- the half that stops the fix from becoming "always blame the caller" ----

  test('POST /v1/purchases — a genuine create IS still exonerated', async () => {
    const fix = await fixFor(() =>
      client().requestPurchase({
        publisher_user_id: 'u_1',
        agent_id: 'a_1',
        merchant: 'nike.com',
        amount: 49.99,
        currency: 'EUR',
        description: 'shoes',
      }),
    )
    expect(fix).toContain(EXONERATES)
    expect(fix).not.toMatch(BLAMES_THE_ID)
  })
})

/**
 * The census: every route this package calls, and which answer it must get.
 *
 * `caller-id` — the caller handed us an id and we interpolated it into the path. A 404 may be that
 * id, so the answer must say so and must not exonerate.
 * `fixed` — this package composed the whole address; the caller contributed no part of it. There is
 * nothing in the request for a 404 to be about, so the answer names the deployment.
 *
 * Two of these live in src/tools/catalog.ts rather than src/client.ts — they call `client.request`
 * directly — and both were answered wrongly by the old heuristic too, in the OTHER direction: any
 * non-POST fell through to "verify the id", including a search that carries no id at all.
 */
type Kind = 'caller-id' | 'fixed'

const catalog = () => createCatalogTools(client()).handlers

const ROUTES: Array<{ route: string; kind: Kind; call: () => Promise<unknown> }> = [
  // --- purchases ---
  { route: 'POST /v1/purchases', kind: 'fixed', call: () =>
    client().requestPurchase({
      publisher_user_id: 'u_1', agent_id: 'a_1', merchant: 'nike.com',
      amount: 49.99, currency: 'EUR', description: 'shoes',
    }) },
  { route: 'GET /v1/purchases/{id}', kind: 'caller-id', call: () => client().getPurchaseStatus('pur_1') },
  { route: 'DELETE /v1/purchases/{id}', kind: 'caller-id', call: () => client().cancelPurchase('pur_1', 'changed mind') },
  { route: 'GET /v1/purchases/{id}/checkout-identity', kind: 'caller-id', call: () => client().getCheckoutIdentity('pur_1') },

  // --- credentials ---
  // Both branches: an explicit caller key and a derived one are two separate `request` calls.
  { route: 'POST /v1/credentials (derived key)', kind: 'fixed', call: () =>
    client().requestCredentials({
      publisher_user_id: 'u_1', agent_id: 'a_1', merchant_domain: 'nike.com', purpose: 'signup',
    }) },
  { route: 'POST /v1/credentials (explicit key)', kind: 'fixed', call: () =>
    client().requestCredentials({
      publisher_user_id: 'u_1', agent_id: 'a_1', merchant_domain: 'nike.com', purpose: 'signup',
      idempotency_key: 'k_1',
    }) },
  { route: 'GET /v1/credentials/{id}', kind: 'caller-id', call: () => client().getCredentialStatus('cred_1') },
  { route: 'GET /v1/credentials/{id}/emails', kind: 'caller-id', call: () => client().getCredentialEmails('cred_1') },

  // --- onboarding ---
  { route: 'POST /v1/onboarding/register', kind: 'fixed', call: () =>
    client().registerUserProfile({ publisher_user_id: 'u_1', user_claims: { email: 'a@b.co' } }) },
  { route: 'GET /v1/onboarding/sessions/{id}', kind: 'caller-id', call: () => client().getOnboardingStatus('sess_1') },

  // --- sandbox ---
  { route: 'POST /v1/sandbox/authorizations', kind: 'fixed', call: () =>
    client().sandboxSimulateAuthorization({
      agent_id: 'a_1', amount: 1000, currency: 'EUR', mcc: '5732',
      merchant_name: 'nike', card_number: '4242424242424242',
    }) },
  { route: 'POST /v1/sandbox/users/{id}/onboarding', kind: 'caller-id', call: () => client().sandboxCompleteOnboarding('usr_1') },
  { route: 'POST /v1/sandbox/purchases/{id}/approve', kind: 'caller-id', call: () => client().sandboxApprovePurchase('pur_1') },
]

describe('SHAT-2678 census: every route gets the answer its address earns', () => {
  for (const { route, kind, call } of ROUTES) {
    test(`${route} → ${kind}`, async () => {
      const fix = await fixFor(call)
      if (kind === 'caller-id') {
        expect(fix, `${route} carries a caller id; it must not be exonerated`).not.toContain(EXONERATES)
        expect(fix, `${route} carries a caller id; the answer must name it`).toMatch(BLAMES_THE_ID)
      } else {
        expect(fix, `${route} takes no id from the caller; it must be exonerated`).toContain(EXONERATES)
        expect(fix, `${route} has no id to verify`).not.toMatch(BLAMES_THE_ID)
      }
      // Whichever side it lands on, it may not land on both.
      expect(fix.includes(EXONERATES) && BLAMES_THE_ID.test(fix)).toBe(false)
    })
  }

  // The catalog pair goes through the tool handlers, which catch the error and return it as the
  // tool result rather than re-throwing — so read the answer from there.
  test('GET /v1/merchants/catalog?… → fixed (a filter is not an address)', async () => {
    stub404()
    const res = await catalog().search_merchants({ query: 'nike' })
    const fix = JSON.parse(res.content[0].text).error.suggested_fix as string
    expect(fix).toContain(EXONERATES)
    expect(fix).not.toMatch(BLAMES_THE_ID)
  })

  test('GET /v1/merchants/catalog/{merchantId} → caller-id', async () => {
    stub404()
    const res = await catalog().get_merchant_details({ merchant_id: 'm_1' })
    const fix = JSON.parse(res.content[0].text).error.suggested_fix as string
    expect(fix).not.toContain(EXONERATES)
    expect(fix).toMatch(BLAMES_THE_ID)
  })

  /**
   * GET /v1/mcc-codes is the fifteenth route and the one whose 404 answer no agent ever reads:
   * `listMCCCodes` catches it and serves the built-in ISO 18245 list instead. Asserted here so the
   * census is complete and so the exemption is a measured fact rather than an omission — if that
   * catch is ever removed, this test says so and the route needs its own answer assertion.
   */
  test('GET /v1/mcc-codes — the 404 never reaches the agent (built-in fallback swallows it)', async () => {
    stub404()
    const out = (await client().listMCCCodes('gambling')) as Record<string, unknown>
    expect(out._source).toBe('built-in')
    expect(String(out._note)).not.toContain(EXONERATES)
    expect(String(out._note)).not.toMatch(BLAMES_THE_ID)
  })
})

/**
 * The third answer, and the reason this is not just a two-way switch.
 *
 * `request` defaults to 'unknown', so a route added tomorrow whose author forgets to say gets an
 * answer that names both causes instead of inheriting a confident wrong half. This assertion is
 * necessarily worded against the new text, because the behaviour it measures — saying plainly that
 * it cannot tell — did not exist before.
 */
describe('SHAT-2678: an unmarked call admits it cannot tell', () => {
  test('a route that says nothing about its address gets both causes, not one', async () => {
    const fix = await fixFor(() => client().request('GET', '/v1/some/future/route'))
    expect(fix).not.toContain(EXONERATES)
    expect(fix).toMatch(/could be either/i)
    expect(fix).toMatch(/id/i)
    expect(fix).toContain('SHATALE_API_URL')
  })
})
