import type { ShataleClient } from '../client.js'
import type { ToolModule } from '../types.js'
import { jsonResult } from '../types.js'
import { errorResult } from '../errors.js'

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
          const result = await client.request('GET', `/v1/merchants/catalog?${params}`)
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'catalog_search_failed',
            message: 'Could not search the merchant catalog.',
            suggested_fix: 'Retry with simpler filters; the catalog service may be temporarily unavailable.',
          })
        }
      },

      get_merchant_details: async (args) => {
        try {
          const result = await client.request('GET', `/v1/merchants/catalog/${encodeURIComponent(String(args.merchant_id))}`)
          return jsonResult(result)
        } catch (err) {
          return errorResult(err, {
            code: 'merchant_details_failed',
            message: 'Could not fetch merchant details.',
            suggested_fix: 'Use a merchant_id from search_merchants results.',
          })
        }
      },
    },
  }
}
