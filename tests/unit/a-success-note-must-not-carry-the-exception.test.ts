/**
 * A note attached to a SUCCESS must not carry the exception's own text.
 *
 * ⚠️ THE REDACTION GUARDS THE ERROR BRANCH, AND THIS WALKED PAST IT AS "SUCCESS WITH A NOTE".
 *
 * Everything in src/errors.ts exists to keep raw caught detail away from the agent: `errorResult`
 * echoes nothing by construction, and the unknown-cause sweep
 * (an-unknown-cause-must-not-name-a-culprit.test.ts) holds every tool to it. `list_mcc_codes` was
 * outside that sweep for a structural reason — it does not FAIL. `listMCCCodes` catches its own
 * error and serves the package's built-in ISO 18245 list, so there is no error result to inspect.
 *
 * MEASURED against the published 1.0.2 and reproduced on main, with SHATALE_API_URL pointed at a
 * URL containing credentials:
 *
 *   "_note": "... the lookup failed (Request cannot be constructed from a URL that includes
 *             credentials: http://user:URLCANARY_5e77@127.0.0.1:9/v1/mcc-codes). ..."
 *   isError: undefined
 *
 * The password reached the agent's context inside a result flagged as success — so nothing
 * downstream (transcript, tool-result logs, the model's own summary) had any reason to treat it as
 * sensitive. The API key is not in that string, because it travels in a header; but "which secret
 * does the exception happen to carry today" is not a safety property, and the text is not ours —
 * it comes from fetch, from the resolver, from whatever throws next release.
 *
 * ⚠️ BOTH HALVES ARE ASSERTED, AND THAT IS DELIBERATE. An absence check alone is satisfied by
 * deleting the note, and deleting the note restores an OLDER defect: the fallback used to be
 * silent, so a built-in answer read exactly as if the server had said it. The agent must still
 * learn that the list did not come from the API and may be stale. So: the canary is absent AND the
 * built-in signal is present AND the codes are still served.
 *
 * ⚠️ AND THE CANARY IS PROVED TO BE A REAL ONE BEFORE ITS ABSENCE MEANS ANYTHING. An absence
 * assertion against a string that never appears anywhere is green for free. The first test below is
 * the positive control: it makes the same request the client makes and shows the raw exception
 * really does contain the canary. If a future runtime stops putting it there, THAT test fails —
 * loudly, saying the canary is dead — instead of the suite quietly certifying nothing.
 */

