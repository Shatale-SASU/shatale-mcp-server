import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// F-003: Zod input validation schemas
const createTestUserSchema = z.object({
  email: z.string().email('must be a valid email').optional(),
  name: z.string().min(1).max(200).optional(),
})

export function createSandboxTools(client: ShataleClient): ToolModule {
  return {
    tools: [
      {
        name: 'sandbox_create_test_user',
        description: 'Create a test user in the sandbox environment. Only available with sandbox API keys.',
        inputSchema: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              description: 'Test user email (optional, auto-generated if omitted)',
            },
            name: {
              type: 'string',
              description: 'Test user display name (optional)',
            },
          },
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
        name: 'sandbox_approve_request',
        description:
          'Manually approve a pending purchase or credential request in sandbox. Simulates user/admin approval.',
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description: 'The purchase or credential request ID to approve',
            },
          },
          required: ['request_id'],
        },
      },
      {
        name: 'sandbox_decline_request',
        description: 'Manually decline a pending request in sandbox. Simulates user/admin rejection.',
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description: 'The request ID to decline',
            },
            reason: {
              type: 'string',
              description: 'Reason for declining (optional)',
            },
          },
          required: ['request_id'],
        },
      },
      {
        name: 'sandbox_reset',
        description:
          'Reset the entire sandbox environment — deletes all test users, purchases, and credentials. Use with caution.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    handlers: {
      sandbox_create_test_user: async (args) => {
        // F-003: Validate input with zod
        const parsed = createTestUserSchema.safeParse(args)
        if (!parsed.success) {
          return textResult(`Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`, true)
        }
        try {
          const result = await client.sandboxCreateTestUser(parsed.data)
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'sandbox_create_user_failed',
            message: 'Could not create the sandbox test user.',
            suggested_fix: 'Ensure you are using a sandbox key (sh_test_*) and retry.',
          })
        }
      },

      sandbox_complete_onboarding: async (args) => {
        try {
          const result = await client.sandboxCompleteOnboarding(String(args.user_id))
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'sandbox_onboarding_failed',
            message: 'Could not complete sandbox onboarding.',
            suggested_fix: 'Pass a user_id returned by sandbox_create_test_user.',
          })
        }
      },

      sandbox_approve_request: async (args) => {
        try {
          const result = await client.sandboxApproveRequest(String(args.request_id))
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'sandbox_approve_failed',
            message: 'Could not approve the sandbox request.',
            suggested_fix: 'Pass a request_id for a pending purchase or credential request.',
          })
        }
      },

      sandbox_decline_request: async (args) => {
        try {
          const result = await client.sandboxDeclineRequest(
            String(args.request_id),
            args.reason ? String(args.reason) : undefined,
          )
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'sandbox_decline_failed',
            message: 'Could not decline the sandbox request.',
            suggested_fix: 'Pass a request_id for a pending request.',
          })
        }
      },

      sandbox_reset: async () => {
        try {
          const result = await client.sandboxReset()
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'sandbox_reset_failed',
            message: 'Could not reset the sandbox.',
            suggested_fix: 'Ensure you are using a sandbox key (sh_test_*) and retry.',
          })
        }
      },
    },
  }
}
