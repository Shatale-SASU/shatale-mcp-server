/**
 * SHAT-4788 — get_purchase_status, await_purchase_approval and cancel_purchase name the PERSON on the wire.
 *
 * 🔴 WHAT WAS MISSING (client half of shatale-api SHAT-4785). These three took a purchase id and sent
 * nothing else, under a key that is ONE key for ALL of a publisher's people — so each could read or
 * cancel any person's purchase by id. The API can scope each to `publisher_user_id` and, from
 * SHAT-4785, REQUIRE it behind a switch; a call without it is then answered 404 "purchase not found",
 * byte for byte the answer for a purchase that does not exist.
 *
 * ⚠️ THE ASSERTION IS THE WIRE, NOT THE HANDLER. Every case reads what the mock upstream RECEIVED, through
 * the built server over stdio. Where the person goes is part of the contract: a GET reads it from the
 * query; the cancel (DELETE) sends it in the query AND in the body, the same string.
 *
 * ⚠️ TWO PEOPLE IN THE FIXTURE, so a constant, a remembered first value or the other person's id fails in
 * the assertion rather than passing by being non-empty. And the person has characters that a hand-built
 * query would break (`+`, `/`, a non-ASCII letter).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const ALICE = 'alice+test/ü@example.test'
const BOB = 'bob@example.test'
const PID = 'pur_mock_1'

const text = (r: any): string => r.content?.[0]?.text as string

describe('the three purchase-access tools carry publisher_user_id (SHAT-4788)', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'status-await-cancel-person',
    )
    await client.initialize()
  })
  afterAll(async () => {
    client.close()
    await mock.close()
  })
  beforeEach(() => {
    mock.requests.length = 0
  })

  const lastWire = (method: string, suffix = '') => {
    const hit = mock.requests.filter((r) => r.method === method && r.path === `/v1/purchases/${PID}${suffix}`)
    expect(hit, `no ${method} ${suffix || 'status'} reached the upstream`).toHaveLength(1)
    return hit[0]
  }

  test.each([ALICE, BOB])('get_purchase_status sends %s in the query, and only that person', async (person) => {
    const r = await client.callTool('get_purchase_status', { purchase_id: PID, publisher_user_id: person })
    expect(r.isError, text(r)).toBeFalsy()
    expect(lastWire('GET').query).toEqual({ publisher_user_id: person })
    expect(r._meta?.deprecation, 'a call that named the person is not deprecated').toBeUndefined()
  })

  test.each([ALICE, BOB])('await_purchase_approval sends %s in the query, and only that person', async (person) => {
    const r = await client.callTool('await_purchase_approval', { purchase_id: PID, publisher_user_id: person })
    expect(r.isError, text(r)).toBeFalsy()
    expect(lastWire('GET', '/await-approval').query).toEqual({ publisher_user_id: person })
    expect(r._meta?.deprecation).toBeUndefined()
  })

  test.each([ALICE, BOB])('cancel_purchase sends %s in the query AND in the body — the same string', async (person) => {
    const r = await client.callTool('cancel_purchase', { purchase_id: PID, reason: 'changed my mind', publisher_user_id: person })
    expect(r.isError, text(r)).toBeFalsy()
    const wire = lastWire('DELETE')
    expect(wire.query).toEqual({ publisher_user_id: person })
    expect(wire.body).toMatchObject({ reason: 'changed my mind', publisher_user_id: person })
    expect((wire.body as Record<string, unknown>).idempotency_key, 'the cancel keeps its key').toBeTruthy()
    expect(r._meta?.deprecation).toBeUndefined()
  })

  // The API stores the person UNNORMALISED and compares it exactly as sent: validating with a trim must
  // not become sending the trimmed value.
  test.each(['get_purchase_status', 'await_purchase_approval', 'cancel_purchase'])(
    '%s sends a person with surrounding spaces exactly as given, not trimmed',
    async (tool) => {
      const padded = '  carol@example.test '
      await client.callTool(tool, { purchase_id: PID, publisher_user_id: padded })
      const wire = mock.requests.find((r) => r.path.startsWith(`/v1/purchases/${PID}`))!
      expect(wire.query).toEqual({ publisher_user_id: padded })
      if (tool === 'cancel_purchase') expect((wire.body as Record<string, unknown>).publisher_user_id).toBe(padded)
    },
  )

  // ── the transition: absent is served as 1.2.x served it, and says so ─────────────────────────────
  test.each([
    ['get_purchase_status', 'GET', ''],
    ['await_purchase_approval', 'GET', '/await-approval'],
    ['cancel_purchase', 'DELETE', ''],
  ])('%s without the person: the request is exactly the old one, and the deprecation reaches caller and log', async (tool, method, suffix) => {
    const before = client.getStderr().length
    const r = await client.callTool(tool, { purchase_id: PID })
    expect(r.isError, text(r)).toBeFalsy()
    const wire = lastWire(method, suffix)
    expect(wire.query, 'no query at all — not an empty parameter').toEqual({})
    expect(JSON.stringify(wire.body ?? {}), 'no person field in the body either').not.toContain('publisher_user_id')
    expect(r._meta?.deprecation?.code, 'the deprecation did not reach the caller').toBe('purchase_access_without_person')
    const log = client.getStderr().slice(before)
    expect(log).toContain(`DEPRECATED — ${tool} for purchase`)
  })

  // ── present but unusable is a mistake, not the transition ────────────────────────────────────────
  test.each([
    ['get_purchase_status', ''],
    ['await_purchase_approval', ''],
    ['cancel_purchase', '   '],
  ])('%s with publisher_user_id %j is refused and NOTHING is sent', async (tool, bad) => {
    const r = await client.callTool(tool, { purchase_id: PID, publisher_user_id: bad })
    expect(text(r)).toMatch(/publisher_user_id/)
    expect(mock.requests, 'a request left for a call that named no usable person').toEqual([])
  })

  test('the tools advertise the field (a person the schema never mentions is a person nobody passes)', async () => {
    const res = await client.send('tools/list')
    const tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> = res.result.tools
    for (const name of ['get_purchase_status', 'await_purchase_approval', 'cancel_purchase']) {
      const t = tools.find((x) => x.name === name)
      expect(t, `${name} missing from tools/list`).toBeDefined()
      expect(Object.keys(t!.inputSchema.properties)).toContain('publisher_user_id')
      expect(t!.inputSchema.required ?? [], 'still optional in this release (transition)').not.toContain('publisher_user_id')
    }
  })
})
