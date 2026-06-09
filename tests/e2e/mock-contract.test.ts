/**
 * SHAT-1449: Deterministic fixture/mock contract tests.
 *
 * Exercises the authenticated + sandbox tool paths with NO live
 * SHATALE_TEST_KEY by pointing the MCP server at a local mock upstream
 * (127.0.0.1 is in the server's host allowlist) using a fake `sk_test_` key.
 * Runs in `test:public`, so CI no longer needs a live key for contract coverage.
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
      { SHATALE_API_KEY: 'sk_test_mock', SHATALE_API_URL: mock.url },
      'mock-contract',
    )
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('sandbox key unlocks all 19 tools', async () => {
    const res = await client.send('tools/list')
    expect(res.result?.tools ?? []).toHaveLength(19)
  })

  test('request_purchase sends merchant_ref + integer amount_cents on the wire', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'Mock contract purchase',
    })
    const text = ToolResultText(result)
    expect(text).toContain('pur_mock_1')

    const wire = mock.lastRequest('POST', '/v1/purchases')
    expect(wire).toBeDefined()
    const body = wire!.body as Record<string, unknown>
    expect(body.merchant_ref).toBe('amazon.com')
    expect(body.amount_cents).toBe(4999)
    expect(body).not.toHaveProperty('merchant')
    expect(body).not.toHaveProperty('amount')
    // idempotency_key auto-generated when omitted
    expect(typeof body.idempotency_key).toBe('string')
  })

  test('forwards the API key as a Bearer token', async () => {
    await client.callTool('get_purchase_status', { purchase_id: 'pur_mock_1' })
    const wire = mock.lastRequest('GET', '/v1/purchases/')
    expect(wire?.authorization).toBe('Bearer sk_test_mock')
  })

  test('search_merchants returns catalog data', async () => {
    const result = await client.callTool('search_merchants', { query: 'electronics' })
    expect(ToolResultText(result)).toContain('Mock Merchant')
  })

  test('sandbox_reset returns a ToolResult', async () => {
    const result = await client.callTool('sandbox_reset', {})
    expect(ToolResultText(result)).toContain('reset')
  })

  test('register_user_profile reaches onboarding endpoint', async () => {
    const result = await client.callTool('register_user_profile', {
      publisher_user_id: 'pub-1',
      user_claims: { email: 'a@b.com', name: 'Mock User' },
    })
    expect(ToolResultText(result)).toContain('sess_mock_1')
    expect(mock.lastRequest('POST', '/v1/onboarding/register')).toBeDefined()
  })
})
