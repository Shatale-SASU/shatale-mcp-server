/**
 * An error whose cause is unknown must not name one.
 *
 * SHAT-2678, found while verifying SHAT-2611 against the published package.
 *
 * ⚠️ MEASURED AGAINST THE PUBLISHED PACKAGE, NOT IMAGINED. With the API unreachable, the shipped
 * 1.0.1 answered `request_purchase` with: "Could not complete the purchase request. Confirm the
 * merchant, amount, and user details are valid, then retry." Nothing had rejected the merchant, the
 * amount or the user. The server was never reached at all.
 *
 * The harm is not an ugly sentence. An agent ACTS on suggested_fix: it edits a request that was
 * already correct and retries into a void, and the one fact that would end the loop — nobody is
 * listening — is the fact the message replaced. It costs the caller its inputs and its trust in
 * them, and it costs the operator the outage report that never gets filed.
 *
 * The mechanism was structural, so this test is too. `errorResult(err, fallback)` reached its
 * fallback exactly when the caught error was NOT a ShataleApiError — that is, when nothing had been
 * learned about why — and every tool had written that fallback as a diagnosis. The branch stated
 * where the cause is UNKNOWN was the branch that named a culprit.
 *
 * ⚠️ SO THIS SWEEPS EVERY TOOL, NOT request_purchase. Fixing the one that was measured would leave
 * the same sentence pattern alive in the neighbours, and the next tool added would copy it. The
 * rule is on the class: no text produced by a caught error may blame the caller's input; advice
 * about inputs belongs to the branch where the SERVER rejected them (mapHttpError), and is asserted
 * to still exist there — otherwise this test could be satisfied by having no advice anywhere.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { mapHttpError, UNKNOWN_CAUSE } from '../../src/errors.js'
import type { ToolModule } from '../../src/types.js'

// A port nothing listens on: every request fails to connect, so no tool can learn anything about
// why. Loopback, so the test cannot reach the network even by accident.
const UNREACHABLE = 'http://127.0.0.1:9'

// ⚠️ THIS IS AN EQUALITY CHECK, NOT A WORD SEARCH, AND THE FIRST ATTEMPT TAUGHT ME WHY. I began by
// grepping the answer for blaming words — and it reddened on the CORRECTED text, because a neutral
// sentence may legitimately contain "check" ("check whether the endpoint is reachable"). A predicate
// that recognises blame by vocabulary punishes the fix as readily as the defect.
//
// The contract is sharper than the vocabulary: when nothing is known about the cause, there is
// exactly ONE text, and it lives in src/errors.ts. Any tool that writes its own — however politely —
// fails here, which is precisely the class that produced the defect: fourteen private sentences,
// each free to invent a diagnosis.

// Arguments that are VALID for each tool: the point is that a good request still gets blamed. A
// tool refusing malformed input is a different, legitimate answer, and would hide the defect.
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['request_purchase', { publisher_user_id: 'pub-1', agent_id: 'agent-1', merchant: 'amazon.com', amount: 49.99, currency: 'EUR', description: 'probe' }],
  ['get_purchase_status', { purchase_id: 'pur_1' }],
  ['cancel_purchase', { purchase_id: 'pur_1' }],
  ['request_temporary_credentials', { publisher_user_id: 'pub-1', agent_id: 'agent-1', merchant_domain: 'amazon.com', purpose: 'checkout' }],
  ['get_credential_status', { credential_request_id: 'cred_1' }],
  ['register_user_profile', { publisher_user_id: 'pub-1', user_claims: { email: 'probe@example.com' } }],
  ['get_onboarding_status', { session_id: 'ses_1' }],
  ['search_merchants', { query: 'electronics' }],
  ['get_merchant_details', { merchant_id: 'mer_1' }],
  ['sandbox_simulate_authorization', { agent_id: 'agent-1', amount: 1000, currency: 'EUR', mcc: '5691', merchant_name: 'Probe', card_number: '4111111111111111' }],
  ['sandbox_approve_purchase', { purchase_id: 'pur_1' }],
  ['sandbox_complete_onboarding', { user_id: 'usr_1' }],
  ['get_checkout_cardholder', { purchase_id: 'pur_1' }],
  ['get_checkout_customer', { purchase_id: 'pur_1' }],
]

let handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>

beforeAll(() => {
  // A short timeout: these calls are meant to fail, and the suite should not wait 30s each.
  const client = new ShataleClient(UNREACHABLE, 'sk_sandbox_probe', 2_000)
  const modules: ToolModule[] = [
    createPurchaseTools(client, { isSandbox: false }),
    createCredentialTools(client),
    createOnboardingTools(client, { enabled: true }),
    createCatalogTools(client),
    createSandboxTools(client),
    createCheckoutTools(client),
  ]
  handlers = Object.assign({}, ...modules.map((m) => m.handlers))
})

describe('when the server never answered, no tool blames the caller', () => {
  test.each(CALLS)('%s', async (name, args) => {
    const handler = handlers[name]
    // A missing handler must fail loudly: silently skipping is how a sweep shrinks to nothing while
    // still reporting green.
    expect(handler, `${name} has no handler — the census is out of date`).toBeTypeOf('function')

    const text = (await handler(args)).content[0].text
    const { error } = JSON.parse(text) as { error: { code: string; message: string; suggested_fix: string } }

    expect(error.message, `${name} wrote its own message for an unknown cause`).toBe(UNKNOWN_CAUSE.message)
    expect(error.suggested_fix, `${name} wrote its own advice for an unknown cause`).toBe(UNKNOWN_CAUSE.suggested_fix)
    // The code stays tool-specific: it is an identifier, not a claim about why.
    expect(error.code, `${name} lost its error code`).toBeTruthy()
  }, 20_000)
})

// The equality above is only as good as the text it pins, so the text itself is checked once, here.
// These are the two things the measured defect got wrong: it named the caller's own fields as
// suspect, and it never said that no answer had come back.
describe('the one unknown-cause text', () => {
  test('does not put the caller\'s request under suspicion', () => {
    const both = `${UNKNOWN_CAUSE.message} ${UNKNOWN_CAUSE.suggested_fix}`
    for (const noun of ['merchant', 'amount', 'user details', 'valid', 'invalid']) {
      expect(both.toLowerCase(), `the neutral text points at "${noun}"`).not.toContain(noun)
    }
  })

  test('and says the thing that ends the retry loop — no reply came back', () => {
    expect(`${UNKNOWN_CAUSE.message} ${UNKNOWN_CAUSE.suggested_fix}`).toMatch(/no reply|did not complete/i)
  })
})

// ⚠️ THE OTHER HALF, WITHOUT WHICH THE ABOVE IS SATISFIED BY SILENCE. Advice about inputs is
// correct exactly where the server rejected them, and this test must not push the codebase into
// removing it. mapHttpError is that branch: the server answered, and its status is the measurement.
describe('where the server DID answer, the advice is still there', () => {
  test('a 400 still tells the caller to look at the request', () => {
    const structured = mapHttpError(400, 'POST', '/v1/purchases').toStructured()
    expect(structured.suggested_fix).toMatch(/\b(check|verify|confirm)\b/i)
    expect(structured.suggested_fix).toMatch(/request|parameter|key/i)
  })

  test('and a 401 still names the key', () => {
    const structured = mapHttpError(401, 'POST', '/v1/purchases').toStructured()
    expect(structured.suggested_fix).toMatch(/sk_sandbox_/)
  })
})
