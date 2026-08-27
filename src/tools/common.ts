import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import type { GuestContext } from './guest.js'
import { jsonResult, textResult } from '../types.js'

// SHAT-1460/2484: a sandbox key is EXACTLY `sk_sandbox_*`. The identity service issues `sk_sandbox_` for
// sandbox and `sk_live_` for live — it has never issued `sk_test_` or `sh_test_`, so those were dead prefixes
// widening acceptance for keys that do not exist. One definition here, imported by index.ts too, so the two
// sandbox-detection sites can no longer drift (they previously listed the same prefixes in different order).
export function isSandboxKey(apiKey: string): boolean {
  return apiKey.startsWith('sk_sandbox_')
}

export function createCommonTools(client: ShataleClient, ctx: GuestContext): ToolModule {

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
      list_capabilities: async () => handleListCapabilities(ctx),

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

// SHAT-1461: the tool list is built FROM THE ROUTER (ctx.getToolNames), never a hand-maintained per-mode
// array. The old static lists drifted three ways at once: they used only three modes (the server has four —
// live-money-GO and live-onboarding-only are distinct), they omitted seven registered tools (the whole
// checkout and onboarding groups) in every mode, and they named request_purchase as callable in sandbox where
// it is client-blocked. Deriving the list from the tools this process actually registered makes all three
// impossible by construction — the same fix explain_shatale already uses.
function handleListCapabilities(ctx: GuestContext) {
  const mode = ctx.isGuest
    ? 'GUEST'
    : ctx.isSandbox
      ? 'DEMO (SANDBOX)'
      : ctx.moneyEnabled
        ? 'LIVE (money-GO)'
        : 'LIVE (onboarding-only)'

  const note = ctx.isGuest
    ? 'No API key configured — explore, simulate, and generate a policy. No real call or payment. Set SHATALE_API_KEY to unlock more tools.'
    : ctx.isSandbox
      ? 'Sandbox key — the full API against test data, no real money. request_purchase runs the ordinary path: the server stamps the environment from the key, so nothing here reaches live money. sandbox_simulate_authorization is the narrower tool for testing a policy decision without creating a purchase.'
      : ctx.moneyEnabled
        ? 'Live key with money-GO — real production APIs; the purchase and credential tools move REAL money.'
        : 'Live key, onboarding-only — real APIs, but money tools are disabled (they require SHATALE_MONEY_GO).'

  const toolList = ctx
    .getToolNames()
    .map((n) => `- \`${n}\``)
    .join('\n')

  return textResult(`# Shatale MCP Server — ${mode} mode

${note}

## Tools available in this mode
${toolList}`)
}
