import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// F-003: Zod input validation schemas
const requestPurchaseSchema = z.object({
  publisher_user_id: z.string().min(1, 'publisher_user_id is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  merchant: z.string().min(1, 'merchant is required'),
  amount: z.number().positive('amount must be positive').max(100_000, 'amount exceeds maximum (100,000)'),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').default('EUR'),
  description: z.string().min(1, 'description is required'),
  user_hint: z.object({
    email: z.string().email().optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    country: z.string().length(2).optional(),
  }).optional(),
  idempotency_key: z.string().optional(),
})

export interface PurchaseToolOptions {
  /**
   * SHAT-1488 safety guard. `POST /v1/purchases` is NOT sandbox-gated on the
   * backend (apps/api/main.go), so a `sk_sandbox_*` key can otherwise reach a
   * live, side-effectful path (real ledger/outbox). When the active key is a
   * sandbox key we block `request_purchase` client-side and steer callers to
   * the side-effect-free `sandbox_simulate_authorization` instead.
   */
  isSandbox: boolean
}

export function createPurchaseTools(client: ShataleClient, options: PurchaseToolOptions): ToolModule {
  return {
    tools: [
      {
        name: 'request_purchase',
        description:
          'Request a purchase on behalf of a user. Shatale validates against spending policies and executes the payment.',
        inputSchema: {
          type: 'object',
          properties: {
            publisher_user_id: {
              type: 'string',
              description: 'The publisher-side user ID who is making the purchase',
            },
            agent_id: {
              type: 'string',
              description: 'Identifier for the AI agent making the request',
            },
            merchant: {
              type: 'string',
              description: 'Merchant name or domain (e.g. "amazon.com")',
            },
            amount: {
              type: 'number',
              description: 'Purchase amount in major currency units (e.g. 49.99 for $49.99)',
            },
            currency: {
              type: 'string',
              description: 'ISO 4217 currency code (e.g. "USD", "EUR")',
            },
            description: {
              type: 'string',
              description: 'Human-readable description of what is being purchased',
            },
            user_hint: {
              type: 'object',
              description: 'Optional user data to pre-fill registration (unverified — user must confirm)',
              properties: {
                email: { type: 'string', description: 'User email address' },
                name: { type: 'string', description: 'User full name' },
                phone: { type: 'string', description: 'User phone number' },
                country: { type: 'string', description: 'User country (ISO 3166-1 alpha-2)' },
              },
            },
            idempotency_key: {
              type: 'string',
              description: 'Unique key for idempotent requests (prevents duplicate purchases). Auto-generated if omitted.',
            },
          },
          required: ['publisher_user_id', 'agent_id', 'merchant', 'amount', 'currency', 'description'],
        },
      },
      {
        name: 'get_purchase_status',
        description: 'Get the current status of a purchase request by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            purchase_id: {
              type: 'string',
              description: 'The purchase request ID returned by request_purchase',
            },
          },
          required: ['purchase_id'],
        },
      },
      {
        name: 'cancel_purchase',
        description: 'Cancel a pending purchase request. Only works for purchases not yet executed.',
        inputSchema: {
          type: 'object',
          properties: {
            purchase_id: {
              type: 'string',
              description: 'The purchase request ID to cancel',
            },
            reason: {
              type: 'string',
              description: 'Reason for cancellation (optional but recommended)',
            },
          },
          required: ['purchase_id'],
        },
      },
    ],
    handlers: {
      request_purchase: async (args) => {
        // F-003: Validate input with zod
        const parsed = requestPurchaseSchema.safeParse(args)
        if (!parsed.success) {
          return textResult(`Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`, true)
        }
        // SHAT-1488 safety guard. /v1/purchases is NOT sandbox-gated on the
        // backend, so a sk_sandbox_* key could otherwise reach a live,
        // side-effectful path (real ledger/outbox). Refuse the call here —
        // placed right before the network call so it can never escape the
        // client under a sandbox key — and steer callers to the
        // side-effect-free sandbox_simulate_authorization.
        if (options.isSandbox) {
          return errorResult(new Error('sandbox_key_purchase_blocked'), {
            code: 'sandbox_key_purchase_blocked',
            message:
              'request_purchase creates real purchase state (ledger/outbox) and is ' +
              'unavailable with sandbox keys.',
            suggested_fix:
              'Use sandbox_simulate_authorization to exercise the policy engine without side ' +
              'effects, or switch to a live key in an environment cleared for real purchases.',
          })
        }
        try {
          const input = parsed.data
          const result = await client.requestPurchase({
            publisher_user_id: input.publisher_user_id,
            agent_id: input.agent_id,
            merchant: input.merchant,
            amount: input.amount,
            currency: input.currency,
            description: input.description,
            user_hint: input.user_hint,
            idempotency_key: input.idempotency_key,
          })
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'purchase_failed',
            message: 'Could not complete the purchase request.',
            suggested_fix: 'Confirm the merchant, amount, and user details are valid, then retry.',
          })
        }
      },

      get_purchase_status: async (args) => {
        try {
          const result = await client.getPurchaseStatus(String(args.purchase_id))
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'purchase_status_failed',
            message: 'Could not fetch the purchase status.',
            suggested_fix: 'Check that purchase_id is the id returned by request_purchase, then retry.',
          })
        }
      },

      cancel_purchase: async (args) => {
        try {
          const result = await client.cancelPurchase(
            String(args.purchase_id),
            args.reason ? String(args.reason) : undefined,
          )
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'purchase_cancel_failed',
            message: 'Could not cancel the purchase.',
            suggested_fix: 'Only pending purchases can be cancelled. Verify purchase_id and its current status.',
          })
        }
      },
    },
  }
}
