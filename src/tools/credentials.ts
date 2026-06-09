import { z } from 'zod'
import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult } from '../errors.js'

// F-003: Zod input validation schemas
const requestCredentialsSchema = z.object({
  publisher_user_id: z.string().min(1, 'publisher_user_id is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  merchant_domain: z.string().min(1, 'merchant_domain is required'),
  purpose: z.string().min(1, 'purpose is required'),
})

export function createCredentialTools(client: ShataleClient): ToolModule {
  return {
    tools: [
      {
        name: 'request_temporary_credentials',
        description:
          'Request temporary payment credentials for a merchant that requires card details. Returns short-lived virtual card numbers.',
        inputSchema: {
          type: 'object',
          properties: {
            publisher_user_id: {
              type: 'string',
              description: 'The publisher-side user ID',
            },
            agent_id: {
              type: 'string',
              description: 'Identifier for the AI agent making the request',
            },
            merchant_domain: {
              type: 'string',
              description: 'The merchant domain these credentials will be used for (e.g. "aws.amazon.com")',
            },
            purpose: {
              type: 'string',
              description: 'Why temporary credentials are needed (e.g. "Add payment method for AWS account")',
            },
          },
          required: ['publisher_user_id', 'agent_id', 'merchant_domain', 'purpose'],
        },
      },
      {
        name: 'get_credential_status',
        description: 'Check the status of a temporary credential request.',
        inputSchema: {
          type: 'object',
          properties: {
            credential_request_id: {
              type: 'string',
              description: 'The credential request ID',
            },
          },
          required: ['credential_request_id'],
        },
      },
    ],
    handlers: {
      request_temporary_credentials: async (args) => {
        // F-003: Validate input with zod
        const parsed = requestCredentialsSchema.safeParse(args)
        if (!parsed.success) {
          return textResult(`Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`, true)
        }
        try {
          const result = await client.requestCredentials(parsed.data) as Record<string, unknown>
          // F-017: Mask generated_password if present in response
          if (result && typeof result === 'object' && 'generated_password' in result) {
            const pw = String(result.generated_password)
            result.generated_password = pw.length > 4
              ? pw.slice(0, 2) + '*'.repeat(pw.length - 4) + pw.slice(-2)
              : '****'
            result._password_note = 'This is a relay-only password for the merchant integration. It will expire after first use.'
          }
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'credentials_failed',
            message: 'Could not issue temporary credentials.',
            suggested_fix: 'Confirm the user is onboarded and the merchant_domain is valid, then retry.',
          })
        }
      },

      get_credential_status: async (args) => {
        try {
          const result = await client.getCredentialStatus(String(args.credential_request_id))
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'credential_status_failed',
            message: 'Could not fetch the credential status.',
            suggested_fix: 'Use the credential_request_id returned by request_temporary_credentials.',
          })
        }
      },
    },
  }
}
