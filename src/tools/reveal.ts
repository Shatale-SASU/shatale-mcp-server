import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult, refusal } from '../errors.js'
import { requireId, exactStringFields, describeShape } from '../validate.js'

// reveal_card — the agent-scoped reveal of the card Shatale issued for THIS purchase (SHAT-3023).
//
// ⚠️ THE BOUNDARY IS NOT IN THIS FILE, AND THAT IS DELIBERATE. Every response this server returns
// passes `redactPurchaseCard` once, inside `ShataleClient.request` (client.ts:277). It decides by
// PROVENANCE — `pathReturnsOurCard(path)` against the allowlist in redact.ts:67 — not by the shape of
// the body, because the body misdescribes itself. Two paths are on that allowlist: the sandbox approval
// and `/v1/purchases/{id}/card-credentials`, the one this tool calls.
//
// So this tool holds NO redaction logic and must never grow any. A scrub written here would be a second
// door with its own opinion, and the day the two disagreed the safer one would be the one nobody read.
// What makes the PAN reach the agent is that the CLIENT METHOD uses the allowlisted path; break that
// and the response arrives redacted, which is the failure this design wants.
//
// ⚠️ AND WHAT IT DOES NOT RETURN. The endpoint stopped returning `three_ds_password` (SHAT-2323): one
// static 3DS password is shared by every card in the pool, so revealing it once for one card discloses
// it for all of them. If it ever reappears in this response, that is not a feature of this tool — it is
// SHAT-2259 reopening, and the containment migration 201 exists to make that answerable by query.
//
// Every call is journalled: card_credential_access_logs, written by the reveal repository itself
// (apps/api/internal/purchases/pgx/card_reveal_repo.go:149), not by this server. The agent cannot
// suppress the record by choosing how it calls.

// ⚠️ requireId, NOT a bare `.min(1)`. validate.ts says why in its own words: «"   " is not an id, and
// it survives a bare .min(1) while producing a URL with an encoded space where a key should be». This
// tool shipped with the bare form and sent GET /v1/purchases/%20%20%20/card-credentials — measured by
// execution, not by reading. The neighbour it was copied from (checkout.ts:13) carries the same defect
// and predates this change; copying a sibling copies its bugs, and the sibling is not the spec.

function hasCard(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.keys(v as object).length > 0
}

// ⚠️ THE API'S OWN NAMES, EXACTLY, AND THE READ REFUSES ANYTHING ELSE (SHAT-3023).
//
// shatale-api RevealCard (apps/api/api/v1/purchases.go, writeJSON after "card credentials revealed to
// agent") answers with these five string keys and no others. This tool used to hand back whatever
// came — the only check was "not empty" — and the mock this repository tested against spoke a
// different dialect (`card_number`, `expiry_month`, `expiry_year`, `cardholder_name`) for the whole
// life of the tool, green. A lenient reader turns a renamed field into silence: the agent fills the
// expiry with nothing and reports a successful checkout.
//
// So a missing, extra or non-string field is a NAMED refusal. An EXTRA field is refused too, on
// purpose: the one extra field this response has ever carried was `three_ds_password`, and its return
// would be SHAT-2259 reopening, not a feature to forward. The refusal names keys only, never a value.
const REVEALED_CARD_FIELDS = ['pan', 'cvv', 'exp_month', 'exp_year', 'last4'] as const

// ⚠️ THE TRANSITION IS LOUD, OR IT IS PERMANENT (SHAT-3023 / SHAT-4051). A reveal without the person
// is served as before, and each one says so in TWO places: the result's `_meta` (the caller that
// omitted it reads its own result) and stderr (the operator who runs the process reads its log).
// Neither carries anything of the card — only the tool name and the purchase id the caller supplied.
// shatale-api counts the same event on its side (`event=reveal_without_person_scope`); when that
// count is zero after the concierge pin moves past this release, `publisher_user_id` becomes required
// here and the API's flag is switched on. Until then this sentence is the countdown.
export const REVEAL_WITHOUT_PERSON_DEPRECATION =
  'reveal_card was called without publisher_user_id. This still works but is DEPRECATED: pass the ' +
  'publisher_user_id the purchase was requested for. Without it the API can check only the ' +
  'publisher, not the person, and a future release will refuse the call.'

