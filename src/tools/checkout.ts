import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// A merchant checkout form can ask for the CARDHOLDER and the BUYER separately. Shatale returns them
// as two honest, legitimately-distinct identities (they need not match — the pool card is Shatale's,
// the purchase is for the end-user). These two tools expose each half so the agent fills the right
// value into the right field. Card credentials (PAN/CVV) are NOT here — they come out-of-band.

const purchaseIdSchema = z.object({
  purchase_id: z.string().min(1, 'purchase_id is required'),
})

type IdentityResponse = {
  billing_identity?: Record<string, unknown>
  merchant_customer_identity?: Record<string, unknown>
}

const purchaseIdProperty = {
  purchase_id: {
    type: 'string' as const,
    description: 'The purchase ID (from request_purchase) whose checkout this identity is for',
  },
}

function hasKeys(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.keys(v as object).length > 0
}

function identityUnavailable(which: string) {
  return errorResult(new Error(`${which} identity unavailable`), {
    code: 'checkout_identity_unavailable',
    message: `The ${which} identity is not available for this purchase.`,
    suggested_fix: 'Check get_purchase_status — the purchase must be payment_ready before checkout identities exist.',
  })
}

export function createCheckoutTools(client: ShataleClient): ToolModule {
  const fetchIdentity = async (args: Record<string, unknown>) => {
    const parsed = purchaseIdSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false as const, result: textResult(`Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`, true) }
    }
    const data = (await client.getCheckoutIdentity(parsed.data.purchase_id)) as IdentityResponse
    return { ok: true as const, data }
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
    ],
    handlers: {
      get_checkout_cardholder: async (args) => {
        try {
          const got = await fetchIdentity(args)
          if (!got.ok) return got.result
          // Fail loud, never an empty-but-successful identity: an agent handed `{}` at a live merchant
          // form would hallucinate a cardholder name/address into real fields. A missing/empty half is
          // an error (typically: the purchase is not payment_ready yet), not a success.
          if (!hasKeys(got.data.billing_identity)) {
            return identityUnavailable('cardholder/billing')
          }
          return jsonResult({
            billing_identity: got.data.billing_identity,
            _note: 'Cardholder/billing identity only. Card number/expiry/CVV are entered out-of-band, not returned here.',
          })
        } catch (err) {
          return errorResult(err, {
            code: 'checkout_cardholder_failed',
            message: 'Could not fetch the cardholder/billing identity.',
            suggested_fix: 'Confirm the purchase is yours and payment_ready, then retry.',
          })
        }
      },

      get_checkout_customer: async (args) => {
        try {
          const got = await fetchIdentity(args)
          if (!got.ok) return got.result
          if (!hasKeys(got.data.merchant_customer_identity)) {
            return identityUnavailable('buyer/customer')
          }
          return jsonResult({
            merchant_customer_identity: got.data.merchant_customer_identity,
          })
        } catch (err) {
          return errorResult(err, {
            code: 'checkout_customer_failed',
            message: 'Could not fetch the buyer/customer identity.',
            suggested_fix: 'Confirm the purchase is yours and payment_ready, then retry.',
          })
        }
      },
    },
  }
}
