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
  /**
   * @param timeoutMs how long ONE request may take, headers AND body. Defaults to the 30s the
   * server has always used; injectable so a test can prove the bound holds without waiting 30
   * seconds, which is the only reason the previous version of this bound went unverified for so
   * long. See `request` for what the bound did and did not cover before.
   */
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number = 30_000,
  ) {}

  /**
   * SHAT-1686. Derived credential idempotency keys, anchored to the FIRST request of a window
   * rather than to a clock grid. See requestCredentials for why the grid had to go.
   *
   * Bounded: entries are pruned when they expire, and the map is capped, so a long-lived server
   * asked for credentials by many agents cannot grow this without limit.
   */
  private readonly credentialKeys = new Map<string, { key: string; expiresAt: number }>()

  /**
   * How long a derived key is reused. It MIRRORS the backend's default credential lifetime
   * (credentials/service.go: defaultTTL = 1 hour) and is deliberately not longer: reusing a key
   * past the credential's life would replay something already expired, which is the defect the
   * original bucket existed to avoid.
   *
   * /!\ THIS IS A COUPLING TO A CONSTANT IN ANOTHER REPOSITORY, and it is one-directional — nothing
   * here notices if the backend changes it. The API takes ttl_seconds but does not RETURN the
   * effective lifetime in a form this client asks for, and CredentialInput has no ttl_seconds
   * field to send. Named so the next person finds the assumption instead of the symptom.
   */
  private static readonly DERIVED_KEY_WINDOW_MS = 60 * 60 * 1000

  private static readonly MAX_CREDENTIAL_KEYS = 512

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

    // /!\ THE TIMEOUT USED TO COVER ONLY THE HEADERS, AND THE MISSING `await` IS THE WHOLE BUG.
    //
    // This was `return res.json()` inside the try. `finally` runs when the try block RETURNS, not
    // when the returned promise settles — so `clearTimeout` fired the instant fetch resolved its
    // headers, cancelling the abort before a single byte of body had been read. An upstream that
    // answered `200` and then stalled mid-body was never aborted by anything.
    //
    // Measured before the fix, against a local server: stalling BEFORE headers aborted at 30.3s as
    // intended; sending `200` plus a partial body and never ending left the call still hanging at
    // 45 seconds with no result. A stdio MCP server is one process serving one agent — a request
    // that never settles is an agent that never answers again, with nothing logged anywhere.
    //
    // `return await` keeps the try frame alive until the body is parsed, so the timer really does
    // bound the whole exchange. It is the one place in this file where `return await` is load-
    // bearing rather than noise, which is exactly why a linter or a tidy-up would remove it.
    //
    // SECURITY.md has claimed "each API call is bounded by a 30s timeout" throughout; it is true
    // from here on.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

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

      return await res.json()
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
    // SHAT-1685: the backend REQUIRES idempotency_key (credentials.go:57 -> 400 without it), so an
    // explicit key wins and otherwise we derive one. Unlike purchases (eternal de-dup is correct),
    // credential de-dup is (agent_id, key) FOREVER while the credential itself EXPIRES - an
    // eternally-stable key would forever replay an expired credential and permanently block
    // re-issuing for the same (user, agent, merchant).
    //
    // SHAT-1686: THE WINDOW IS ANCHORED TO THE FIRST REQUEST, NOT TO A CLOCK GRID.
    //
    // This used to hash a wall-clock hour bucket, `floor(now / 3_600_000)`, with the comment
    // "rapid retries within the hour de-dup (no accidental double-mint)". That claim was false at
    // the one place a grid can fail, and false for the retry most likely to be an accident: two
    // calls TWO SECONDS apart, at 10:59:59 and 11:00:01, landed in different buckets and minted a
    // second live credential. Measured before it was changed - the test that shows it is in
    // tests/unit/credential-idempotency-window.test.ts and it failed on the old code.
    //
    // /!\ AND THE FIX THE TICKET PROPOSED - "a principled TTL-aligned window" - WOULD NOT HAVE
    // FIXED IT. Aligning the grid to the credential TTL moves the boundary; it does not remove it.
    // Any `floor(now / period)` splits two calls that straddle a multiple of `period`, however
    // small the gap between them. The defect is the GRID, not its size, so changing the size would
    // have closed the ticket and left the failure.
    //
    // An anchored window has no boundary to straddle: the first call starts the window, every
    // repeat inside it gets the same key, and the window ends one credential-lifetime later - which
    // is when replaying would hand back something expired.
    //
    // /!\ WHAT THIS STILL DOES NOT FIX, said here rather than discovered later: the memo is
    // per-PROCESS. Two agent processes asking for the same credential still derive different keys
    // and still double-mint, because nothing outside this process knows the first request happened.
    // Closing that needs the backend to de-dup on (publisher_user_id, agent_id, merchant_domain)
    // while a credential is live, or to expose a lookup for one - neither exists today.
    if (input.idempotency_key) {
      return this.request('POST', '/v1/credentials', { ...input, idempotency_key: input.idempotency_key })
    }

    const now = Date.now()
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.publisher_user_id,
          input.agent_id,
          input.merchant_domain,
          input.purpose,
        ]),
      )
      .digest('hex')

    for (const [k, v] of this.credentialKeys) {
      if (v.expiresAt <= now) this.credentialKeys.delete(k)
    }

    let entry = this.credentialKeys.get(fingerprint)
    if (!entry || entry.expiresAt <= now) {
      // The anchor. `now` appears ONCE, when the window opens, and never again for this
      // fingerprint - that is the whole difference from a grid, where it was consulted on every
      // call and could change the answer between two of them.
      entry = {
        key:
          'mcp-cred-' +
          createHash('sha256').update(fingerprint + ':' + now).digest('hex').slice(0, 32),
        expiresAt: now + ShataleClient.DERIVED_KEY_WINDOW_MS,
      }
      // Cap before inserting. Map preserves insertion order, so the oldest goes first; every
      // entry still live is a window someone may retry into, so this is a last resort rather than
      // routine - at 512 distinct (user, agent, merchant, purpose) tuples inside one hour, in one
      // process, something else is already wrong.
      if (this.credentialKeys.size >= ShataleClient.MAX_CREDENTIAL_KEYS) {
        const oldest = this.credentialKeys.keys().next().value
        if (oldest !== undefined) this.credentialKeys.delete(oldest)
      }
      this.credentialKeys.set(fingerprint, entry)
    }

    return this.request('POST', '/v1/credentials', { ...input, idempotency_key: entry.key })
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
