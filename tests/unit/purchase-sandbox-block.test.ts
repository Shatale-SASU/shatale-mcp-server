/**
 * SHAT-2525 — non-key-gated sentinel for the SHAT-1488 sandbox guard.
 *
 * The ONLY prior assertion that `request_purchase` is blocked under a sandbox key lived in a
 * key-gated e2e suite (tests/e2e/sandbox-tools.test.ts — `describe.skip` when SHATALE_TEST_KEY is
 * unset). In CI, with no key, that suite SKIPS, and a skip is indistinguishable from a pass — so the
 * guard that keeps a `sk_sandbox_*` key off the side-effectful `/v1/purchases` path (real
 * ledger/outbox) was not sentinelled at all. A guard nobody runs is counted as coverage.
 *
 * This test needs no key, no network and no spawn: it invokes the handler directly. It goes RED the
 * moment the `if (options.isSandbox)` block is removed or its outcome changed, and the positive
 * control proves the block is conditional on isSandbox — not a constant that would also break the
 * live path.
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

describe('request_purchase sandbox block — non-key-gated (SHAT-2525)', () => {
  test('isSandbox:true blocks with sandbox_key_purchase_blocked and steers to the safe tool', async () => {
    const { text } = await callRequestPurchase(true)
    expect(text).toContain('sandbox_key_purchase_blocked')
    expect(text).toContain('sandbox_simulate_authorization')
  })

  test('isSandbox:true blocks BEFORE any network call (guard sits ahead of the client)', async () => {
    const { wasCalled } = await callRequestPurchase(true)
    expect(wasCalled()).toBe(false)
  })

  test('positive control: isSandbox:false does NOT block — it reaches the client path', async () => {
    const { text, wasCalled } = await callRequestPurchase(false)
    expect(text).not.toContain('sandbox_key_purchase_blocked')
    expect(wasCalled()).toBe(true)
  })

  test('the block is on isSandbox alone, not a validation artifact — valid input still blocks', async () => {
    const { text } = await callRequestPurchase(true, { ...validArgs, amount: 12.5 })
    expect(text).toContain('sandbox_key_purchase_blocked')
  })
})
