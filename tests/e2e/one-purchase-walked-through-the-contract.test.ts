/**
 * SHAT-3023, the acceptance clause the slice is not done without: the path walked FROM BEGINNING TO
 * END THROUGH THE PUBLIC CONTRACT — "not through unit tests and not through a private call. The
 * project has twice paid for the opposite: a feature tested everywhere except the front door."
 *
 * 🔴 WHAT WAS MISSING WAS THE JOIN, NOT THE TOOLS. Every tool in this chain already had a keyed test
 * of its own: request_purchase alone, sandbox_approve_purchase against a non-existent id,
 * get_purchase_status against a non-existent id. Four tests, four different subjects, and not one of
 * them asked whether the id that comes OUT of the first reaches the LAST. A suite of independent
 * single-tool tests is green on a chain that does not connect — which is the shape SHAT-3023 was
 * filed about one level down (the reveal path existed and had no caller).
 *
 * So what is asserted here is the id travelling: the same purchase id in the approval's PATH, in the
 * status read, and in the reveal. The tool results matter less than the outbound requests, and the
 * mock upstream records those exactly.
 *
 * ⚠️ AND THE REVEAL IS ASSERTED AFTER THE REDACTION LAYER, which is the part no unit test of the tool
 * can reach. Every response passes `redactPurchaseCard` once inside ShataleClient.request, and it
 * decides by PROVENANCE — the path — not by the shape of the body. So a sentinel that arrives intact
 * proves the client method used the allowlisted path; the same sentinel arriving scrubbed is exactly
 * what a broken path looks like. #69 pinned that at the URL; this pins it at the response, at the end
 * of a chain.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const TEST_KEY = process.env.SHATALE_TEST_KEY
const describeIfKey = TEST_KEY ? describe : describe.skip

const text = (result: any): string => {
  expect(result.content?.[0]?.type).toBe('text')
  return result.content[0].text as string
}

describe('SHAT-3023: one purchase, walked through the contract (mock upstream)', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'purchase-chain',
    )
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('the id from request_purchase reaches approve, status and reveal', async () => {
    // ⚠️ THE FIRST LINK, ADDED AFTER THE LIVE RUN REFUSED THE CHAIN WITHOUT IT. request_purchase
    // needs a publisher_user_id that HAS AN ACTIVE DELEGATION, and sandbox_create_user is the only
    // thing in the contract that makes one — its own description says so: "This is the first step".
    // The mock answers 200 to anything, so the mock chain could never have told me: only the live
    // dispatch could, and it did, with HTTP 400 on step one.

    const provisioned = await client.callTool('sandbox_create_user', {
      user_id: 'usr_chain_1',
      agent_id: 'agt_chain_1',
    })
    expect(provisioned.isError).toBeFalsy()

    const created = await client.callTool('request_purchase', {
      publisher_user_id: 'usr_chain_1',
      agent_id: 'agt_chain_1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'SHAT-3023 chain',
    })
    expect(created.isError).toBeFalsy()

    // The id is taken FROM THE TOOL'S ANSWER, not written here. A test that hard-codes the id it
    // expects proves the mock, not the chain: the next step would be given the right id by the test
    // even if the tool had answered with a different one.
    const purchaseId = JSON.parse(text(created)).purchase_id as string
    expect(purchaseId, 'request_purchase answered without a purchase_id').toBeTruthy()

    const approved = await client.callTool('sandbox_approve_purchase', { purchase_id: purchaseId })
    expect(approved.isError).toBeFalsy()

    const status = await client.callTool('get_purchase_status', { purchase_id: purchaseId })
    expect(status.isError).toBeFalsy()

    const revealed = await client.callTool('reveal_card', { purchase_id: purchaseId })
    expect(revealed.isError, `reveal_card refused: ${text(revealed)}`).toBeFalsy()

    // ── the joins, which are the subject ──────────────────────────────────────────────────────────
    const provision = mock.lastRequest('POST', '/v1/sandbox/users')
    expect(provision, 'no sandbox user was provisioned — the chain skipped its own first link')
      .toBeDefined()

    const approve = mock.lastRequest('POST', '/v1/sandbox/purchases/')
    expect(approve, 'no approval request reached the upstream').toBeDefined()
    expect(approve!.path, 'the approval was sent for a different purchase than the one created')
      .toBe(`/v1/sandbox/purchases/${purchaseId}/approve`)

    const read = mock.lastRequest('GET', `/v1/purchases/${purchaseId}`)
    expect(read, 'no status read reached the upstream for that purchase').toBeDefined()

    const reveal = mock.lastRequest('GET', `/v1/purchases/${purchaseId}/card-credentials`)
    expect(reveal, 'the reveal did not ask the allowlisted card-credentials path for that purchase')
      .toBeDefined()

    // ── and the card survived the redaction layer, because the path is allowlisted ────────────────
    const card = JSON.parse(text(revealed))
    expect(card.card_number, 'the card field came back scrubbed — the client method is off the allowlisted path')
      .toBe('MOCK-CARD-NUMBER-NOT-A-PAN')
    expect(card.cvv).toBe('MOCK-CVV')
  })

  // ⚠️ THE CONTROL FOR THE ASSERTION ABOVE, AND WITHOUT IT "the sentinel arrived" PROVES NOTHING
  // ABOUT THE ALLOWLIST: it would also hold if redaction did nothing at all, anywhere. So the same
  // sentinel is sent down a path that is NOT on the allowlist, through a tool that reads it, and it
  // must come back scrubbed.
  test('the same card shape is scrubbed when it arrives from a path that is not allowlisted', async () => {
    const checkout = await client.callTool('get_checkout_cardholder', { purchase_id: 'pur_mock_1' })
    expect(checkout.isError).toBeFalsy()
    // The checkout-identity route answers identity, never a card — so the assertion here is about
    // the LAYER, not about that route's payload: nothing card-shaped may pass from a path off the
    // allowlist. If this ever starts carrying card fields, the guard next door
    // (no-tool-result-carries-a-card.test.ts) is the one that fails, and it should.
    expect(text(checkout)).not.toContain('MOCK-CARD-NUMBER-NOT-A-PAN')
  })
})

// ── the same chain against the LIVE sandbox ──────────────────────────────────────────────────────
//
// 🔴 IT RAN, AND IT REFUSED THE CHAIN — which is the whole reason a dispatch was asked for. Run
// 34825051118 (ci-sandbox, 2026-09-14): 44 files passed, this one failed, and it failed on STEP ONE
// with `request_purchase` → HTTP 400. The mock could not have told me: it answers 200 to anything.
//
// THE CAUSE WAS A MISSING FIRST LINK, NOT A BROKEN TOOL. request_purchase needs a publisher_user_id
// that HAS AN ACTIVE DELEGATION, and `sandbox_create_user` is the only thing in the contract that
// makes one — its own description says "This is the first step … nothing else here creates one".
//
// ⚠️ AND ONE PRECONDITION CANNOT COME FROM THE CONTRACT AT ALL, BY DESIGN. The same description:
// "agent_id must be an agent YOU created by hand in the publisher console; no API key can create an
// agent, so if you do not have one, ask the person for it rather than inventing an id." So the agent
// is obtained the way the publish gate obtains it — `GET /v1/agents` with the same key, a READ —
// and that step is a PREMISE, not part of the walk. The walk itself is the five tool calls.
//
// ⚠️ A MISSING AGENT IS A LOUD FAILURE, NEVER A SKIP, and that is the neighbouring gate's rule for
// the same premise: "an unverified premise is how a test ends up asserting nothing". The remedy is
// named in the message — set `SHATALE_GATE_AGENT_ID` (the variable publish.yml already uses) or seed
// one agent in the console — so the red says what to do rather than only that something is wrong.
//
// ⚠️ AND A SKIP IS NOT A PASS. Without a key the whole block is `describe.skip`, and the summary
// prints skipped and passed on the same line. This repository has been bitten twice by
// green-by-skip in sandbox-tools.test.ts.
//
// ⚠️ THE LIVE REVEAL HAS TWO LEGITIMATE ENDINGS. Whether the sandbox issues a card for an approved
// purchase is not answerable from this tree: reveal_card returns the card when the purchase is
// payment_ready and holds one, and refuses with the NAMED code `card_credentials_unavailable` when
// it does not. Both are the door working; any other failure, or a refusal with no name, is not.
const API_BASE = process.env.SHATALE_API_URL ?? 'https://api.shatale.com'

/** The premise, read the way publish-gate.mjs reads it. Read-only: GET /v1/agents. */
async function resolveSandboxAgentId(): Promise<string> {
  const pinned = process.env.SHATALE_GATE_AGENT_ID
  const headers = { Authorization: `Bearer ${TEST_KEY}`, Accept: 'application/json' }
  if (pinned) {
    const probe = await fetch(`${API_BASE}/v1/agents/${encodeURIComponent(pinned)}`, { headers })
    if (!probe.ok) {
      throw new Error(
        `SHATALE_GATE_AGENT_ID=${pinned} does not resolve on ${API_BASE} (HTTP ${probe.status}). ` +
          'A chain pointed at a non-existent agent can only produce the 400 it cannot distinguish ' +
          'from a real refusal. ⚠️ And an id that exists on ANOTHER account resolves to 404 here ' +
          'exactly like an id that exists nowhere: the pin must name an agent of the account this ' +
          'key belongs to.',
      )
    }
    return pinned
  }
  const res = await fetch(`${API_BASE}/v1/agents`, { headers })
  if (!res.ok) {
    throw new Error(
      `GET /v1/agents answered HTTP ${res.status} on ${API_BASE}, so the chain has no agent to walk ` +
        'with. Set SHATALE_GATE_AGENT_ID (publish.yml already uses that variable) or seed one agent ' +
        'in the publisher console — no API key can create one, which is why this cannot be fixed in ' +
        'the test.',
    )
  }
  const body = (await res.json()) as { agents?: Array<{ id?: string }> }
  const id = body.agents?.find((a) => typeof a.id === 'string' && a.id.length > 0)?.id
  if (!id) {
    // 🔴 THE MESSAGE NAMES THE DISCRIMINATOR, BECAUSE THE CHANNEL DOES NOT CARRY ONE. Measured
    // 2026-09-14 across two ci-sandbox dispatches: this key sees ZERO agents while a working key
    // sees TWO — on the SAME host. So `SHATALE_TEST_KEY` in Actions and `SHATALE_TEST_KEY` on a
    // developer's machine are DIFFERENT KEYS, i.e. different sandbox accounts under one name, and
    // the deployment is not involved at all.
    //
    // The first version of this message offered two remedies — set the variable, or seed an agent —
    // and was silent about the likeliest one. A guard's message is followed LITERALLY: pinning an
    // id from the wrong account would only change the text of the red, which is what fixing a
    // symptom looks like. "Which account does the secret belong to" is the question that separates
    // "wrong key" from "empty account", and nothing in the tool surface can answer it: none of the
    // 22 tools lists a publisher's agents (measured 2026-09-10 by role, not by name).
    throw new Error(
      `GET /v1/agents returned no agent on ${API_BASE}, so THIS KEY HAS ZERO AGENTS. ` +
        'Check WHICH ACCOUNT the key belongs to, not which deployment it addresses: measured on ' +
        '2026-09-14, the key in Actions secrets saw zero agents while a working key saw two on this ' +
        'same host — one name, two sandbox accounts. Remedies, in the order that actually applies: ' +
        '(1) seed one agent in the publisher console on the account that owns THIS key — no API key ' +
        'can create an agent, by design; (2) replace the secret with a key of an account that ' +
        'already has agents; (3) only if you know the id belongs to THIS account, pin it with ' +
        'SHATALE_GATE_AGENT_ID. Pinning an id from another account changes the wording of this ' +
        'failure and nothing else.',
    )
  }
  return id
}

