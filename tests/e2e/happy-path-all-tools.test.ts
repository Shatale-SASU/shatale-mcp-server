/**
 * SHAT-1334: Happy-path test for every MCP tool.
 * Ensures each tool can be called without crashing and returns a valid response.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { testId, testEmail } from '../harness/testIds'

const TEST_KEY = process.env.SHATALE_TEST_KEY
const describeIfKey = TEST_KEY ? describe : describe.skip

// ── Guest tools (no key) ────────────────────────────────────────────────

describe('Happy Path: Guest Tools', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: '' }, 'happy-guest')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('list_mcc_codes returns MCC data', async () => {
    const result = await client.callTool('list_mcc_codes', {})
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text.length).toBeGreaterThan(50)
  })

  test('get_merchant_details with query', async () => {
    const result = await client.callTool('get_merchant_details', { merchant_id: 'amazon' })
    expect(result.content[0].type).toBe('text')
    // May return "not found" but should not throw
    expect(result.content[0].text).toBeDefined()
  })
})

// ── Sandbox tools (with key) ────────────────────────────────────────────

describeIfKey('Happy Path: Sandbox Tools', () => {
  let client: McpTestClient
  const run = testId('hp')

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, `happy-sandbox-${run}`)
    await client.initialize()
  })

  afterAll(() => client.close())

  // ── Purchase tools ──

  // ⚠️ THIS ASSERTED A REFUSAL THAT OUTLIVED ITS REASON — SHAT-2611. The client refused
  // request_purchase under a sandbox key, citing "/v1/purchases is NOT sandbox-gated on the
  // backend". SHAT-2373 changed exactly that: the endpoint serves sandbox keys deliberately, the
  // environment is stamped from the KEY, and the money-movers resolve to sandbox implementations.
  //
  // What is asserted now is the property that replaced it: the call REACHES the server, and it is
  // not refused by us. Whether it succeeds depends on the sandbox account this suite runs against,
  // so the assertion is about the refusal being gone, not about a particular outcome.
  test('request_purchase is no longer refused by the client under a sandbox key', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: 'amazon.com',
      amount: 15.00,
      currency: 'EUR',
      description: `E2E happy path purchase ${run}`,
      idempotency_key: testId('idem'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).not.toContain('sandbox_key_purchase_blocked')
    // And the old escape hatch must not survive anywhere: it pushed the caller toward real money.
    expect(result.content[0].text).not.toMatch(/run with a live key/i)
  })

  test('get_purchase_status with non-existent ID', async () => {
    const result = await client.callTool('get_purchase_status', {
      purchase_id: testId('fake-purchase'),
    })
    expect(result.content[0].type).toBe('text')
    // Will return not-found or error, but should not crash
    expect(result.content[0].text).toBeDefined()
  })

  test('cancel_purchase with non-existent ID', async () => {
    const result = await client.callTool('cancel_purchase', {
      purchase_id: testId('fake-purchase'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  // ── Credential tools ──

  test('request_temporary_credentials returns response', async () => {
    const result = await client.callTool('request_temporary_credentials', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      purpose: 'E2E test credential request',
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('get_credential_status with non-existent ID', async () => {
    const result = await client.callTool('get_credential_status', {
      credential_id: testId('fake-cred'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  // ── Onboarding tools ──

  test('register_user_profile creates profile', async () => {
    const email = testEmail()
    const result = await client.callTool('register_user_profile', {
      publisher_user_id: testId('user'),
      user_claims: {
        email,
        name: 'E2E Test User',
      },
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('get_onboarding_status returns status', async () => {
    const result = await client.callTool('get_onboarding_status', {
      publisher_user_id: testId('user'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  // ── Sandbox-specific tools (SHAT-1488: deployed routes only) ──

  test('sandbox_simulate_authorization runs the policy engine', async () => {
    const result = await client.callTool('sandbox_simulate_authorization', {
      agent_id: testId('agent'),
      amount: 15000,
      currency: 'EUR',
      mcc: 5691,
      merchant_name: 'E2E Clothing Co',
      card_number: '4242424242424242',
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('sandbox_complete_onboarding with non-existent user', async () => {
    const result = await client.callTool('sandbox_complete_onboarding', {
      user_id: testId('user'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('sandbox_approve_purchase with non-existent purchase', async () => {
    const result = await client.callTool('sandbox_approve_purchase', {
      purchase_id: testId('fake-purchase'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })
})
