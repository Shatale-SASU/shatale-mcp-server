/**
 * SHAT-2683 — a tool DESCRIPTION is a promise too: read before the tool is called, acted on after.
 *
 * Two texts, both measured against the code they describe:
 *
 * 1. `request_purchase` said "Shatale validates against spending policies and executes the
 *    payment." No branch of the backend does that. `Service.RequestPurchase` assigns
 *    onboarding_required, delegation_required, blocked, pending_approval or failed
 *    (apps/api/internal/purchases/service.go), and even payment_ready means only that a card was
 *    issued — paying at the merchant is the agent's own step. An agent told the call executes the
 *    payment reports a completed purchase to the person while the purchase waits for a human.
 *
 * 2. Every 401 AND every 403 answered "Set SHATALE_API_KEY to a valid sandbox key". Under a live
 *    key that instruction is destructive: the server refuses to start with SHATALE_MODE=live and a
 *    non-live key, so following it stops the integration, and dropping the mode flag instead
 *    silently demotes production to demo. And a 403 is not a bad key at all — it is a key that was
 *    accepted and is not allowed here, so replacing it is fixing the one thing that worked.
 *
 * The shared shape: a sentence written for the common case, stated as if it were the only case.
 */

import { describe, test, expect } from 'vitest'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'
import { mapHttpError } from '../../src/errors.js'
import type { ShataleClient } from '../../src/client.js'

function purchaseDescription(): string {
  const mod = createPurchaseTools({} as ShataleClient, { isSandbox: true })
  const tool = mod.tools.find((t) => t.name === 'request_purchase')
  expect(tool, 'request_purchase is not in this module — the test is out of date').toBeDefined()
  return tool!.description
}

describe('request_purchase does not promise a completed payment', () => {
  test('the description does not claim the call pays', () => {
    const d = purchaseDescription()
    expect(d).not.toMatch(/executes the payment|completes the (payment|purchase)|payment is (made|taken)/i)
  })

  test('and it names the outcomes that actually come back', () => {
    const d = purchaseDescription()
    // Naming them is the part that changes what an agent does: it has to read a status and branch,
    // not report success. Two of the five are enough to prove the sentence is about outcomes; the
    // full list lives in the backend and would go stale here.
    expect(d).toMatch(/onboarding/i)
    expect(d).toMatch(/approval/i)
    expect(d, 'it must say the payment itself is still the caller\'s step').toMatch(/payment_ready|next step/i)
  })
})

describe('auth advice depends on what the caller is running with', () => {
  test('a live key is never told to swap in a sandbox key', () => {
    const fix = mapHttpError(401, 'POST', '/v1/purchases', undefined, { keyKind: 'live' }).toStructured().suggested_fix
    expect(fix, 'this advice stops a live integration').not.toMatch(/set SHATALE_API_KEY to a valid sandbox key/i)
    expect(fix, 'it must warn instead of instruct').toMatch(/do not|don't/i)
  })

  test('a keyless session still gets the sign-up link — the advice is not merely deleted', () => {
    const fix = mapHttpError(401, 'POST', '/v1/purchases', undefined, { keyKind: 'none' }).toStructured().suggested_fix
    expect(fix).toMatch(/sk_sandbox_/)
    expect(fix).toMatch(/register/)
  })

  test('a sandbox key is told to check its own key, not to fetch a new one', () => {
    const fix = mapHttpError(401, 'POST', '/v1/purchases', undefined, { keyKind: 'sandbox' }).toStructured().suggested_fix
    expect(fix).toMatch(/sandbox key was not accepted/i)
    expect(fix).not.toMatch(/register\?ref=mcp/)
  })

  // ⚠️ 403 IS A DIFFERENT ANSWER AND USED TO SHARE 401's. The key worked; the principal may not
  // have this resource. Advising a replacement sends the reader to fix what already works.
  test('a 403 is not reported as a bad key, whatever the key is', () => {
    for (const kind of ['none', 'sandbox', 'live'] as const) {
      const e = mapHttpError(403, 'GET', '/v1/purchases/pur_1', undefined, { keyKind: kind }).toStructured()
      expect(e.code, `403 under ${kind} still reports as auth_failed`).toBe('forbidden')
      expect(e.suggested_fix, `403 under ${kind} still tells the caller to replace the key`).not.toMatch(
        /set SHATALE_API_KEY|get a free one/i,
      )
      expect(e.suggested_fix).toMatch(/scope|belong/i)
    }
  })
})

// SHAT-2530 — the third text, and the one that cost the most by saying the least.
//
// `sandbox_complete_onboarding`'s parameter said "The test user ID to complete onboarding for". The
// API resolved it as Shatale's INTERNAL user id, which no tool, endpoint or response in this server
// ever hands out — so the call could not be made correctly, and answered 404. A 404 reads as "your
// user does not exist", not as "you cannot express which user you mean", and that is why the route
// sat unreachable rather than reported broken.
//
// ⚠️ THE SHAPE IS THE SAME AS THE TWO ABOVE AND ONE STEP EARLIER: not a sentence written for the
// common case, but a sentence that named the RIGHT THING AMBIGUOUSLY. "The test user ID" is true of
// both ids. An agent reading it cannot be wrong, and cannot be right either.
describe('sandbox_complete_onboarding says which id it wants', () => {
  function onboardingTool() {
    const mod = createSandboxTools({} as ShataleClient)
    const tool = mod.tools.find((t) => t.name === 'sandbox_complete_onboarding')
    expect(tool, 'sandbox_complete_onboarding is not in this module — the test is out of date').toBeDefined()
    return tool!
  }

  test('the id is named by where the caller got it, not as "the user id"', () => {
    const t = onboardingTool()
    const param = (t.inputSchema as { properties: { user_id: { description: string } } }).properties.user_id.description
    const both = `${t.description}\n${param}`
    expect(both, 'it must point at the id the caller actually holds').toMatch(/sandbox_create_user/)
    // ⚠️ THE POSITIVE CONTROL FOR THIS FILE'S OTHER HALF: sandbox_create_user is where the id comes
    // from, and it already says so. If that sentence ever goes, the reference above points nowhere.
    const create = createSandboxTools({} as ShataleClient).tools.find((x) => x.name === 'sandbox_create_user')!
    expect(create.description, 'the id must still be described as the caller\'s own choice there').toMatch(
      /your own|you choose|yours to choose/i,
    )
  })

  test('and it names the failure against an older API rather than leaving a bare 404', () => {
    const t = onboardingTool()
    const param = (t.inputSchema as { properties: { user_id: { description: string } } }).properties.user_id.description
    // The server this tool talks to is deployed separately from the tool, so "pass the external id"
    // is advice that is wrong for exactly as long as the deployment is behind. Saying what a 404
    // means there is what keeps the text true whichever version the caller is pointed at.
    expect(param).toMatch(/404/)
    expect(param).toMatch(/internal/i)
  })
})
