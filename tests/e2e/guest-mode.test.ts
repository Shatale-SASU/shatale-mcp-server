import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'

describe('Guest Mode (no API key)', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: '' }, 'guest-mode')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('lists only guest + common + catalog tools', async () => {
    const tools = await client.listTools()

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

    // Should NOT have authenticated tools
    expect(tools).not.toContain('request_purchase')
    expect(tools).not.toContain('request_temporary_credentials')
    expect(tools).not.toContain('sandbox_create_test_user')
    expect(tools).not.toContain('sandbox_reset')
  })

  test('guest mode has exactly 7 tools', async () => {
    const tools = await client.listTools()
    expect(tools).toHaveLength(7)
  })

  test('explain_shatale returns text about Shatale', async () => {
    const result = await client.callTool('explain_shatale')
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Shatale')
  })

  test('simulate_purchase_flow returns step-by-step flow', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: 'amazon.com',
      amount: 49.99,
      description: 'headphones',
    })
    expect(result.content[0].text).toContain('Simulated Purchase Flow')
    expect(result.content[0].text).toContain('amazon.com')
  })

  test('simulate_purchase_flow approves a small in-budget purchase', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: 'github.com',
      amount: 25,
      description: 'dev tool subscription',
    })
    const text = result.content[0].text
    expect(text).toContain('"result": "approved"')
    expect(text).toContain('demo_trace_')
    expect(text).toContain('sandbox_equivalent_tools')
  })

  test('simulate_purchase_flow declines a blocked category (gambling)', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: 'casino-royale.com',
      amount: 50,
      description: 'chips',
    })
    const text = result.content[0].text
    expect(text).toContain('"result": "declined"')
    expect(text).toContain('blocked_category')
  })

  test('simulate_purchase_flow declines an amount over the guest cap', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: 'apple.com',
      amount: 5000,
      description: 'a laptop',
    })
    const text = result.content[0].text
    expect(text).toContain('"result": "declined"')
    expect(text).toContain('guest_cap')
  })

  test('simulate_purchase_flow requires approval above the threshold', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: 'apple.com',
      amount: 750,
      description: 'a tablet',
    })
    expect(result.content[0].text).toContain('"result": "requires_approval"')
  })

  test('generate_policy_template returns JSON policy', async () => {
    const result = await client.callTool('generate_policy_template', {
      use_case: 'SaaS subscriptions',
    })
    expect(result.content[0].text).toContain('Spending Policy Template')
    expect(result.content[0].text).toContain('SaaS subscriptions')
  })

  test('generate_policy_template includes a validation block', async () => {
    const result = await client.callTool('generate_policy_template', {
      use_case: 'cloud infrastructure',
      monthly_budget: 8000,
    })
    const text = result.content[0].text
    expect(text).toContain('Validation')
    expect(text).toContain('risk_level')
    expect(text).toContain('recommended_controls')
  })

  test('explain_shatale reports GUEST mode and lists available tools', async () => {
    const result = await client.callTool('explain_shatale')
    const text = result.content[0].text
    expect(text).toContain('Current mode: GUEST')
    expect(text).toContain('simulate_purchase_flow')
    expect(text).toContain('register?ref=mcp')
  })

  test('list_capabilities shows guest mode', async () => {
    const result = await client.callTool('list_capabilities')
    expect(result.content[0].text).toContain('guest')
    expect(result.content[0].text).toContain('explain_shatale')
  })

  test('resources are available', async () => {
    const resources = await client.listResources()
    expect(resources.length).toBeGreaterThan(0)
    const uris = resources.map((r: any) => r.uri)
    expect(uris).toContain('shatale://guides/quickstart')
    expect(uris).toContain('shatale://guides/policies')
    expect(uris).toContain('shatale://guides/verticals')
  })

  test('prompts are available', async () => {
    const prompts = await client.listPrompts()
    expect(prompts.length).toBeGreaterThan(0)
    const names = prompts.map((p: any) => p.name)
    expect(names).toContain('shopping-agent')
    expect(names).toContain('travel-agent')
    expect(names).toContain('policy-designer')
    expect(names).toContain('test-my-setup')
  })

  test('calling unknown tool returns error', async () => {
    const result = await client.callTool('nonexistent_tool')
    expect(result.content[0].text).toContain('Unknown tool')
  })
})
