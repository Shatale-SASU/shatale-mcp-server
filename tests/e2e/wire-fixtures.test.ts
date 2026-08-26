/**
 * SHAT-2165 — wire-body fixtures.
 *
 * The hermetic half of the release gate. `scripts/publish-gate.mjs` asks the real backend
 * "do you accept this?", which is the only authoritative answer — but it needs a network,
 * a key and a seeded agent. This file captures the exact bodies the built server puts on
 * the wire, so that:
 *
 *   1. any change to a field NAME or a field TYPE shows up as a diff in a committed
 *      artifact, reviewable in the PR, instead of hiding behind a mock that accepts
 *      anything (the mock is this side of the contract, so it can never reject what this
 *      side sends — which is exactly how the numeric-`mcc` defect passed 129 green tests
 *      twice); and
 *   2. the fixtures can be replayed against the Go structs. A test in apps/api can
 *      `json.Unmarshal` each body into the real request struct with DisallowUnknownFields
 *      and turn "the TypeScript disagrees with the Go" into a compile-fast failure. See
 *      tests/fixtures/wire/README.md.
 *
 * This does NOT replace the live gate: a fixture that both sides agree is wrong is still
 * wrong. It shortens the feedback loop; the live gate is what proves the wire works.
 *
 * Regenerate after an intentional contract change:  UPDATE_WIRE_FIXTURES=1 npx vitest run tests/e2e/wire-fixtures.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/wire')
const FIXTURE_FILE = resolve(FIXTURE_DIR, 'outbound-requests.json')

/** The money-GO code is checked by SHA-256 exact match, so a test can mint its own pair. */
const MONEY_GO = 'shat-2165-wire-fixtures'
const MONEY_GO_SHA256 = createHash('sha256').update(MONEY_GO, 'utf8').digest('hex')

interface WireFixture {
  label: string
  /** The Go request struct this body must decode into, for the replay test in apps/api. */
  struct_hint: string
  method: string
  path: string
  body: unknown
  /**
   * /!\ QUERY IS PART OF THE CONTRACT, AND FOR A READ IT IS MOST OF IT — SHAT-1455.
   *
   * The original six fixtures were all writes, so `body` carried the whole agreement. Half the
   * tools are READS, and a read's body is empty: what can drift is the PATH SHAPE and the QUERY
   * PARAMETER NAMES. A renamed `q`, a segment moved from the path into the query, or an id that
   * stops being URL-encoded are exactly the changes that produce a 404 in production and a green
   * mock in CI — because a mock is this side of the contract and cannot reject what this side
   * sends.
   */
  query?: Record<string, string>
}

/**
 * Idempotency keys are derived from a clock bucket (credentials) or from the input
 * (purchases), so the VALUE is not the contract — its presence and its type are. Pinning
 * the literal would make the fixture rot hourly and teach everyone to regenerate on red,
 * which is how a fixture stops being read.
 */
function normalise(body: unknown): unknown {
  if (body == null || typeof body !== 'object') return body
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) }
  if (typeof out.idempotency_key === 'string') out.idempotency_key = '<derived-string>'
  return out
}

