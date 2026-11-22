import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
// @ts-expect-error — plain ESM shared with scripts/, no types alongside it
import { MODES } from '../../scripts/lib/serverRoster.mjs'

/**
 * SHAT-8729 — readOnlyHint: true ONLY ON THE APPROVED TOOLS, NEVER ON ANYTHING ELSE.
 *
 * 🔴 WHY THIS IS A MONEY-AND-SECRETS RULE AND NOT A COSMETIC ONE. A client that trusts the server less
 * (Hermes with `trust: untrusted`) asks the person before every call EXCEPT the tools marked
 * readOnlyHint: true. A hint on reveal_card removes the button in front of the card number; a hint on
 * the credential tools removes it in front of a store's email and password. So the rule is:
 * readOnlyHint: true only if the tool changes nothing AND its answer carries no card number, secret,
 * personal data or credentials.
 *
 * The lists below are Voland's classification of 21.11.2026 (SHAT-8729), copied here BY NAME rather
 * than read from the sources: a guard that reads the same table the code reads agrees with any edit
 * to it. They are asked of the RUNNING SERVER in every mode, as tests/harness/toolRoster.ts explains.
 *
 * The two CONDITIONAL tools carry no hint. The classification allows one only once their answer is
 * shown to carry nothing of the above, and GET /v1/purchases/{id} — which both read — can carry
 * approval_url and onboarding_url (links that act for the person) and the card's last4
 * (shatale-api apps/api/api/v1/purchases.go, measured 21.11.2026). Until that changes, omitted.
 */
const APPROVED_READ_ONLY = [
  'explain_shatale',
  'generate_policy_template',
  'get_merchant_details',
  'list_capabilities',
  'list_mcc_codes',
  'sandbox_simulate_authorization',
  'search_merchants',
  'simulate_purchase_flow',
]

const CONDITIONAL_OMITTED = ['await_purchase_approval', 'get_purchase_status']

const NEVER = [
  'cancel_purchase',
  'get_checkout_cardholder',
  'get_checkout_customer',
  'get_credential_emails',
  'get_credential_status',
  'get_shipping_address',
  'request_purchase',
  'request_temporary_credentials',
  'reveal_card',
  'sandbox_approve_purchase',
  'sandbox_complete_onboarding',
  'sandbox_create_user',
]

type Listed = { name: string; annotations?: { readOnlyHint?: unknown } }

/** mode id -> the tools that mode advertises, as full objects. */
const byMode = new Map<string, Listed[]>()

describe('SHAT-8729: readOnlyHint is set only on the approved tools', () => {
  const clients: McpTestClient[] = []

  beforeAll(async () => {
    for (const [id, , env] of MODES as Array<[string, string, Record<string, string>]>) {
      const c = new McpTestClient({ SHATALE_API_URL: 'http://127.0.0.1:9', ...env }, `read-only-hint-${id}`)
      clients.push(c)
      await c.initialize()
      const res = await c.send('tools/list', {})
      const tools = res?.result?.tools as Listed[] | undefined
      if (!tools || tools.length === 0) throw new Error(`mode "${id}" advertised no tools — nothing was measured`)
      byMode.set(id, tools)
    }
  }, 60_000)

  afterAll(() => {
    for (const c of clients) c.close()
  })

  const all = () => [...byMode.values()].flat()
  const hinted = () => [...new Set(all().filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name))].sort()

  it('the three lists do not overlap and are each sorted (a name in two lists would be judged twice)', () => {
    const lists = [APPROVED_READ_ONLY, CONDITIONAL_OMITTED, NEVER]
    for (const l of lists) expect(l).toEqual([...l].sort())
    const seen = lists.flat()
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('every tool the server offers, in any mode, is classified — a new tool must be classified first', () => {
    const classified = new Set([...APPROVED_READ_ONLY, ...CONDITIONAL_OMITTED, ...NEVER])
    const roster = [...new Set(all().map((t) => t.name))].sort()
    // Positive control: the reader sees the roster it is judging (22 tools when written).
    expect(roster.length).toBeGreaterThanOrEqual(20)
    expect(roster.filter((n) => !classified.has(n)), 'tools with no readOnlyHint classification').toEqual([])
  })

  it('the set of tools with readOnlyHint: true is exactly the approved list', () => {
    // Both directions: a hint outside the list is the danger; a missing one on the list means the reader
    // is not seeing the field at all — the positive control that keeps the NEVER check below honest.
    expect(hinted()).toEqual(APPROVED_READ_ONLY)
  })

  for (const name of [...NEVER, ...CONDITIONAL_OMITTED]) {
    it(`${name} never carries readOnlyHint: true`, () => {
      const offers = all().filter((t) => t.name === name)
      expect(offers.length, `${name} was not offered in any mode — nothing measured`).toBeGreaterThan(0)
      for (const t of offers) expect(t.annotations?.readOnlyHint, name).not.toBe(true)
    })
  }

  it('a tool carries the same hint in every mode that offers it', () => {
    const seen = new Map<string, unknown>()
    for (const [mode, tools] of byMode) {
      for (const t of tools) {
        const v = t.annotations?.readOnlyHint
        if (seen.has(t.name)) expect(v, `${t.name} in mode ${mode}`).toBe(seen.get(t.name))
        else seen.set(t.name, v)
      }
    }
  })
})
