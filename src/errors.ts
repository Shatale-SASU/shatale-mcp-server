import { jsonResult, type ToolCallResult } from './types.js'

/**
 * SHAT-1463: structured error envelope surfaced to the calling agent.
 *
 * Every tool error is reported as `{ error: { code, message, suggested_fix } }`
 * so the LLM gets a stable machine-readable `code` plus an actionable
 * `suggested_fix` instead of an opaque prose string. Raw upstream bodies are
 * never echoed — messages are fixed, leak-safe text (see client.ts, which does
 * not read the error body).
 */
export interface StructuredError {
  code: string
  message: string
  suggested_fix: string
}

export class ShataleApiError extends Error {
  readonly code: string
  readonly suggested_fix: string

  constructor(err: StructuredError) {
    super(err.message)
    this.name = 'ShataleApiError'
    this.code = err.code
    this.suggested_fix = err.suggested_fix
  }

  toStructured(): StructuredError {
    return { code: this.code, message: this.message, suggested_fix: this.suggested_fix }
  }
}

/** Map an HTTP status into a structured, leak-safe error. */
export function mapHttpError(status: number, method: string, path: string): ShataleApiError {
  if (status === 401 || status === 403) {
    return new ShataleApiError({
      code: 'auth_failed',
      message: 'Authentication failed.',
      suggested_fix:
        'Set SHATALE_API_KEY to a valid sandbox key (sh_test_*). Get a free one at https://admin.shatale.com/register?ref=mcp',
    })
  }
  if (status === 404) {
    return new ShataleApiError({
      code: 'not_found',
      message: `Resource not found (${method} ${path}).`,
      suggested_fix: 'Verify the id exists — pass the id returned by the create call (purchase_id, session_id, etc.).',
    })
  }
  if (status === 429) {
    return new ShataleApiError({
      code: 'rate_limited',
      message: 'Rate limit exceeded.',
      suggested_fix: 'Wait a few seconds before retrying. Avoid tight polling loops on get_*_status.',
    })
  }
  if (status >= 500) {
    return new ShataleApiError({
      code: 'upstream_error',
      message: `Shatale API server error (HTTP ${status}).`,
      suggested_fix: 'This is a transient server-side issue. Retry shortly; if it persists, contact support@shatale.com.',
    })
  }
  return new ShataleApiError({
    code: 'api_error',
    message: `API request failed (HTTP ${status}).`,
    suggested_fix: 'Check your API key and request parameters, then retry.',
  })
}

/**
 * Convert any caught error into a structured, leak-safe tool error result.
 * Known {@link ShataleApiError}s pass through their structured shape; anything
 * else (network failure, abort, unexpected throw) maps to `fallback` so we
 * never surface raw stack traces, file paths, or driver errors to the agent.
 */
export function errorResult(err: unknown, fallback: StructuredError): ToolCallResult {
  const structured = err instanceof ShataleApiError ? err.toStructured() : fallback
  return jsonResult({ error: structured }, true)
}
