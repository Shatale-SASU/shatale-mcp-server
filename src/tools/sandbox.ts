import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// F-003: Zod input validation schemas
/**
 * The only card numbers this endpoint accepts, and the only ones it ever needs.
 *
 * 4242424242424242 forces approve, 4000000000000002 forces decline, 4111111111111111
 * lets the real policy decide. Declared ONCE so the Zod schema and the JSON input schema
 * cannot drift apart - that drift is what SHAT-2161 was: a description naming three
 * cards, and a validator accepting any 12-19 digits.
 */
export const SANDBOX_TEST_CARDS = [
  '4242424242424242',
  '4000000000000002',
  '4111111111111111',
] as const

const simulateAuthorizationSchema = z.object({
  agent_id: z.string().min(1, 'agent_id is required'),
  amount: z.number().int('amount must be an integer minor-unit value').nonnegative(),
  currency: z.string().min(3).max(3, 'currency must be a 3-letter ISO code'),
  mcc: z.number().int('mcc must be an integer category code'),
  merchant_name: z.string().min(1).max(200),
  // SHAT-2161. An ENUM of the three sandbox cards, not a length range.
  //
  // The description below has said "exactly one of three" since the backend was
  // tightened, while the schema said min(12).max(19) - so any 12-19 digit string was
  // accepted, INCLUDING a real card number somebody pastes. The API refuses it, which is
  // the SHAT-1557 fix, but by then the digits have been through the tool call, this
  // process's memory and the wire. By the standard SHAT-1557 was closed on - PCI scope is
  // what a process CAN receive, not what it does afterwards - the client half was open.
  //
  // The enum closes it before the digits are ever typed: the host validates a tool call
  // against the JSON schema below, so the model cannot offer a real PAN in the first place.
  card_number: z.enum(SANDBOX_TEST_CARDS, {
    // A CUSTOM message, because zod's default one echoes the rejected value:
    // "Invalid enum value. Expected '4242…' | …, received '4929123456789012'".
    //
    // That turns this fix into a different leak. The handler interpolates i.message into
    // the tool result, so a real card pasted here would no longer go to the API - it
    // would be printed into the model's context, the conversation transcript, and
    // anything that logs tool results. By the standard this whole ticket rests on - PCI
    // scope is what a process CAN receive - a transcript-bound copy is arguably worse
    // than the API-bound one, because it is more durable and harder to find later.
    // Caught in review, after I had already written the enum.
    //
    // It also printed all three test cards in full, undoing the deliberate choice in the
    // description below to abbreviate them so no complete number sits in the tool surface.
    errorMap: () => ({
      message:
        'must be one of the three sandbox test cards (see this field\'s description); ' +
        'a real card number is never needed here and is refused',
    }),
  }),
})

/**
 * Removes long digit runs from a validation message before it leaves this process.
 *
 * The specific leak this closes is described on card_number above: zod's default enum
 * error echoes the rejected value, and the handler interpolates that into the tool
 * result - so a pasted card number lands in the model's context and the transcript.
 * The errorMap on that field fixes the known case; this fixes the class.
 *
 * Deliberately a belt on top of the braces. A field added later with a validator that
 * quotes its input - a regex, a literal, a refine - would reintroduce the same leak
 * silently, and nothing about the field name would make anyone think of PCI. Twelve or
 * more consecutive digits is a card-shaped run and nothing this API legitimately needs
 * to see quoted back.
 *
 * It does NOT try to be a PAN detector: no Luhn check, no brand prefixes. A redactor
 * that only catches valid card numbers misses the typo'd ones, and those are just as
 * much a person's card.
 */
function redactLongDigitRuns(message: string): string {
  return message.replace(/\d[\d\s-]{10,}\d/g, '[redacted]')
}

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
            // The enum is what stops a real PAN being typed at all: the host validates the
            // tool call against this schema before it reaches us.
            enum: [...SANDBOX_TEST_CARDS],
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
        redactLongDigitRuns(
          `Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        ),
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
