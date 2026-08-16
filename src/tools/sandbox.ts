import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// F-003: Zod input validation schemas
const simulateAuthorizationSchema = z.object({
  agent_id: z.string().min(1, 'agent_id is required'),
  amount: z.number().int('amount must be an integer minor-unit value').nonnegative(),
  currency: z.string().min(3).max(3, 'currency must be a 3-letter ISO code'),
  // A four-digit ISO 18245 code, on the wire as a STRING.
  //
  // This was `z.number()`, and the backend's struct is `MCC string` — Go's decoder rejects
  // a JSON number into a string field, so every call returned 400 "invalid request body"
  // before the handler ran. The one policy-engine tool a sandbox agent can call never
  // worked, and there was no input that could reach it: a string was refused client-side by
  // this very schema.
  //
  // Exactly the failure that made 0.2.1 broken — a field's TYPE disagreeing with the Go
  // struct — which is why both spellings are accepted here and normalised to the one the
  // backend reads. An agent that sends 5999 or "5999" is asking the same question.
  mcc: z
    .union([z.number().int(), z.string().regex(/^\d{3,4}$/, 'mcc must be a 3-4 digit category code')])
    .transform((v) => String(v)),
  merchant_name: z.string().min(1).max(200),
  card_number: z.string().min(12).max(19),
})

/**
 * Sandbox tool surface (SHAT-1488, Option 1).
 *
 * Every tool here maps to a route the backend ACTUALLY deploys
 * (apps/api/main.go). The previously-shipped `sandbox_create_test_user`,
 * `sandbox_decline_request`, and `sandbox_reset` tools called endpoints that
 * were never deployed and have been removed — an honest, smaller surface beats
 * visible-but-broken tools.
 */
export function createSandboxTools(client: ShataleClient): ToolModule {
  const tools: ToolDefinition[] = [
    {
      name: 'sandbox_simulate_authorization',
      description:
        'Run the Shatale policy engine against a simulated authorization — side-effect-free ' +
        '(no purchase, no ledger, no outbox, no money). Returns the approve/decline decision ' +
        'plus the rule explanation. Test cards: 4242… forces approve, 4000…0002 forces decline, ' +
        'a neutral card (e.g. 4111…) lets the real policy decide. The agent must belong to the ' +
        'publisher that owns the sandbox key. Only available with sandbox API keys.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Sandbox agent ID (must belong to the key\'s publisher)',
          },
          amount: {
            type: 'number',
            description: 'Amount as an integer minor-unit value (e.g. 15000 = €150.00)',
          },
          currency: {
            type: 'string',
            description: '3-letter ISO currency code (e.g. EUR)',
          },
          mcc: {
            // string, because that is what the backend decodes. A number is accepted and
            // converted, so an agent following an older description still works.
            type: 'string',
            description:
              'Merchant category code, 4 digits (e.g. "5691" clothing, "7995" gambling)',
          },
          merchant_name: {
            type: 'string',
            description: 'Merchant display name',
          },
          card_number: {
            type: 'string',
            description:
              'Sandbox test card. Exactly one of three: 4242424242424242 forces approve, ' +
              '4000000000000002 forces decline, 4111111111111111 lets the real policy ' +
              'decide. Any other number is refused — this endpoint never needs a real card.',
          },
        },
        required: ['agent_id', 'amount', 'currency', 'mcc', 'merchant_name', 'card_number'],
      },
    },
    {
      name: 'sandbox_complete_onboarding',
      description:
        'Mark a sandbox test user as fully onboarded (KYC passed, wallet funded). Skips real verification steps.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The test user ID to complete onboarding for',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'sandbox_approve_purchase',
      description:
        'Manually approve a sandbox purchase that is pending user/admin approval ' +
        '(simulates the human-in-the-loop approval beat).',
      inputSchema: {
        type: 'object',
        properties: {
          purchase_id: {
            type: 'string',
            description: 'The sandbox purchase ID to approve',
          },
        },
        required: ['purchase_id'],
      },
    },
  ]

  const simulateAuthorization: ToolHandler = async (args) => {
    // F-003: Validate input with zod
    const parsed = simulateAuthorizationSchema.safeParse(args)
    if (!parsed.success) {
      return textResult(
        `Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        true,
      )
    }
    try {
      const result = await client.sandboxSimulateAuthorization(parsed.data)
      return jsonResult(result)
    } catch (err) {
      return errorResult(err, {
        code: 'sandbox_simulate_failed',
        message: 'Could not run the sandbox authorization.',
        suggested_fix:
          'Ensure you are using a sandbox key (sk_sandbox_*) and that agent_id is an agent ' +
          'owned by the key\'s publisher.',
      })
    }
  }

  const approvePurchase: ToolHandler = async (args) => {
    const purchaseId = String(args.purchase_id ?? args.request_id ?? '')
    try {
      const result = await client.sandboxApprovePurchase(purchaseId)
      return jsonResult(result)
    } catch (err) {
      return errorResult(err, {
        code: 'sandbox_approve_failed',
        message: 'Could not approve the sandbox purchase.',
        suggested_fix: 'Pass a purchase_id for a sandbox purchase that is pending approval.',
      })
    }
  }

  const handlers: Record<string, ToolHandler> = {
    sandbox_simulate_authorization: simulateAuthorization,

    sandbox_complete_onboarding: async (args) => {
      try {
        const result = await client.sandboxCompleteOnboarding(String(args.user_id))
        return jsonResult(result)
      } catch (err) {
        return errorResult(err, {
          code: 'sandbox_onboarding_failed',
          message: 'Could not complete sandbox onboarding.',
          suggested_fix: 'Pass the user_id of a sandbox user that is awaiting onboarding.',
        })
      }
    },

    sandbox_approve_purchase: approvePurchase,
  }

  return { tools, handlers }
}
