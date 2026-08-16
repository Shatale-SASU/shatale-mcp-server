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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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

    sandbox.close()

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
    onboarding.close()
  })

  afterAll(async () => {
    await mock.close()
  })

  test('every captured request actually reached the upstream', () => {
    // A body that was never sent would serialise as `undefined` and then "match" a fixture
    // regenerated from the same silence. Assert presence before asserting shape.
    for (const f of captured) {
      expect(f.method, `${f.label} never left the client`).toBeTruthy()
      expect(f.body, `${f.label} sent no body`).toBeTypeOf('object')
    }
    expect(captured).toHaveLength(6)
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
})

/** Pull the most recent captured request for a route and shape it as a fixture record. */
function describeLast(mock: MockUpstream, method: string, pathPrefix: string) {
  const req = mock.lastRequest(method, pathPrefix)
  if (!req) throw new Error(`No ${method} ${pathPrefix} reached the mock upstream — the tool never called it.`)
  return { method: req.method, path: req.path, body: req.body }
}
