import { jsonResult, type ToolCallResult } from './types.js'

/**
 * SHAT-1463: structured error envelope surfaced to the calling agent.
 *
 * Every tool error is reported as `{ error: { code, message, suggested_fix, request_id? } }`
 * so the LLM gets a stable machine-readable `code` plus an actionable `suggested_fix` instead of an
 * opaque prose string. Raw upstream bodies are never echoed — the messages are fixed, leak-safe text.
 *
 * /!\ AND `request_id` IS THE HANDLE BACK TO THE RECORD OF THIS CALL, which is the whole of
 * SHAT-1468 and the thing 1469/1470 are the same subject as.
 *
 * The backend has always sent it: `writeErrorCtx` (apps/api/api/v1/authorizations.go) puts
 * `request_id` in every error body, and on a REDACTED 5xx it mints a correlation id specifically so
 * the message the client sees can be stripped while the real detail stays findable in the server log
 * (`logRedactedError`). client.ts threw the whole body away, so the one field that existed to make a
 * failure traceable never left the process.
 *
 * /!\ AND READING IT DOES NOT WEAKEN THE REDACTION, WHICH IS THE OBJECTION TO ANSWER. The rule is
 * "upstream error DETAIL never reaches the agent", and it is kept by extracting exactly one field by
 * name and discarding the rest of the body unread — never `error`, never `detail`, never a message.
 * An id is a pointer to a record; the detail stays where only a person with access can read it.
 * Widening this whitelist re-opens the leak that `publicErrorMessage` exists to close.
 */
export interface StructuredError {
  code: string
  message: string
  suggested_fix: string
  /** The server-side correlation id for THIS call, when the backend sent one. */
  request_id?: string
}

export class ShataleApiError extends Error {
  readonly code: string
  readonly suggested_fix: string
  readonly request_id?: string

  constructor(err: StructuredError) {
    super(err.message)
    this.name = 'ShataleApiError'
    this.code = err.code
    this.suggested_fix = err.suggested_fix
    this.request_id = err.request_id
  }

  toStructured(): StructuredError {
    const out: StructuredError = { code: this.code, message: this.message, suggested_fix: this.suggested_fix }
    if (this.request_id) out.request_id = this.request_id
    return out
  }
}

/**
 * Pull ONLY the correlation id out of an upstream error body.
 *
 * A whitelist of one field, by name. Everything else in that body is upstream detail and must not
 * be read, let alone forwarded — see the note above. Returns undefined for anything that is not a
 * plain non-empty string, so a hostile or malformed body cannot smuggle an object or a novel through
 * this field.
 */
export function extractRequestId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const id = (body as Record<string, unknown>).request_id
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 128) return undefined
  return trimmed
}

/**
 * What the code that BUILT a request path knows about that path, carried alongside the request so a
 * failure does not have to be reconstructed from the string afterwards.
 *
 * Stated at the call site, never inferred. `unknown` is the default on purpose: a call that says
 * nothing gets an answer admitting both possibilities, rather than a confident half.
 */
export type RequestAddressing =
  /** The path carries an id the CALLER supplied; this client only interpolated it. */
  | 'caller-id'
  /** Every character of the address was composed here; the caller contributed no part of it. */
  | 'fixed'
  /** Nobody said. Answer with both possibilities. */
  | 'unknown'

/**
 * The three answers to "the server said 404", one per thing we actually know about the address.
 *
 * A table rather than a ternary, so a fourth kind of knowledge cannot compile until it has a
 * sentence of its own, and so each sentence sits next to the ones it must not contradict.
 */
const NOT_FOUND_FIX: Record<RequestAddressing, string> = {
  'caller-id':
    'Verify the id in the path — pass the id returned by the create call (purchase_id, session_id, etc.). ' +
    'One 404 covers an id that never existed, one belonging to another publisher, and one from the other ' +
    'environment (a sandbox id is not visible to a live key, or the reverse). If the id is right, the route ' +
    'may not be deployed on the environment SHATALE_API_URL points at.',
  fixed:
    'This route is not available on the connected deployment — nothing in your request is wrong. Check SHATALE_API_URL points at the right environment, and that the feature is released there.',
  unknown:
    'This could be either, and nothing here can tell which: an id in the request that does not resolve, or a ' +
    'route that is not deployed on the connected deployment. If the request carried an id, verify that first; ' +
    'otherwise check SHATALE_API_URL points at the right environment.',
}

