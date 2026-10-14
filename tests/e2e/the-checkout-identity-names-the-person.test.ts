// SHAT-6105: get_checkout_cardholder and get_checkout_customer carry the person to the API.
//
// shatale-api's CheckoutIdentity reads `publisher_user_id` from the QUERY of
// GET /v1/purchases/{id}/checkout-identity and gates the read with PurchaseBelongsToPerson. An EMPTY
// scope passes that gate without reading the row — so a server that never sends the person turns the
// gate off for every MCP caller, and the buyer's name and email go to anyone holding the publisher key
// and a purchase id. 1.3.0 never sent it (client.ts getCheckoutIdentity took the id alone).
//
// These cases run the BUILT server over stdio against the mock upstream and assert on the WIRE, not
// on the handler: what matters is what the API receives.
//
// Mutant (run by hand when this file was written): delete the `?publisher_user_id=` suffix in
// client.ts getCheckoutIdentity → the first two cases fail ("the person did not reach the API").
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'
import { API_CHECKOUT_IDENTITY } from '../fixtures/api-response-shapes'

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text as string
}

const TOOLS = ['get_checkout_cardholder', 'get_checkout_customer'] as const

describe('SHAT-6105: the checkout identity tools name the person', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'checkout-identity-person',
    )
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('both tools declare publisher_user_id in their schema, still optional', async () => {
    const listed = (await client.send('tools/list')).result
    for (const name of TOOLS) {
      const tool = listed.tools.find((t: { name: string }) => t.name === name)
      expect(tool, `${name} is not on the sandbox roster`).toBeDefined()
      expect(Object.keys(tool.inputSchema.properties)).toContain('publisher_user_id')
      expect(tool.inputSchema.required).toEqual(['purchase_id'])
    }
  })

  for (const [i, name] of TOOLS.entries()) {
    test(`${name}: the person reaches the API as the query parameter the gate reads`, async () => {
      // `+`, `/` and non-ASCII: the value must arrive exactly as passed, encoded once.
      const person = `usr_6105+${i}/Ж`
      const purchase = `pur_6105_person_${i}`
      const res = await client.callTool(name, { purchase_id: purchase, publisher_user_id: person })
      expect(res.isError, `${name} refused: ${text(res)}`).toBeFalsy()
      expect(res._meta?.deprecation, 'a scoped call must not carry the deprecation').toBeUndefined()
      const sent = mock.lastRequest('GET', `/v1/purchases/${purchase}/checkout-identity`)
      expect(sent, 'the call never reached the API').toBeDefined()
      expect(sent!.query, 'the person did not reach the API').toEqual({ publisher_user_id: person })
    })

    test(`${name}: without the person the 1.3.0-shaped call still works, and says it is deprecated`, async () => {
      const purchase = `pur_6105_unscoped_${i}`
      const res = await client.callTool(name, { purchase_id: purchase })
      expect(res.isError, `the 1.3.0-shaped call broke: ${text(res)}`).toBeFalsy()
      expect(res._meta?.deprecation?.code).toBe('checkout_identity_without_person')
      const sent = mock.lastRequest('GET', `/v1/purchases/${purchase}/checkout-identity`)
      expect(sent?.query, 'the unscoped call must carry no query at all').toEqual({})
      expect(client.getStderr()).toContain(`DEPRECATED — ${name} for purchase`)
    })

    test(`${name}: a person that is present but blank is refused before anything is sent`, async () => {
      const purchase = `pur_6105_blank_${i}`
      const res = await client.callTool(name, { purchase_id: purchase, publisher_user_id: '   ' })
      expect(res.isError).toBe(true)
      expect(mock.lastRequest('GET', `/v1/purchases/${purchase}/`), 'a blank person was sent').toBeUndefined()
    })
  }

  test('the identity halves are unchanged by the person', async () => {
    const holder = await client.callTool('get_checkout_cardholder', { purchase_id: 'pur_6105_h', publisher_user_id: 'u1' })
    const buyer = await client.callTool('get_checkout_customer', { purchase_id: 'pur_6105_b', publisher_user_id: 'u1' })
    expect(JSON.parse(text(holder)).billing_identity).toEqual(API_CHECKOUT_IDENTITY.billing_identity)
    expect(JSON.parse(text(buyer)).merchant_customer_identity).toEqual(API_CHECKOUT_IDENTITY.merchant_customer_identity)
  })
})
