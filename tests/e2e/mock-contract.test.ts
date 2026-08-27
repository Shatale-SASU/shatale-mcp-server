/**
 * SHAT-1449 / SHAT-1488: Deterministic fixture/mock contract tests.
 *
 * Exercises the authenticated + sandbox tool paths with NO live
 * SHATALE_TEST_KEY by pointing the MCP server at a local mock upstream
 * (127.0.0.1 is in the server's host allowlist) using a fake `sk_sandbox_` key.
 * Runs in `test:public`, so CI no longer needs a live key for contract coverage.
 *
 * SHAT-1488 changes the sandbox surface: `sandbox_simulate_authorization`
 * (side-effect-free policy engine) replaces the phantom create-user/decline/reset
 * tools, and `request_purchase` is blocked client-side under a sandbox key
 * because `/v1/purchases` is not sandbox-gated on the backend.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const ToolResultText = (result: any): string => {
  expect(result.content?.[0]?.type).toBe('text')
  return result.content[0].text as string
}

describe('Mock Contract: sandbox mode (no live key)', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'mock-contract',
    )
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('sandbox key unlocks the 19 backed tools; the two unbacked ones stay hidden', async () => {
    const res = await client.send('tools/list')
    // 19, and every one missing is missing on purpose — a tool we advertise is a
    // tool an agent will try, and it cannot ask a follow-up question when the answer
    // is a 404.
    //
    //   register_user_profile  \ the register→status loop cannot close on ANY
    //   get_onboarding_status  / deployed backend — the session id is never
    //                            persisted, so the second step 404s forever
    //                            (SHAT-1662)
    //
    // ⚠️ get_credential_emails WAS THE THIRD, and it is here now. Its suppression named a
    // condition — "#361 merged AND deployed" — and both halves have been met: the route is
    // registered with no flag beside it, and the live API answers 401 from the auth middleware
    // where an unserved path answers a plain 404 (SHAT-2527). The count moved 15 → 16 because a
    // reason expired, not because the rule changed.
    //
    // 16 → 17 is `sandbox_create_user` (SHAT-2698), which is the opposite kind of move: a tool
    // ADDED against a route the backend already serves. The two withheld ones above are unchanged.
    //
    // ⚠️ 17 → 19 is the two checkout-identity tools (SHAT-2674), and it is the SAME kind of move as
    // get_credential_emails: a reason expired, the rule did not change. They were withheld because
    // "the backend rejects sandbox keys"; the backend does not. Measured against api.shatale.com
    // with the key the deployed Concierge uses — a fresh sandbox user, a purchase at 2500 minor
    // units reaching payment_ready, then GET /v1/purchases/{id}/checkout-identity answering 200
    // with billing_identity and merchant_customer_identity.
    //
    // ⚠️ AND THIS COMMENT SAID "16" FOR A RELEASE WHILE THE ASSERTION THREE LINES DOWN SAID 17.
    // Whoever bumped the number bumped the title and the expectation and not the prose between
    // them, which is the same shape as every defect this file's neighbours were written for: the
    // count is measured, the explanation of the count is not, and a reader checking WHY the number
    // is what it is gets last release's answer. Bump all three or none.
    expect(res.result?.tools ?? []).toHaveLength(19)
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('get_credential_emails')
    expect(names).not.toContain('register_user_profile')
    expect(names).not.toContain('get_onboarding_status')
  })

  // ⚠️ THIS TEST ASSERTED THE OPPOSITE, FOR A REASON THAT WAS WRONG TWICE OVER (SHAT-2674).
  //
  // It said: "the backend rejects sandbox keys on /v1/purchases, so exposing them here would only
  // 403". Both halves fail. The backend does not reject sandbox keys on checkout-identity — the
  // route sits in the ordinary purchases group behind RequireAPIKeyScope alone, with no SandboxOnly
  // and no live-only middleware (main.go:5448) — and the sandbox refusal on /v1/purchases that the
  // sentence leaned on was itself removed in SHAT-2611. It also named the wrong route: these tools
  // call /v1/purchases/{id}/checkout-identity, not /v1/purchases.
  //
  // What the environment does is ISOLATE, not reject: a sandbox key can never read a LIVE purchase's
  // customer (purchases.go). The negative control that settles it — the same route on a purchase
  // still in onboarding_required answers JSON 404 "checkout identity not available", a refusal by
  // BUSINESS STATE. The server distinguishes "there is no identity yet" from "you may not have it",
  // and never refuses on the key.
  //
  // Asserted by INTENT rather than left to the count above, for the same reason the old test gave:
  // a count moves for many reasons and says nothing about which tool moved.
  test('checkout-identity tools ARE exposed in sandbox mode', async () => {
    const res = await client.send('tools/list')
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('get_checkout_cardholder')
    expect(names).toContain('get_checkout_customer')
  })

  test('sandbox_simulate_authorization hits the side-effect-free policy engine', async () => {
    const result = await client.callTool('sandbox_simulate_authorization', {
      agent_id: 'agent-1',
      amount: 15000,
      currency: 'EUR',
      mcc: 5691,
      merchant_name: 'Mock Clothing Co',
      card_number: '4242424242424242',
    })
    expect(ToolResultText(result)).toContain('approved')

    const wire = mock.lastRequest('POST', '/v1/sandbox/authorizations')
    expect(wire).toBeDefined()
    const body = wire!.body as Record<string, unknown>
    expect(body.agent_id).toBe('agent-1')
    expect(body.amount).toBe(15000)
    // A STRING on the wire, because the backend's struct is `MCC string` and Go rejects a
    // JSON number into a string field. This assertion used to demand a NUMBER, so the
    // suite certified the exact defect that made every real call return 400 — the mock
    // accepts any body, so nothing else could have caught it. A contract test has to
    // assert the contract the OTHER side reads, not the one this side happens to send.
    expect(body.mcc).toBe('5691')
    expect(body.card_number).toBe('4242424242424242')
  })

  test('a string mcc is accepted too, and reaches the wire unchanged', async () => {
    // Both spellings ask the same question. An agent following an older tool description
    // sends a number; one reading the current schema sends a string. Neither should meet
    // a client-side refusal, and both must arrive in the form the backend decodes.
    const result = await client.callTool('sandbox_simulate_authorization', {
      agent_id: 'agent-1',
      amount: 15000,
      currency: 'EUR',
      mcc: '7995',
      merchant_name: 'Mock Betting Co',
      card_number: '4242424242424242',
    })
    expect(ToolResultText(result)).not.toContain('Invalid input')

    const wire = mock.lastRequest('POST', '/v1/sandbox/authorizations')
    const body = wire!.body as Record<string, unknown>
    expect(body.mcc).toBe('7995')
  })

  // SHAT-2611 — the concierge's through-scenario under a SANDBOX key, and it goes through the MCP
  // tools only: no handler is invoked directly, no client method is called from the test. This is
  // the assertion that used to say the opposite ("blocked, never hits /v1/purchases"), and it was
  // true when written. SHAT-2373 made the endpoint serve sandbox keys deliberately: a sandbox key
  // using the same public contract an outsider uses IS the product.
  test('a publisher can buy end to end under a sandbox key, through the tools alone', async () => {
    const created = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'Mock contract purchase',
    })
    expect(created.isError).toBeFalsy()
    expect(ToolResultText(created)).not.toContain('sandbox_key_purchase_blocked')
    expect(ToolResultText(created)).toContain('pur_mock_1')

    // It reached the real, shared route — not a privileged sandbox bypass, which SHAT-2373 names
    // as the thing it forbids.
    const wire = mock.lastRequest('POST', '/v1/purchases')
    expect(wire).toBeDefined()
    expect(wire!.authorization).toBe('Bearer sk_sandbox_mock')

    // ⚠️ THE ENVIRONMENT IS STAMPED FROM THE KEY, NEVER FROM THE BODY. If this client ever starts
    // TELLING the server which environment it is in, the server has a second, caller-controlled
    // source for a fact it already owns — and the test that reads "sandbox works" would then be
    // reading the client's own claim back to itself.
    const body = wire!.body as Record<string, unknown>
    for (const claimed of ['environment', 'mode', 'sandbox', 'is_sandbox']) {
      expect(body[claimed]).toBeUndefined()
    }

    // And the purchase is readable afterwards — the scenario ends where a publisher would look.
    const status = await client.callTool('get_purchase_status', { purchase_id: 'pur_mock_1' })
    expect(ToolResultText(status)).toContain('pur_mock_1')
  })

  // The advice is pinned separately from the refusal. The old message told the caller to escape a
  // sandbox by switching to a live key plus the money flag — it pointed at REAL MONEY as the way
  // out of a path that was safe by construction. If a refusal ever comes back for another reason,
  // it must not come back carrying that.
  test('no tool answers a sandbox purchase by pointing at real money', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'Mock contract purchase',
    })
    const text = ToolResultText(result)
    expect(text).not.toMatch(/run with a live key/i)
    expect(text).not.toMatch(/SHATALE_MONEY_GO/)
    expect(text).not.toMatch(/sk_live_/)
  })

  // ⚠️ THE SERVER'S OWN GUIDANCE IS PART OF THE REFUSAL. Removing the code block left two shipped
  // sentences still telling an agent that request_purchase is "disabled"/"BLOCKED" under a sandbox
  // key — and the whole suite stayed green, because nothing pinned the prose. An agent reads that
  // text and does not call the tool: a refusal made of words costs exactly what a refusal made of
  // code costs.
  test('nothing the server SAYS claims a purchase is refused here', async () => {
    for (const tool of ['explain_shatale', 'list_capabilities']) {
      const text = ToolResultText(await client.callTool(tool, {}))
      expect(text, `${tool} still advertises a refusal`).not.toMatch(
        /request_purchase[^.]{0,80}(disabled|blocked|unavailable|not available)/i,
      )
      expect(text, `${tool} still names a refusal code`).not.toContain('sandbox_key_purchase_blocked')
    }
  })

  test('forwards the API key as a Bearer token', async () => {
    await client.callTool('sandbox_complete_onboarding', { user_id: 'usr_mock_1' })
    const wire = mock.lastRequest('POST', '/v1/sandbox/users/')
    expect(wire?.authorization).toBe('Bearer sk_sandbox_mock')
  })

  test('search_merchants returns catalog data', async () => {
    const result = await client.callTool('search_merchants', { query: 'electronics' })
    expect(ToolResultText(result)).toContain('Mock Merchant')
  })

  test('sandbox_approve_purchase repoints to /v1/sandbox/purchases/{id}/approve', async () => {
    const result = await client.callTool('sandbox_approve_purchase', { purchase_id: 'pur_mock_1' })
    expect(ToolResultText(result)).toContain('approved')
    expect(mock.lastRequest('POST', '/v1/sandbox/purchases/')).toBeDefined()
  })

  // Same two-layer gate as get_credential_emails: unlisted AND uncallable. The
  // dispatch resolves handlers, not the advertised list, so a listing-only gate
  // leaves the tool reachable by name — and this pair must not reach the backend at
  // all, because the call succeeds and hands back a session id that will never
  // resolve. A silent dead end is worse than a refusal.
  test('the onboarding pair is not callable while gated (flag off)', async () => {
    for (const name of ['register_user_profile', 'get_onboarding_status']) {
      const result = await client.callTool(name, {
        publisher_user_id: 'pub-1',
        user_claims: { email: 'a@b.com', name: 'Mock User' },
        session_id: 'sess_mock_1',
      })
      expect(ToolResultText(result)).toContain(`Unknown tool: ${name}`)
    }
    expect(mock.lastRequest('POST', '/v1/onboarding/register')).toBeUndefined()
  })

  // And the gate opens. A gate nobody has seen open is a gate that may simply be a
  // deletion — this is the shape the deploy takes once Funnel B is merged AND
  // deployed, which is the flip condition, not "the backend flag is on".
  test('the onboarding pair returns when SHATALE_ONBOARDING_ENABLED=true', async () => {
    const flagged = new McpTestClient(
      {
        SHATALE_API_KEY: 'sk_sandbox_mock',
        SHATALE_API_URL: mock.url,
        SHATALE_ONBOARDING_ENABLED: 'true',
      },
      'mock-contract-onboarding-on',
    )
    try {
      await flagged.initialize()
      const res = await flagged.send('tools/list')
      const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
      expect(names).toContain('register_user_profile')
      expect(names).toContain('get_onboarding_status')

      const result = await flagged.callTool('register_user_profile', {
        publisher_user_id: 'pub-1',
        user_claims: { email: 'a@b.com', name: 'Mock User' },
      })
      expect(ToolResultText(result)).toContain('sess_mock_1')
      expect(mock.lastRequest('POST', '/v1/onboarding/register')).toBeDefined()
    } finally {
      await flagged.close()
    }
  })

  // With the flag off (default), the gate must hold at BOTH layers: unlisted
  // (asserted above) AND uncallable — the dispatch resolves handlers, not the
  // advertised list, so a listing-only gate would leave the tool reachable by
  // name and 404ing against its not-yet-deployed backend.
  // ⚠️ THE "NOT CALLABLE WHILE GATED" TEST IS GONE WITH ITS SUBJECT (SHAT-2527). It asserted that
  // the tool answers "Unknown tool" while the flag is off, and there is no flag: the condition it
  // named — "#361 merged AND deployed" — has been met on both halves. Keeping it would demand the
  // return of a suppression whose reason expired, which is the shape this ticket removes.
  //
  // What it protected is not lost. The test below calls the tool and asserts the request reaches
  // the relay inbox, so a tool that stopped working is still caught — by what it DOES rather than
  // by what it refuses.
  test('get_credential_emails is callable now that its backend is deployed', async () => {
    const result = await client.callTool('get_credential_emails', { credential_request_id: 'cred_mock_1' })
    expect(ToolResultText(result)).not.toContain('Unknown tool')
    expect(mock.lastRequest('GET', '/v1/credentials/cred_mock_1/emails')).toBeDefined()
  })

  // The email flow itself stays covered: same server, flag ON — the shape the
  // deploy takes once #361 is live and SHATALE_CREDENTIAL_EMAILS_ENABLED=true.
  test('get_credential_emails (flag on) reads the relay inbox and flows the body through', async () => {
    const flagged = new McpTestClient(
      {
        SHATALE_API_KEY: 'sk_sandbox_mock',
        SHATALE_API_URL: mock.url,
        SHATALE_CREDENTIAL_EMAILS_ENABLED: 'true',
      },
      'mock-contract-emails-on',
    )
    try {
      await flagged.initialize()

      const res = await flagged.send('tools/list')
      const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
      expect(names).toContain('get_credential_emails')

      const result = await flagged.callTool('get_credential_emails', { credential_request_id: 'cred_mock_1' })
      const text = ToolResultText(result)
      // The OTP body must reach the agent verbatim (it's the payload)...
      expect(text).toContain('483920')
      expect(text).toContain('noreply@namecheap.com')
      // ...alongside the untrusted-content warning in the payload.
      expect(text).toContain('untrusted external content')
      // Hit the right, publisher-scoped backend route.
      const wire = mock.lastRequest('GET', '/v1/credentials/cred_mock_1/emails')
      expect(wire).toBeDefined()
      expect(wire?.authorization).toBe('Bearer sk_sandbox_mock')
    } finally {
      flagged.close()
    }
  })
})
