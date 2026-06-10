import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { testId, testEmail } from '../harness/testIds'

const TEST_KEY = process.env.SHATALE_TEST_KEY
const describeIfKey = TEST_KEY ? describe : describe.skip

describeIfKey('Sandbox Mode (with API key)', () => {
  let client: McpTestClient
  const runId = testId('sandbox')

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, runId)
    await client.initialize()
  })

  afterAll(() => client.close())

  test('lists all 17 tools in sandbox mode', async () => {
    const tools = await client.listTools()
    expect(tools).toHaveLength(17)

    // Guest tools
    expect(tools).toContain('explain_shatale')
    expect(tools).toContain('simulate_purchase_flow')
    expect(tools).toContain('generate_policy_template')

    // Common tools
    expect(tools).toContain('list_capabilities')
    expect(tools).toContain('list_mcc_codes')

    // Catalog tools
    expect(tools).toContain('search_merchants')
    expect(tools).toContain('get_merchant_details')

    // Purchase tools (request_purchase is present but guarded under sandbox keys)
    expect(tools).toContain('request_purchase')
    expect(tools).toContain('get_purchase_status')
    expect(tools).toContain('cancel_purchase')

    // Credential tools
    expect(tools).toContain('request_temporary_credentials')
    expect(tools).toContain('get_credential_status')

    // Onboarding tools
    expect(tools).toContain('register_user_profile')
    expect(tools).toContain('get_onboarding_status')

    // Sandbox tools (SHAT-1488: deployed routes only)
    expect(tools).toContain('sandbox_simulate_authorization')
    expect(tools).toContain('sandbox_complete_onboarding')
    expect(tools).toContain('sandbox_approve_purchase')

    // SHAT-1488: phantom tools removed
    expect(tools).not.toContain('sandbox_create_test_user')
    expect(tools).not.toContain('sandbox_decline_request')
    expect(tools).not.toContain('sandbox_reset')
    expect(tools).not.toContain('sandbox_approve_request')
  })

  test('list_capabilities shows sandbox mode', async () => {
    const result = await client.callTool('list_capabilities')
    expect(result.content[0].text).toContain('sandbox')
    expect(result.content[0].text).toContain('request_purchase')
  })

  test('search_merchants returns results', async () => {
    const result = await client.callTool('search_merchants', { query: 'amazon' })
    expect(result.content[0].text).toBeDefined()
  })

  test('guest tools still work in sandbox mode', async () => {
    const result = await client.callTool('explain_shatale')
    expect(result.content[0].text).toContain('Shatale')
  })

  test('sandbox_simulate_authorization runs the policy engine (side-effect-free)', async () => {
    const result = await client.callTool('sandbox_simulate_authorization', {
      agent_id: testId('agent'),
      amount: 15000,
      currency: 'EUR',
      mcc: 5691,
      merchant_name: 'E2E Clothing Co',
      card_number: '4242424242424242',
    })
    // Should succeed or return a meaningful response (not crash)
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')
  })

  test('request_purchase is blocked under a sandbox key', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: 'amazon.com',
      amount: 15.0,
      currency: 'EUR',
      description: 'Should be blocked under sandbox key',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('sandbox_key_purchase_blocked')
  })
})