import { describe, test, expect, beforeAll, vi, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { ShataleClient } from '../../src/client.js'
import { createCommonTools } from '../../src/tools/common.js'
import { BUILT_IN_MCC_NOTE, MALFORMED_QUERY } from '../../src/errors.js'
import type { GuestContext } from '../../src/tools/guest.js'
import type { ToolCallResult } from '../../src/types.js'

// A password that cannot occur by accident and is recognisable in any haystack. Port 9 is the
// discard port on loopback: this test reaches no network under any outcome.
const CANARY = 'URLCANARY_5e77'
const URL_WITH_CREDENTIALS = `http://user:${CANARY}@127.0.0.1:9`

const CTX: GuestContext = {
  isGuest: false,
  isSandbox: true,
  moneyEnabled: false,
  getToolNames: () => ['list_mcc_codes'],
}

function handlerFor(baseUrl: string) {
  // 2s, not the 30s default: every call here is meant to fail, and the failure is immediate anyway.
  const client = new ShataleClient(baseUrl, 'sk_sandbox_probe', 2_000)
  return createCommonTools(client, CTX).handlers.list_mcc_codes
}

/** Everything the agent receives, as one string — the note, the body, and any stray field. */
function wholeResult(r: ToolCallResult): string {
  return JSON.stringify(r)
}

// ── Positive control ────────────────────────────────────────────────────────────────────────────
// Without this, every assertion below could pass because the canary was never reachable at all.
describe('the canary is real: this URL does produce an exception carrying the password', () => {
  test('fetch rejects with the credentials embedded in its message', async () => {
    let caught: unknown
    try {
      await fetch(`${URL_WITH_CREDENTIALS}/v1/mcc-codes?q=gambling`)
    } catch (err) {
      caught = err
    }
    expect(caught, 'the probe URL did not throw — the canary cannot be planted this way any more').toBeInstanceOf(Error)
    expect(
      (caught as Error).message,
      'the runtime no longer puts the URL in this exception — this canary is dead and the ' +
        'absence assertions below have stopped measuring anything. Pick a new one.',
    ).toContain(CANARY)
  })
})

// ── The defect ──────────────────────────────────────────────────────────────────────────────────
describe('list_mcc_codes falls back to the built-in list', () => {
  let result: ToolCallResult
  let body: Record<string, unknown>

  beforeAll(async () => {
    result = await handlerFor(URL_WITH_CREDENTIALS)({ query: 'gambling' })
    body = JSON.parse(result.content[0].text) as Record<string, unknown>
  })

  test('and the answer is still a success, not an error', () => {
    // Stated so the test is honest about which branch it is inspecting: this is the SUCCESS path,
    // which is exactly why src/errors.ts never saw it.
    expect(result.isError).toBeFalsy()
  })

  // ── half one: the exception's text is gone ────────────────────────────────────────────────────
  test('without leaking the caught exception into the agent context', () => {
    expect(
      wholeResult(result),
      'the caught error text reached the agent inside a successful result',
    ).not.toContain(CANARY)
  })

  test('and not by any other spelling of the same leak', () => {
    const text = wholeResult(result)
    // The measured message, minus the secret: if any recognisable fragment of the runtime's prose
    // survives, the note is still relaying an exception rather than stating a fact.
    for (const fragment of ['Request cannot be constructed', 'includes credentials', '127.0.0.1']) {
      expect(text, `the note still quotes the exception ("${fragment}")`).not.toContain(fragment)
    }
  })

  // ── half two: the signal the agent needs is still there ───────────────────────────────────────
  // Without these, the tests above are satisfied by returning nothing at all — which would restore
  // the older defect this note was added to fix.
  test('while still saying the list did NOT come from the API', () => {
    expect(body._source, 'the built-in provenance marker was dropped').toBe('built-in')
    expect(body._note, 'the note was dropped — a silent fallback reads as a server answer').toBe(BUILT_IN_MCC_NOTE)
  })

  test('and the note states all three facts an agent has to act on', () => {
    const note = String(body._note).toLowerCase()
    expect(note, 'the note does not say the lookup failed').toMatch(/lookup failed|could not be reached/)
    expect(note, 'the note does not say where the data came from').toMatch(/built-in/)
    expect(note, 'the note does not warn the list can be behind the server').toMatch(/will not appear|stale|out of date/)
  })

  test('and the fallback still serves the codes it was asked for', () => {
    // The fix must not "solve" the leak by failing the call. A stale-but-correct MCC list beats no
    // list at all — that is why the fallback exists.
    const codes = body.codes as Array<{ code: number }>
    expect(Array.isArray(codes)).toBe(true)
    expect(codes.map((c) => c.code)).toContain(7995)
  })
})

// ── The other half of the same fix: the detail must still exist SOMEWHERE ───────────────────────
//
// ⚠️ THE LEAK WAS CLOSED BY THROWING THE DETAIL AWAY, AND THE NOTE WENT ON PROMISING IT.
//
// Removing `err` from the catch stopped the exception reaching the agent — which was the point —
// but the caught error was then bound to nothing and dropped. Meanwhile the note told the operator
// "the server-side log has the detail". For the most common causes of this branch there IS no
// server-side log: a DNS failure, a refused connection or a timeout never reached a server, so no
// server wrote a line about it. The only place that detail ever existed was this process, and the
// fix deleted it. An operator following that sentence goes looking through backend logs for an
// event that was never emitted, and concludes the deployment is fine.
//
// stderr is the right channel and this package already uses it for exactly this class of operator
// message (src/index.ts refuses to start and says why on stderr). Under stdio MCP the protocol owns
// stdout; stderr goes to the host's own log and never enters the model's context — so the operator
// can have the detail without the agent getting it. That separation is what BOTH assertions below
// hold in place at once: present on stderr, absent from the result.
describe('the caught detail reaches the operator, and only the operator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('the note does not promise a log that does not exist for this failure', () => {
    // A DNS failure, a refused connection and a timeout produce no server-side record anywhere.
    // Pointing the reader at one is a wrong diagnosis dressed as a next step.
    expect(
      BUILT_IN_MCC_NOTE,
      'the note still sends the operator to a "server-side log" — the usual causes of this branch ' +
        '(DNS, connection refused, timeout) never reached a server, so nothing there logged them.',
    ).not.toMatch(/server-side log/i)
  })

  test('the note points at a place the detail is actually written', () => {
    expect(
      BUILT_IN_MCC_NOTE.toLowerCase(),
      'the note says the reason is not reported to the agent but never says where it IS reported. ' +
        'The operator is left with no next step at all, which is the defect the old sentence was ' +
        'trying to avoid.',
    ).toMatch(/stderr|this server's log|the server's own log/)
  })

  test('the caught exception is written to stderr, where the operator can read it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handlerFor(URL_WITH_CREDENTIALS)({ query: 'gambling' })

    expect(
      spy.mock.calls.length,
      'nothing was logged. The catch drops the error entirely, so the one and only copy of why ' +
        '/v1/mcc-codes could not be reached is destroyed at the moment it is caught — and the ' +
        'fallback then answers as a success, so nothing downstream reports a problem either.',
    ).toBeGreaterThan(0)

    const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged, 'the log line does not name the tool whose lookup failed').toMatch(/mcc/i)
    expect(
      logged,
      'the log line does not carry the caught reason, so it says no more than the note already did',
    ).toContain(CANARY)
  })

  // ⚠️ AND "A REASON WAS LOGGED" IS NOT THE SAME CLAIM AS "THE REASON WAS LOGGED".
  //
  // The note now promises the operator that this server writes the reason to stderr. Node's fetch
  // does not put the reason in `err.message`: every network failure arrives as the same five
  // characters, `fetch failed`, with the thing that actually happened — ECONNREFUSED, ENOTFOUND,
  // a timeout — hidden one level down in `err.cause`. Measured against a dead loopback port before
  // this was handled, the whole line read "Reason: fetch failed".
  //
  // That is the original defect wearing the fix's clothes: DNS, refused and timeout are the three
  // causes the note names as the reason a server-side log would not have this, and they were
  // exactly the three the log could not tell apart. So the cause chain is flattened, and this test
  // is what stops it silently collapsing back to the generic message.
  test('the logged reason names the underlying cause, not just "fetch failed"', async () => {
    // ⚠️ NOT PORT 9, WHICH THE REST OF THIS FILE USES. Port 9 is on the fetch spec's BLOCKED-PORT
    // list, so undici refuses it before opening a socket and the cause reads "bad port" — a real
    // cause, but not the one operators actually meet. A port that is merely CLOSED gives the
    // ordinary ECONNREFUSED. Bound and released so the number is known to be free rather than
    // assumed, and it is on loopback either way: no packet leaves the machine.
    const port = await new Promise<number>((res) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port
        srv.close(() => res(p))
      })
    })

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handlerFor(`http://127.0.0.1:${port}`)({ query: 'gambling' })

    const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged, 'nothing was logged for a connection failure').toMatch(/mcc/i)
    expect(
      logged,
      `the log line stops at Node's generic wrapper and never reaches err.cause, so every DNS ` +
        `failure, refused connection and timeout produces the same unusable sentence. Logged: ` +
        `"${logged}"`,
    ).toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect /)
  })

  test('and that stderr line does not also travel to the agent', async () => {
    // The two assertions are a pair on purpose. Satisfying the one above by putting the detail back
    // into `_note` would reopen SHAT-2686 exactly as it was.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handlerFor(URL_WITH_CREDENTIALS)({ query: 'gambling' })
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    expect(
      wholeResult(result),
      'the detail was routed to stderr AND left in the tool result — the leak is unchanged',
    ).not.toContain(CANARY)
  })
})

