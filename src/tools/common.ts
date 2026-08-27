import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import type { GuestContext } from './guest.js'
import { jsonResult, textResult } from '../types.js'
import { errorResult, refusal, MALFORMED_QUERY } from '../errors.js'

/**
 * Can this string be put on a URL at all?
 *
 * Asked by CALLING the very function that would throw, rather than by restating its rule as a
 * surrogate-pair regex. A hand-written predicate and `encodeURIComponent` would be two definitions
 * of the same thing, free to drift, and the one that decides the outcome is the one in client.ts.
 */
function isUrlEncodable(s: string): boolean {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

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

      // ⚠️ THIS CATCH USED TO PRINT THE EXCEPTION VERBATIM — `API error: ${err.message}` — AND IT
      // WAS BELIEVED UNREACHABLE BECAUSE listMCCCodes SWALLOWS ITS OWN FAILURES. IT IS NOT.
      //
      // Measured, not reasoned: `list_mcc_codes({ query: "\uD800" })` against a healthy client
      // answered `API error: URI malformed`. listMCCCodes builds its query string BEFORE opening
      // its try, so `encodeURIComponent` throws past the fallback and lands here. "No caller can
      // reach it" was a property of one line's position inside another file — the kind of claim
      // that stops being true when someone tidies an unrelated line.
      //
      // So this no longer echoes anything, and it does not lean on unreachability either. The one
      // cause we can actually name is refused by name; anything else goes through `errorResult`
      // like every other tool in this package.
      list_mcc_codes: async (args) => {
        const query = args.query ? String(args.query) : undefined
        if (query !== undefined && !isUrlEncodable(query)) return refusal(MALFORMED_QUERY)
        try {
          return jsonResult(await client.listMCCCodes(query))
        } catch (err) {
          return errorResult(err, 'mcc_lookup_failed')
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