/**
 * What the caller is RUNNING WITH. It exists because the auth advice used to be written for one of
 * the three: every 401 and every 403 told the reader to "set SHATALE_API_KEY to a valid sandbox
 * key". Under a live key that instruction is destructive — the server refuses to start with
 * SHATALE_MODE=live and a non-live key (src/index.ts), so following it stops the integration, and
 * dropping the mode flag instead silently demotes production to demo.
 */
export type KeyKind = 'none' | 'sandbox' | 'live'

const GET_A_KEY = 'Get a free one at https://admin.shatale.com/register?ref=mcp'

/**
 * Map an HTTP status into a structured, leak-safe error.
 *
 * `addressing` is what the CALL SITE knows about the path (see {@link RequestAddressing}). Omitting
 * it is not an error — it means the 404 answer names both causes instead of one.
 *
 * `keyKind` is what the process holds (see {@link KeyKind}), and it decides whether the auth advice
 * is safe to follow.
 */
export function mapHttpError(
  status: number,
  method: string,
  path: string,
  requestId?: string,
  // ⚠️ ONE NAMED BAG, NOT TWO POSITIONAL SLOTS, AND THE REASON IS FRESH. These two arrived in
  // separate branches and met in a merge: the fifth argument meant `keyKind` in one and
  // `addressing` in the other, both are string unions, and the tests kept compiling while passing
  // 'live' where the environment expected 'caller-id'. Two adjacent parameters that describe
  // different knowledge, in the same shape, is an invitation to swap them silently.
  known: { addressing?: RequestAddressing; keyKind?: KeyKind } = {},
): ShataleApiError {
  const addressing: RequestAddressing = known.addressing ?? 'unknown'
  const keyKind: KeyKind = known.keyKind ?? 'none'
  const withId = (e: StructuredError) => new ShataleApiError(requestId ? { ...e, request_id: requestId } : e)
  // 401 and 403 are different answers and were sharing one. 401: the key was not accepted. 403: it
  // WAS accepted, and this principal may not have this resource — a scope, or someone else's
  // record. Telling a 403 to replace its key sends the reader to fix the one thing that worked.
  if (status === 403) {
    return withId({
      code: 'forbidden',
      message: 'The key was accepted, but it is not allowed to do this.',
      suggested_fix:
        'This is not a bad key — do not replace it. Check that the ids in the request belong to the ' +
        'publisher this key belongs to, and that the key carries the scope this route needs.',
    })
  }
  if (status === 401) {
    return withId({
      code: 'auth_failed',
      message: 'Authentication failed.',
      suggested_fix:
        keyKind === 'live'
          ? 'The live key was not accepted. Check it is current and that SHATALE_API_URL points at ' +
            'production. Do NOT swap in a sandbox key while SHATALE_MODE=live — the server refuses ' +
            'to start on that combination, and dropping the mode flag would quietly move you off ' +
            'production.'
          : keyKind === 'sandbox'
            ? 'The sandbox key was not accepted. Check it is current and that SHATALE_API_URL points ' +
              'at the environment that issued it.'
            : `Set SHATALE_API_KEY to a valid sandbox key (sk_sandbox_*). ${GET_A_KEY}`,
    })
  }
  if (status === 404) {
    // /!\ WHO IS BLAMED FOR A 404 IS DECIDED AT THE CALL SITE, NOT BY THE SHAPE OF THE PATH — AND
    // THIS HAS NOW BEEN WRONG IN BOTH DIRECTIONS (SHAT-2678).
    //
    // First it sent EVERY 404 hunting for a bad id, which is nonsense for a genuine create: POST
    // /v1/purchases carries no id to verify. The correction guessed "creating" from the string —
    // POST, plus a last segment with no "id" in it — which reads the wrong end of the path. POST
    // /v1/sandbox/purchases/{purchaseId}/approve and POST /v1/sandbox/users/{userId}/onboarding
    // both carry a caller-supplied id in the MIDDLE and both end in a verb, so both classified as
    // creates and both were answered "nothing in your request is wrong". A 404 on either
    // overwhelmingly means the id is wrong: apps/api api/v1/sandbox.go answers absent, another
    // publisher's, and wrong-environment with one indistinguishable 404. An agent told its request
    // is blameless stops examining the one thing it can fix and reports a misconfiguration instead.
    //
    // The same guess was wrong in the other direction for every id-less GET: GET /v1/mcc-codes and
    // GET /v1/merchants/catalog were both told to "verify the id" when neither has one.
    //
    // No path string can settle this, because the answer is not in the string: `/v1/purchases` and
    // `/v1/sandbox/purchases/{id}/approve` are both "POST ending in a word". What knows is the code
    // that BUILT the path — it either interpolated a caller's id or it did not. So the fact rides
    // along with the request (`addressing`), instead of being reconstructed from its remains, and
    // where nobody stated it we name both causes rather than pick a side.
    return withId({
      code: 'not_found',
      message: `Resource not found (${method} ${path}).`,
      suggested_fix: NOT_FOUND_FIX[addressing],
    })
  }
  if (status === 429) {
    return withId({
      code: 'rate_limited',
      message: 'Rate limit exceeded.',
      suggested_fix: 'Wait a few seconds before retrying. Avoid tight polling loops on get_*_status.',
    })
  }
  if (status >= 500) {
    return withId({
      code: 'upstream_error',
      message: `Shatale API server error (HTTP ${status}).`,
      suggested_fix: 'This is a transient server-side issue. Retry shortly; if it persists, contact support@shatale.com.',
    })
  }
  return withId({
    code: 'api_error',
    message: `API request failed (HTTP ${status}).`,
    suggested_fix: 'Check your API key and request parameters, then retry.',
  })
}

