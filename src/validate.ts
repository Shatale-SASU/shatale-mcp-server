import { z } from 'zod'
import { textResult, type ToolCallResult } from './types.js'

/**
 * /!\ SECURITY.md SAID SENSITIVE INPUTS WERE VALIDATED BEFORE ANY API CALL. FOR IDs THEY WERE NOT.
 *
 * The claim — "Sensitive tool inputs (purchases, onboarding, credentials, sandbox) are validated
 * (zod) before any API call" — was true of the five handlers that take a BODY, and of none of the
 * handlers that take an ID. Those did `String(args.purchase_id)` and interpolated the result into a
 * path. `String(undefined)` is the four-character string "undefined"; `String(args.x ?? '')` is the
 * empty string.
 *
 * Measured, by calling each tool with `{}` and recording what reached the upstream:
 *
 *     POST   /v1/sandbox/users/undefined/onboarding
 *     POST   /v1/sandbox/purchases//approve        <- an EMPTY path segment, on a WRITE route
 *     GET    /v1/purchases/undefined
 *     GET    /v1/credentials/undefined
 *     DELETE /v1/purchases/undefined
 *
 * /!\ THE HARM IS NOT "A 404 IS UGLY". Two things follow from letting these leave the process:
 *
 *   1. The empty segment collapses `/v1/sandbox/purchases/{id}/approve` into a DIFFERENT ROUTE.
 *      What that resolves to is the backend router's business, not ours, and guessing is exactly
 *      what a boundary exists to avoid. A malformed write should never become a well-formed request
 *      for something else.
 *   2. The model gets a backend error for a mistake it made HERE, one hop away from the cause. A
 *      caller that omitted an argument is told "purchase not found" and reasonably concludes the
 *      purchase does not exist — so it retries, or invents an id, or reports the wrong thing to the
 *      person. An error must name the mistake that was actually made.
 *
 * The fix is not more zod schemas per call site — that is what drifted. It is ONE helper every
 * id-taking handler goes through, so the next tool cannot be written without it by simply not
 * knowing, and a reviewer can see the absence.
 */

/**
 * requireId validates a path-parameter id: present, a string, non-empty after trimming.
 *
 * Trimmed deliberately: "   " is not an id, and it survives a bare `.min(1)` while producing a URL
 * with an encoded space where a key should be.
 */
export function requireId(
  args: Record<string, unknown>,
  field: string,
): { ok: true; value: string } | { ok: false; result: ToolCallResult } {
  const schema = z.object({
    [field]: z
      .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
      .trim()
      .min(1, `${field} must not be empty`),
  })
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join(', ')
    return {
      ok: false,
      result: textResult(
        `Invalid input: ${detail}. No request was sent — this is a problem with the arguments to ` +
          `this tool, not with the server or with any record on it.`,
        true,
      ),
    }
  }
  return { ok: true, value: (parsed.data as Record<string, string>)[field] }
}

/**
 * requireFirstId is the same check for a handler that accepts an id under more than one name.
 * `sandbox_approve_purchase` takes `purchase_id` OR `request_id`; without this it did
 * `String(args.purchase_id ?? args.request_id ?? '')` and sent an empty segment when it had neither.
 *
 * The error names every accepted spelling, because "purchase_id is required" is a misleading thing
 * to tell a caller who correctly supplied `request_id` and misspelled it.
 */
export function requireFirstId(
  args: Record<string, unknown>,
  fields: [string, ...string[]],
): { ok: true; value: string } | { ok: false; result: ToolCallResult } {
  for (const field of fields) {
    if (typeof args[field] === 'string' && (args[field] as string).trim() !== '') {
      return { ok: true, value: (args[field] as string).trim() }
    }
  }
  return {
    ok: false,
    result: textResult(
      `Invalid input: one of ${fields.join(' or ')} is required and must be a non-empty string. ` +
        `No request was sent — this is a problem with the arguments to this tool, not with the ` +
        `server or with any record on it.`,
      true,
    ),
  }
}
