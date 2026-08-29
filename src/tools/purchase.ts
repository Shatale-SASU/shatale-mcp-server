import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'
import { requireId } from '../validate.js'

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

// redactPurchaseCard moved to src/redact.ts and is now applied inside ShataleClient.request, so the
// guarantee is the client's rather than four call sites'. Re-exported here because the tests and
// tools that import it from this path are about the FUNCTION, and moving a file should not be the
// thing that breaks them.
export { redactPurchaseCard } from '../redact.js'

/**
 * The shortest gap this tool will leave between two calls to the API, whatever the API does.
 *
 * ⚠️ IT EXISTS BECAUSE THE PACE WAS SOMEBODY ELSE'S PROPERTY. The waiting endpoint holds each call
 * for its own budget, so the loop below was paced correctly — by the far side. Measured against an
 * upstream that answers instantly: 520,008 requests in 50 seconds, over ten thousand a second. The
 * tool written to END tight polling became the tightest polling loop in the product, and every other
 * assertion about it still passed. Two seconds is far below the API's own budget, so this never
 * fires in normal operation and is the whole defence when normal operation stops.
 */
const MIN_POLL_INTERVAL_MS = 2_000

export interface PurchaseToolOptions {
  /**
   * Whether the active key is a sandbox key. NOT USED FOR A REFUSAL — SHAT-2611.
   *
   * This doc used to be the SHAT-1488 safety guard: "`POST /v1/purchases` is NOT sandbox-gated on
   * the backend, so a `sk_sandbox_*` key can otherwise reach a live, side-effectful path — we block
   * `request_purchase` client-side". SHAT-2373 changed that property of the backend. The endpoint
   * serves sandbox keys deliberately, the environment is stamped by the SERVER from the key, and
   * the money-movers resolve to sandbox implementations.
   *
   * The field stays only because both call sites pass it and a future decision may legitimately
   * want to know the mode. If nothing claims it, it should go: a plausible unused seam is an
   * invitation to re-wire the refusal it used to carry.
   */
  isSandbox: boolean
}