/**
 * A refusal the CLIENT itself decided, where the cause is known and the advice is earned.
 *
 * Kept separate from {@link errorResult} on purpose. Both used to be the same call, and the shared
 * shape is what hid the defect below: one path knows why it failed, the other does not, and only
 * one of them may name a cause.
 */
export function refusal(structured: StructuredError): ToolCallResult {
  return jsonResult({ error: structured }, true)
}

/**
 * The ONE text for "the call failed and nothing is known about why".
 *
 * Exported so a test can assert that every tool produces exactly this, rather than each tool being
 * trusted to write a neutral sentence of its own. Fourteen private sentences is how the class came
 * about; one shared sentence is what keeps it gone.
 */
export const UNKNOWN_CAUSE = {
  message: 'The request did not complete, and no reply came back to say why.',
  suggested_fix:
    'No reply arrived, so nothing in the request has been judged. Retry, and if it keeps failing, ' +
    'look at whether the API endpoint (SHATALE_API_URL) can be reached from here — the deployment, ' +
    'not the call.',
} as const

/**
 * ⚠️ THE ONE TEXT FOR "THE LOOKUP FAILED AND WE SERVED THE BUILT-IN LIST INSTEAD" — AND IT LIVES
 * HERE, IN THE ERROR-TEXT MODULE, BECAUSE THE LEAK IT CLOSES CAME IN THROUGH A *SUCCESS*.
 *
 * Everything else in this file guards the error branch: `errorResult` echoes nothing by
 * construction, and the tools were swept once already to make sure they all go through it. The MCC
 * fallback walked straight past that guard by not being an error. `listMCCCodes` catches its own
 * failure, serves the built-in ISO 18245 list, and — measured against the published 1.0.2 — pasted
 * the caught exception's own message into the `_note` of a result with `isError` unset:
 *
 *   "_note": "... the lookup failed (Request cannot be constructed from a URL that includes
 *             credentials: http://user:<password>@127.0.0.1:9/v1/mcc-codes). ..."
 *
 * A URL in SHATALE_API_URL with a password in it therefore reached the agent's context, the
 * transcript, and anything that logs tool results — flagged as success, so nothing downstream had
 * any reason to treat it as sensitive. The API key itself is a header, not part of the URL, so it
 * was not in that string; but "which secrets does an exception happen to carry today" is not a
 * safety property, and it is not one this package controls. The exception's text is not ours: it
 * comes from fetch, from the DNS resolver, from whatever throws next release.
 *
 * ⚠️ AND THE NOTE ITSELF IS NOT THE PROBLEM — DELETING IT WOULD BE A SECOND DEFECT. The fallback
 * used to be SILENT, which made a built-in answer read as if the server had said it. What the agent
 * needs is the FACT (the lookup failed, this is the packaged list, it can be stale), and the fact
 * fits in a fixed sentence. What it has no use for is the exception's prose.
 *
 * Exported so the test pins THIS text rather than restating a paraphrase of it, the way
 * {@link UNKNOWN_CAUSE} is.
 */
