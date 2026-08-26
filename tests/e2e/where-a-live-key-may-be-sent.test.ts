/**
 * /!\ WHAT THE HOST CHECK GUARDS IS NOT A URL. IT IS THE API KEY.
 *
 * client.ts attaches `Authorization: Bearer ${apiKey}` to whatever host survives the check in
 * index.ts, unconditionally. So every case below is one question: who ends up holding a live key.
 *
 * SHAT-2558. The old expression READ like an allowlist and was not one:
 *
 *     ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.shatale.com'))
 *
 * The second disjunct never mentions `h`. It is a constant inside the callback — simply OR-ed onto
 * the whole test — so the three named hosts only ever contributed exact matches and the real rule
 * was the wildcard. Someone checking "is this host allowed?" reads the array and gets the wrong
 * answer.
 *
 * /!\ ONE WORRY DOES NOT REPRODUCE, AND THE CONTROL FOR IT IS BELOW SO NOBODY RE-RAISES IT: a
 * LOOKALIKE domain is refused, because the suffix carries the leading dot. `evilshatale.com` fails.
 *
 * What is true is narrower and still serious: ANY subdomain of shatale.com receives the key, and a
 * dangling CNAME or one taken-over marketing subdomain is enough to be handed `Bearer sk_live_*`
 * and every purchase body after it. Plus, until now, no scheme check at all: `http://` started
 * normally and sent the bearer token in cleartext.
 *
 * These spawn the built server, so they assert what the process actually does on startup rather
 * than what a unit-level reading of the module suggests it would.
 */
import { describe, test, expect } from 'vitest'
import { spawn } from 'child_process'
import { resolve } from 'path'

const ENTRY = resolve(import.meta.dirname, '../../dist/index.js')

function spawnAndCapture(env: Record<string, string>): Promise<{ stderr: string; code: number | null }> {
  return new Promise((done) => {
    const proc = spawn('node', [ENTRY], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr!.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('close', (code) => done({ stderr, code }))
    // A server that starts successfully never exits on its own — it waits on stdio. Killing it is
    // how "it started" is observed, and `code` is then null rather than 0.
    setTimeout(() => proc.kill(), 3000)
  })
}

const LIVE = { SHATALE_API_KEY: 'sk_live_testkey', SHATALE_MODE: 'live' }
const SANDBOX = { SHATALE_API_KEY: 'sk_sandbox_testkey' }

describe('where an API key may be sent (SHAT-2558)', () => {
  // /!\ THE CONTROLS COME FIRST. Every refusal below is only meaningful if the server can still
  // START — a build that exits 1 on everything would satisfy each "must refuse" case perfectly.
  test('CONTROL: a sandbox key against the canonical host starts', async () => {
    const { stderr, code } = await spawnAndCapture({ ...SANDBOX, SHATALE_API_URL: 'https://api.shatale.com' })
    expect(code, `the server refused the canonical host with a sandbox key: ${stderr}`).toBeNull()
    expect(stderr).toContain('demo(sandbox) mode')
  })

  test('CONTROL: a live key against the canonical host starts', async () => {
    const { stderr, code } = await spawnAndCapture({ ...LIVE, SHATALE_API_URL: 'https://api.shatale.com' })
    expect(code, `the server refused the canonical host with a live key: ${stderr}`).toBeNull()
    expect(stderr).toContain('live')
  })

  // /!\ AND THE CONTROL THAT MATTERS MOST FOR PROPORTION: the wildcard is untouched for sandbox.
  // The new live-host rule must refuse nothing anyone does today. Sandbox users point at
  // sandbox.api.shatale.com, and that has to keep working or the fix is worse than the flaw.
  test('CONTROL: a sandbox key against a shatale.com subdomain still starts', async () => {
    const { stderr, code } = await spawnAndCapture({ ...SANDBOX, SHATALE_API_URL: 'https://sandbox.api.shatale.com' })
    expect(code, `a sandbox key was refused a legitimate subdomain — the guard now blocks normal use: ${stderr}`).toBeNull()
    expect(stderr).toContain('demo(sandbox) mode')
  })

  test('a lookalike domain is refused (this already worked; recorded so it is not re-litigated)', async () => {
    const { stderr, code } = await spawnAndCapture({ ...SANDBOX, SHATALE_API_URL: 'https://evilshatale.com' })
    expect(code).toBe(1)
    expect(stderr).toContain('Untrusted API URL')
  })

  // /!\ THE POINT, HALF ONE.
  test('a LIVE key is refused a non-canonical subdomain', async () => {
    const { stderr, code } = await spawnAndCapture({ ...LIVE, SHATALE_API_URL: 'https://attacker.shatale.com' })
    expect(
      code,
      'the server started and would have sent Bearer sk_live_* to attacker.shatale.com. Any ' +
        'subdomain passes the host allowlist, so a dangling CNAME or a taken-over marketing ' +
        'subdomain is enough to receive a live key and every purchase body after it.',
    ).toBe(1)
    expect(stderr).toContain('LIVE key would be sent')
  })

  test('and it can be allowed, deliberately, by saying so', async () => {
    const { stderr, code } = await spawnAndCapture({
      ...LIVE,
      SHATALE_API_URL: 'https://eu.api.shatale.com',
      SHATALE_ALLOW_NONSTANDARD_LIVE_HOST: 'true',
    })
    expect(code, `the escape hatch does not work, so the rule cannot be satisfied at all: ${stderr}`).toBeNull()
    expect(stderr).toContain('WARNING: sending a LIVE key')
  })

  // /!\ THE POINT, HALF TWO. Nothing legitimate needs a bearer token over plaintext.
  test('http:// is refused for a remote host', async () => {
    const { stderr, code } = await spawnAndCapture({ ...SANDBOX, SHATALE_API_URL: 'http://api.shatale.com' })
    expect(
      code,
      'the server started on http:// and would send Bearer sk_sandbox_* in cleartext. `new URL()` ' +
        'accepts any protocol and nothing checked it, which is why this went unnoticed — the host ' +
        'was right, so every reading of the host check agreed.',
    ).toBe(1)
    expect(stderr).toContain('cleartext')
  })

  // Loopback stays exempt, or the mock-upstream harness (http://127.0.0.1) cannot run at all — and a
  // packet that never leaves the machine is not what this rule is about.
  test('http:// on loopback is still allowed, for the test harness and local development', async () => {
    const { stderr, code } = await spawnAndCapture({ ...SANDBOX, SHATALE_API_URL: 'http://127.0.0.1:9999' })
    expect(code, `loopback was refused, which breaks every local and harness run: ${stderr}`).toBeNull()
    expect(stderr).toContain('demo(sandbox) mode')
  })
})
