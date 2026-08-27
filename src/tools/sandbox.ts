import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolDefinition, ToolHandler, ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'
import { requireId, requireFirstId } from '../validate.js'

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
    .union([
      // Both spellings validate to the same range. The number arm used to accept any
      // int, so mcc: -5 became "-5" on the wire and the backend, which takes any
      // string, would have stored it — the two spellings have to agree on what is
      // valid, not only on what type comes out.
      z.number().int().min(100).max(9999),
      z.string().regex(/^\d{3,4}$/, 'mcc must be a 3-4 digit category code'),
    ])
    .transform((v) => String(v)),
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
  // The enum STEERS the model away from typing a real card, and the server-side check
  // below is what actually stops one.
  //
  // I first wrote that the host validates a tool call against the JSON schema, so a real
  // PAN "cannot" be offered. That is not true and review was right to press on it: the
  // MCP spec does not require clients to validate arguments against inputSchema, and
  // Claude Code does not enforce it before dispatch. The schema is a contract the model
  // reads, not a gate the transport enforces.
  //
  // So the guaranteed stop is this Zod check, which by definition runs AFTER the digits
  // have entered this process over the transport. The enum is still worth having - it
  // materially reduces the chance the model types a card, and it puts the contract where
  // a reader will find it - but it is not the thing that makes the refusal certain.
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
 * Sandbox tool surface (SHAT-1488, Option 1; corrected SHAT-2621 on 2026-08-27).
 *
 * Every tool here maps to a route the backend actually serves.
 *
 * ⚠️ THE REASON THIS COMMENT USED TO GIVE WAS FALSE, AND A SURFACE CHECK CONFIRMED IT. It said
 * `sandbox_create_test_user`, `sandbox_decline_request` and `sandbox_reset` "called endpoints that
 * were never deployed". Measured:
 *
 *     apps/api/main.go:4838  POST /v1/sandbox/reset      registered, behind
 *                            SANDBOX_CANCEL_ROUTES_ENABLED, parsed fail-closed
 *     live api.shatale.com   POST /v1/sandbox/reset  -> 404
 *                            POST /v1/sandbox/users  -> 401   (control, same host, route mounted)
 *
 * The routes exist. They are switched off. "Never deployed" and "registered and disabled" call for
 * different actions — one is a rewrite, the other an environment variable.
 *
 * ⚠️ AND THE SENTENCE WAS RIGHT FOR THE WRONG REASON, WHICH OUTLIVES BEING SIMPLY WRONG. A reader
 * who checks production sees the 404, concludes "never deployed" is accurate, and stops. A plainly
 * false comment is caught by the first measurement; a false reason that a shallow check CONFIRMS is
 * not caught at all.
 *
 * `sandbox_create_user` has since returned (PR #51). `sandbox_decline_request` is in scope to
 * return — a demo that can show "yes" and not "no" is half a demo of a product whose point is that
 * a person may refuse. `sandbox_reset` is deliberately NOT in this surface: it erases sandbox state,
 * and this surface is what we hand to an external publisher, where the cost of a mistaken call is
 * not symmetric with the cost of a correct one.
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
            // The enum here is steering for the model, not a transport-level gate: MCP
            // clients are not required to validate against inputSchema. The refusal that
            // is certain is the Zod check in the schema above.
            enum: [...SANDBOX_TEST_CARDS],
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
      name: 'sandbox_create_user',
      description:
        "Create one of YOUR OWN sandbox users and give it the delegation that lets it buy. This is " +
        "the first step: request_purchase needs a publisher_user_id that has an active delegation, " +
        "and nothing else here creates one. Idempotent — calling it again with the same ids changes " +
        "nothing. agent_id must be an agent YOU created by hand in the publisher console; no API key " +
        "can create an agent, so if you do not have one, ask the person for it rather than inventing " +
        "an id. user_id is yours to choose: it is how you will refer to this person afterwards.",
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'Your own identifier for this person — you choose it, and you reuse it later',
          },
          agent_id: {
            type: 'string',
            description: 'An agent created by a person in the publisher console. Ask for it; do not invent one.',
          },
          onboarded: {
            type: 'boolean',
            description: 'Mark the user as onboarded (KYC passed). Default true — an un-onboarded user cannot buy.',
          },
          currency: {
            type: 'string',
            description: 'Delegation budget currency. Defaults to EUR, which is what request_purchase defaults to.',
          },
        },
        required: ['user_id', 'agent_id'],
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
      return errorResult(err, 'sandbox_simulate_failed')
    }
  }

  const approvePurchase: ToolHandler = async (args) => {
    const chosen = requireFirstId(args, ['purchase_id', 'request_id'])
    if (!chosen.ok) return chosen.result
    const purchaseId = chosen.value
    try {
      const result = await client.sandboxApprovePurchase(purchaseId)
      // This returns a top-level `card` with number and cvv, and it reaches the caller INTACT —
      // this path is on the disclosure allowlist in src/redact.ts, deliberately.
      //
      // The comment here used to state the opposite invariant: "no tool result carries a
      // number+cvv pair, without exceptions". It sat directly above the one call the allowlist
      // exempts, and it stayed after the allowlist was introduced. A stale invariant is worse than
      // none: the next reader trusts it and stops checking.
      //
      // What is true: the card returned here is OURS, minted for this purchase, and the agent is
      // given it because it has to pay with it. The person's own card is never returned on any
      // path. Which of the two you get is decided by the endpoint, not by the response body — see
      // SECURITY.md, which carries the same decision in the same words.
      return jsonResult(result)
    } catch (err) {
      return errorResult(err, 'sandbox_approve_failed')
    }
  }

  const handlers: Record<string, ToolHandler> = {
    sandbox_simulate_authorization: simulateAuthorization,

    sandbox_create_user: async (args) => {
      // Both ids are required HERE, before the network. agent_id optional would be an invitation to
      // send an empty one, and the backend would answer with a sentence about delegations that reads
      // like a server problem rather than a missing argument.
      const userId = requireId(args, 'user_id')
      if (!userId.ok) return userId.result
      const agentId = requireId(args, 'agent_id')
      if (!agentId.ok) return agentId.result
      try {
        const result = await client.createSandboxUser(userId.value, agentId.value, {
          onboarded: args.onboarded === undefined ? true : Boolean(args.onboarded),
          currency: typeof args.currency === 'string' ? args.currency : undefined,
        })
        return jsonResult(result)
      } catch (err) {
        return errorResult(err, 'sandbox_create_user_failed')
      }
    },

    sandbox_complete_onboarding: async (args) => {
      const userId = requireId(args, 'user_id')
      if (!userId.ok) return userId.result
      try {
        const result = await client.sandboxCompleteOnboarding(userId.value)
        return jsonResult(result)
      } catch (err) {
        return errorResult(err, 'sandbox_onboarding_failed')
      }
    },

    sandbox_approve_purchase: approvePurchase,
  }

  return { tools, handlers }
}
