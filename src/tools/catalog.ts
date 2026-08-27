import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult } from '../types.js'
import { errorResult } from '../errors.js'
import { requireId } from '../validate.js'

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
          return errorResult(err, 'merchant_details_failed')
        }
      },
    },
  }
}
