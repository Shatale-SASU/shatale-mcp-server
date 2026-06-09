import { randomUUID } from 'node:crypto'
import type { PurchaseInput, CredentialInput, SandboxUserInput } from './types.js'
import { VERSION as CLIENT_VERSION } from './version.js'
import { mapHttpError } from './errors.js'

/**
 * Translate the LLM-facing purchase shape (`merchant` + decimal `amount`)
 * into the backend wire contract. apps/api (api/v1/purchases.go) decodes
 * `merchant_ref` (string) + `amount_cents` (int64), so convert here at the
 * HTTP boundary rather than leaking cents into the agent-facing schema.
 */
export function toPurchaseWireBody(
  input: PurchaseInput,
  generateIdempotencyKey: boolean,
): Record<string, unknown> {
  const amountCents = Math.round(Number(input.amount) * 100)
  const body: Record<string, unknown> = {
    publisher_user_id: input.publisher_user_id,
    agent_id: input.agent_id,
    merchant_ref: input.merchant,
    amount_cents: amountCents,
    currency: input.currency,
    description: input.description,
  }
  if (input.user_hint) body.user_hint = input.user_hint
  if (input.idempotency_key) body.idempotency_key = input.idempotency_key
  else if (generateIdempotencyKey) body.idempotency_key = randomUUID()
  return body
}

export class ShataleClient {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // SHAT-1465: attribution headers identify the official MCP client so the
    // backend can derive guest→sandbox→purchase funnel events from already-
    // authenticated traffic. Gated on apiKey presence ON PURPOSE — guest mode
    // sends no attribution headers and stays intentionally untracked (no new
    // transport, no telemetry endpoint; see README "Privacy & telemetry").
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
      headers['User-Agent'] = `shatale-mcp-server/${CLIENT_VERSION}`
      headers['X-Shatale-Client'] = 'shatale-mcp-server'
      headers['X-Shatale-Client-Version'] = CLIENT_VERSION
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    try {
      const res = await fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      if (!res.ok) {
        // F-006 / SHAT-1463: never leak raw backend bodies — map the status to a
        // structured {code, message, suggested_fix} error instead.
        throw mapHttpError(res.status, method, path)
      }

      return res.json()
    } finally {
      clearTimeout(timeout)
    }
  }

  // ---- Purchase flow ----

  async requestPurchase(input: PurchaseInput): Promise<unknown> {
    return this.request('POST', '/v1/purchases', toPurchaseWireBody(input, true))
  }

  async getPurchaseStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/purchases/${encodeURIComponent(id)}`)
  }

  async cancelPurchase(id: string, reason?: string): Promise<unknown> {
    return this.request('DELETE', `/v1/purchases/${encodeURIComponent(id)}`, { reason })
  }

  // ---- Credentials ----

  async requestCredentials(input: CredentialInput): Promise<unknown> {
    return this.request('POST', '/v1/credentials', input)
  }

  async getCredentialStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/credentials/${encodeURIComponent(id)}`)
  }

  // ---- Onboarding / User Resolution ----

  async registerUserProfile(input: {
    publisher_user_id: string
    user_claims: { email: string; name?: string; phone?: string; country?: string }
    intended_use?: string
    idempotency_key?: string
  }): Promise<unknown> {
    return this.request('POST', '/v1/onboarding/register', input)
  }

  async getOnboardingStatus(sessionId: string): Promise<unknown> {
    return this.request('GET', `/v1/onboarding/sessions/${encodeURIComponent(sessionId)}`)
  }

  // ---- Common ----

  async listMCCCodes(query?: string): Promise<unknown> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : ''
    try {
      return await this.request('GET', `/v1/mcc-codes${qs}`)
    } catch {
      // F-008/F-011: Fallback to built-in MCC list when API returns error
      return ShataleClient.filterBuiltInMCC(query)
    }
  }

  /** Built-in MCC code list used as fallback when API is unavailable */
  private static readonly BUILT_IN_MCC: Array<{ code: number; description: string; category: string }> = [
    { code: 4511, description: 'Airlines, Air Carriers', category: 'travel' },
    { code: 4722, description: 'Travel Agencies and Tour Operators', category: 'travel' },
    { code: 4816, description: 'Computer Network/Information Services', category: 'technology' },
    { code: 5111, description: 'Stationery, Office Supplies', category: 'office' },
    { code: 5311, description: 'Department Stores', category: 'retail' },
    { code: 5411, description: 'Grocery Stores, Supermarkets', category: 'food' },
    { code: 5541, description: 'Service Stations (Fuel)', category: 'auto' },
    { code: 5699, description: 'Miscellaneous Apparel and Accessory Shops', category: 'retail' },
    { code: 5732, description: 'Electronics Stores', category: 'retail' },
    { code: 5734, description: 'Computer Software Stores', category: 'technology' },
    { code: 5812, description: 'Eating Places, Restaurants', category: 'food' },
    { code: 5814, description: 'Fast Food Restaurants', category: 'food' },
    { code: 5816, description: 'Digital Goods: Games', category: 'digital' },
    { code: 5817, description: 'Digital Goods: Applications', category: 'digital' },
    { code: 5818, description: 'Digital Goods: Large Digital Goods Merchant', category: 'digital' },
    { code: 5921, description: 'Package Stores, Beer, Wine, Liquor', category: 'restricted' },
    { code: 5943, description: 'Stationery Stores, Office and School Supply', category: 'office' },
    { code: 5993, description: 'Cigar Stores and Stands', category: 'restricted' },
    { code: 5999, description: 'Miscellaneous and Specialty Retail Stores', category: 'retail' },
    { code: 6011, description: 'Financial Institutions: Automated Cash Disbursements', category: 'financial' },
    { code: 6051, description: 'Non-Financial Institutions: Foreign Currency, Money Orders', category: 'financial' },
    { code: 7011, description: 'Hotels, Motels, Resorts', category: 'travel' },
    { code: 7273, description: 'Dating and Escort Services', category: 'restricted' },
    { code: 7372, description: 'Computer Programming, Data Processing', category: 'technology' },
    { code: 7512, description: 'Automobile Rental Agency', category: 'travel' },
    { code: 7941, description: 'Commercial Sports, Athletic Fields', category: 'entertainment' },
    { code: 7995, description: 'Gambling — Betting/Casino/Lottery', category: 'restricted' },
  ]

  private static filterBuiltInMCC(query?: string) {
    const list = ShataleClient.BUILT_IN_MCC
    if (!query) return { codes: list, source: 'built-in' }
    const q = query.toLowerCase()
    const filtered = list.filter(
      m => m.description.toLowerCase().includes(q) || m.category.includes(q) || String(m.code).includes(q),
    )
    return { codes: filtered, source: 'built-in' }
  }

  // ---- Sandbox ----

  async sandboxCreateTestUser(input?: SandboxUserInput): Promise<unknown> {
    return this.request('POST', '/v1/sandbox/users', input ?? {})
  }

  async sandboxCompleteOnboarding(userId: string): Promise<unknown> {
    return this.request('POST', `/v1/sandbox/users/${encodeURIComponent(userId)}/onboarding`)
  }

  async sandboxApproveRequest(requestId: string): Promise<unknown> {
    return this.request('POST', `/v1/sandbox/requests/${encodeURIComponent(requestId)}/approve`)
  }

  async sandboxDeclineRequest(requestId: string, reason?: string): Promise<unknown> {
    return this.request('POST', `/v1/sandbox/requests/${encodeURIComponent(requestId)}/decline`, { reason })
  }

  async sandboxReset(): Promise<unknown> {
    return this.request('POST', '/v1/sandbox/reset')
  }
}
