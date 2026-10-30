import type { ShataleClient } from '../client.js'
import type { ToolCallResult, ToolModule } from '../types.js'
import { jsonResult } from '../types.js'
import { errorResult, refusal } from '../errors.js'
import { requireId, requirePersonId, exactStringFields, describeShape } from '../validate.js'
import { forLog } from '../log-value.js'

// A merchant checkout form can ask for the CARDHOLDER and the BUYER separately. Shatale returns them
// as two honest, legitimately-distinct identities (they need not match — the pool card is Shatale's,
// the purchase is for the end-user). These two tools expose each half so the agent fills the right
// value into the right field. Card credentials (PAN/CVV) are NOT here — they come out-of-band.

// ⚠️ requireId, NOT a bare `.min(1)` — the defect review of #69 named here and left: `"   "` survived
// it and went out as GET /v1/purchases/%20%20%20/checkout-identity. validate.ts says why in its words.

type IdentityResponse = {
  billing_identity?: unknown
  merchant_customer_identity?: unknown
}

// ⚠️ EACH HALF IN THE API'S OWN NAMES, EXACTLY (SHAT-3023). shatale-api CheckoutIdentity
// (apps/api/api/v1/purchases.go) writes these keys and no others. The mock this repository tested
// against sent `address_line1` and no city or postal code, and nothing noticed, because the tool
// checked only "the half is not empty" and passed the object through. An agent filling a billing
// form from a half whose names drifted fills the wrong fields or none, and says it succeeded.
//
// Each tool judges ONLY ITS OWN HALF: the cardholder tool does not refuse because the buyer half
// changed, or one drift would take both tools down for a reason only one of them has.
const BILLING_FIELDS = ['name', 'address_line', 'city', 'postal_code', 'country'] as const
const CUSTOMER_FIELDS = ['name', 'first_name', 'last_name', 'email'] as const

function identityUnrecognised(which: string, detail: string) {
  return refusal({
    code: 'checkout_identity_unrecognised',
    message:
      `The ${which} identity came back in a shape this tool does not recognise (${detail}), so none ` +
      'of it is handed over.',
    suggested_fix:
      'Do not fill the merchant form from this response. This is a contract mismatch between this ' +
      'MCP server and the Shatale API, not a problem with the purchase — upgrade shatale-mcp-server, ' +
      'or report it with this message.',
  })
}

const purchaseIdProperty = {
  purchase_id: {
    type: 'string' as const,
    description: 'The purchase ID (from request_purchase) whose checkout this identity is for',
  },
  publisher_user_id: {
    type: 'string' as const,
    description:
      'The same publisher_user_id the purchase was requested for (the person it belongs to). Pass ' +
      "it: the API then returns this identity only to the person whose purchase it is. Omitting it " +
      'still works for now but is DEPRECATED and will become an error.',
  },
}

// ⚠️ THE PERSON, NOT ONLY THE PUBLISHER (SHAT-6105). The same gap reveal_card closed in 1.2.0
// (SHAT-3023 / SHAT-4016), on the route that carries the BUYER'S name and email: the API checks the
// person only when the caller names one, and this tool never did. So any person of a publisher could
// name another person's purchase id and read that person's identity. ABSENT stays served — published
// 1.0.x–1.3.0 callers send purchase_id alone, and the owner's rule is that an upgrade does not break
// them — and says so in `_meta` and on stderr, exactly like reveal_card. PRESENT BUT UNUSABLE (empty,
// whitespace, not a string) is refused before anything is sent.
export const CHECKOUT_IDENTITY_WITHOUT_PERSON_DEPRECATION =
  'This checkout identity tool was called without publisher_user_id. This still works but is ' +
  'DEPRECATED: pass the publisher_user_id the purchase was requested for. Without it the API can ' +
  'check only the publisher, not the person, and a future release will refuse the call.'

function withPersonNotice(result: ToolCallResult, person: string | undefined): ToolCallResult {
  if (person === undefined) {
    result._meta = {
      deprecation: { code: 'checkout_identity_without_person', message: CHECKOUT_IDENTITY_WITHOUT_PERSON_DEPRECATION },
    }
  }
  return result
}

