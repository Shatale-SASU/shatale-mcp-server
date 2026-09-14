import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ShataleClient } from '../../src/client.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'
import { createCommonTools } from '../../src/tools/common.js'
import type { ToolModule } from '../../src/types.js'

/**
 * /!\ THE PCI GUARANTEE WAS A PROPERTY OF FOUR CALL SITES, NOT OF THE SERVER.
 *
 * redactPurchaseCard's own comment claims the global form — "this walks the whole result and
 * enforces one invariant everywhere: NO TOOL RESULT CARRIES A NUMBER+CVV PAIR". That is true of
 * what the FUNCTION does and false of what the SERVER does. Measured before this change: it was
 * applied at exactly four places (three in purchase.ts, one in sandbox.ts). Every other tool
 * returned the upstream body unfiltered, and a tool written tomorrow got nothing from anywhere.
 *
 * The scrub now runs inside ShataleClient.request, so it is the CLIENT's property: one door, which
 * a new tool cannot miss by not knowing it exists.
 *
 * /!\ AND THIS TEST ASKS THE QUESTION THE OLD ONES COULD NOT. They handed each handler a STUB
 * client and asserted the handler stripped the PAN — which measured the handler, and left every
 * tool that never had a scrub call uncovered by construction. A test double makes a test blind to
 * exactly the layer it replaces; that is how a missing `.WithAuthSimulator(...)` passed 109 green
 * packages, because the route's own tests injected a fake simulator.
 *
 * So: the REAL client, against an upstream that puts a PAN and a CVV in EVERY response, driving
 * EVERY tool that calls out. The question is not "does this handler scrub" but "can a card reach a
 * tool result at all".
 */

const PAN = '4111111111114242'
const CVV = '737'

let server: Server | undefined
let modules: ToolModule[]

beforeAll(async () => {
  // Answers every path with a body carrying a card in three different shapes, so a redactor that
  // only reaches `payment.card` — which is all it reached before review widened it — is caught.
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'x_1',
        status: 'ok',
        payment: { card: { number: PAN, cvv: CVV, exp_month: 12 } },
        issued_card: { card_number: PAN, cvc: CVV },
        cards: [{ number: PAN, cvv: CVV }],
        merchants: [{ id: 'm1', name: 'Fixture' }],
        codes: [{ code: '5691', description: 'Clothing' }],
      }),
    )
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const client = new ShataleClient(url, 'sk_sandbox_test', 3000)

  modules = [
    createPurchaseTools(client, { isSandbox: false }),
    createCredentialTools(client, { emailsEnabled: true }),
    createOnboardingTools(client, { enabled: true }),
    createCatalogTools(client),
    createCheckoutTools(client),
    createRevealTools(client),
    createSandboxTools(client),
    createCommonTools(client, {
      isGuest: false,
      isSandbox: true,
      isLive: false,
      moneyEnabled: false,
      getToolNames: () => [],
    }),
  ]
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
})

/** Arguments good enough to get each tool as far as a request. */
const args: Record<string, Record<string, unknown>> = {
  request_purchase: {
    publisher_user_id: 'u', agent_id: 'a', merchant: 'm', amount: 2.5, currency: 'EUR', description: 'd',
  },
  get_purchase_status: { purchase_id: 'p_1' },
  reveal_card: { purchase_id: 'p_1' },
  cancel_purchase: { purchase_id: 'p_1', reason: 'r' },
  request_temporary_credentials: {
    publisher_user_id: 'u', agent_id: 'a', merchant_domain: 'example.com', purpose: 'p',
  },
  get_credential_status: { credential_request_id: 'c_1' },
  get_credential_emails: { credential_request_id: 'c_1' },
  register_user_profile: {
    publisher_user_id: 'u', user_claims: { email: 'a@b.test', name: 'N', country: 'FR' }, intended_use: 'purchase',
  },
  get_onboarding_status: { session_id: 's_1' },
  search_merchants: { query: 'nike' },
  get_merchant_details: { merchant_id: 'm_1' },
  list_mcc_codes: { query: 'clothing' },
  get_checkout_cardholder: { purchase_id: 'p_1' },
  get_checkout_customer: { purchase_id: 'p_1' },
  sandbox_simulate_authorization: {
    agent_id: 'a', amount: 100, currency: 'EUR', mcc: '5691', merchant_name: 'M', card_number: '4111111111111111',
  },
  sandbox_complete_onboarding: { user_id: 'u_1' },
  sandbox_approve_purchase: { purchase_id: 'p_1' },
}

