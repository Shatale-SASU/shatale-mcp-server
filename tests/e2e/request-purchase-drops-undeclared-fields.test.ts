// SHAT-4116, the half that lives in this server: what request_purchase does with a field its contract
// does not declare. The ticket left it "NOT MEASURED", and its whole severity hung on the answer.
//
// The answer, held here: the field set is decided THREE times — requestPurchaseSchema is a plain
// z.object (no .passthrough(), so zod strips unknown keys), the handler names each field it hands the
// client, and toPurchaseWireBody (client.ts) builds the body key by key. A `purchase_id` the model
// invented does not reach POST /v1/purchases.
//
// Mutants, run by hand when this file was written (14.10.2026):
//   `.passthrough()` on the schema alone           → SURVIVES (the two explicit picks still hold);
//   `...args` in the handler + `...input` in the wire body → this test FAILS.
// So .passthrough() by itself is not the failure this guards; spreading at both later layers is.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

describe('SHAT-4116: request_purchase sends only the fields it declares', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient({ SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url }, 'rp-undeclared')
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('an undeclared purchase_id (and any other stray key) never reaches the API', async () => {
    const res = await client.callTool('request_purchase', {
      publisher_user_id: 'usr_4116',
      agent_id: 'agt_4116',
      merchant: 'amazon.com',
      amount: 12.5,
      currency: 'EUR',
      description: 'stray-field probe',
      purchase_id: 'pur_owned_by_somebody_else',
      status: 'approved',
    })
    expect(res.isError, JSON.stringify(res)).toBeFalsy()
    const sent = mock.lastRequest('POST', '/v1/purchases')
    expect(sent, 'request_purchase never reached the API').toBeDefined()
    const body = sent!.body as Record<string, unknown>
    expect(body.publisher_user_id, 'control: the declared fields did arrive').toBe('usr_4116')
    expect(body).not.toHaveProperty('purchase_id')
    expect(body).not.toHaveProperty('status')
  })
})
