import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
// @ts-expect-error — plain ESM shared with scripts/, no types alongside it
import { MODES } from '../../scripts/lib/serverRoster.mjs'

/**
 * SHAT-8734 — EVERY TOOL CARRIES ITS APPROVED PUBLIC SUMMARY, BYTE FOR BYTE.
 *
 * The descriptions in this package are written for the MODEL and explain mechanics. Listings people
 * read (shatale.com/mcp, client catalogs) need a short public line instead. The lines are Voland's, from
 * the SHAT-8734 comments of 21.11.2026 (the set; line 16 replaced by the later approval), and they are
 * served as the MCP tool `title`.
 *
 * Copied here by name rather than read from the sources, and asked of the RUNNING SERVER in every mode,
 * as tests/harness/toolRoster.ts explains: a guard that reads the same table the code reads agrees with
 * any edit to it.
 */
const APPROVED: Record<string, string> = {
  explain_shatale: 'Introduces the Shatale MCP server and what it can do.',
  simulate_purchase_flow: 'Walks through a purchase end to end without charging anything.',
  generate_policy_template: 'Creates and validates a spending-policy template.',
  list_capabilities: 'Lists the tools available in the current mode.',
  list_mcc_codes: 'Looks up merchant category (MCC) codes.',
  search_merchants: 'Searches the merchant catalog.',
  get_merchant_details: 'Returns details about a merchant.',
  request_purchase: 'Starts a purchase request for approval.',
  get_purchase_status: 'Returns the status of a purchase.',
  await_purchase_approval: 'Waits for the person to approve or decline a purchase.',
  cancel_purchase: 'Cancels a purchase request.',
  request_temporary_credentials: 'Requests temporary sign-in details for a store.',
  get_credential_status: 'Returns the status of a temporary sign-in request.',
  get_credential_emails: 'Retrieves messages sent to the temporary store address.',
  sandbox_simulate_authorization: 'Runs a policy check in the sandbox with no effect.',
  sandbox_create_user: 'Creates a sandbox test user that is allowed to buy.',
  sandbox_complete_onboarding: 'Marks a sandbox test user as ready.',
  sandbox_approve_purchase: "Approves a purchase on the person's behalf in the sandbox.",
  get_checkout_cardholder: 'Provides the cardholder fields needed to complete checkout.',
  get_checkout_customer: 'Provides the customer details needed for a checkout form.',
  get_shipping_address: 'Provides the shipping address for an order.',
  reveal_card: 'Reveals the purchase card so the payment can be completed.',
}

type Listed = { name: string; title?: unknown }

const listed: Array<{ mode: string; tool: Listed }> = []

describe('SHAT-8734: every tool carries its approved public summary', () => {
  const clients: McpTestClient[] = []

  beforeAll(async () => {
    for (const [id, , env] of MODES as Array<[string, string, Record<string, string>]>) {
      const c = new McpTestClient({ SHATALE_API_URL: 'http://127.0.0.1:9', ...env }, `summary-${id}`)
      clients.push(c)
      await c.initialize()
      const res = await c.send('tools/list', {})
      const tools = res?.result?.tools as Listed[] | undefined
      if (!tools || tools.length === 0) throw new Error(`mode "${id}" advertised no tools — nothing was measured`)
      for (const tool of tools) listed.push({ mode: id, tool })
    }
  }, 60_000)

  afterAll(() => {
    for (const c of clients) c.close()
  })

  it('the approved set and the roster the server offers are the same names', () => {
    const roster = [...new Set(listed.map((l) => l.tool.name))].sort()
    // Positive control: the reader sees the roster it judges (22 tools when written).
    expect(roster.length).toBeGreaterThanOrEqual(20)
    expect(roster, 'a tool without an approved summary, or a summary for a tool that is gone').toEqual(
      Object.keys(APPROVED).sort(),
    )
  })

  it('each tool, in every mode that offers it, carries exactly its approved summary', () => {
    const wrong = listed
      .filter(({ tool }) => tool.title !== APPROVED[tool.name])
      .map(({ mode, tool }) => `${mode}/${tool.name}: ${JSON.stringify(tool.title)}`)
    expect(wrong).toEqual([])
  })

  it('no two tools share a summary (a copied line would describe one of them falsely)', () => {
    const values = Object.values(APPROVED)
    expect(new Set(values).size).toBe(values.length)
  })
})
