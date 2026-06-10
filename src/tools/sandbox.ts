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
  mcc: z.number().int('mcc must be an integer category code'),
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
            type: 'number',
            description: 'Merchant category code (e.g. 5691 clothing, 7995 gambling)',
          },
          merchant_name: {
            type: 'string',
            description: 'Merchant display name',
          },
          card_number: {
            type: 'string',
            description:
              'Sandbox test card. 4242… → force approve, 4000…0002 → force decline, ' +
              'neutral (4111…) → real policy decides',
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
