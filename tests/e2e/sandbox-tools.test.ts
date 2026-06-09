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

  test('lists all 19 tools in sandbox mode', async () => {
    const tools = await client.listTools()
    expect(tools).toHaveLength(19)

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

    // Purchase tools
    expect(tools).toContain('request_purchase')
    expect(tools).toContain('get_purchase_status')
    expect(tools).toContain('cancel_purchase')

    // Credential tools
    expect(tools).toContain('request_temporary_credentials')
    expect(tools).toContain('get_credential_status')

    // Onboarding tools
    expect(tools).toContain('register_user_profile')
    expect(tools).toContain('get_onboarding_status')

    // Sandbox tools
    expect(tools).toContain('sandbox_create_test_user')
    expect(tools).toContain('sandbox_complete_onboarding')
    expect(tools).toContain('sandbox_approve_request')
    expect(tools).toContain('sandbox_decline_request')
    expect(tools).toContain('sandbox_reset')
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

  test('sandbox_create_test_user with unique email', async () => {
    const email = testEmail()
    const result = await client.callTool('sandbox_create_test_user', { email })
    // Should succeed or return a meaningful response (not crash)
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')
  })
})
