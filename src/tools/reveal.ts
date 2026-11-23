import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult, refusal } from '../errors.js'
import { requireId, requirePersonId, exactStringFields, describeShape } from '../validate.js'

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
// ⚠️ AND WHAT IT DOES NOT RETURN. The endpoint stopped returning `three_ds_password` (SHAT-2323); it
// is not part of this response. If it ever reappears in this response, that is not a feature of this tool — it is
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

// ⚠️ THE PERSON IS REQUIRED (SHAT-8736). The transition SHAT-3023 / SHAT-4051 opened — absent person
// served unscoped, with a deprecation in `_meta` and on stderr — is closed. shatale-api already refuses
// an unscoped reveal in production (REVEAL_REQUIRE_PERSON_SCOPE=true), and the reveal journal
// (card_credential_access_logs, #6458) must always name the person a card was revealed to. This is
// ATTRIBUTION, not a ban on revealing: a call that names the person is served exactly as before. A call
// that does not is refused HERE, before any request leaves, with an argument error that says what to
// pass — not after a round trip that would end in the API's refusal anyway.

export function createRevealTools(client: ShataleClient): ToolModule {
  return {
    tools: [
      {
        name: 'reveal_card',
        title: 'Reveals the purchase card so the payment can be completed.',
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
                'is. Required: a call without it is refused before any request is sent.',
            },
            // SHAT-8390. The currency the OPEN checkout page charges in, as the page itself states it —
            // not the currency of the card, and not what the model believes the price to be. Shatale
            // compares it with the currency the MERCHANT priced this purchase in, refuses the reveal when
            // they differ and cancels the purchase. Omit it when the page's currency could not be read:
            // Shatale then behaves exactly as it did before this field existed.
            page_currency: {
              type: 'string' as const,
              description:
                'ISO 4217 code of the currency the open checkout page charges in (e.g. "USD"), read ' +
                'from the page itself. Omit it if the page does not state one.',
            },
          },
          // SHAT-8736: the person is required. Declared here so a client that honours the schema never
          // builds the call without it; enforced in the handler too, because a schema is advice to the
          // caller, not a check on it.
          required: ['purchase_id', 'publisher_user_id'],
        },
      },
    ],
    handlers: {
      reveal_card: async (args) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result
        // ⚠️ THE PERSON, NOT ONLY THE PUBLISHER (SHAT-4016 / SHAT-4051 / SHAT-8736). Without it the API
        // can only check that the key's publisher owns the purchase, so any person of that publisher
        // could name another person's purchase id and receive that card — and the reveal journal could
        // not say who received it. ABSENT, empty, whitespace or not a string: all refused, one rule
        // (requirePersonId), and nothing is sent.
        const person = requirePersonId(args)
        if (!person.ok) return person.result
        const personValue = person.value
        // WHICH currencies a purchase may be charged in is shatale-api's to decide (one reader,
        // SHAT-8511), and a second opinion here would be a second door onto the same money. So the
        // VALUE is passed through unjudged — but its SHAPE is not.
        //
        // 🔴 AND THE SHAPE IS CHECKED BECAUSE OF WHAT THE API DOES WITH A VALUE IT CANNOT READ
        // (measured by the second hand on this branch, 16.11.2026). The API compares the string with
        // the purchase's currency and, on a difference, REFUSES THE REVEAL AND CANCELS THE PURCHASE.
        // It does not ask whether the string is a currency code at all. So a model that read «$»,
        // «dollars» or a zero-width space off the page — U+200B is not whitespace, `trim` leaves it —
        // would not report a mismatch: it would CANCEL THE PERSON'S PURCHASE over an unreadable answer.
        // "I could not read the page's currency" is not "the page is in another currency", and only
        // the caller can tell those apart.
        //
        // Refused rather than quietly dropped, for the reason stated above about publisher_user_id: a
        // caller that tried to state the currency and got it wrong has made a mistake, and treating it
        // as absent would hide that mistake behind the compatibility path — here by walking around the
        // very gate it was trying to pass. Nothing is sent, nothing is cancelled, and the agent is told
        // what a readable answer looks like.
        //
        // ⚠️ THIS IS A SECOND LINE, NOT THE LINE. Any other caller can still send «$» straight to the
        // API; the cancel on an unreadable currency is the API's to fix (SHAT-8390, the gate itself).
        let pageCurrency: string | undefined
        if (args.page_currency !== undefined && args.page_currency !== null) {
          if (typeof args.page_currency !== 'string' || !/^[A-Za-z]{3}$/.test(args.page_currency.trim())) {
            return refusal({
              code: 'page_currency_unreadable',
              message:
                'page_currency must be a three-letter ISO 4217 currency code, as the checkout page states ' +
                'it — for example "USD". Nothing was sent and nothing was changed.',
              suggested_fix:
                'Read the currency CODE from the page and pass it (USD, EUR, GBP). A symbol such as "$", ' +
                'a word such as "dollars", or a value with stray characters in it is not a code. If the ' +
                'page does not state a currency you can read, OMIT page_currency rather than guessing: a ' +
                'guess that is wrong cancels the person\'s purchase.',
            })
          }
          pageCurrency = args.page_currency.trim()
        }
        try {
          const data = await client.getCardCredentials(id.value, personValue, pageCurrency)
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
