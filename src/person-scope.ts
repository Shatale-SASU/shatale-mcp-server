import type { ToolCallResult } from './types.js'
import { requireId } from './validate.js'
import { forLog } from './log-value.js'

// The person on the three purchase-access tools — get_purchase_status, await_purchase_approval,
// cancel_purchase (SHAT-4788, the client half of shatale-api SHAT-4785).
//
// 🔴 WHAT WAS MISSING. A publisher API key is ONE key for ALL of a publisher's people, so these three
// calls — which take only a purchase id — could read or cancel ANY of the publisher's people's
// purchases by id. The API can scope each of them to the person (`publisher_user_id`, the same string
// the purchase was requested for) and from SHAT-4785 it can REQUIRE it behind a switch; a call without
// it is then answered 404 "purchase not found", byte for byte the answer for a purchase that does not
// exist. An agent on a version that never sends it would read its own live purchase as nonexistent.
//
// ⚠️ THE SAME TRANSITION AS reveal_card (reveal.ts, SHAT-3023), ON PURPOSE. Absent is served exactly as
// 1.2.x served it and says so, in two places: the result's `_meta` (the caller reads its own result) and
// stderr (the operator reads the process log). Present but unusable — empty, whitespace, not a string —
// is REFUSED: a caller that tried to name a person and got it wrong made a mistake, and serving it
// unscoped would hide the mistake behind the path meant for callers that never knew the field.
// shatale-api counts the same event (`event=purchase_access_without_person_scope`, by route); when that
// is zero after this release is in use, the field becomes required here and the API's switch goes on.

export const ACCESS_WITHOUT_PERSON_DEPRECATION_CODE = 'purchase_access_without_person'

export function accessWithoutPersonDeprecation(tool: string): string {
  return (
    `${tool} was called without publisher_user_id. This still works but is DEPRECATED: pass the ` +
    'publisher_user_id the purchase was requested for. Without it the API can check only the ' +
    'publisher, not the person, and a future release will refuse the call.'
  )
}

/** The schema fragment every one of the three tools carries. */
export const PUBLISHER_USER_ID_PROPERTY = {
  type: 'string' as const,
  description:
    'The same publisher_user_id the purchase was requested for (the person it belongs to). Pass it: ' +
    'the API then answers only for that person\'s purchase. Omitting it still works for now but is ' +
    'DEPRECATED and will become an error.',
}

export type PersonScope =
  | { ok: true; person: string | undefined }
  | { ok: false; result: ToolCallResult }

/**
 * Read the person out of the tool arguments. Absent → `person: undefined` and ONE stderr line (this
 * call, not each poll of an await); present → validated by the same `requireId` as every id here.
 */
export function readPerson(args: Record<string, unknown>, tool: string, purchaseId: string): PersonScope {
  if (args.publisher_user_id === undefined) {
    // The purchase id is the CALLER'S and requireId only trims it: forLog quotes and escapes it
    // (SHAT-4307) so a newline inside cannot end this line and start one the server did not write.
    process.stderr.write(
      `shatale-mcp-server: DEPRECATED — ${tool} for purchase ${forLog(purchaseId)} without ` +
        `publisher_user_id; served unscoped. ${accessWithoutPersonDeprecation(tool)}\n`,
    )
    return { ok: true, person: undefined }
  }
  const person = requireId(args, 'publisher_user_id')
  if (!person.ok) return person
  // ⚠️ THE VALUE AS GIVEN, NOT `person.value`. requireId TRIMS, to decide whether the field is usable;
  // the API stores the person UNNORMALISED and compares it EXACTLY as sent, so a person created as
  // " alice " is found only by " alice ". Sending the trimmed form would turn a valid, validated person
  // into the API's indistinguishable 404 (found by round-1 review). requireId has proved it is a
  // non-blank string, so the cast is the checked value, untouched.
  return { ok: true, person: args.publisher_user_id as string }
}

/** Put the deprecation on a result that was served without the person. */
export function markServedWithoutPerson(result: ToolCallResult, tool: string, person: string | undefined): ToolCallResult {
  if (person === undefined) {
    result._meta = {
      deprecation: { code: ACCESS_WITHOUT_PERSON_DEPRECATION_CODE, message: accessWithoutPersonDeprecation(tool) },
    }
  }
  return result
}

/** `?publisher_user_id=…` for a person, '' for none — the query form of the field. */
export function personQuery(person: string | undefined): string {
  return person === undefined ? '' : `?publisher_user_id=${encodeURIComponent(person)}`
}