// ── The second raw echo, at src/tools/common.ts ─────────────────────────────────────────────────
// This catch was believed unreachable, "because listMCCCodes swallows its own failures". It is
// reachable: the query string is built OUTSIDE that try, so `encodeURIComponent` throws past the
// fallback. Measured on main: `API error: URI malformed`.
describe('a query that cannot be put on a URL', () => {
  const LONE_SURROGATE = '\uD800'

  test('positive control: this really does throw, and this really is its text', () => {
    let caught: unknown
    try {
      encodeURIComponent(LONE_SURROGATE)
    } catch (err) {
      caught = err
    }
    expect(caught, 'the lone surrogate no longer throws — this route is no longer testable this way').toBeInstanceOf(URIError)
    expect((caught as Error).message).toBe('URI malformed')
  })

  test('is refused without the exception being quoted back', async () => {
    const result = await handlerFor('http://127.0.0.1:9')({ query: LONE_SURROGATE })
    expect(result.isError).toBe(true)
    expect(wholeResult(result), 'the raw exception text reached the agent').not.toContain('URI malformed')
  })

  test('and is answered with the cause we actually know, not with a guess about the deployment', async () => {
    const result = await handlerFor('http://127.0.0.1:9')({ query: LONE_SURROGATE })
    const { error } = JSON.parse(result.content[0].text) as {
      error: { code: string; message: string; suggested_fix: string }
    }
    expect(error.code).toBe(MALFORMED_QUERY.code)
    // ⚠️ THE OTHER HALF AGAIN. Routing this through the unknown-cause text would have satisfied
    // "no raw echo" while telling the agent to go and check whether the API is reachable — when
    // our own encode call threw before a single byte was sent. That is the misdiagnosis SHAT-2678
    // removed from the opposite direction, and it must not come back through this door.
    expect(error.suggested_fix).not.toMatch(/SHATALE_API_URL|reach|deployment/i)
    expect(`${error.message} ${error.suggested_fix}`).toMatch(/quer/i)
  })
})
