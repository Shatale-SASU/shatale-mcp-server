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

  test('lists the 17 backed tools in sandbox mode (the onboarding pair stays withheld)', async () => {
    const tools = await client.listTools()
    // 17. Two tools are withheld because their flow cannot complete on any deployed backend:
    // the register→status onboarding pair (the session id is never persisted, SHAT-1662).
    // Kept in lockstep with mock-contract.test.ts.
    //
    // This file is key-gated (describe.skip without SHATALE_TEST_KEY), so a stale count
    // here stays green-by-skip and only breaks the first KEYED run — exactly the
    // skipped-but-green trap (#276). It did: the count stayed at 17 when the tools were
    // unadvertised, and the keyless CI that gates PRs never ran this file.
    //
    // ⚠️ AND IT DID IT AGAIN, TWICE OVER, WHICH IS WHY THE WARNING ABOVE IS NOT ENOUGH ON ITS OWN.
    // This assertion sat at 15 across two changes that each moved the roster — get_credential_emails
    // ceasing to be withheld (15 → 16, SHAT-2527) and sandbox_create_user being added (16 → 17,
    // SHAT-2698) — while `not.toContain('get_credential_emails')` below had become the exact
    // opposite of the truth. Neither showed up: keyless CI skips the file, and a skip and a pass are
    // the same line in the summary.
    //
    // The count is reachable WITHOUT a live key, because the roster is decided by the key's PREFIX
    // and the env flags before any request is made (src/tools/common.ts isSandboxKey). Measured with
    // SHATALE_TEST_KEY=sk_sandbox_<anything>: 17, and this assertion failed at 15.
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

    // Credential tools. get_credential_emails is ADVERTISED now: its suppression named a condition
    // — "#361 merged AND deployed" — and both halves have been met, so the flag it hid behind is
    // gone (SHAT-2527). This line asserted `not.toContain` for a release after that became false.
    expect(tools).toContain('request_temporary_credentials')
    expect(tools).toContain('get_credential_status')
    expect(tools).toContain('get_credential_emails')

    // Onboarding tools stay hidden: RegisterUserProfile never persists the session id it
    // returns, so the second step 404s forever (SHAT-1662). Behind SHATALE_ONBOARDING_ENABLED.
    expect(tools).not.toContain('register_user_profile')
    expect(tools).not.toContain('get_onboarding_status')

    // Sandbox tools (SHAT-1488: deployed routes only)
    expect(tools).toContain('sandbox_simulate_authorization')
    expect(tools).toContain('sandbox_create_user')
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

  // ⚠️ THIS TEST ASSERTED THE OPPOSITE UNTIL TODAY, AND NOTHING CAUGHT IT. SHAT-2611 removed the
  // client-side refusal — the backend serves sandbox keys deliberately, stamping the environment
  // from the key — and the unit and mock-contract assertions were inverted with it. This one was
  // missed because it is key-gated: without SHATALE_TEST_KEY the whole suite SKIPS, and a skip is
  // indistinguishable from a pass. It would have failed on the first keyed run, asserting the
  // presence of a refusal that no longer exists.
  //
  // So it now watches the property that replaced it, against the REAL backend rather than a mock:
  // the first call a publisher has to make is not refused by us.
  test('request_purchase is NOT refused under a sandbox key', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: 'amazon.com',
      amount: 15.0,
      currency: 'EUR',
      description: 'Reaches the same contract an outsider uses',
    })
    const text = result.content[0].text

    // Deliberately not asserting success: with a fresh test user the backend may legitimately
    // answer onboarding_required or delegation_required, and pinning one outcome would make this
    // test about the fixture rather than about the refusal. What must be absent is OUR refusal.
    expect(text).not.toContain('sandbox_key_purchase_blocked')
    expect(text).not.toMatch(/run with a live key/i)
    expect(text).not.toMatch(/SHATALE_MONEY_GO/)
  })
})
