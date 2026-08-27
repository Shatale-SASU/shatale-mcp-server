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

/** Map an HTTP status into a structured, leak-safe error. */
export function mapHttpError(status: number, method: string, path: string, requestId?: string): ShataleApiError {
  const withId = (e: StructuredError) => new ShataleApiError(requestId ? { ...e, request_id: requestId } : e)
  if (status === 401 || status === 403) {
    return withId({
      code: 'auth_failed',
      message: 'Authentication failed.',
      suggested_fix:
        'Set SHATALE_API_KEY to a valid sandbox key (sk_sandbox_*). Get a free one at https://admin.shatale.com/register?ref=mcp',
    })
  }
  if (status === 404) {
    // A 404 on a POST that creates something is not a missing id — there is no id in
    // the request to verify. The old advice ("pass the id returned by the create
    // call") sent a caller hunting for its own mistake when the truth was that the
    // route is not deployed, which is the failure it kept meaning in practice.
    const creating = method.toUpperCase() === 'POST' && !/\/[^/]*_?id[^/]*$/i.test(path)
    return withId({
      code: 'not_found',
      message: `Resource not found (${method} ${path}).`,
      suggested_fix: creating
        ? 'This route is not available on the connected deployment — nothing in your request is wrong. Check SHATALE_API_URL points at the right environment, and that the feature is released there.'
        : 'Verify the id exists — pass the id returned by the create call (purchase_id, session_id, etc.). If the id is right, the route may not be deployed on the environment SHATALE_API_URL points at.',
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
