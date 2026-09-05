import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult, refusal } from '../errors.js'
import { requireId } from '../validate.js'

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
          'Every call is recorded in the credential access log.',
        inputSchema: {
          type: 'object',
          properties: {
            purchase_id: {
              type: 'string' as const,
              description:
                'The purchase ID (from request_purchase) whose issued card is to be revealed',
            },
          },
          required: ['purchase_id'],
        },
      },
    ],
    handlers: {
      reveal_card: async (args) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result
        try {
          const data = await client.getCardCredentials(id.value)
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
          return jsonResult(data)
        } catch (err) {
          return errorResult(err, 'reveal_card_failed')
        }
      },
    },
  }
}
