import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'
import { requireId } from '../validate.js'

// F-003: Zod input validation schemas
const registerUserProfileSchema = z.object({
  publisher_user_id: z.string().min(1, 'publisher_user_id is required'),
  user_claims: z.object({
    email: z.string().email('valid email is required'),
    name: z.string().optional(),
    phone: z.string().optional(),
    country: z.string().length(2, 'country must be a 2-letter ISO code').optional(),
  }),
  intended_use: z.enum(['purchase', 'credentials', 'general']).optional().default('general'),
  idempotency_key: z.string().optional(),
})

// SHAT-1662. These two tools are OFF unless SHATALE_ONBOARDING_ENABLED=true, and the
// flip condition is not "the backend flag is on" — it is "the funnel can close".
//
// ⚠️ THE CAUSE THIS COMMENT USED TO NAME HAS BEEN CURED, AND THE CONCLUSION STILL
// STANDS FOR A DIFFERENT ONE (SHAT-2622, measured 2026-09-14 against shatale-api
// origin/main fb9b983bc). It read:
//
//   "RegisterUserProfile mints sessionID = ulid.New() and never persists it … then
//    returns it as `claim_set_id`. GET /v1/onboarding/sessions/{that id} 404s
//    forever, because there is no row to find."
//
// That was true when written and it is FALSE NOW, in the code rather than in prose:
//   api/v1/onboarding_api.go:161  returns `claim_set_id` from res.ClaimSetID — the
//                                 resolver's row — and :154 REFUSES when it is empty
//                                 rather than handing out a minted id
//   api/v1/onboarding_api.go:242  GetSessionStatus does
//                                 `SELECT status, user_id, created_at FROM
//                                  publisher_user_links WHERE id = $1`
//   and api/v1/the_claim_set_funnel_reaches_step_two_db_test.go walks exactly that,
//   against a database, and passes.
//
// 🔴 WHY THE PAIR STAYS OFF ANYWAY: the id register hands out and the id the LATER
// steps read live in different tables. Read in the handlers, not in a comment about
// them:
//   POST /v1/onboarding/register                → publisher_user_links  (the id)
//   GET  /v1/onboarding/sessions/{id}           → publisher_user_links  (finds it)
//   POST /v1/onboarding/sessions/{id}/profile   → enrollment_sessions   (onboarding_api.go:203)
//   POST /v1/onboarding/sessions/{id}/send-code → enrollment_sessions   (onboarding_send_code_handler.go:78)
//   POST …/verify-code                          → enrollment_sessions   (main.go:2003)
//   POST …/complete                             → enrollment_sessions   (onboarding_complete_handler.go:52)
// So with both flags on, an agent CAN register and CAN poll status, and the four
// steps after that answer "session not found" for the only id it was ever given.
// SHAT-2722 owns that defect; SHAT-2011 names a second blocker (its own supports are
// worth re-reading — GetSessionStatus is no longer the stub it describes).
//
// Control on that reading, because "every step reads enrollment_sessions" would be
// the same answer from a broken reader: the same reading finds TWO steps that agree
// with each other (register and status, both publisher_user_links). It is a
// mismatch between halves, not one table everywhere.
//
// ⇒ AND THIS CORRECTION IS THE POINT, not tidiness. A reader who checked the cause
// this comment used to name would find it fixed, conclude the condition was met, and
// flip the flag straight into four 404s on an identity path. A stale reason under a
// right conclusion is more dangerous than no reason at all: it tells the next person
// exactly which wrong thing to verify. The same shape, from the other direction, is
// recorded beside get_credential_emails (SHAT-2527): there the condition HAD been
// met and the sentence outlived the measurement for seventeen days.
//
// THE FLIP CONDITION, RESTATED SO IT CAN BE MEASURED: the four later steps read the
// row the register step writes. Check the handlers' tables, not this comment.
//
// So this was not flag-dark, it was unwired: two tools advertised in every client's
// tool list, describing a flow whose later steps could never succeed. An agent
// cannot ask a follow-up question — a tool that is visible is a tool it will try,
// and a promise it will build on.
//
// Same shape as get_credential_emails: the gate removes the HANDLER as well as the
// listing, because CallTool dispatches on handlers, and a merely-unlisted tool stays
// callable by name.
export function createOnboardingTools(
  client: ShataleClient,
  opts: { enabled?: boolean } = {},
): ToolModule {
  const enabled = opts.enabled ?? false
  const mod: ToolModule = {
    tools: [
      {
        name: 'register_user_profile',
        description:
          'Submit user profile data to Shatale for a new user. The user will receive a verification link ' +
          'to confirm their identity and data. This does NOT create an active account — the user must verify. ' +
          'Use this when you have user details but no immediate purchase intent, or to pre-register before purchasing.',
        inputSchema: {
          type: 'object',
          properties: {
            publisher_user_id: {
              type: 'string',
              description: 'Your publisher-side user identifier',
            },
            user_claims: {
              type: 'object',
              description: 'User data to submit (unverified — user must confirm)',
              properties: {
                email: { type: 'string', description: 'User email address (required)' },
                name: { type: 'string', description: 'User full name' },
                phone: { type: 'string', description: 'User phone number' },
                country: { type: 'string', description: 'User country code (ISO 3166-1 alpha-2, e.g. "FR", "US")' },
              },
              required: ['email'],
            },
            intended_use: {
              type: 'string',
              enum: ['purchase', 'credentials', 'general'],
              description: 'What this registration is for (helps optimize the flow)',
            },
            idempotency_key: {
              type: 'string',
              description: 'Unique key to prevent duplicate submissions',
            },
          },
          required: ['publisher_user_id', 'user_claims'],
        },
      },
      {
        name: 'get_onboarding_status',
        description:
          'Check the status of a user onboarding/registration session. ' +
          'Returns whether the user has verified their email, completed their profile, and granted any required consents.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The onboarding session ID returned by register_user_profile or request_purchase',
            },
          },
          required: ['session_id'],
        },
      },
    ],
    handlers: {
      register_user_profile: async (args) => {
        // F-003: Validate input with zod
        const parsed = registerUserProfileSchema.safeParse(args)
        if (!parsed.success) {
          return textResult(`Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`, true)
        }
        try {
          const input = parsed.data
          const result = await client.registerUserProfile({
            publisher_user_id: input.publisher_user_id,
            user_claims: input.user_claims,
            intended_use: input.intended_use,
            idempotency_key: input.idempotency_key,
          })
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'registration_failed')
        }
      },

      get_onboarding_status: async (args) => {
        const sessionId = requireId(args, 'session_id')
        if (!sessionId.ok) return sessionId.result
        try {
          const result = await client.getOnboardingStatus(sessionId.value)
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'onboarding_status_failed')
        }
      },
    },
  }

  if (!enabled) {
    mod.tools = []
    mod.handlers = {}
  }
  return mod
}