function hasKeys(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.keys(v as object).length > 0
}

// A refusal THIS CLIENT decided, having read the response — the cause is known, so the advice is
// earned. It goes through refusal(), not errorResult(): the latter is for a caught error whose cause
// nobody knows, and it is no longer allowed to name one.
function identityUnavailable(which: string) {
  return refusal({
    code: 'checkout_identity_unavailable',
    message: `The ${which} identity is not available for this purchase.`,
    suggested_fix: 'Check get_purchase_status — the purchase must be payment_ready before checkout identities exist.',
  })
}

// SHAT-6291: the delivery address, in the API's own names. shatale-api answers
// GET /v1/purchases/{id}/shipping-address with exactly these ten string keys inside `shipping_address`
// (an empty value is ""). Strict for the reason BILLING_FIELDS is: an agent typing a renamed field
// into a delivery form reports success on a parcel that goes nowhere.
const SHIPPING_ADDRESS_FIELDS = [
  'recipient_name', 'company', 'line1', 'line2', 'postal_code', 'city', 'region', 'country', 'phone',
  'delivery_notes',
] as const

export function createCheckoutTools(client: ShataleClient): ToolModule {
  const fetchIdentity = async (tool: string, args: Record<string, unknown>) => {
    const id = requireId(args, 'purchase_id')
    if (!id.ok) return { ok: false as const, result: id.result }
    let person: string | undefined
    if (args.publisher_user_id !== undefined) {
      const p = requirePersonId(args)
      if (!p.ok) return { ok: false as const, result: p.result }
      person = p.value
    } else {
      // The ids are the CALLER'S; forLog quotes and escapes them so a newline cannot forge a line.
      process.stderr.write(
        `shatale-mcp-server: DEPRECATED — ${tool} for purchase ${forLog(id.value)} without ` +
          `publisher_user_id; served unscoped. ${CHECKOUT_IDENTITY_WITHOUT_PERSON_DEPRECATION}\n`,
      )
    }
    const data = (await client.getCheckoutIdentity(id.value, person)) as IdentityResponse
    return { ok: true as const, data, person }
  }

  return {
    tools: [
      {
        name: 'get_checkout_cardholder',
        description:
          "The CARDHOLDER / billing identity to put in a merchant's cardholder and billing-address " +
          'fields: Shatale (the legal owner of the card being used). This is NOT the buyer — use ' +
          'get_checkout_customer for the buyer/customer fields. This returns an IDENTITY only: the ' +
          'card number, expiry and CVV are NOT returned here; card entry is handled out-of-band.',
        inputSchema: {
          type: 'object',
          properties: purchaseIdProperty,
          required: ['purchase_id'],
        },
      },
      {
        name: 'get_checkout_customer',
        description:
          "The BUYER / customer identity to put in a merchant's name, email and customer/donor " +
          'fields: the end-user this purchase is for. This is NOT the cardholder — use ' +
          'get_checkout_cardholder for the cardholder/billing fields.',
        inputSchema: {
          type: 'object',
          properties: purchaseIdProperty,
          required: ['purchase_id'],
        },
      },
      {
        name: 'get_shipping_address',
        description:
          "Read the person's delivery address for THIS purchase, to complete a merchant's shipping " +
          'form. It is PERSONAL DATA. It is released only while the purchase is payment_ready ' +
          'AND the person\'s account is active (not after completion), and only for a purchase that asked for shipping (request_purchase with ' +
          'requires_shipping: true). EVERY read is journaled and is visible to the person in their ' +
          'account. Use it only to complete this purchase\'s delivery: do not store it, do not reuse ' +
          'it for another purchase, and do not repeat it back or send it anywhere else. If it comes ' +
          'back as missing, send the person to add an address (follow next_action open_url when it is ' +
          'given); if not ready, wait for the purchase to be payment_ready (and the account active); if shipping is not ' +
          'required, the purchase was created without requires_shipping; not_found means check the ' +
          'ids.',
        inputSchema: {
          type: 'object',
          properties: {
            purchase_id: {
              type: 'string' as const,
              description: 'The purchase ID (from request_purchase) whose delivery address is needed',
            },
            publisher_user_id: {
              type: 'string' as const,
              description:
                'The same publisher_user_id the purchase was requested for (the person it belongs to). ' +
                'REQUIRED: the API answers 400 without it, and releases the address only to the person whose purchase it is.',
            },
          },
          required: ['purchase_id', 'publisher_user_id'],
        },
      },
    ],
    handlers: {
      get_shipping_address: async (args) => {
        try {
          const id = requireId(args, 'purchase_id')
          if (!id.ok) return id.result
          // REQUIRED, unlike the other two reads: the API answers 400 invalid_request without the
          // person, so a missing or blank one is refused here, before anything is sent.
          const p = requirePersonId(args)
          if (!p.ok) return p.result
          const person = p.value
          const data = (await client.getShippingAddress(id.value, person)) as {
            purchase_id?: unknown
            shipping_address?: unknown
            bound_via?: unknown
          }
          if (!hasKeys(data?.shipping_address)) {
            return refusal({
              code: 'shipping_address_unrecognised',
              message: 'The API answered without a shipping address object.',
              suggested_fix: 'Do not invent an address. Check get_purchase_status and the person on the purchase.',
            })
          }
          const addr = exactStringFields(data.shipping_address, SHIPPING_ADDRESS_FIELDS)
          if (!addr.ok) {
            return refusal({
              code: 'shipping_address_unrecognised',
              message:
                `The shipping address came back in a shape this tool does not recognise (${describeShape(addr.report)}), so none of it is handed over.`,
              suggested_fix:
                'Do not fill the delivery form from this response. This is a contract mismatch between ' +
                'this MCP server and the Shatale API — upgrade shatale-mcp-server, or report it.',
            })
          }
          return jsonResult({
            purchase_id: typeof data.purchase_id === 'string' ? data.purchase_id : id.value,
            shipping_address: addr.fields,
            ...(typeof data.bound_via === 'string' ? { bound_via: data.bound_via } : {}),
            _note:
              'Personal data, journaled and visible to the person. Use it only to complete this ' +
              "purchase's delivery.",
          })
        } catch (err) {
          return errorResult(err, 'shipping_address_failed')
        }
      },

      get_checkout_cardholder: async (args) => {
        try {
          const got = await fetchIdentity('get_checkout_cardholder', args)
          if (!got.ok) return got.result
          // Fail loud, never an empty-but-successful identity: an agent handed `{}` at a live merchant
          // form would hallucinate a cardholder name/address into real fields. A missing/empty half is
          // an error (typically: the purchase is not payment_ready yet), not a success.
          if (!hasKeys(got.data.billing_identity)) {
            return identityUnavailable('cardholder/billing')
          }
          const billing = exactStringFields(got.data.billing_identity, BILLING_FIELDS)
          if (!billing.ok) return identityUnrecognised('cardholder/billing', describeShape(billing.report))
          return withPersonNotice(
            jsonResult({
              billing_identity: billing.fields,
              _note: 'Cardholder/billing identity only. Card number/expiry/CVV are entered out-of-band, not returned here.',
            }),
            got.person,
          )
        } catch (err) {
          return errorResult(err, 'checkout_cardholder_failed')
        }
      },

      get_checkout_customer: async (args) => {
        try {
          const got = await fetchIdentity('get_checkout_customer', args)
          if (!got.ok) return got.result
          if (!hasKeys(got.data.merchant_customer_identity)) {
            return identityUnavailable('buyer/customer')
          }
          const customer = exactStringFields(got.data.merchant_customer_identity, CUSTOMER_FIELDS)
          if (!customer.ok) return identityUnrecognised('buyer/customer', describeShape(customer.report))
          return withPersonNotice(
            jsonResult({
              merchant_customer_identity: customer.fields,
            }),
            got.person,
          )
        } catch (err) {
          return errorResult(err, 'checkout_customer_failed')
        }
      },
    },
  }
}