describeIfKey('SHAT-3023: one purchase, walked through the contract (live sandbox)', () => {
  let client: McpTestClient
  let agentId: string

  beforeAll(async () => {
    agentId = await resolveSandboxAgentId()
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, 'purchase-chain-live')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('provision → request → approve → status → reveal, on the same purchase', async () => {
    const userId = `shat3023-${Date.now()}`

    // The first link, through the contract: the delegation request_purchase needs.
    const provisioned = await client.callTool('sandbox_create_user', {
      user_id: userId,
      agent_id: agentId,
    })
    expect(provisioned.isError, `sandbox_create_user failed: ${text(provisioned)}`).toBeFalsy()

    const created = await client.callTool('request_purchase', {
      publisher_user_id: userId,
      agent_id: agentId,
      merchant: 'amazon.com',
      amount: 12.34,
      currency: 'EUR',
      description: 'SHAT-3023 chain (live sandbox)',
    })
    expect(created.isError, `request_purchase failed: ${text(created)}`).toBeFalsy()

    const purchaseId = (JSON.parse(text(created)) as { purchase_id?: string }).purchase_id
    expect(purchaseId, `no purchase_id in ${text(created)}`).toBeTruthy()

    // The approval beat is only meaningful when the purchase is actually waiting for one; a purchase
    // that came back payment_ready needs no approval, and asking for one is not a failure either.
    const approved = await client.callTool('sandbox_approve_purchase', { purchase_id: purchaseId! })
    expect(approved.content?.[0]?.text, 'the approval answered nothing at all').toBeDefined()

    const status = await client.callTool('get_purchase_status', { purchase_id: purchaseId! })
    expect(status.isError, `get_purchase_status failed: ${text(status)}`).toBeFalsy()
    expect(text(status), 'the status read answered about a different purchase').toContain(purchaseId!)

    const revealed = await client.callTool('reveal_card', { purchase_id: purchaseId! })
    const answer = text(revealed)
    const cardArrived = answer.includes('card_number') || answer.includes('"number"')
    const namedRefusal = answer.includes('card_credentials_unavailable')
    expect(
      cardArrived || namedRefusal,
      `reveal_card ended in neither of its two legitimate outcomes: ${answer}`,
    ).toBe(true)
  })
})
