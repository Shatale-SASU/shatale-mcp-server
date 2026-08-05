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

  test('sandbox key unlocks the 17 backed tools (get_credential_emails gated until #361)', async () => {
    const res = await client.send('tools/list')
    // 17, not 18: get_credential_emails is withheld until its backend (PR #361,
    // GET /v1/credentials/{id}/emails) is deployed, so we never advertise a
    // working-but-404ing tool. It returns once SHATALE_CREDENTIAL_EMAILS_ENABLED=true.
    expect(res.result?.tools ?? []).toHaveLength(17)
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).not.toContain('get_credential_emails')
  })

  // The live-only checkout-identity tools must NOT be listed in sandbox — the backend rejects sandbox
  // keys on /v1/purchases, so exposing them here would only 403. Assert their absence by INTENT, not
  // just by the count above.
  test('checkout-identity tools are NOT exposed in sandbox mode', async () => {
    const res = await client.send('tools/list')
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).not.toContain('get_checkout_cardholder')
    expect(names).not.toContain('get_checkout_customer')
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
    expect(body.mcc).toBe(5691)
    expect(body.card_number).toBe('4242424242424242')
  })

  test('request_purchase is blocked under a sandbox key (never hits /v1/purchases)', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'Mock contract purchase',
    })
    expect(result.isError).toBe(true)
    expect(ToolResultText(result)).toContain('sandbox_key_purchase_blocked')
    // The guard must short-circuit before any outbound call.
    expect(mock.lastRequest('POST', '/v1/purchases')).toBeUndefined()
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

  test('register_user_profile reaches onboarding endpoint', async () => {
    const result = await client.callTool('register_user_profile', {
      publisher_user_id: 'pub-1',
      user_claims: { email: 'a@b.com', name: 'Mock User' },
    })
    expect(ToolResultText(result)).toContain('sess_mock_1')
    expect(mock.lastRequest('POST', '/v1/onboarding/register')).toBeDefined()
  })

  test('get_credential_emails reads the relay inbox and flows the body through', async () => {
    const result = await client.callTool('get_credential_emails', { credential_request_id: 'cred_mock_1' })
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
  })
})
