import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { testId } from '../harness/testIds'

const TEST_KEY = process.env.SHATALE_TEST_KEY
const describeIfKey = TEST_KEY ? describe : describe.skip

describeIfKey('Input Validation', () => {
  let client: McpTestClient
  const runId = testId('validation')

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, runId)
    await client.initialize()
  })

  afterAll(() => client.close())

  test('request_purchase rejects empty input', async () => {
    const result = await client.callTool('request_purchase', {})
    expect(result.content[0].text).toContain('Invalid input')
  })

  test('request_purchase rejects negative amount', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: testId('merchant'),
      amount: -1,
      currency: 'EUR',
      description: 'e2e validation test',
    })
    expect(result.content[0].text).toContain('Invalid input')
    expect(result.content[0].text).toContain('positive')
  })

  test('request_purchase rejects zero amount', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: testId('merchant'),
      amount: 0,
      currency: 'EUR',
      description: 'e2e validation test',
    })
    expect(result.content[0].text).toContain('Invalid input')
  })

  test('request_purchase rejects amount exceeding max', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: testId('merchant'),
      amount: 999_999,
      currency: 'EUR',
      description: 'e2e validation test',
    })
    expect(result.content[0].text).toContain('Invalid input')
    expect(result.content[0].text).toContain('maximum')
  })

  test('request_purchase rejects invalid currency length', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      agent_id: testId('agent'),
      merchant: testId('merchant'),
      amount: 10,
      currency: 'EURO',
      description: 'e2e validation test',
    })
    expect(result.content[0].text).toContain('Invalid input')
  })

  test('request_purchase rejects missing required fields', async () => {
    const result = await client.callTool('request_purchase', {
      publisher_user_id: testId('user'),
      // missing agent_id, merchant, etc.
    })
    expect(result.content[0].text).toContain('Invalid input')
  })

  test('register_user_profile rejects invalid email', async () => {
    const result = await client.callTool('register_user_profile', {
      publisher_user_id: testId('user'),
      user_claims: {
        email: 'not-an-email',
      },
    })
    expect(result.content[0].text).toContain('Invalid input')
  })

  test('sandbox_create_test_user rejects invalid email', async () => {
    const result = await client.callTool('sandbox_create_test_user', {
      email: 'not-valid',
    })
    expect(result.content[0].text).toContain('Invalid input')
  })
})
