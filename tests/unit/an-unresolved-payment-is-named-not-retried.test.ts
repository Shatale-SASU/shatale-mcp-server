import { describe, it, expect, afterEach, vi } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { ShataleApiError } from '../../src/errors.js'

// SHAT-8325. The API refuses a new purchase on a card whose earlier failed purchase still has money
// taken and unresolved: 409 with code unresolved_payment_on_a_failed_purchase. Before this entry the
// agent got our generic 409 envelope, which ends by inviting a retry — the one thing this refusal
// exists to stop. The case walks the real request path (requestPurchase → fetch → mapping), not only
// the dictionary, so a client that stops consulting the dictionary turns it red.
describe('409 unresolved_payment_on_a_failed_purchase reaches the agent by name', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond409 = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } })))

  const purchase = {
    publisher_user_id: 'pu_1', agent_id: 'ag_1', merchant: 'shop', amount: '10.00',
    currency: 'EUR', description: 'a thing',
  }

  async function refusal(): Promise<ShataleApiError> {
    const c = new ShataleClient('https://api.example.test', 'sk_sandbox_test')
    try {
      await c.requestPurchase(purchase as never)
    } catch (e) {
      expect(e).toBeInstanceOf(ShataleApiError)
      return e as ShataleApiError
    }
    throw new Error('expected a refusal')
  }

  it('the named code arrives with its own words: no retry, tell the person to go to support', async () => {
    respond409({ code: 'unresolved_payment_on_a_failed_purchase', error: 'server prose we never forward', request_id: 'req-8325' })
    const e = await refusal()
    expect(e.code).toBe('unresolved_payment_on_a_failed_purchase')
    expect(e.request_id).toBe('req-8325')
    expect(e.message).toMatch(/earlier payment on this card/i)
    expect(e.suggested_fix).toMatch(/^Do not retry/)
    expect(e.suggested_fix).toMatch(/sorted out with support/)
    expect(e.suggested_fix).toMatch(/do not suggest trying the purchase again/)
    // The two invitations this text must not carry: the envelope's «then retry», and «another card».
    expect(e.suggested_fix).not.toMatch(/then retry/i)
    expect(e.suggested_fix).not.toMatch(/another/i)
    // The server's own prose is never forwarded.
    expect(JSON.stringify(e)).not.toMatch(/server prose/)
  })

  it('CONTROL: a 409 without an agreed code still gets our envelope, so the case above discriminates', async () => {
    respond409({ code: 'idempotency_key_conflict_unlisted_variant', error: 'x' })
    const e = await refusal()
    expect(e.code).not.toBe('unresolved_payment_on_a_failed_purchase')
    expect(e.suggested_fix ?? '').not.toMatch(/sorted out with support/)
  })
})