export function createPurchaseTools(client: ShataleClient, options: PurchaseToolOptions): ToolModule {
  return {
    tools: [
      {
        name: 'request_purchase',
        description:
          // NOT "executes the payment" — that was the description until SHAT-2683, and no branch of
          // the backend does it. RequestPurchase answers with a STATUS, and the reachable ones
          // include onboarding_required, delegation_required, blocked, pending_approval and failed
          // (apps/api/internal/purchases/service.go). Even payment_ready only means a card was
          // issued; paying at the merchant is still the agent's own step. An agent told the call
          // executes the payment reports success on a purchase that is waiting for a human.
          'Request a purchase on behalf of a user. Shatale checks it against the spending policies ' +
          'and answers with a STATUS to act on — it does not complete the payment. The answer may ' +
          'say the user must finish onboarding, that a delegation is missing, that policy blocked ' +
          'it, or that it is waiting for approval. When it reaches payment_ready a card has been ' +
          'issued for it and paying at the merchant is the next step, yours to take.',
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
              description:
                'Unique key for idempotent requests (prevents duplicate purchases). If omitted, a ' +
                'DETERMINISTIC key is derived from the purchase fields, so re-sending an identical ' +
                'request returns the SAME (possibly already-completed) purchase instead of charging ' +
                'again. To intentionally repeat an identical purchase, pass a fresh unique key.',
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
        name: 'await_purchase_approval',
        description:
          'Wait for the person to answer a purchase that needs their approval, instead of polling. ' +
          'Returns approved, declined, expired — or still_waiting, which means nobody has answered ' +
          'yet and you may call this again. It reads the decision; calling it never changes the ' +
          'purchase, and get_purchase_status keeps working alongside it.',
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
        // ⚠️ THE REFUSAL THAT USED TO LIVE HERE OUTLIVED THE SERVER IT CITED — SHAT-2611.
        //
        // It said, in as many words: "SHAT-1488 safety guard. /v1/purchases is NOT sandbox-gated on
        // the backend, so a sk_sandbox_* key could otherwise reach a live, side-effectful path (real
        // ledger/outbox)." That was TRUE when it was written, and it was recorded as a PROPERTY OF
        // THE SERVER rather than as a measurement with a date.
        //
        // SHAT-2373 changed exactly that property, and said why in the API's own guard: "/v1/purchases
        // now serves sandbox keys DELIBERATELY — a sandbox key creating and cancelling a purchase
        // through the SAME public contract an outsider uses IS the product (a privileged
        // /v1/sandbox/purchases bypass is exactly what the ticket forbids)." The environment is
        // stamped from the KEY, never the body; every money-mover takes its implementation from the
        // environment resolver, so no real money moves and no real card is issued; and both
        // properties are guarded (TestEveryMoneyMoverTakesItsImplFromTheResolver, and the
        // cross-environment scoping guard).
        //
        // So the client was refusing on the strength of a sentence about a server that no longer
        // behaves that way — and refusing the one call a publisher has to make first.
        //
        // ⚠️ AND ITS ADVICE POINTED THE WRONG WAY, WHICH IS THE PART WORTH REMEMBERING. The refusal's
        // suggested_fix told the caller to escape the sandbox by switching to a live key together with
        // the two production money switches. It pushed a caller toward REAL MONEY to escape a sandbox
        // that had been safe by construction for months. A protection whose escape hatch is more
        // dangerous than the thing it protects against is worse than no protection: it is read as
        // guidance. (The exact wording is not reproduced here on purpose — this comment ships in the
        // published package, and a recipe quoted verbatim is a recipe someone can follow.)
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
          // PCI: never surface raw PAN/CVV into the agent context.
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'purchase_failed')
        }
      },

      /**
       * ⚠️ THE WAIT THE AGENT SEES IS SEVERAL BOUNDED WAITS UNDERNEATH, AND THAT IS NOT A TRICK.
       * The API answers within its own budget and says `still_waiting`; this loops. The 30s bound
       * SECURITY.md promises on every API call stays true word for word, and the agent still makes
       * ONE tool call instead of about thirty.
       *
       * ⚠️ HOW LONG IT MAY LOOP IS THE HOST'S DECISION, NOT OURS. A progress notification resets the
       * client's request timeout only when the client asked for progress AND enabled
       * `resetTimeoutOnProgress`. Without a token nobody is listening and the SDK's 60s default
       * stands, so this finishes inside it. With one, it waits longer — and still stops, because a
       * tool that never returns is a tool that cannot be retried.
       *
       * Either way it ends by RETURNING still_waiting rather than failing. The outcome is read from
       * the purchase, never consumed, so calling again loses nothing.
       */
      await_purchase_approval: async (args, ctx) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result

        // Without a listener: stay inside the SDK's 60s default. With one: a few minutes, then hand
        // the decision back to the agent. Neither number is a preference — the first is the host's
        // timeout, the second is how long we are willing to hold a stdio request open.
        const budgetMs = ctx?.hasProgressToken ? 5 * 60_000 : 50_000
        const deadline = Date.now() + budgetMs

        try {
          for (;;) {
            const startedAt = Date.now()
            const result = await client.awaitPurchaseApproval(id.value)
            if (result.outcome !== 'still_waiting') {
              return jsonResult(result)
            }
            if (Date.now() >= deadline) {
              // Not a failure: nobody has answered yet. Saying so, and being callable again, is what
              // keeps this honest when the host gives us less time than the person takes.
              return jsonResult(result)
            }
            await ctx?.reportProgress('waiting for the account holder to answer')

            // The pace is OURS, not the far side's — see MIN_POLL_INTERVAL_MS above.
            const elapsed = Date.now() - startedAt
            if (elapsed < MIN_POLL_INTERVAL_MS) {
              await new Promise((r) => setTimeout(r, MIN_POLL_INTERVAL_MS - elapsed))
            }
          }
        } catch (err) {
          return errorResult(err, 'await_approval_failed')
        }
      },

      get_purchase_status: async (args) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result
        try {
          const result = await client.getPurchaseStatus(id.value)
          // PCI: redaction is the client's guarantee (see redact.ts), applied inside
          // ShataleClient.request rather than at four call sites.
          //
          // ⚠️ THIS COMMENT USED TO SAY THE GET "advances the state machine and can itself issue a
          // card", AND THAT STOPPED BEING TRUE IN SHAT-2781. A read no longer moves the purchase:
          // the approve button drives it. Corrected rather than deleted, because it was the reason
          // this line existed and the next reader deserves to know the reason changed.
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'purchase_status_failed')
        }
      },

      cancel_purchase: async (args) => {
        const id = requireId(args, 'purchase_id')
        if (!id.ok) return id.result
        try {
          const result = await client.cancelPurchase(
            id.value,
            args.reason ? String(args.reason) : undefined,
          )
          // Belt-and-braces: cancel's response also carries the payment block.
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'purchase_cancel_failed')
        }
      },
    },
  }
}