describe('Wire fixtures: the exact bodies the built server sends', () => {
  let mock: MockUpstream
  const captured: WireFixture[] = []

  beforeAll(async () => {
    mock = await MockUpstream.start()

    // ── Sandbox mode ────────────────────────────────────────────────────────
    const sandbox = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'wire-fixtures-sandbox',
    )
    await sandbox.initialize()

    await sandbox.callTool('sandbox_simulate_authorization', {
      agent_id: 'agent-1',
      amount: 15000,
      currency: 'EUR',
      mcc: '5691',
      merchant_name: 'Fixture Clothing Co',
      card_number: '4111111111111111',
    })
    captured.push({
      label: 'sandbox_simulate_authorization (mcc given as a string)',
      struct_hint: 'apps/api/api/v1/sandbox.go sandboxAuthRequest',
      ...describeLast(mock, 'POST', '/v1/sandbox/authorizations'),
    })

    await sandbox.callTool('sandbox_simulate_authorization', {
      agent_id: 'agent-1',
      amount: 15000,
      currency: 'EUR',
      // The spelling 0.2.1 and 0.5.0 put on the wire RAW, and the one an agent following an
      // older tool description still sends. It must arrive as a string either way.
      mcc: 5691,
      merchant_name: 'Fixture Clothing Co',
      card_number: '4111111111111111',
    })
    captured.push({
      label: 'sandbox_simulate_authorization (mcc given as a number — must still go out as a string)',
      struct_hint: 'apps/api/api/v1/sandbox.go sandboxAuthRequest',
      ...describeLast(mock, 'POST', '/v1/sandbox/authorizations'),
    })

    await sandbox.callTool('request_temporary_credentials', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant_domain: 'namecheap.com',
      purpose: 'domain registration',
    })
    captured.push({
      label: 'request_temporary_credentials',
      struct_hint: 'apps/api/api/v1/credentials.go request struct',
      ...describeLast(mock, 'POST', '/v1/credentials'),
    })

    await sandbox.callTool('cancel_purchase', { purchase_id: 'pur_fixture_1', reason: 'user changed their mind' })
    captured.push({
      label: 'cancel_purchase',
      struct_hint: 'apps/api/api/v1/purchases.go cancel request struct',
      ...describeLast(mock, 'DELETE', '/v1/purchases/'),
    })

    // ── SHAT-1455: THE READS, which had no fixtures at all ──────────────────
    //
    // /!\ SIX OF THE SEVEN TOOLS BELOW HAD NOTHING PINNING THEIR ROUTE. The original set covered
    // writes because a write carries a body and a body looks like a contract. A read's contract is
    // its PATH SHAPE and its QUERY NAMES, and those drift in exactly the way that survives CI: the
    // mock is on this side of the wire, so it answers whatever this side asks. `get_merchant_details`
    // asking `/v1/merchants/{id}` instead of `/v1/merchants/catalog/{id}` is green here and a 404 in
    // production, and nothing in the tree would have said so.

    await sandbox.callTool('search_merchants', { query: 'nike', country: 'FR' })
    captured.push({
      label: 'search_merchants (query parameter NAMES are the contract for a read)',
      struct_hint: 'apps/api/api/v1/merchants.go catalog handler query params',
      ...describeLast(mock, 'GET', '/v1/merchants/catalog'),
    })

    await sandbox.callTool('get_merchant_details', { merchant_id: 'mrc fixture/1' })
    captured.push({
      // The id is deliberately hostile: a space and a slash. encodeURIComponent turns it into one
      // segment; drop it and the slash becomes a path separator and the request lands on a
      // different route entirely.
      label: 'get_merchant_details (id is URL-encoded into ONE path segment)',
      struct_hint: 'apps/api/api/v1/merchants.go catalog detail route',
      ...describeLast(mock, 'GET', '/v1/merchants/catalog/'),
    })

    await sandbox.callTool('list_mcc_codes', { query: 'gambling' })
    captured.push({
      label: 'list_mcc_codes',
      struct_hint: 'apps/api/api/v1/mcc_codes.go ServeMCCCodes query params',
      ...describeLast(mock, 'GET', '/v1/mcc-codes'),
    })

    await sandbox.callTool('get_purchase_status', { purchase_id: 'pur_fixture_2' })
    captured.push({
      label: 'get_purchase_status',
      struct_hint: 'apps/api/api/v1/purchases.go get route',
      ...describeLast(mock, 'GET', '/v1/purchases/pur_fixture_2'),
    })

    await sandbox.callTool('get_credential_status', { credential_request_id: 'cred_fixture_1' })
    captured.push({
      label: 'get_credential_status',
      struct_hint: 'apps/api/api/v1/credentials.go status route',
      ...describeLast(mock, 'GET', '/v1/credentials/cred_fixture_1'),
    })

    await sandbox.callTool('sandbox_complete_onboarding', { user_id: 'usr_fixture_1' })
    captured.push({
      label: 'sandbox_complete_onboarding (a WRITE with no body — the path IS the request)',
      struct_hint: 'apps/api/api/v1/sandbox.go complete-onboarding route',
      ...describeLast(mock, 'POST', '/v1/sandbox/users/'),
    })

    await sandbox.callTool('sandbox_approve_purchase', { purchase_id: 'pur_fixture_5' })
    captured.push({
      label: 'sandbox_approve_purchase (a WRITE with no body — the path IS the request)',
      struct_hint: 'apps/api/api/v1/sandbox.go approve route',
      ...describeLast(mock, 'POST', '/v1/sandbox/purchases/'),
    })

    sandbox.close()

    // ── The emails tool, behind its own deploy flag ─────────────────────────
    const emails = new McpTestClient(
      {
        SHATALE_API_KEY: 'sk_sandbox_mock',
        SHATALE_API_URL: mock.url,
        SHATALE_CREDENTIAL_EMAILS_ENABLED: 'true',
      },
      'wire-fixtures-emails',
    )
    await emails.initialize()
    await emails.callTool('get_credential_emails', { credential_request_id: 'cred_fixture_2' })
    captured.push({
      label: 'get_credential_emails',
      struct_hint: 'apps/api/api/v1/credentials.go emails route',
      ...describeLast(mock, 'GET', '/v1/credentials/cred_fixture_2/emails'),
    })
    emails.close()

    // ── Live mode + money-GO: the real purchase body ────────────────────────
    const live = new McpTestClient(
      {
        SHATALE_API_KEY: 'sk_live_mock_fixture_only',
        SHATALE_MODE: 'live',
        SHATALE_API_URL: mock.url,
        SHATALE_MONEY_GO: MONEY_GO,
        SHATALE_MONEY_GO_SHA256: MONEY_GO_SHA256,
      },
      'wire-fixtures-live',
    )
    await live.initialize()
    await live.callTool('request_purchase', {
      publisher_user_id: 'pub-1',
      agent_id: 'agent-1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'Fixture purchase',
    })
    captured.push({
      label: 'request_purchase (decimal amount → integer amount_cents, merchant → merchant_ref)',
      struct_hint: 'apps/api/api/v1/purchases.go create request struct',
      ...describeLast(mock, 'POST', '/v1/purchases'),
    })

    // /!\ THE CHECKOUT TOOLS LIVE HERE AND NOT IN THE SANDBOX BLOCK, and finding that out was the
    // first thing this expansion measured. index.ts registers createCheckoutTools ONLY under
    // `isLive && moneyGo` — the backend rejects sandbox keys on that route — so capturing them with
    // a sandbox client produced "the tool never called it", which is the harness telling the truth
    // about a mode boundary rather than a broken fixture. Worth writing down: which MODE a tool
    // exists in is part of its contract, and the fixture file is now the only place that records it
    // for these two.
    await live.callTool('get_checkout_cardholder', { purchase_id: 'pur_fixture_3' })
    captured.push({
      label: 'get_checkout_cardholder (LIVE + money-GO only; shares one route with get_checkout_customer)',
      struct_hint: 'apps/api/api/v1/purchases.go checkout-identity route',
      ...describeLast(mock, 'GET', '/v1/purchases/pur_fixture_3/checkout-identity'),
    })

    await live.callTool('get_checkout_customer', { purchase_id: 'pur_fixture_4' })
    captured.push({
      label: 'get_checkout_customer (LIVE + money-GO only; same route, different half of the response)',
      struct_hint: 'apps/api/api/v1/purchases.go checkout-identity route',
      ...describeLast(mock, 'GET', '/v1/purchases/pur_fixture_4/checkout-identity'),
    })
    live.close()

    // ── Onboarding, behind its deploy flag ──────────────────────────────────
    const onboarding = new McpTestClient(
      {
        SHATALE_API_KEY: 'sk_sandbox_mock',
        SHATALE_API_URL: mock.url,
        SHATALE_ONBOARDING_ENABLED: 'true',
      },
      'wire-fixtures-onboarding',
    )
    await onboarding.initialize()
    await onboarding.callTool('register_user_profile', {
      publisher_user_id: 'pub-1',
      user_claims: { email: 'fixture@test.shatale.com', name: 'Fixture User', country: 'FR' },
      intended_use: 'purchase',
    })
    captured.push({
      label: 'register_user_profile',
      struct_hint: 'apps/api/api/v1/onboarding.go register request struct',
      ...describeLast(mock, 'POST', '/v1/onboarding/register'),
    })

    await onboarding.callTool('get_onboarding_status', { session_id: 'sess_fixture_1' })
    captured.push({
      label: 'get_onboarding_status',
      struct_hint: 'apps/api/api/v1/onboarding.go session status route',
      ...describeLast(mock, 'GET', '/v1/onboarding/sessions/'),
    })
    onboarding.close()
  })

  afterAll(async () => {
    await mock.close()
  })

  test('every captured request actually reached the upstream', () => {
    // A request that was never sent would serialise as silence and then "match" a fixture
    // regenerated from the same silence. Assert presence before asserting shape.
    //
    // /!\ THE BODY CHECK IS NOW PER-METHOD, and the change is not cosmetic. It used to demand an
    // object body from every fixture, which is true of a write and FALSE of a read — and of
    // sandbox_approve_purchase, a POST whose whole request is its path. Keeping the old blanket
    // assertion would have forced the reads to be left out, which is how the gap being closed here
    // stayed open: the shape of the check decided the shape of the coverage.
    for (const f of captured) {
      expect(f.method, `${f.label} never left the client`).toBeTruthy()
      expect(f.path, `${f.label} reached no path`).toMatch(/^\/v1\//)
      if (f.method === 'GET') {
        expect(f.body, `${f.label} is a GET and must send no body`).toBeUndefined()
      }
    }
  })

  test('mcc leaves as a STRING for both spellings (the 0.2.1 / 0.5.0 regression pin)', () => {
    const sandboxBodies = captured
      .filter((f) => f.path === '/v1/sandbox/authorizations')
      .map((f) => f.body as Record<string, unknown>)
    expect(sandboxBodies).toHaveLength(2)
    for (const body of sandboxBodies) {
      expect(typeof body.mcc).toBe('string')
      expect(body.mcc).toBe('5691')
    }
  })

  test('the wire bodies match the committed fixtures', () => {
    const current = captured.map((f) => ({ ...f, body: normalise(f.body) }))

    if (process.env.UPDATE_WIRE_FIXTURES === '1') {
      mkdirSync(FIXTURE_DIR, { recursive: true })
      writeFileSync(FIXTURE_FILE, JSON.stringify(current, null, 2) + '\n')
      // Regenerating and passing in the same run would let a drifting contract rewrite its
      // own expectation and stay green. The run is a regeneration, not a verification.
      throw new Error('Fixtures regenerated. Review the diff, commit it, and re-run WITHOUT UPDATE_WIRE_FIXTURES.')
    }

    if (!existsSync(FIXTURE_FILE)) {
      throw new Error(
        `No fixture file at ${FIXTURE_FILE}. Generate it with UPDATE_WIRE_FIXTURES=1 — ` +
          'a missing contract is a failure, not a pass.',
      )
    }

    const expected = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as WireFixture[]
    // Deep equality, so a renamed field, a changed type (5691 vs "5691"), an added field or
    // a moved route all read as a diff on a committed file.
    expect(current).toEqual(expected)
  })

  /**
   * /!\ SHAT-1455's ACTUAL SUBJECT: not "add more fixtures" but "a tool cannot ship without one".
   *
   * Six fixtures covering five tools looked like a fixture layer, and the twelve tools with nothing
   * pinning their route looked exactly the same from outside — which is the whole failure mode. A
   * hand-written set silently excludes everything added after it, and the exclusion is
   * indistinguishable from coverage. The same shape put four deterministic test files outside the
   * only suite that gates a pull request (SHAT-1325) and let a coverage matrix report 17/17 while
   * the code defined 20 (SHAT-2527).
   *
   * So: every tool in the roster either sends a request and has a fixture, or is listed here as
   * offline WITH a reason. A new tool that calls the API and is not captured fails this test by
   * existing.
   */
  test('every tool that calls the API has a wire fixture', () => {
    // The roster of record, read from the source rather than from a list somebody maintains.
    const toolSrc = readdirSync(resolve(import.meta.dirname, '../../src/tools'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(resolve(import.meta.dirname, '../../src/tools', f), 'utf8'))
      .join('\n')
    const roster = [...toolSrc.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]).sort()

    // Positive control on the read: an empty roster satisfies the assertion trivially and for ever.
    expect(
      roster.length,
      'no tool names were parsed out of src/tools — the search is broken, not the tree, and this ' +
        'check would pass while measuring nothing',
    ).toBeGreaterThan(10)

    /** Tools that reach no network at all, and why. Each entry is a claim somebody can check. */
    const offline: Record<string, string> = {
      explain_shatale: 'renders text from the process state — mode, tool roster, recommended prompt',
      simulate_purchase_flow: 'the guest simulator; evaluatePurchase is pure and deterministic',
      generate_policy_template: 'builds and validates a policy object locally',
      list_capabilities: 'reports the live tool roster from memory',
    }

    const captured_tools = new Set(captured.map((f) => f.label.split(' ')[0]))
    const missing = roster.filter((t) => !captured_tools.has(t) && !(t in offline))

    expect(
      missing,
      `these tools have no wire fixture and are not declared offline:\n  ${missing.join('\n  ')}\n\n` +
        `A tool with nothing pinning its route drifts in the way that survives CI: the mock upstream ` +
        `is on THIS side of the contract, so it answers whatever this side asks. A renamed query ` +
        `parameter or a path segment moved into the query is green here and a 404 in production.\n\n` +
        `Add a capture in beforeAll and regenerate with UPDATE_WIRE_FIXTURES=1 — or, if the tool ` +
        `genuinely makes no request, add it to \`offline\` WITH the reason. A list of names without ` +
        `reasons beside them is a list nobody can ever shorten.`,
    ).toEqual([])

    // The other direction: an `offline` entry for a tool that HAS a fixture is a stale claim, and a
    // stale exemption is inherited silently by whatever is renamed into that slot next.
    const wrongly_offline = Object.keys(offline).filter((t) => captured_tools.has(t))
    expect(
      wrongly_offline,
      `these tools are declared offline but WERE captured making a request: ${wrongly_offline.join(', ')}`,
    ).toEqual([])

    // And an `offline` entry for a tool that no longer exists.
    const gone = Object.keys(offline).filter((t) => !roster.includes(t))
    expect(gone, `these offline entries name tools that no longer exist: ${gone.join(', ')}`).toEqual([])
  })
})

/** Pull the most recent captured request for a route and shape it as a fixture record. */
function describeLast(mock: MockUpstream, method: string, pathPrefix: string) {
  const req = mock.lastRequest(method, pathPrefix)
  if (!req) throw new Error(`No ${method} ${pathPrefix} reached the mock upstream — the tool never called it.`)
  const out: { method: string; path: string; body: unknown; query?: Record<string, string> } = {
    method: req.method,
    path: req.path,
    body: req.body,
  }
  // Only when there is one, so the 6 existing write fixtures keep their exact committed shape and
  // this change shows up as additions rather than as a rewrite of every record.
  if (Object.keys(req.query).length > 0) out.query = req.query
  return out
}
