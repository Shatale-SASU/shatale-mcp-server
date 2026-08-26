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
// flip condition is not "the backend flag is on" — it is "Funnel B is merged AND
// deployed". Review traced the loop at the source and it cannot close even with the
// backend flag enabled:
//
//   RegisterUserProfile mints sessionID = ulid.New() and never persists it — main.go
//   says so in as many words — then returns it as `claim_set_id`, while this tool's
//   description promised a `session_id`. GET /v1/onboarding/sessions/{that id} 404s
//   forever, because there is no row to find.
//
// So this was not flag-dark, it was unwired: two tools advertised in every client's
// tool list, describing a two-step flow whose second step could never succeed. An
// agent cannot ask a follow-up question — a tool that is visible is a tool it will
// try, and a promise it will build on.
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
          return errorResult(err, {
            code: 'registration_failed',
            message: 'Could not register the user profile.',
            suggested_fix: 'Confirm user_claims.email is a valid email, then retry.',
          })
        }
      },

      get_onboarding_status: async (args) => {
        const sessionId = requireId(args, 'session_id')
        if (!sessionId.ok) return sessionId.result
        try {
          const result = await client.getOnboardingStatus(sessionId.value)
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'onboarding_status_failed',
            message: 'Could not fetch the onboarding status.',
            suggested_fix: 'Use the session_id returned by register_user_profile or request_purchase.',
          })
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