export function createRevealTools(client: ShataleClient): ToolModule {
  return {
    tools: [
      {
        name: 'reveal_card',
        description:
          'Reveal the card credentials (number, expiry, CVV) of the Shatale card issued for THIS ' +
          'purchase, so the agent can complete a merchant checkout that has no out-of-band path. ' +
          'Only the card WE issued for this purchase is ever returned — a customer\'s own instrument ' +
          'is not available here and is stripped from any other response. Use get_checkout_cardholder ' +
          'and get_checkout_customer for the identity fields; this tool is only for the card fields. ' +
          'Every successful reveal is recorded in the credential access log.',
        inputSchema: {
          type: 'object',
          properties: {
            purchase_id: {
              type: 'string' as const,
              description:
                'The purchase ID (from request_purchase) whose issued card is to be revealed',
            },
            publisher_user_id: {
              type: 'string' as const,
              description:
                'The same publisher_user_id the purchase was requested for (the person it belongs ' +
                'to). Pass it: the API then reveals the card only to the person whose purchase it ' +
                'is. Omitting it still works for now but is DEPRECATED and will become an error.',
            },
          },
          // ⚠️ NOT YET IN `required`, AND THAT IS A TRANSITION, NOT A DECISION (SHAT-3023, 28.09.2026).
          // Published 1.1.0/1.1.1 shipped this tool with purchase_id alone, and whoever built on
          // those versions calls it that way; the owner's rule is that an existing caller does not
          // break on upgrade. So an absent person is still served — and says so, every time, below.
          required: ['purchase_id'],
        },
      },
    ],
    handlers: {
      reveal_card: async (args) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result
        // ⚠️ THE PERSON, NOT ONLY THE PUBLISHER (SHAT-4016 / SHAT-4051). Without it the API can only
        // check that the key's publisher owns the purchase, so any person of that publisher could
        // name another person's purchase id and receive that card. shatale-api keeps the parameter
        // optional for compatibility and names THIS tool as the one live caller that does not send
        // it — the reason the person gate cannot be switched on.
        //
        // ABSENT is the transition (see REVEAL_WITHOUT_PERSON_DEPRECATION). PRESENT BUT UNUSABLE —
        // empty, whitespace, not a string — is refused: a caller that tried to name a person and got
        // it wrong has made a mistake, and serving it unscoped would hide the mistake behind the
        // compatibility path meant for callers that never knew the field.
        let personValue: string | undefined
        if (args.publisher_user_id !== undefined) {
          const person = requireId(args, 'publisher_user_id')
          if (!person.ok) return person.result
          personValue = person.value
        } else {
          process.stderr.write(
            `shatale-mcp-server: DEPRECATED — reveal_card for purchase ${id.value} without ` +
              `publisher_user_id; served unscoped. ${REVEAL_WITHOUT_PERSON_DEPRECATION}\n`,
          )
        }
        try {
          const data = await client.getCardCredentials(id.value, personValue)
          // Fail loud rather than hand back an empty-but-successful reveal. An agent given `{}` at a
          // live checkout form fills nothing and reports success, and the purchase stalls with no cause
          // recorded anywhere. The usual reason is that the purchase is not payment_ready yet.
          if (!hasCard(data)) {
            return refusal({
              code: 'card_credentials_unavailable',
              message: 'No card credentials are available for this purchase.',
              suggested_fix:
                'Check get_purchase_status — the purchase must be payment_ready and hold an issued card ' +
                'before its credentials can be revealed.',
            })
          }
          const card = exactStringFields(data, REVEALED_CARD_FIELDS)
          if (!card.ok) {
            return refusal({
              code: 'card_credentials_unrecognised',
              message:
                'The card credentials came back in a shape this tool does not recognise ' +
                `(${describeShape(card.report)}), so none of it is handed over.`,
              suggested_fix:
                'Do not fill the merchant form from this response. This is a contract mismatch between ' +
                'this MCP server and the Shatale API, not a problem with the purchase — upgrade ' +
                'shatale-mcp-server, or report it with this message.',
            })
          }
          const result = jsonResult(card.fields)
          if (personValue === undefined) {
            result._meta = { deprecation: { code: 'reveal_without_person', message: REVEAL_WITHOUT_PERSON_DEPRECATION } }
          }
          return result
        } catch (err) {
          return errorResult(err, 'reveal_card_failed')
        }
      },
    },
  }
}
