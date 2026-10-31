/**
 * SHAT-7667 — get_credential_status and get_credential_emails name the PERSON on the wire.
 *
 * shatale-api reads the person on both routes from `?publisher_user_id=`. With the production flags
 * CREDENTIAL_STATUS_REQUIRE_PERSON_SCOPE / CREDENTIAL_EMAILS_REQUIRE_PERSON_SCOPE on, a request without
 * it is refused 400. The assertion is the WIRE: what the mock upstream RECEIVED through the built server.
 * Two people, one with characters a hand-built query would break.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const ALICE = 'alice+test/ü@example.test'
const BOB = 'bob@example.test'
const CID = 'cred_mock_1'
const text = (r: any): string => r.content?.[0]?.text as string

const TOOLS = [
  ['get_credential_status', ''],
  ['get_credential_emails', '/emails'],
] as const

describe('the two credential reads carry publisher_user_id (SHAT-7667)', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient({ SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url }, 'credentials-person')
    await client.initialize()
  })
  afterAll(async () => {
    client.close()
    await mock.close()
  })
  beforeEach(() => {
    mock.requests.length = 0
  })

  const wireOf = (suffix: string) => {
    const hit = mock.requests.filter((r) => r.method === 'GET' && r.path === `/v1/credentials/${CID}${suffix}`)
    expect(hit, `no GET ${suffix || 'status'} reached the upstream`).toHaveLength(1)
    return hit[0]
  }

  for (const [tool, suffix] of TOOLS) {
    test.each([ALICE, BOB])(`${tool} sends %s in the query, and only that person`, async (person) => {
      const r = await client.callTool(tool, { credential_request_id: CID, publisher_user_id: person })
      expect(r.isError, text(r)).toBeFalsy()
      expect(wireOf(suffix).query).toEqual({ publisher_user_id: person })
      expect(r._meta?.deprecation, 'a call that named the person is not deprecated').toBeUndefined()
    })

    test(`${tool} sends a person with surrounding spaces exactly as given, not trimmed`, async () => {
      const padded = '  carol@example.test '
      await client.callTool(tool, { credential_request_id: CID, publisher_user_id: padded })
      expect(wireOf(suffix).query).toEqual({ publisher_user_id: padded })
    })

    test(`${tool} without the person: the old request, and the deprecation reaches caller and log`, async () => {
      const before = client.getStderr().length
      const r = await client.callTool(tool, { credential_request_id: CID })
      expect(r.isError, text(r)).toBeFalsy()
      expect(wireOf(suffix).query, 'no query at all').toEqual({})
      expect(r._meta?.deprecation?.code).toBe('credential_access_without_person')
      expect(r._meta?.deprecation?.message).not.toMatch(/purchase/i)
      expect(client.getStderr().slice(before)).toContain(`DEPRECATED — ${tool} for credential`)
    })

    test.each(['', '   ', 42, null])(`${tool} with publisher_user_id %j is refused and NOTHING is sent`, async (bad) => {
      const r = await client.callTool(tool, { credential_request_id: CID, publisher_user_id: bad as any })
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(/publisher_user_id/)
      expect(mock.requests, 'a request left for a call that named no usable person').toEqual([])
    })
  }

  test('the tools advertise the field and it stays optional in this release', async () => {
    const res = await client.send('tools/list')
    const tools: Array<{ name: string; inputSchema: { properties: Record<string, any>; required?: string[] } }> = res.result.tools
    for (const [name] of TOOLS) {
      const t = tools.find((x) => x.name === name)
      expect(t, `${name} missing from tools/list`).toBeDefined()
      expect(Object.keys(t!.inputSchema.properties)).toContain('publisher_user_id')
      expect(t!.inputSchema.properties.publisher_user_id.description).toMatch(/credential/)
      expect(t!.inputSchema.required ?? []).not.toContain('publisher_user_id')
    }
  })
})
