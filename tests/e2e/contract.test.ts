/**
 * SHAT-1335: Contract testing — validate JSON-RPC response shapes.
 * Catches schema drift between MCP server and backend API.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { rosterByMode } from '../harness/toolRoster'
import { z } from 'zod'

// JSON-RPC tool call result schema
const ToolResult = z.object({
  content: z.array(z.object({
    type: z.literal('text'),
    text: z.string(),
  })).min(1),
  isError: z.boolean().optional(),
})

// tools/list response item
const ToolDef = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()),
  }),
})

// resources/list response item
const ResourceDef = z.object({
  uri: z.string().startsWith('shatale://'),
  name: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
})

// prompts/list response item
const PromptDef = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })).optional(),
})

describe('Contract: Guest mode response schemas', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: '' }, 'contract-guest')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('tools/list returns valid tool definitions', async () => {
    const res = await client.send('tools/list')
    const tools = res.result?.tools ?? []
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      const parsed = ToolDef.safeParse(tool)
      if (!parsed.success) {
        throw new Error(`Tool "${tool.name}" fails schema: ${parsed.error.message}`)
      }
    }
  })

  test('resources/list returns valid resource definitions', async () => {
    const resources = await client.listResources()
    expect(resources.length).toBeGreaterThan(0)
    for (const resource of resources) {
      const parsed = ResourceDef.safeParse(resource)
      if (!parsed.success) {
        throw new Error(`Resource "${resource.uri}" fails schema: ${parsed.error.message}`)
      }
    }
  })

  test('prompts/list returns valid prompt definitions', async () => {
    const prompts = await client.listPrompts()
    expect(prompts.length).toBeGreaterThan(0)
    for (const prompt of prompts) {
      const parsed = PromptDef.safeParse(prompt)
      if (!parsed.success) {
        throw new Error(`Prompt "${prompt.name}" fails schema: ${parsed.error.message}`)
      }
    }
  })

  test('tool call results match ToolResult schema', async () => {
    const guestTools = ['explain_shatale', 'list_capabilities', 'list_mcc_codes']
    for (const toolName of guestTools) {
      const result = await client.callTool(toolName, {})
      const parsed = ToolResult.safeParse(result)
      if (!parsed.success) {
        throw new Error(`Tool "${toolName}" response fails schema: ${parsed.error.message}`)
      }
    }
  })

  test('unknown tool returns error with ToolResult schema', async () => {
    const result = await client.callTool('nonexistent_xyz', {})
    const parsed = ToolResult.safeParse(result)
    expect(parsed.success).toBe(true)
  })
})

const TEST_KEY = process.env.SHATALE_TEST_KEY
const describeIfKey = TEST_KEY ? describe : describe.skip

describeIfKey('Contract: Sandbox mode response schemas', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, 'contract-sandbox')
    await client.initialize()
  })

  afterAll(() => client.close())

  // 17: only the register→status onboarding pair is withheld, until its backend persists the
  // session id (see mock-contract.test.ts). This count is key-gated, so it only breaks on a KEYED
  // run — it stayed at 18 after the tools were unadvertised because the CI that gates PRs runs
  // keyless.
  //
  // ⚠️ AND IT THEN SAT AT 15 THROUGH TWO MORE ROSTER MOVES, for the same reason and unnoticed:
  // get_credential_emails ceasing to be withheld (SHAT-2527) and sandbox_create_user arriving
  // (SHAT-2698). A comment warning about the skipped-but-green trap does not escape it. Measured
  // with a sandbox-PREFIXED key and no network — the roster is fixed before any request — this
  // read 17 while asserting 15.
  // 🔴 THE COUNT IS GONE, AND THE COMMENT ABOVE IS WHY (SHAT-2674). It has been wrong three times —
  // 18, then 15 across two roster moves, now 17 against an actual 20 — and each time the repair was
  // to write the new number, which buys silence until the next tool. A set stated as a QUANTITY says
  // nothing about WHICH members it has, so it cannot fail for the reason the test exists.
  //
  // What replaces it is the roster measured from the RUNNING SERVER for this mode
  // (tests/harness/toolRoster.ts). Deriving the expectation from the sources was tried and rejected
  // here with a measurement — SHAT-2527: a tool declared outside src/tools was invisible to the
  // derivation AND to its second opinion, so the two agreed while both were blind.
  //
  // ⚠️ AND THE INVARIANT IS NOW WORTH KEY-GATING, WHICH THE COUNT WAS NOT. The roster is decided by
  // the key's PREFIX and the env flags before any request is made, so a number here could always have
  // been checked keyless — and never was, because this file is skipped without a key and a skip and a
  // pass are the same line. What genuinely needs a real key is the statement below: holding one does
  // not change what you are offered.
  test('a real key is offered exactly what the mode advertises, and every definition is valid', async () => {
    const res = await client.send('tools/list')
    const tools = res.result?.tools ?? []
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(await rosterByMode('sandbox'))
    for (const tool of tools) {
      const parsed = ToolDef.safeParse(tool)
      if (!parsed.success) {
        throw new Error(`Tool "${tool.name}" fails schema: ${parsed.error.message}`)
      }
    }
  })

  test('all sandbox tool calls return ToolResult schema', async () => {
    // Tools that can be called without side effects
    const safeTools = [
      { name: 'list_capabilities', args: {} },
      { name: 'list_mcc_codes', args: {} },
      { name: 'explain_shatale', args: {} },
      { name: 'search_merchants', args: { query: 'test' } },
    ]
    for (const { name, args } of safeTools) {
      const result = await client.callTool(name, args)
      const parsed = ToolResult.safeParse(result)
      if (!parsed.success) {
        throw new Error(`Tool "${name}" response fails schema: ${parsed.error.message}`)
      }
    }
  })
})
