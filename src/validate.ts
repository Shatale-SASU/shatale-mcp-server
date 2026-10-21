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
 * SHAT-4823 — requirePersonId is requireId's rule for ONE field, publisher_user_id, MINUS the trim.
 *
 * ⚠️ THE TRIM IN requireId IS DELIBERATE AND STAYS (see its comment): a path-parameter id of "   "
 * is not an id, and trimming it is the only way "   " does not become an encoded space in a URL.
 * publisher_user_id is NOT a path parameter. It travels as the query `?publisher_user_id=` and the
 * API decides what it means — purchases/service.go:1608 PersonScope: EMPTY AFTER TrimSpace means
 * "the field is absent", anything else is used AS SENT.
 *
 * ⇒ If we trim here, we answer a question that belongs to the API, and we answer it differently
 * from the API: a caller who sends " u1 " would be scoped to "u1" through this server and to " u1 "
 * when calling the API directly. Same input, two meanings, and the difference is invisible to the
 * caller. So: blank is refused (it is "absent", and a caller who tried to name a person and got it
 * wrong has made a mistake worth telling them about), and everything else leaves UNCHANGED.
 *
 * One rule for every tool that takes this field — reveal_card, checkout_identity, request_purchase,
 * request_credentials — so the next tool cannot drift simply by not knowing. mcp-server#99 adds
 * three more (get_purchase_status, await_purchase_approval, cancel_purchase); they take this too.
 */
export const personIdSchema = z
  .string({
    required_error: 'publisher_user_id is required',
    invalid_type_error: 'publisher_user_id must be a string',
  })
  .refine((v) => v.trim() !== '', { message: 'publisher_user_id must not be empty' })

export function requirePersonId(
  args: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; result: ToolCallResult } {
  const parsed = z.object({ publisher_user_id: personIdSchema }).safeParse(args)
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
  return { ok: true, value: parsed.data.publisher_user_id }
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

/**
 * ⚠️ THE OTHER DIRECTION OF THE SAME BOUNDARY: WHAT COMES BACK, NOT WHAT GOES OUT (SHAT-3023).
 *
 * Everything above guards the ids we SEND. The end of a purchase — reveal_card and the two checkout
 * identity tools — READS a response and hands it to an agent that will type it into a merchant's
 * form. Those tools used to check only "not empty" and pass the body through, so a field the API
 * renamed, dropped or added went to the agent unremarked. Measured on this repository before this
 * change: the mock upstream answered the reveal as `card_number / expiry_month / expiry_year` while
 * shatale-api answers `pan / exp_month / exp_year / last4`, and every test was green. A lenient reader
 * turns a name mismatch into silence; this one refuses instead.
 *
 * It reports NAMES ONLY — which keys were missing, which were unexpected, which were not strings —
 * and never a value. The object it inspects may be a card: echoing any part of it into an error
 * would make the refusal the leak.
 */
export type ShapeReport = { missing: string[]; unexpected: string[]; notString: string[] }

export function exactStringFields(
  value: unknown,
  names: readonly string[],
): { ok: true; fields: Record<string, string> } | { ok: false; report: ShapeReport } {
  const report: ShapeReport = { missing: [], unexpected: [], notString: [] }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, report: { ...report, missing: [...names] } }
  }
  const o = value as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(o, n)) report.missing.push(n)
    else if (typeof o[n] !== 'string') report.notString.push(n)
    else fields[n] = o[n] as string
  }
  for (const k of Object.keys(o)) {
    // A key name is the API's, not the card's — but it is still upstream text, so it is bounded.
    if (!names.includes(k)) report.unexpected.push(k.slice(0, 64))
  }
  if (report.missing.length || report.unexpected.length || report.notString.length) {
    return { ok: false, report }
  }
  return { ok: true, fields }
}

/** One sentence naming what did not match, for a refusal's message. Names only, never values. */
export function describeShape(report: ShapeReport): string {
  const parts: string[] = []
  if (report.missing.length) parts.push(`missing: ${report.missing.join(', ')}`)
  if (report.unexpected.length) parts.push(`unexpected: ${report.unexpected.join(', ')}`)
  if (report.notString.length) parts.push(`not a string: ${report.notString.join(', ')}`)
  return parts.join('; ')
}
