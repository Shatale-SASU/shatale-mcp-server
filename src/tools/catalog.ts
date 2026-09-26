import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult } from '../types.js'
import { errorResult, ShataleApiError } from '../errors.js'
import { requireId } from '../validate.js'

/**
 * The one `catalog_state` under which a 404 for a merchant id is NOT about the id.
 *
 * The field has exactly one producer — shatale-api, `apps/api/api/v1/merchant_catalog.go`, func
 * `catalogState` — and it returns one of `ok`, `out_of_range`, `not_published`, `no_match`
 * (measured on that repo's origin/main on 2026-09-27). Three of the four mean the catalogue HAS
 * published merchants, and then an id it cannot find is an id worth checking. Only this one means
 * there is nothing to find at all.
 *
 * ⚠️ Written as an inclusion, never as `!== something`: an exclusion is satisfied by every value
 * the producer might add later, and by every value it never had. SHAT-4031 was exactly that — a
 * comparison against `'published'`, which is not in the set above and never was.
 */
const CATALOGUE_HAS_NOTHING_TO_FIND = 'not_published'

/**
 * The catalogue's own account of itself, from the endpoint search_merchants uses.
 *
 * Returns `undefined` when it cannot be established — a probe that fails must never replace the
 * caller's original error with a worse one, so the 404 stands and this simply adds nothing.
 */
async function catalogState(client: ShataleClient): Promise<string | undefined> {
  try {
    const catalog = await client.request('GET', '/v1/merchants/catalog', undefined, 'fixed')
    const state = (catalog as { catalog_state?: unknown } | null)?.catalog_state
    return typeof state === 'string' ? state : undefined
  } catch {
    return undefined
  }
}

export function createCatalogTools(client: ShataleClient): ToolModule {
  return {
    tools: [
      {
        name: 'search_merchants',
        description:
          'Search the Shatale merchant catalog. Find merchants by category, capability, keyword, or country. ' +
          'Returns merchants with their MCP capabilities so you can determine which merchants support agent-driven purchases.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword search (merchant name, description)' },
            category: { type: 'string', description: 'Filter by category (e.g., "marketplace", "travel", "electronics")' },
            capability: { type: 'string', description: 'Filter by capability (e.g., "search", "cart", "checkout", "tracking", "returns")' },
            country: { type: 'string', description: 'Filter by country code (e.g., "US", "DE", "FR")' },
          },
        },
      },
      {
        name: 'get_merchant_details',
        description:
          'Get detailed information about a specific merchant, including their MCP server configuration, ' +
          'available tools, rate limits, and capabilities. Use this after search_merchants to get integration details.',
        inputSchema: {
          type: 'object',
          properties: {
            merchant_id: { type: 'string', description: 'Merchant ID from search_merchants results' },
          },
          required: ['merchant_id'],
        },
      },
    ],
    handlers: {
      search_merchants: async (args) => {
        try {
          const params = new URLSearchParams()
          if (args.query) params.set('q', String(args.query))
          if (args.category) params.set('category', String(args.category))
          if (args.capability) params.set('capability', String(args.capability))
          if (args.country) params.set('country', String(args.country))
          // SHAT-2678: the query string filters, it does not address. No id here for a 404 to be
          // about, so do not send the caller looking for one.
          const result = await client.request('GET', `/v1/merchants/catalog?${params}`, undefined, 'fixed')
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, 'catalog_search_failed')
        }
      },

      get_merchant_details: async (args) => {
        const merchantId = requireId(args, 'merchant_id')
        if (!merchantId.ok) return merchantId.result
        try {
          const result = await client.request(
            'GET',
            `/v1/merchants/catalog/${encodeURIComponent(merchantId.value)}`,
            undefined,
            'caller-id',
          )
          return jsonResult(result)
        } catch (err) {
          // ⚠️ THE HONEST ANSWER ALREADY EXISTS ONE ENDPOINT AWAY, AND THIS PATH USED TO IGNORE IT.
          //
          // search_merchants returns `catalog_state` — measured in production, `"not_published"` —
          // so the neighbour can say WHY it found nothing. This handler could not, and answered a
          // bare `not_found` whose suggested_fix offers four causes: the id never existed, it
          // belongs to another publisher, it came from the other environment, or the route is not
          // deployed. With an unpublished catalogue every one of them is wrong, and a reader who
          // follows the advice starts three hunts, none of them the cause.
          //
          // A hint that points away from the cause is worse than no hint: silence makes someone
          // ask us, advice makes them search on their own.
          //
          // ⚠️ SO THE EXPLANATION IS READ FROM THE SAME PLACE THE NEIGHBOUR READS IT, not written
          // here in different words. Two sites answering one question out of separate knowledge
          // drift apart, and the one that drifts is the one nobody touches.
          if (err instanceof ShataleApiError && err.code === 'not_found') {
            const state = await catalogState(client)
            // Only the catalogue's own word overrides the 404, and only the ONE word that explains
            // it. SHAT-4031: this used to read `state !== 'published'` — a value the producer has
            // never emitted, so the test was true for every real answer and a healthy catalogue's
            // 404 lost the advice that was correct. See CATALOGUE_HAS_NOTHING_TO_FIND.
            if (state !== undefined && state === CATALOGUE_HAS_NOTHING_TO_FIND) {
              return jsonResult({
                catalog_state: state,
                merchant_id: merchantId.value,
                merchant: null,
              })
            }
          }
          return errorResult(err, 'merchant_details_failed')
        }
      },
    },
  }
}
