// SHAT-6291: shipping address for agents — requires_shipping on request_purchase, and the read-only
// get_shipping_address tool. Contract source: SHAT-6280 F1 (shatale-api).
//
// These cases run the BUILT server over stdio against a small scripted upstream and assert on the
// WIRE and on what the agent is handed, not on the handlers. The upstream here is local to this file
// because the shared mock answers one fixed body per route, and these cases need to choose the
// status and body (blocked outcome, three different 404s).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpTestClient } from '../harness/mcpClient'

type Seen = { method: string; path: string; query: Record<string, string>; body: unknown }

const ADDRESS = {
  recipient_name: 'Fixture Person',
  company: '',
  line1: '1 Rue Fixture',
  line2: '',
  postal_code: 'FX-000',
  city: 'Fixture City',
  region: '',
  country: 'FR',
  phone: '+330000000000',
  delivery_notes: 'ring twice',
}

const BLOCKED = {
  purchase_id: 'pur_ship_blocked',
  status: 'blocked',
  block_reason: 'shipping_address_required',
  state: 'action_required',
  requirements: [{ type: 'shipping_address', status: 'missing' }],
  next_action: { type: 'open_url', url: 'https://app.example.test/profile' },
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text as string
}

describe('SHAT-6291: shipping address', () => {
  let server: Server
  let url = ''
  const seen: Seen[] = []
  // What the scripted upstream answers next, per route.
  let purchaseAnswer: { status: number; body: unknown } = { status: 200, body: { purchase_id: 'pur_ok', status: 'pending' } }
  let addressAnswer: { status: number; body: unknown } = { status: 200, body: {} }
  let client: McpTestClient

  const last = (method: string, prefix: string): Seen | undefined =>
    [...seen].reverse().find((r) => r.method === method && r.path.startsWith(prefix))

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1')
        const raw = Buffer.concat(chunks).toString()
        seen.push({
          method: req.method ?? 'GET',
          path: u.pathname,
          query: Object.fromEntries(u.searchParams),
          body: raw ? JSON.parse(raw) : undefined,
        })
        const answer = u.pathname.endsWith('/shipping-address') ? addressAnswer : purchaseAnswer
        res.writeHead(answer.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    client = new McpTestClient({ SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: url }, 'shipping-address')
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  beforeEach(() => {
    purchaseAnswer = { status: 200, body: { purchase_id: 'pur_ok', status: 'pending' } }
    addressAnswer = { status: 200, body: {} }
  })

  const base = {
    publisher_user_id: 'usr_6291',
    agent_id: 'agt_6291',
    merchant: 'shop.example',
    amount: 20,
    currency: 'EUR',
    description: 'a parcel',
  }

  describe('request_purchase: requires_shipping', () => {
    test('the schema declares a boolean requires_shipping, optional, and no address field', async () => {
      const tool = (await client.send('tools/list')).result.tools.find((t: { name: string }) => t.name === 'request_purchase')
      const props = tool.inputSchema.properties
      expect(props.requires_shipping.type).toBe('boolean')
      expect(tool.inputSchema.required).not.toContain('requires_shipping')
      for (const k of ['line1', 'line2', 'city', 'postal_code', 'country', 'region', 'recipient_name', 'phone', 'shipping_address', 'address']) {
        expect(props, `request_purchase must not declare ${k}`).not.toHaveProperty(k)
      }
    })

    test('true and false are both passed through to POST /v1/purchases', async () => {
      for (const flag of [true, false]) {
        const res = await client.callTool('request_purchase', { ...base, description: `flag ${flag}`, requires_shipping: flag })
        expect(res.isError, text(res)).toBeFalsy()
        expect((last('POST', '/v1/purchases')!.body as Record<string, unknown>).requires_shipping).toBe(flag)
      }
    })

    test('the key is omitted from the body when the caller did not give it', async () => {
      const res = await client.callTool('request_purchase', { ...base, description: 'no flag' })
      expect(res.isError, text(res)).toBeFalsy()
      expect(last('POST', '/v1/purchases')!.body).not.toHaveProperty('requires_shipping')
    })

    test('a non-boolean requires_shipping is refused before anything is sent', async () => {
      const before = seen.length
      const res = await client.callTool('request_purchase', { ...base, requires_shipping: 'yes' })
      expect(res.isError).toBe(true)
      expect(seen.length).toBe(before)
    })

    test('address keys never reach the API, even when the model supplies them', async () => {
      const res = await client.callTool('request_purchase', {
        ...base,
        description: 'address probe',
        requires_shipping: true,
        line1: '1 Rue Secret',
        city: 'Nowhere',
        postal_code: '00000',
        country: 'FR',
        shipping_address: { line1: '1 Rue Secret' },
        address: '1 Rue Secret',
      })
      expect(res.isError, text(res)).toBeFalsy()
      const body = last('POST', '/v1/purchases')!.body as Record<string, unknown>
      expect(body.requires_shipping, 'control: the flag did arrive').toBe(true)
      for (const k of ['line1', 'city', 'postal_code', 'country', 'shipping_address', 'address']) {
        expect(body).not.toHaveProperty(k)
      }
      expect(JSON.stringify(body)).not.toContain('Rue Secret')
    })

    test('the same purchase with and without delivery does not share an idempotency key', async () => {
      await client.callTool('request_purchase', { ...base, description: 'idem probe' })
      const plain = (last('POST', '/v1/purchases')!.body as Record<string, unknown>).idempotency_key
      await client.callTool('request_purchase', { ...base, description: 'idem probe', requires_shipping: true })
      const shipped = (last('POST', '/v1/purchases')!.body as Record<string, unknown>).idempotency_key
      expect(shipped).not.toBe(plain)
    })

    test('the tool description tells the agent what to do with shipping_address_required', async () => {
      const tool = (await client.send('tools/list')).result.tools.find((t: { name: string }) => t.name === 'request_purchase')
      expect(tool.description).toContain('shipping_address_required')
      expect(tool.description).toContain('open_url')
      expect(tool.description).toContain('No money moves')
    })

    test('the blocked shipping_address_required outcome reaches the agent with its open_url', async () => {
      purchaseAnswer = { status: 200, body: BLOCKED }
      const res = await client.callTool('request_purchase', { ...base, description: 'blocked', requires_shipping: true })
      expect(res.isError, text(res)).toBeFalsy()
      const out = JSON.parse(text(res))
      expect(out.block_reason).toBe('shipping_address_required')
      expect(out.state).toBe('action_required')
      expect(out.requirements).toEqual([{ type: 'shipping_address', status: 'missing' }])
      expect(out.next_action).toEqual({ type: 'open_url', url: 'https://app.example.test/profile' })
    })
  })

  describe('get_shipping_address', () => {
    test('is on the roster with the personal-data promises in its description', async () => {
      const tool = (await client.send('tools/list')).result.tools.find((t: { name: string }) => t.name === 'get_shipping_address')
      expect(tool, 'get_shipping_address is not advertised').toBeDefined()
      expect(tool.inputSchema.required).toEqual(['purchase_id'])
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['publisher_user_id', 'purchase_id'])
      for (const phrase of ['PERSONAL DATA', 'payment_ready', 'completed', 'journaled', 'visible to the person', 'delivery']) {
        expect(tool.description, `description lacks "${phrase}"`).toContain(phrase)
      }
    })

    test('success: returns the shipping_address object, with the person on the query', async () => {
      addressAnswer = { status: 200, body: { purchase_id: 'pur_ship_1', shipping_address: ADDRESS, bound_via: 'approval' } }
      const res = await client.callTool('get_shipping_address', { purchase_id: 'pur_ship_1', publisher_user_id: 'usr+6291/Ж' })
      expect(res.isError, text(res)).toBeFalsy()
      const out = JSON.parse(text(res))
      expect(out.shipping_address).toEqual(ADDRESS)
      expect(out.purchase_id).toBe('pur_ship_1')
      const sent = last('GET', '/v1/purchases/pur_ship_1/shipping-address')!
      expect(sent.query).toEqual({ publisher_user_id: 'usr+6291/Ж' })
    })

    test('without publisher_user_id the call carries no query', async () => {
      addressAnswer = { status: 200, body: { purchase_id: 'pur_ship_2', shipping_address: ADDRESS } }
      const res = await client.callTool('get_shipping_address', { purchase_id: 'pur_ship_2' })
      expect(res.isError, text(res)).toBeFalsy()
      expect(last('GET', '/v1/purchases/pur_ship_2/shipping-address')!.query).toEqual({})
    })

    test('blank ids are refused before anything is sent', async () => {
      const before = seen.length
      expect((await client.callTool('get_shipping_address', { purchase_id: '   ' })).isError).toBe(true)
      expect((await client.callTool('get_shipping_address', { purchase_id: 'pur_x', publisher_user_id: ' ' })).isError).toBe(true)
      expect(seen.length).toBe(before)
    })

    test('a response in a different shape is refused, naming keys and never values', async () => {
      addressAnswer = { status: 200, body: { purchase_id: 'p', shipping_address: { line1: '1 Rue Fixture', street: 'x' } } }
      const res = await client.callTool('get_shipping_address', { purchase_id: 'pur_shape' })
      expect(res.isError).toBe(true)
      const out = JSON.parse(text(res))
      expect(out.error.code).toBe('shipping_address_unrecognised')
      expect(text(res)).not.toContain('1 Rue Fixture')
    })

    test('the three 404 reasons give three distinct results', async () => {
      const answers: Array<[string, unknown]> = [
        ['shipping_address_missing', { error: 'x', code: 'shipping_address_missing' }],
        ['shipping_address_not_ready', { error: 'x', code: 'shipping_address_not_ready' }],
        ['shipping_address_not_available', { error: 'shipping address not available' }],
      ]
      const results: Array<{ code: string; message: string; suggested_fix: string }> = []
      for (const [expected, body] of answers) {
        addressAnswer = { status: 404, body }
        const res = await client.callTool('get_shipping_address', { purchase_id: 'pur_404', publisher_user_id: 'u1' })
        expect(res.isError, expected).toBe(true)
        const e = JSON.parse(text(res)).error
        expect(e.code).toBe(expected)
        results.push(e)
      }
      expect(new Set(results.map((r) => r.code)).size).toBe(3)
      expect(new Set(results.map((r) => r.message)).size).toBe(3)
      expect(new Set(results.map((r) => r.suggested_fix)).size).toBe(3)
      // Plainly worded, and none of them blames the id in the path or the deployment.
      expect(results[0].suggested_fix).toMatch(/add a shipping address/)
      expect(results[1].suggested_fix).toMatch(/payment_ready or completed/)
      for (const r of results.slice(0, 2)) expect(r.suggested_fix).not.toMatch(/SHATALE_API_URL|Verify the id/)
    })

    test('a 404 with an unreadable body or an unlisted code is the third answer, not a guess', async () => {
      for (const body of [{ code: 'something_else' }, 'not json at all', null]) {
        addressAnswer = { status: 404, body }
        const res = await client.callTool('get_shipping_address', { purchase_id: 'pur_404b' })
        expect(res.isError).toBe(true)
        expect(JSON.parse(text(res)).error.code).toBe('shipping_address_not_available')
      }
    })
  })
})
