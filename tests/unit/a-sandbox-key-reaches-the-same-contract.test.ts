/**
 * SHAT-2611 — the sentinel now watches the property that REPLACED the block.
 *
 * It used to assert that `request_purchase` is refused under a sandbox key, and that assertion was
 * right when it was written. The refusal cited a property of the server: "/v1/purchases is NOT
 * sandbox-gated on the backend, so a sk_sandbox_* key could reach a live, side-effectful path".
 *
 * ⚠️ SHAT-2373 CHANGED EXACTLY THAT PROPERTY, AND THE CLIENT WENT ON CITING IT. The endpoint serves
 * sandbox keys DELIBERATELY — the API's own guard says a sandbox key using the same public contract
 * an outsider uses IS the product, and that a privileged /v1/sandbox/purchases bypass is what the
 * ticket forbids. The environment is stamped from the KEY, never the body; money-movers resolve to
 * sandbox implementations; both are guarded server-side.
 *
 * So the sentinel is inverted, not deleted: a publisher's FIRST call must not be refused by us. The
 * shape that made the old one valuable is kept — no key, no network, no spawn, handler invoked
 * directly — because the previous assertion lived only in a key-gated suite that SKIPS in CI, and a
 * skip is indistinguishable from a pass.
 *
 * ⚠️ AND IT PINS THE ADVICE, NOT ONLY THE REFUSAL. The old message told the caller to "run with a
 * live key (sk_live_) plus SHATALE_MODE=live and SHATALE_MONEY_GO" — it pushed a caller toward REAL
 * MONEY to escape a sandbox that had been safe by construction for months. A protection whose
 * escape hatch is more dangerous than what it protects against is read as guidance.
 */
import { describe, test, expect } from 'vitest'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import type { ShataleClient } from '../../src/client.js'

const validArgs = {
  publisher_user_id: 'pub_user_1',
  agent_id: 'agent_1',
  merchant: 'amazon.com',
  amount: 49.99,
  currency: 'EUR',
  description: 'headphones',
}

// A client that records whether requestPurchase was reached and returns a benign purchase, so the
// NON-sandbox (live) path completes without a network call. If the sandbox path ever reaches here,
// wasCalled() flips true and the "blocks before any network call" test fails.
function trackingClient() {
  let called = false
  const client = {
    requestPurchase: async () => {
      called = true
      return { purchase_id: 'p_1', status: 'onboarding_required' }
    },
  } as unknown as ShataleClient
  return { client, wasCalled: () => called }
}

async function callRequestPurchase(isSandbox: boolean, args: unknown = validArgs) {
  const { client, wasCalled } = trackingClient()
  const mod = createPurchaseTools(client, { isSandbox })
  const result = (await mod.handlers.request_purchase(args as Record<string, unknown>)) as {
    content: Array<{ text: string }>
  }
  return { text: result.content[0].text, wasCalled }
}

describe('a sandbox key reaches the same contract an outsider uses (SHAT-2611)', () => {
  test('a sandbox key is NOT refused by the client', async () => {
    const { text } = await callRequestPurchase(true)
    expect(text).not.toContain('sandbox_key_purchase_blocked')
  })

  test('and the call actually reaches the client — the publisher can start', async () => {
    const { wasCalled } = await callRequestPurchase(true)
    expect(wasCalled()).toBe(true)
  })

  // ⚠️ THE NEGATIVE CONTROL. The live path must be unchanged by this: if the two behaved
  // differently before and identically now, that would be a real finding — but they are identical
  // for the right reason, because the client never decided the environment. The server stamps it
  // from the key.
  test('a live key behaves exactly as before — the client never decided the environment', async () => {
    const { text, wasCalled } = await callRequestPurchase(false)
    expect(text).not.toContain('sandbox_key_purchase_blocked')
    expect(wasCalled()).toBe(true)
  })

  // The escape hatch that pointed at real money must not survive anywhere in this tool's output.
  test('nothing advises the caller to switch to a live key', async () => {
    for (const isSandbox of [true, false]) {
      const { text } = await callRequestPurchase(isSandbox)
      expect(text).not.toMatch(/run with a live key/i)
      expect(text).not.toMatch(/SHATALE_MONEY_GO/)
    }
  })

  // Validation is untouched: the refusal that remains is about the INPUT, not about the key.
  test('invalid input is still refused, and says so as input', async () => {
    const { text, wasCalled } = await callRequestPurchase(true, { ...validArgs, amount: 'not-a-number' })
    expect(text).toMatch(/Invalid input/)
    expect(wasCalled()).toBe(false)
  })
})
