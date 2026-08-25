/**
 * Security edge cases — key validation, URL whitelisting, injection, malformed input.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { resolve } from 'path'
import { McpTestClient } from '../harness/mcpClient'

const ENTRY = resolve(import.meta.dirname, '../../dist/index.js')

function spawnAndCapture(env: Record<string, string>): Promise<{ stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      resolve({ stderr, code })
    })

    setTimeout(() => {
      proc.kill()
    }, 5000)
  })
}

// ── Key rejection ───────────────────────────────────────────────────────

describe('Security: Key Validation', () => {
  // A live key WITHOUT explicit SHATALE_MODE=live intent must fail fast (fat-finger
  // guard) — the security property is unchanged from the old blanket reject; only the
  // message differs now that a legitimate intent-gated live path exists.
  test('rejects sh_live_ keys without SHATALE_MODE=live', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_KEY: 'sh_live_TESTING_ONLY_NOT_REAL',
      SHATALE_MODE: '',
    })
    expect(stderr).toContain('without SHATALE_MODE=live')
    expect(code).toBe(1)
  })

  test('rejects sk_live_ keys without SHATALE_MODE=live', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_KEY: 'sk_live_TESTING_ONLY',
      SHATALE_MODE: '',
    })
    expect(stderr).toContain('without SHATALE_MODE=live')
    expect(code).toBe(1)
  })

  test('rejects bare sk_live_ prefix without SHATALE_MODE=live', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_KEY: 'sk_live_',
      SHATALE_MODE: '',
    })
    expect(stderr).toContain('without SHATALE_MODE=live')
    expect(code).toBe(1)
  })

  // SHAT-1460 (Blocker 2): sk_test_ is a DEAD prefix — the identity service issues only sk_sandbox_ for
  // sandbox. It must be REFUSED at startup, not silently treated as a sandbox key. This pins isSandboxKey:
  // a mutant re-widening it to accept sk_test_ made the server start in sandbox mode and this test go red.
  test('rejects sk_test_ keys — a dead prefix the system never issues', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_KEY: 'sk_test_abc',
      SHATALE_MODE: '',
    })
    expect(code).toBe(1)
    expect(stderr).toContain('unrecognized API key')
  })

  // A live key WITH explicit intent is ACCEPTED — the MCP now has a working
  // normal/prod mode (SHAT two-mode design). Without money-GO it starts in
  // onboarding-only live mode and does NOT hit the fat-finger refusal.
  test('accepts sk_live_ key WITH SHATALE_MODE=live (starts live mode)', async () => {
    const { stderr } = await spawnAndCapture({
      SHATALE_API_KEY: 'sk_live_TESTING_ONLY',
      SHATALE_MODE: 'live',
    })
    expect(stderr).not.toContain('without SHATALE_MODE=live')
    expect(stderr.toLowerCase()).toContain('live')
  })

  test('rejects SHATALE_MODE=live with a non-live key', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_KEY: 'sk_sandbox_TESTING',
      SHATALE_MODE: 'live',
    })
    expect(stderr).toContain('requires a live key')
    expect(code).toBe(1)
  })

  test('accepts empty key (guest mode)', async () => {
    const { stderr } = await spawnAndCapture({
      SHATALE_API_KEY: '',
    })
    expect(stderr).not.toContain('without SHATALE_MODE=live')
  })
})

// ── URL whitelisting ────────────────────────────────────────────────────

describe('Security: URL Whitelisting', () => {
  test('rejects untrusted SHATALE_API_URL', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_URL: 'https://evil.attacker.com',
    })
    expect(stderr).toContain('Untrusted API URL')
    expect(code).toBe(1)
  })

  test('allows *.shatale.com URLs', async () => {
    const { stderr } = await spawnAndCapture({
      SHATALE_API_URL: 'https://staging.shatale.com',
      SHATALE_API_KEY: '',
    })
    expect(stderr).not.toContain('Untrusted API URL')
  })

  test('allows localhost URLs', async () => {
    const { stderr } = await spawnAndCapture({
      SHATALE_API_URL: 'http://localhost:3000',
      SHATALE_API_KEY: '',
    })
    expect(stderr).not.toContain('Untrusted API URL')
  })

  test('rejects URL with shatale.com as subdomain of attacker', async () => {
    const { stderr, code } = await spawnAndCapture({
      SHATALE_API_URL: 'https://shatale.com.evil.net',
    })
    expect(stderr).toContain('Untrusted API URL')
    expect(code).toBe(1)
  })
})

// ── Tool injection / malformed calls ────────────────────────────────────

describe('Security: Tool Injection & Malformed Input', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: '' }, 'security-injection')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('tool name with path traversal characters', async () => {
    const result = await client.callTool('../../../etc/passwd', {})
    expect(result.content[0].text).toContain('Unknown tool')
  })

  test('tool name with SQL injection attempt', async () => {
    const result = await client.callTool("'; DROP TABLE users; --", {})
    expect(result.content[0].text).toContain('Unknown tool')
  })

  test('tool name with null bytes', async () => {
    const result = await client.callTool('explain_shatale\x00malicious', {})
    expect(result.content[0].text).toContain('Unknown tool')
  })

  test('oversized argument string', async () => {
    const bigString = 'A'.repeat(100_000)
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: bigString,
      amount: 100,
      description: 'test',
    })
    // Should handle gracefully — not crash
    expect(result.content).toBeDefined()
  })

  test('deeply nested object arguments', async () => {
    let nested: any = { value: 'leaf' }
    for (let i = 0; i < 50; i++) {
      nested = { nested }
    }
    const result = await client.callTool('explain_shatale', nested)
    expect(result.content).toBeDefined()
  })

  test('special characters in arguments', async () => {
    const result = await client.callTool('simulate_purchase_flow', {
      merchant: '<script>alert(1)</script>',
      amount: 100,
      description: '${process.env.SECRET}',
    })
    expect(result.content).toBeDefined()
    // Response should NOT contain expanded env vars
    expect(result.content[0].text).not.toContain(process.env.HOME)
  })
})

// ── Stderr leak detection ───────────────────────────────────────────────

describe('Security: No Secret Leaks in Output', () => {
  let client: McpTestClient

  beforeAll(async () => {
    client = new McpTestClient({ SHATALE_API_KEY: '' }, 'security-leaks')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('error responses do not leak server internals', async () => {
    const result = await client.callTool('request_purchase', {})
    const text = result.content[0].text
    // Should not contain stack traces or file paths
    expect(text).not.toMatch(/at\s+\w+\s+\(\//)
    expect(text).not.toContain('node_modules')
    expect(text).not.toContain('/home/')
    expect(text).not.toContain('/Users/')
  })
})
