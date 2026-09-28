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
                'to). The API reveals a card only to the person whose purchase it is.',
            },
          },
          required: ['purchase_id', 'publisher_user_id'],
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
        // it — the reason the person gate cannot be switched on. Required here, so that it can.
        const person = requireId(args, 'publisher_user_id')
        if (!person.ok) return person.result
        try {
          const data = await client.getCardCredentials(id.value, person.value)
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
          return jsonResult(card.fields)
        } catch (err) {
          return errorResult(err, 'reveal_card_failed')
        }
      },
    },
  }
}
