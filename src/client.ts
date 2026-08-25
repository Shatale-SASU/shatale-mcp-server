import { createHash } from 'node:crypto'
import type { PurchaseInput, CredentialInput, SandboxAuthInput } from './types.js'
import { VERSION as CLIENT_VERSION } from './version.js'
import { mapHttpError } from './errors.js'

/**
 * SHAT-1682: derive a STABLE idempotency key from the purchase's identifying
 * fields, so an LLM (or transport) that retries the same logical `request_purchase`
 * — e.g. after the 30s fetch timeout below — reuses the same key and the backend
 * de-dups instead of charging twice. A per-call `randomUUID()` did the opposite:
 * every retry got a fresh key and became a SECOND real purchase (the money-out
 * "intent-first / stable key" lesson). Callers who genuinely want to repeat an
 * identical purchase must pass an explicit `idempotency_key` to differentiate.
 */
export function deriveIdempotencyKey(input: PurchaseInput, amountCents: number): string {
  // JSON.stringify (not a space-join): fields can contain spaces, so a delimiter
  // join lets two DIFFERENT purchases canonicalize to the same string and collide
  // onto one key (e.g. merchant="nike 4999 EUR" vs description carrying "4999 EUR").
  const canonical = JSON.stringify([
    input.publisher_user_id,
    input.agent_id,
    input.merchant,
    amountCents,
    input.currency,
    input.description,
  ])
  return 'mcp-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

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
  // Explicit caller key wins; otherwise a DETERMINISTIC key (not random) so
  // retries of the same logical purchase de-dup rather than double-charge.
  if (input.idempotency_key) body.idempotency_key = input.idempotency_key
  else if (generateIdempotencyKey) body.idempotency_key = deriveIdempotencyKey(input, amountCents)
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
    // SHAT-1685: the backend REQUIRES idempotency_key (credentials.go:57 → 400
    // without it), and minting a card burns real funding, so an explicit key wins
    // and otherwise we derive one. Unlike purchases (eternal de-dup is correct),
    // credential de-dup is (agent_id, key) FOREVER while the credential itself
    // EXPIRES — an eternally-stable key would forever replay an expired credential
    // and permanently block re-issuing for the same (user, agent, merchant). So the
    // derived key carries a coarse HOURLY bucket: rapid retries within the hour
    // de-dup (no accidental double-mint), while a later legitimate re-request gets
    // a fresh key. (SHAT: a principled TTL-aligned window is tracked separately.)
    const hourBucket = Math.floor(Date.now() / 3_600_000)
    const idempotency_key =
      input.idempotency_key ||
      'mcp-cred-' +
        createHash('sha256')
          .update(
            JSON.stringify([
              input.publisher_user_id,
              input.agent_id,
              input.merchant_domain,
              input.purpose,
              hourBucket,
            ]),
          )
          .digest('hex')
          .slice(0, 32)
    return this.request('POST', '/v1/credentials', { ...input, idempotency_key })
  }

  async getCredentialStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/credentials/${encodeURIComponent(id)}`)
  }

  // Emails received on a credential's relay address (verification/OTP mail). Publisher-scoped
  // by the API key on the backend; the agent reads the code it needs to finish signup.
  async getCredentialEmails(id: string): Promise<unknown> {
    return this.request('GET', `/v1/credentials/${encodeURIComponent(id)}/emails`)
  }

  // ---- Checkout identity ----

  // Returns the two honest identities for a purchase's checkout: billing_identity (Shatale, the
  // cardholder on the pool card) and merchant_customer_identity (the end-user / buyer). Live money
  // path (agent-scoped by the API key's publisher); no card credentials here.
  async getCheckoutIdentity(id: string): Promise<unknown> {
    return this.request('GET', `/v1/purchases/${encodeURIComponent(id)}/checkout-identity`)
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
    } catch (err) {
      // F-008/F-011: fall back to the built-in list rather than failing — this is static
      // reference data and an agent looking up "which code is gambling" should not be
      // blocked by a network hiccup.
      //
      // But it SAYS SO. The fallback used to be silent, which made every answer read as
      // if it came from the server; review measured that /v1/mcc-codes does not exist on
      // the deployment at all, so the fallback fires every single time and nothing said
      // so. "Error reads as data" is the worst failure mode for a caller that cannot ask
      // a follow-up question — so the reason travels with the answer.
      return {
        ...(ShataleClient.filterBuiltInMCC(query) as Record<string, unknown>),
        _source: 'built-in',
        _note:
          'Served from this package\'s built-in ISO 18245 list, not from the API — the ' +
          'lookup failed (' + (err instanceof Error ? err.message : String(err)) + '). ' +
          'Codes are stable, but a code added server-side will not appear here.',
      }
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
  //
  // These map 1:1 to the three sandbox routes the backend actually deploys
  // (apps/api/main.go): the side-effect-free policy engine and the two
  // SandboxOnly-gated lifecycle helpers. The previously-shipped
  // create-user / requests/{id}/{approve,decline} / reset methods were built
  // against endpoints that were never deployed and have been removed
  // (SHAT-1488).

  /**
   * Run the policy engine without side effects (no ledger, no outbox, no
   * money). amount is an integer minor-unit value per the backend
   * sandboxAuthRequest struct. Test cards: 4242… force-approve, 4000…0002
   * force-decline, neutral (e.g. 4111…) → real policy decides.
   */
  async sandboxSimulateAuthorization(input: SandboxAuthInput): Promise<unknown> {
    return this.request('POST', '/v1/sandbox/authorizations', {
      agent_id: input.agent_id,
      amount: input.amount,
      currency: input.currency,
      mcc: input.mcc,
      merchant_name: input.merchant_name,
      card_number: input.card_number,
    })
  }

  async sandboxCompleteOnboarding(userId: string): Promise<unknown> {
    return this.request('POST', `/v1/sandbox/users/${encodeURIComponent(userId)}/onboarding`)
  }

  async sandboxApprovePurchase(purchaseId: string): Promise<unknown> {
    return this.request('POST', `/v1/sandbox/purchases/${encodeURIComponent(purchaseId)}/approve`)
  }
}
