import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult } from '../types.js'
import { errorResult, ShataleApiError } from '../errors.js'
import { requireId } from '../validate.js'

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

/**
 * A plain sentence for the state search_merchants' own endpoint reports, or `undefined`.
 *
 * `ok` needs no explanation, and a missing or unrecognised state gets none: only the catalogue's
 * own word counts, the same rule get_merchant_details follows. Inventing a reason for a state we
 * do not know would be a hint that can point away from the cause.
 */
function catalogMessage(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined
  const { catalog_state: state, total } = result as { catalog_state?: unknown; total?: unknown }
  switch (state) {
    case 'not_published':
      return (
        'The catalog has no published merchants yet, so every search returns an empty list. ' +
        'This is not caused by your filters. The catalog fills as merchants are published; ' +
        'search again later. (get_merchant_details cannot help meanwhile: it reads the same catalog.)'
      )
    case 'no_match':
      return (
        'The catalog has published merchants, but none matched these filters. ' +
        'Broaden or remove a filter (query, category, capability, country) and search again.'
      )
    case 'out_of_range':
      return typeof total === 'number'
        ? `The requested offset is past the end of the results (total is ${total}). Use a smaller offset.`
        : 'The requested offset is past the end of the results. Use a smaller offset.'
    default:
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
          'Returns merchants with their MCP capabilities so you can determine which merchants support agent-driven purchases. ' +
          'An empty result carries catalog_state and a message saying why it is empty.',
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
          // SHAT-3796: an empty list agrees with every hypothesis — broken connection, bad filter,
          // no data — so the answer says which one it is. The API already knows (`catalog_state`);
          // this only puts it into a sentence. The JSON is kept as it was, with one field added.
          const message = catalogMessage(result)
          return jsonResult(message === undefined ? result : { ...(result as object), message })
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
            // Only the catalogue's own word overrides the 404. If it IS published, this really is
            // an unknown id and the original advice is the correct advice — so it survives.
            if (state !== undefined && state !== 'published') {
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