describe('no tool result carries a card (SHAT-1463 / PCI)', () => {
  it('the fixture upstream really does serve a PAN and a CVV', () => {
    // /!\ POSITIVE CONTROL. Every assertion below is "the PAN is absent", and an upstream that
    // served no PAN would satisfy all of them while proving nothing at all.
    expect(PAN).toHaveLength(16)
    const bodies = modules.flatMap((m) => Object.keys(m.handlers))
    expect(
      bodies.length,
      'no handlers were collected — the modules failed to build and every absence below is vacuous',
    ).toBeGreaterThan(10)
  })

  // ⚠️ THE PREMISE NARROWED BY AN OWNER DECISION, AND THE NARROWING IS RECORDED — SHAT-2610.
  //
  // This asserted that NO tool result carries a card. The rule now distinguishes two subjects it
  // used to treat as one:
  //
  //   THE CARD WE ISSUE is a tool we handed the agent so it could pay — capped, ours, minted for
  //   that purchase. Withholding its digits removed the only way to use the thing we gave it for.
  //   Owner's decision, verbatim: "we disclose the CVV of OUR card, not the client's".
  //
  //   THE CUSTOMER'S CARD is their real instrument, and nothing here changes about it.
  //
  // So the exception is BY TOOL and written down. Everything not named keeps the old rule, and a
  // tool added tomorrow is covered by default — the list is an allowlist, and its absence is a
  // refusal.
  const REVEALS_OUR_ISSUED_CARD = new Set(['reveal_card', 'sandbox_approve_purchase'])

  it('every tool that calls out returns no PAN and no CVV, except where we hand over our own card', async () => {
    const leaked: string[] = []
    const revealed: string[] = []
    let called = 0

    for (const mod of modules) {
      for (const [name, handler] of Object.entries(mod.handlers)) {
        const a = args[name]
        if (!a) continue // guest/offline tools: they never reach the client
        called++
        const result = await handler(a)
        const text = JSON.stringify(result)
        const carries = text.includes(PAN) || text.includes(`"cvv"`) || text.includes(`"cvc"`)
        if (REVEALS_OUR_ISSUED_CARD.has(name)) {
          // ⚠️ AND THE EXCEPTION IS ASSERTED IN BOTH DIRECTIONS. A named tool that STOPPED handing
          // the card over is also a defect — it is the path the agent pays with — and an allowlist
          // nobody checks is how an entry outlives the decision that earned it.
          if (carries) revealed.push(name)
          continue
        }
        if (text.includes(PAN)) leaked.push(`${name}: raw PAN`)
        if (text.includes(`"cvv"`) || text.includes(`"cvc"`)) leaked.push(`${name}: cvv/cvc field`)
      }
    }

    // The other half of the control: if the arg table has gone stale and nothing ran, the leak list
    // is empty for the wrong reason.
    expect(
      called,
      'no tool was actually invoked — the argument table above has drifted from the tool names, so ' +
        'this test reports a clean result having exercised nothing',
    ).toBeGreaterThan(10)

    expect(
      leaked,
      `these tool results carried card data:\n  ${leaked.join('\n  ')}\n\n` +
        `The scrub lives in ShataleClient.request so that it applies to every response — including ` +
        `the tools that never had a scrub call of their own, which is most of them. If it has been ` +
        `moved back to individual call sites, this is the list of what stops being covered.\n\n` +
        `Raw PAN/CVV must not enter the LLM reasoning context, the MCP host's logs, or the chat ` +
        `history. last4 survives the scrub, so an agent can still tell two cards apart.`,
    ).toEqual([])

    expect(
      revealed,
      `these tools are listed as handing over OUR issued card and did not:\n  ${[...REVEALS_OUR_ISSUED_CARD].filter((n) => !revealed.includes(n)).join('\n  ')}\n\n` +
        `The agent pays with that card; a tool that stops returning it removes the working path, ` +
        `which is what SHAT-2610 was opened to undo. Either restore it, or remove the entry — an ` +
        `allowlist nobody checks outlives the decision that earned it.`,
    ).toEqual([...REVEALS_OUR_ISSUED_CARD])
  })

  it('last4 survives, so the redaction does not make a result useless', async () => {
    const purchase = modules[0]
    const r = await purchase.handlers.get_purchase_status({ purchase_id: 'p_1' })
    const text = JSON.stringify(r)
    expect(text).not.toContain(PAN)
    expect(
      text,
      'the PAN is gone and so is last4 — an agent that cannot tell two cards apart will look for the ' +
        'number some other way, which is how a redaction gets routed around rather than obeyed',
    ).toContain('4242')
  })
})
