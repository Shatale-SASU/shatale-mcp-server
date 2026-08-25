import { describe, test, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'

// SHAT-1686 — the derived credential idempotency key, and the window it is reused for.
//
// It USED TO carry a wall-clock hourly bucket, `floor(now / 3_600_000)`, under a comment claiming
// "rapid retries within the hour de-dup (no accidental double-mint), while a later legitimate
// re-request gets a fresh key". The first half was false at the one place a grid can fail — its
// boundary — and false for the retry most likely to be an accident: an immediate one. The first
// test below is the measurement, and it FAILED on the old code before anything was changed.
//
// ⚠️ THE TICKET'S OWN PROPOSED FIX WOULD NOT HAVE FIXED IT. "A principled TTL-aligned window" moves
// the boundary; it does not remove one. Any `floor(now / period)` splits two calls that straddle a
// multiple of `period`, however small the gap between them. The defect is the GRID, not its size —
// so changing the size would have closed the ticket and left the failure in place.
//
// The window is now ANCHORED to the first request of each (user, agent, merchant, purpose), so
// there is no boundary to straddle, and it lasts one credential lifetime, so nothing is replayed
// after it has expired. These tests pin both ends and the two ways of getting a different key.

const BASE = 'http://127.0.0.1:9'

function captureBody() {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function keyOf(fn: ReturnType<typeof vi.fn>, call: number): string {
  const init = fn.mock.calls[call][1] as RequestInit
  return JSON.parse(init.body as string).idempotency_key
}

const input = {
  publisher_user_id: 'pub-user-1',
  agent_id: 'agent-1',
  merchant_domain: 'example.com',
  purpose: 'signup',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SHAT-1686 the derived credential key', () => {
  // The claim the comment makes, at the moment it is false. Two calls TWO SECONDS apart get
  // different keys because a wall-clock hour ticked over between them — so the backend, whose only
  // de-dup is (agent_id, idempotency_key), mints a SECOND live credential for the same
  // (user, agent, merchant).
  test('does NOT de-dup a rapid retry that straddles the hour boundary', async () => {
    const fn = captureBody()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')

    vi.useFakeTimers()
    // 10:59:59 — one second before a bucket rolls over.
    vi.setSystemTime(new Date('2026-08-25T10:59:59.000Z'))
    await client.requestCredentials({ ...input })

    // 11:00:01 — two seconds later. To a person and to an agent, this is the same request retried.
    vi.setSystemTime(new Date('2026-08-25T11:00:01.000Z'))
    await client.requestCredentials({ ...input })

    expect(keyOf(fn, 0)).toBe(keyOf(fn, 1))
  })

  // The control, and the half that DOES hold: away from a boundary, a rapid retry de-dups. Without
  // it the test above is satisfied by a key that never changes, which is the eternal-replay defect
  // the bucket was introduced to avoid.
  test('DOES de-dup a rapid retry away from the boundary', async () => {
    const fn = captureBody()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T10:20:00.000Z'))
    await client.requestCredentials({ ...input })
    vi.setSystemTime(new Date('2026-08-25T10:20:02.000Z'))
    await client.requestCredentials({ ...input })

    expect(keyOf(fn, 0)).toBe(keyOf(fn, 1))
  })

  // The other half, and the reason the key cannot simply be time-free: a window that never ends
  // would replay an EXPIRED credential forever and permanently block re-issuing for this
  // (user, agent, merchant). So the window closes after one credential lifetime.
  //
  // /!\ THE WINDOW IS NOW THE SAME LENGTH AS THE CREDENTIAL, AND ANCHORED AT THE SAME MOMENT.
  // The old grid was one hour of WALL CLOCK while the backend's TTL is one hour FROM ISSUANCE
  // (credentials/service.go defaultTTL), so the two drifted apart by up to 59 minutes in either
  // direction. Anchoring the window to the first request makes them coincide: a replay inside the
  // window returns a credential that is still alive, and the moment it would not be, the window is
  // over.
  //
  // Within the window a late retry still receives a credential with only its remaining life. That
  // is not a defect — it is what idempotency MEANS: the same request gets the same answer, and the
  // answer was minted when the request was first made.
  test('derives a FRESH key once the window has passed', async () => {
    const fn = captureBody()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T10:01:00.000Z'))
    await client.requestCredentials({ ...input })

    // One hour and a minute later: the first credential has expired, so replaying its key would
    // hand back something dead.
    vi.setSystemTime(new Date('2026-08-25T11:02:00.000Z'))
    await client.requestCredentials({ ...input })

    expect(keyOf(fn, 0)).not.toBe(keyOf(fn, 1))
  })

  // A different (user, agent, merchant, purpose) is a different credential and must never share a
  // key — otherwise one agent's request would replay another's credential.
  test('a different tuple never shares a key', async () => {
    const fn = captureBody()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T10:20:00.000Z'))
    await client.requestCredentials({ ...input })
    await client.requestCredentials({ ...input, merchant_domain: 'other.example' })

    expect(keyOf(fn, 0)).not.toBe(keyOf(fn, 1))
  })

  // An explicit key always wins — the caller who knows what it is retrying is never second-guessed.
  test('an explicit idempotency_key is used verbatim', async () => {
    const fn = captureBody()
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')
    await client.requestCredentials({ ...input, idempotency_key: 'caller-chose-this' })
    expect(keyOf(fn, 0)).toBe('caller-chose-this')
  })
})
