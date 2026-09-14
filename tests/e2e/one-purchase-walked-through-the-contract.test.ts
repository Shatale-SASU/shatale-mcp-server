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
    const created = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
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
// 🔴 NOT EXECUTED BY ITS AUTHOR, AND SAID HERE RATHER THAN DISCOVERED LATER. There is no
// SHATALE_TEST_KEY on the machine this was written on, so this block was never run: it is written
// from the tool schemas and the outbound shapes the mock chain proves, and its first real execution
// will be in ci-sandbox.yml (workflow_dispatch) or the nightly run. A test that has not run is not
// evidence — that is the rule this file is trying to satisfy, so it must not be broken by the file
// itself.
//
// ⚠️ AND A SKIP IS NOT A PASS. Without a key this whole block is `describe.skip`, and the summary
// prints skipped and passed on the same line. This repository has been bitten by that twice in
// sandbox-tools.test.ts, where a stale roster count sat green-by-skip through two changes.
//
// ⚠️ THE ASSERTION IS THE CHAIN, AND THE REVEAL HAS TWO LEGITIMATE ENDINGS. Whether the sandbox
// issues a card for an approved purchase is not something this tree can answer — reveal_card returns
// the card when the purchase is payment_ready and holds one, and refuses with the NAMED code
// `card_credentials_unavailable` when it does not. Both are the door working; what would be a defect
// is any OTHER failure, or a refusal with no name. So the outcome is required to be one of the two,
// which is a weaker claim than "a card comes back" and a true one.
describeIfKey('SHAT-3023: one purchase, walked through the contract (live sandbox)', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, 'purchase-chain-live')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('request → approve → status → reveal, on the same purchase', async () => {
    const created = await client.callTool('request_purchase', {
      publisher_user_id: `shat3023-${Date.now()}`,
      agent_id: 'shat3023-agent',
      merchant: 'amazon.com',
      amount: 12.34,
      currency: 'EUR',
      description: 'SHAT-3023 chain (live sandbox)',
    })
    expect(created.isError, `request_purchase failed: ${text(created)}`).toBeFalsy()

    const body = JSON.parse(text(created))
    const purchaseId = body.purchase_id as string
    expect(purchaseId, `no purchase_id in ${text(created)}`).toBeTruthy()

    // The approval beat is only meaningful when the purchase is actually waiting for one; a purchase
    // that came back payment_ready needs no approval and asking for one is not a failure either.
    const approved = await client.callTool('sandbox_approve_purchase', { purchase_id: purchaseId })
    expect(approved.content?.[0]?.text, 'the approval answered nothing at all').toBeDefined()

    const status = await client.callTool('get_purchase_status', { purchase_id: purchaseId })
    expect(status.isError, `get_purchase_status failed: ${text(status)}`).toBeFalsy()
    expect(text(status), 'the status read answered about a different purchase').toContain(purchaseId)

    const revealed = await client.callTool('reveal_card', { purchase_id: purchaseId })
    const answer = text(revealed)
    const cardArrived = answer.includes('card_number') || answer.includes('"number"')
    const namedRefusal = answer.includes('card_credentials_unavailable')
    expect(
      cardArrived || namedRefusal,
      `reveal_card ended in neither of its two legitimate outcomes: ${answer}`,
    ).toBe(true)
  })
})
