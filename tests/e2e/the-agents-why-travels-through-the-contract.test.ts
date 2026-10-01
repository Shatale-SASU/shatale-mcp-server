/**
 * SHAT-4438, through the PUBLIC contract: the built server over stdio, a sandbox key, a mock upstream.
 * The epic's acceptance (SHAT-2116) is that a slice is not done until it passes end to end through the
 * contract an outsider uses — so the reason is asserted on the request the built server actually sent,
 * and the tool's advertised schema is asserted to offer it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

describe('agent_intent through the published tool', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient({ SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url }, 'agent-intent')
    await client.initialize()
  })
  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('the tool offers agent_intent, bounded, and does not require it', async () => {
    const res = await client.send('tools/list')
    const tool = (res.result.tools as any[]).find((t) => t.name === 'request_purchase')
    expect(tool.inputSchema.properties.agent_intent.type).toBe('string')
    expect(tool.inputSchema.properties.agent_intent.maxLength).toBe(500)
    expect(tool.inputSchema.required).not.toContain('agent_intent')
  })

  test('a purchase with a reason reaches the API carrying it', async () => {
    const created = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'shoes.example',
      amount: 99,
      currency: 'EUR',
      description: 'Running shoes, size 42',
      agent_intent: 'Cheapest of the three the person shortlisted <b>not markup</b>.',
    })
    expect(created.isError).toBeFalsy()
    const body = mock.lastRequest('POST', '/v1/purchases')!.body as Record<string, unknown>
    expect(body.agent_intent).toBe('Cheapest of the three the person shortlisted <b>not markup</b>.')
    expect(body.description).toBe('Running shoes, size 42')
  })

  test('a reason the API would refuse never leaves the process', async () => {
    const before = mock.requests.length
    const res = await client.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'shoes.example',
      amount: 99,
      currency: 'EUR',
      description: 'Running shoes, size 42',
      agent_intent: 'x'.repeat(501),
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('agent_intent')
    expect(mock.requests.length).toBe(before)
  })
})
