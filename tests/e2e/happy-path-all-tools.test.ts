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

  test('request_purchase creates a purchase', async () => {
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
    // Should contain purchase info or onboarding_required status
    expect(result.content[0].text).toBeDefined()
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

  // ── Sandbox-specific tools ──

  test('sandbox_complete_onboarding with non-existent user', async () => {
    const result = await client.callTool('sandbox_complete_onboarding', {
      publisher_user_id: testId('user'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('sandbox_approve_request with non-existent purchase', async () => {
    const result = await client.callTool('sandbox_approve_request', {
      purchase_id: testId('fake-purchase'),
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('sandbox_decline_request with non-existent purchase', async () => {
    const result = await client.callTool('sandbox_decline_request', {
      purchase_id: testId('fake-purchase'),
      reason: 'E2E test decline',
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })

  test('sandbox_reset returns response', async () => {
    const result = await client.callTool('sandbox_reset', {})
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBeDefined()
  })
})
