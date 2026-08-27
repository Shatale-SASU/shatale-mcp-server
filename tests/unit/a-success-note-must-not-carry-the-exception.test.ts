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

import { describe, test, expect, beforeAll } from 'vitest'
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
