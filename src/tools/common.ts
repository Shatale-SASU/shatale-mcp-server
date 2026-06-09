import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult, textResult } from '../types.js'

export function createCommonTools(client: ShataleClient): ToolModule {
  const apiKey = process.env.SHATALE_API_KEY ?? ''
  const isGuest = !apiKey
  const isSandbox = apiKey.startsWith('sh_test_') || apiKey.startsWith('sk_test_') || apiKey.startsWith('sk_sandbox_')
  const mode = isGuest ? 'guest' : isSandbox ? 'sandbox' : 'production'

  return {
    tools: [
      {
        name: 'list_capabilities',
        description:
          'Lists all capabilities currently available on this MCP server, based on the configured API key mode.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_mcc_codes',
        description:
          'Search or list MCC (Merchant Category Codes) used for spending policy configuration.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to filter MCC codes (e.g. "airline", "software", "restaurant")',
            },
          },
        },
      },
    ],
    handlers: {
      list_capabilities: async () => handleListCapabilities(mode),

      list_mcc_codes: async (args) => {
        try {
          const result = await client.listMCCCodes(
            args.query ? String(args.query) : undefined,
          )
          return jsonResult(result)
        } catch (err) {
          return textResult(`API error: ${err instanceof Error ? err.message : String(err)}`, true)
        }
      },
    },
  }
}

function handleListCapabilities(mode: string) {
  const guestTools = [
    'explain_shatale -- Learn about Shatale',
    'simulate_purchase_flow -- Walk through a purchase scenario',
    'generate_policy_template -- Generate a spending policy',
  ]

  const commonTools = [
    'list_capabilities -- This tool',
    'list_mcc_codes -- Search MCC codes',
  ]

  const purchaseTools = [
    'request_purchase -- Execute a purchase',
    'get_purchase_status -- Check purchase status',
    'cancel_purchase -- Cancel a pending purchase',
  ]

  const credentialTools = [
    'request_temporary_credentials -- Get short-lived card credentials',
    'get_credential_status -- Check credential request status',
  ]

  const sandboxTools = [
    'sandbox_create_test_user -- Create a test user',
    'sandbox_complete_onboarding -- Skip onboarding for a test user',
    'sandbox_approve_request -- Approve a pending request',
    'sandbox_decline_request -- Decline a pending request',
    'sandbox_reset -- Reset sandbox environment',
  ]

  let tools = [...guestTools, ...commonTools]
  let description = ''

  switch (mode) {
    case 'guest':
      description = 'Guest mode -- no API key configured. Set SHATALE_API_KEY to unlock more tools.'
      break
    case 'sandbox':
      description = 'Sandbox mode -- using test API key. All tools available with test data.'
      tools = [...tools, ...purchaseTools, ...credentialTools, ...sandboxTools]
      break
    case 'production':
      description = 'Production mode -- using live API key. Real purchases enabled.'
      tools = [...tools, ...purchaseTools, ...credentialTools]
      break
  }

  return textResult(`# Shatale MCP Server -- ${mode} mode

${description}

## Available tools

${tools.map((t) => `- ${t}`).join('\n')}`)
}