export const BUILT_IN_MCC_NOTE =
  'Served from this package\'s built-in ISO 18245 list, not from the API — the lookup failed. ' +
  'Codes are stable, but a code added server-side will not appear here, and the reason for the ' +
  'failure is not reported to the agent. If this matters, check that SHATALE_API_URL is reachable ' +
  'and that /v1/mcc-codes is deployed there; the server-side log has the detail.'

/**
 * The refusal for a `query` this process cannot put on a URL at all.
 *
 * ⚠️ NAMED, RATHER THAN SWEPT INTO {@link UNKNOWN_CAUSE}, BECAUSE THE CAUSE REALLY IS KNOWN HERE.
 * `encodeURIComponent` throws `URIError` on an unpaired surrogate, and it is OUR call that throws,
 * before any request is attempted — so nothing about the deployment is implicated. Answering this
 * with the unknown-cause text would send an agent to check whether the API is reachable when the
 * only thing wrong is the string it passed, which is the same misdiagnosis SHAT-2678 removed from
 * the other direction.
 */
export const MALFORMED_QUERY = {
  code: 'invalid_query',
  message: 'The search query is not valid text and cannot be placed in a URL.',
  suggested_fix:
    'Pass a plain text query (e.g. "gambling", "airline"). The string contained an unpaired ' +
    'surrogate — usually a truncated emoji or a sliced multi-byte character. Omit `query` to get ' +
    'the full list.',
} as const

/** The same, for the one non-answer we CAN name: our own timeout fired. */
export const TIMED_OUT = {
  // Not "the request was sent": one AbortController is armed before fetch, so it also covers DNS and
  // connect. An abort from a host that never accepted a connection means nothing was sent at all.
  message: 'No reply arrived before the timeout.',
  suggested_fix: UNKNOWN_CAUSE.suggested_fix,
} as const

/**
 * Convert a CAUGHT error into a structured, leak-safe tool error result.
 *
 * ⚠️ THE SECOND ARGUMENT IS A CODE, NOT A DIAGNOSIS, AND THAT IS THE WHOLE POINT. SHAT-2678.
 *
 * This used to take a whole `fallback: StructuredError`, and every tool wrote one as a sentence
 * about WHY the call failed: "Confirm the merchant, amount, and user details are valid, then
 * retry." But this branch is reached precisely when the error is NOT a ShataleApiError — when the
 * server never answered at all. Measured against the published package with an unreachable API: a
 * connection refused came back advising the caller to check the merchant and the amount. An agent
 * follows that: it edits a perfectly good request and retries into a void, and the one fact that
 * would end the loop — nobody is listening — is the fact the message replaced.
 *
 * A fallback is stated exactly where the cause is unknown, so it must not name a cause. Input
 * advice belongs to the branch where the SERVER rejected the input, which is `mapHttpError` — a
 * distinction this file already drew once, for the 404 that kept meaning "not deployed".
 *
 * Nothing from the caught error is echoed: a raw message can carry a URL, a path or a driver
 * string, and the agent has no use for it.
 */
export function errorResult(err: unknown, code: string): ToolCallResult {
  if (err instanceof ShataleApiError) return jsonResult({ error: err.toStructured() }, true)

  const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  return jsonResult({ error: { code, ...(timedOut ? TIMED_OUT : UNKNOWN_CAUSE) } }, true)
}
