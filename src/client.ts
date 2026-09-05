import { createHash } from 'node:crypto'
import type { PurchaseInput, CredentialInput, SandboxAuthInput } from './types.js'
import { VERSION as CLIENT_VERSION } from './version.js'
import { mapHttpError, extractRequestId, BUILT_IN_MCC_NOTE, type RequestAddressing, type KeyKind } from './errors.js'
import { redactPurchaseCard } from './redact.js'

/**
 * Flattens an error's `cause` chain into one operator-readable line.
 *
 * ⚠️ FOR STDERR ONLY — NEVER FOR ANYTHING AN AGENT RECEIVES. Everything a tool returns goes through
 * `errorResult`, which echoes nothing by construction. This exists for the one place that must tell
 * the OPERATOR what happened (the `list_mcc_codes` fallback), on the channel the model cannot see.
 *
 * ⚠️ AND IT EXISTS BECAUSE `err.message` ALONE SAYS NOTHING. Node's fetch reports every network
 * failure as the same two words — `fetch failed` — and puts the thing that actually happened one
 * level down in `cause`: `connect ECONNREFUSED 127.0.0.1:9`, `getaddrinfo ENOTFOUND …`, a timeout.
 * Logging only the message produces a line that is identical for DNS, refusal and timeout, which
 * are precisely the three cases the note tells the operator this log will distinguish. A promise of
 * a reason has to deliver the reason.
 */
export function describeErrorChain(err: unknown, maxDepth = 5): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; depth < maxDepth && cur && typeof cur === 'object'; depth++) {
    if (seen.has(cur)) break // a cause chain may loop back on itself
    seen.add(cur)
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown }
    if (typeof e.message === 'string' && e.message) {
      // The code is the part an operator greps for, and it is not always in the message.
      const code = typeof e.code === 'string' && !e.message.includes(e.code) ? ` (${e.code})` : ''
      const line = `${e.message}${code}`
      if (!parts.includes(line)) parts.push(line)
    }
    cur = e.cause
  }
  return parts.length ? parts.join(' ← ') : String(err)
}

/**
 * SHAT-1682: derive a STABLE idempotency key from the purchase's identifying
 * fields, so an LLM (or transport) that retries the same logical `request_purchase`
 * — e.g. after the 30s fetch timeout below — reuses the same key and the backend
 * de-dups instead of charging twice. A per-call `randomUUID()` did the opposite:
 * every retry got a fresh key and became a SECOND real purchase (the money-out
 * "intent-first / stable key" lesson). Callers who genuinely want to repeat an
 * identical purchase must pass an explicit `idempotency_key` to differentiate.
 */
/**
 * A stable idempotency key for an operation identified by its target, not by its payload.
 *
 * ⚠️ DETERMINISTIC, NOT RANDOM, FOR THE SAME REASON AS deriveIdempotencyKey ABOVE. A per-call
 * `randomUUID()` gives every retry a fresh key, so a transport retry or an LLM repeating itself
 * becomes a SECOND real effect — the exact defect SHAT-1682 fixed for purchases. Keyed on the
 * operation and its target, a retry of "approve purchase X" is the same intent and de-dups, while
 * "approve purchase Y" is a different key.
 *
 * ⚠️ AND THAT IS THE RIGHT CHOICE ONLY BECAUSE THESE OPERATIONS ARE ADDRESSED, NOT CREATED. Each
 * names a row that already exists (a purchase, a user), so repeating the call can only ever mean
 * "do that same thing again". request_purchase is different — it CREATES — which is why it hashes
 * the whole purchase and lets a caller pass an explicit key to repeat one deliberately.
 */
export function deriveOperationKey(operation: string, ...targets: string[]): string {
  const canonical = JSON.stringify([operation, ...targets])
  return 'mcp-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

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
   * What this process is RUNNING WITH — read from the key it holds, never from a flag someone set.
   * The auth advice depends on it: telling a live integration to swap in a sandbox key is
   * destructive (SHAT-2678 follow-up), and telling a keyless session to check its scopes is noise.
   */
  private keyKind(): KeyKind {
    if (!this.apiKey) return 'none'
    if (this.apiKey.startsWith('sk_live_')) return 'live'
    if (this.apiKey.startsWith('sk_sandbox_')) return 'sandbox'
    return 'none'
  }

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

  /**
   * ⚠️ `addressing` IS THE ONE FACT ONLY THIS FILE HAS, AND IT MUST BE STATED, NOT GUESSED
   * (SHAT-2678).
   *
   * Every method below either interpolates an id the caller handed us or composes a constant
   * path. That is knowledge, and it decides who a 404 blames — see `NOT_FOUND_FIX` in errors.ts
   * for what was wrong twice when the answer was inferred from the path string instead.
   *
   * The default is 'unknown' deliberately. A new route whose author forgets this argument gets an
   * answer that admits both causes; it does NOT inherit a confident wrong half. Say 'fixed' only
   * where the caller contributed no part of the address.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    addressing: RequestAddressing = 'unknown',
  ): Promise<unknown> {
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
        //
        // /!\ ONE FIELD IS READ OUT OF THAT BODY, BY NAME, AND NOTHING ELSE: request_id.
        //
        // This used to discard the body unread, and the comment above described that as the leak
        // guard. It is not — the guard is that no upstream MESSAGE reaches the agent, and that holds
        // exactly as before. What was lost with the body was the one field the backend puts there to
        // make a failure traceable: writeErrorCtx sends `request_id` on every error, and on a
        // REDACTED 5xx it mints a correlation id specifically so the client can be told nothing while
        // the real detail stays findable in the server log. Throwing that away meant a person
        // debugging a 500 had a fixed sentence and no way to find the record behind it.
        //
        // extractRequestId reads that one key and drops the rest of the body unread, refusing
        // anything that is not a short plain string — so a hostile or malformed body cannot use this
        // field as a channel. A pointer to a record is not the record.
        //
        // The read cannot itself become a failure: a body that is empty, truncated or not JSON makes
        // this undefined, and the error is thrown exactly as it was before.
        let requestId: string | undefined
        try {
          requestId = extractRequestId(await res.json())
        } catch {
          requestId = undefined
        }
        throw mapHttpError(res.status, method, path, requestId, { addressing, keyKind: this.keyKind() })
      }

      // /!\ THE PCI SCRUB IS APPLIED HERE, ON EVERY RESPONSE, AND THAT IS THE WHOLE CHANGE.
      //
      // It used to be called at four tool call sites, while its own comment claimed the global form:
      // "NO TOOL RESULT CARRIES A NUMBER+CVV PAIR". True of the function; false of the server. Every
      // other tool returned the upstream body unfiltered, and a tool written tomorrow got nothing.
      //
      // One door. A new tool cannot miss it by not knowing it exists, and its absence is visible in
      // one place instead of by auditing every handler. Nothing legitimate is lost: no tool needs a
      // PAN in its RESULT — card_number is an INPUT to sandbox_simulate_authorization — and last4 is
      // derived before the deletion so an agent can still tell two cards apart.
      //
      // /!\ THE `await` IS NOT THIS CHANGE'S, AND BOTH HALVES OF THIS LINE ARE LOAD-BEARING.
      //
      // `await` belongs to the request-timeout fix: without it `finally` clears the abort timer the
      // moment the try block RETURNS a promise, so the timeout covered the headers and not the body,
      // and an upstream that stalled mid-body hung the agent for ever. `redactPurchaseCard` is this
      // change: the PCI scrub applied once, here, instead of at four tool call sites.
      //
      // They arrived as separate pull requests and conflicted on exactly this line, as predicted and
      // rehearsed before either was merged. Taking either side alone compiles, passes most of the
      // suite, and silently restores one of the two defects. Keep both.
      // ⚠️ THE PATH IS PASSED NOW, BECAUSE THE QUESTION IS WHOSE CARD IT IS (SHAT-2610). The scrub
      // was shape-based and could not tell the card we issued — a tool we handed the agent so it
      // could pay — from the customer's own instrument, which is never ours to show. Provenance is
      // what we know for certain; the body misdescribes itself (the sandbox approval claims
      // merchant_locked, and no such field is sent to the issuer at all).
      return redactPurchaseCard(await res.json(), path)
    } finally {
      clearTimeout(timeout)
    }
  }

  // ---- Purchase flow ----

  async requestPurchase(input: PurchaseInput): Promise<unknown> {
    // The one genuine create on the money path: a constant collection address, no id from the
    // caller anywhere in it. A 404 here is about the deployment.
    return this.request('POST', '/v1/purchases', toPurchaseWireBody(input, true), 'fixed')
  }

  async getPurchaseStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/purchases/${encodeURIComponent(id)}`, undefined, 'caller-id')
  }

  /**
   * Ask the API to wait, briefly, for the person to answer.
   *
   * ⚠️ ONE CALL OF THIS IS NOT THE WHOLE WAIT. The API bounds its own wait to well under the 30s
   * this client allows every request (SECURITY.md promises that bound, for the stated reason that a
   * stalled backend must not hang the agent), and answers `still_waiting` when its budget runs out.
   * The caller loops. That is deliberate: the guarantee stays true word for word, and the tool above
   * this one is what turns several bounded calls into one wait the agent sees.
   */
  async awaitPurchaseApproval(id: string): Promise<{ outcome: string; purchase?: unknown }> {
    return this.request(
      'GET',
      `/v1/purchases/${encodeURIComponent(id)}/await-approval`,
      undefined,
      'caller-id',
    ) as Promise<{ outcome: string; purchase?: unknown }>
  }

  async cancelPurchase(id: string, reason?: string): Promise<unknown> {
    // SHAT-2633: a cancel is a state change on the money path. Without a key a retry is
    // indistinguishable from a second intent — the sentence that ticket uses to explain why this
    // one mattered, and the reason "all" was in SHAT-1104's title.
    return this.request(
      'DELETE',
      `/v1/purchases/${encodeURIComponent(id)}`,
      { reason, idempotency_key: deriveOperationKey('cancel_purchase', id) },
      'caller-id',
    )
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
      return this.request(
        'POST',
        '/v1/credentials',
        { ...input, idempotency_key: input.idempotency_key },
        'fixed',
      )
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

    return this.request('POST', '/v1/credentials', { ...input, idempotency_key: entry.key }, 'fixed')
  }

  async getCredentialStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/credentials/${encodeURIComponent(id)}`, undefined, 'caller-id')
  }

  // Emails received on a credential's relay address (verification/OTP mail). Publisher-scoped
  // by the API key on the backend; the agent reads the code it needs to finish signup.
  async getCredentialEmails(id: string): Promise<unknown> {
    return this.request('GET', `/v1/credentials/${encodeURIComponent(id)}/emails`, undefined, 'caller-id')
  }

  // ---- Checkout identity ----

  // Returns the two honest identities for a purchase's checkout: billing_identity (Shatale, the
  // cardholder on the pool card) and merchant_customer_identity (the end-user / buyer). Live money
  // path (agent-scoped by the API key's publisher); no card credentials here.
  // The reveal path the redaction allowlist has been holding open since SHAT-2610. `redact.ts:71`
  // lists it with the comment "for when the client learns to call it" — this is the client learning.
  //
  // ⚠️ WHY THIS GOES THROUGH `request` LIKE EVERYTHING ELSE, AND MUST. The PCI scrub is applied ONCE,
  // in `request` (client.ts:277), and it decides by PROVENANCE: `pathReturnsOurCard(path)`. A method
  // that fetched this path any other way — its own fetch, a different helper — would return the PAN
  // having passed no boundary at all, and nothing in the type system would say so. The scrub is not a
  // filter this method opts into; it is the door this method must not walk around.
  //
  // The endpoint is agent-scoped and journalled: every call writes card_credential_access_logs
  // (apps/api/internal/purchases/pgx/card_reveal_repo.go:149). It returns this card's PAN, expiry and
  // CVV and NOT `three_ds_password` — that removal is the point of SHAT-2323, because one pool 3DS
  // password is shared by every card in the pool and revealing it once discloses it for all of them.
  async getCardCredentials(id: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/purchases/${encodeURIComponent(id)}/card-credentials`,
      undefined,
    )
  }

  async getCheckoutIdentity(id: string): Promise<unknown> {
    // The id sits in the MIDDLE and the path ends in a noun — the shape that fooled the old
    // heuristic in both of its incarnations. It is still a caller's id.
    return this.request(
      'GET',
      `/v1/purchases/${encodeURIComponent(id)}/checkout-identity`,
      undefined,
      'caller-id',
    )
  }

  // ---- Onboarding / User Resolution ----

  async registerUserProfile(input: {
    publisher_user_id: string
    user_claims: { email: string; name?: string; phone?: string; country?: string }
    intended_use?: string
    idempotency_key?: string
  }): Promise<unknown> {
    // ⚠️ SHAT-2633: THIS FORWARDED A KEY AND DID NOT ENFORCE ONE, WHICH IS NOT THE SAME THING.
    //
    // `idempotency_key` was an optional field on the input, passed straight through. A caller who
    // supplied one got idempotency; a caller who did not — which is every caller that does not know
    // to — got none. SHAT-1104 was closed over the word "all" with this counted as done, and an
    // optional field satisfies "the tool accepts a key" while satisfying nothing about the request
    // that actually leaves.
    //
    // An explicit key still wins: registration is addressed by publisher_user_id, so deriving from
    // it means a retry of the same registration de-dups, while a caller who genuinely wants to
    // repeat one can say so.
    return this.request(
      'POST',
      '/v1/onboarding/register',
      {
        ...input,
        idempotency_key:
          input.idempotency_key ?? deriveOperationKey('register_user_profile', input.publisher_user_id),
      },
      'fixed',
    )
  }

  async getOnboardingStatus(sessionId: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/onboarding/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      'caller-id',
    )
  }

  // ---- Common ----

  async listMCCCodes(query?: string): Promise<unknown> {
    // /!\ THIS LINE IS OUTSIDE THE try ON PURPOSE, AND IT IS THE ONLY WAY THIS METHOD THROWS.
    // encodeURIComponent raises URIError on an unpaired surrogate, and that is a fact about the
    // caller's string, not about the API — so it must NOT be answered with the built-in list and a
    // "the lookup failed" note, which would blame the deployment for a bad query. The tool layer
    // refuses it by name (MALFORMED_QUERY). Moving this inside the try would silently convert a
    // malformed query into a confident, wrong answer.
    const qs = query ? `?q=${encodeURIComponent(query)}` : ''
    try {
      // `qs` is a filter, not an address: the route is constant and carries no id. The old
      // heuristic (any non-POST → "verify the id") told a caller to check an id this call
      // does not have.
      return await this.request('GET', `/v1/mcc-codes${qs}`, undefined, 'fixed')
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
      //
      // ⚠️ THE REASON, NOT THE EXCEPTION. The caught error is not even bound here any more, and
      // that is deliberate: this used to interpolate `err.message` into `_note`, which handed the
      // agent whatever text fetch happened to throw — measured against the published 1.0.2, an
      // API URL carrying a password put that password into a result with `isError` unset. Every
      // other failure in this package goes through `errorResult`, which echoes nothing by
      // construction; this path bypassed that guard purely by being a success. The note keeps the
      // FACT and drops the prose — see BUILT_IN_MCC_NOTE in errors.ts.
      //
      // ⚠️ BUT "NOT TO THE AGENT" IS NOT THE SAME AS "NOWHERE", AND FOR ONE RELEASE IT WAS. With
      // `err` unbound the exception was destroyed at the moment it was caught, while the note went
      // on telling the operator that "the server-side log has the detail" — and for the usual
      // causes here (DNS, connection refused, timeout) NO SERVER WAS REACHED, so no server-side log
      // exists to have it. The fallback answers as a success, so nothing downstream reports a
      // problem either: a deployment where /v1/mcc-codes is simply absent looks completely healthy
      // from every direction at once.
      //
      // stderr is the channel that separates the two audiences. Under stdio MCP the protocol owns
      // stdout and stderr goes to the host's own log, out of the model's context — the same channel
      // src/index.ts already uses to refuse a start and say why. The operator gets the exception;
      // the agent still gets only the fact.
      //
      // ⚠️ AND WHAT GOES TO stderr IS UNFILTERED, WHICH IS DELIBERATE AND WORTH SAYING OUT LOUD.
      // Every other egress in this package is scrubbed — redactPurchaseCard on every response,
      // redactLongDigitRuns on validation messages, errorResult echoing nothing by construction.
      // This line is the exception: describeErrorChain flattens the whole cause chain verbatim, so
      // if SHATALE_API_URL carries credentials they appear here, and whatever a future runtime puts
      // in a `cause` appears here too.
      //
      // That is the correct trade for THIS audience and only this one. The operator supplied
      // SHATALE_API_URL themselves, the host's log is their own machine, and a redacted diagnostic
      // is frequently a useless one — the point of the line is to tell DNS, refusal and timeout
      // apart. It must never be widened to a channel the model reads.

      console.error(
        `list_mcc_codes: the /v1/mcc-codes lookup failed, serving this package's built-in ISO ` +
          `18245 list instead. Reason: ${describeErrorChain(err)}`,
      )
      return {
        ...(ShataleClient.filterBuiltInMCC(query) as Record<string, unknown>),
        _source: 'built-in',
        _note: BUILT_IN_MCC_NOTE,
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
  // These map to the sandbox routes the backend serves: the side-effect-free policy engine and the
  // SandboxOnly-gated lifecycle helpers.
  //
  // ⚠️ CORRECTED (SHAT-2621, 2026-08-27). This said the removed methods were built "against
  // endpoints that were never deployed". They were not: /v1/sandbox/reset is registered at
  // apps/api/main.go:4838 behind SANDBOX_CANCEL_ROUTES_ENABLED, parsed fail-closed, and answers 404
  // in production only because the flag is off — while POST /v1/sandbox/users answers 401 on the
  // same host, which is the control that tells "not mounted" from "wrong host".
  //
  // The second copy of this claim lived in src/tools/sandbox.ts and is corrected there too. Both
  // were written from one measurement and both outlived it; fixing one and not the other is the
  // failure this repository has hit repeatedly.

  /**
   * Run the policy engine without side effects (no ledger, no outbox, no
   * money). amount is an integer minor-unit value per the backend
   * sandboxAuthRequest struct. Test cards: 4242… force-approve, 4000…0002
   * force-decline, neutral (e.g. 4111…) → real policy decides.
   */
  async sandboxSimulateAuthorization(input: SandboxAuthInput): Promise<unknown> {
    return this.request(
      'POST',
      '/v1/sandbox/authorizations',
      {
        agent_id: input.agent_id,
        amount: input.amount,
        currency: input.currency,
        mcc: input.mcc,
        merchant_name: input.merchant_name,
        card_number: input.card_number,
      },
      'fixed',
    )
  }

  /**
   * ⚠️ THESE TWO ARE POSTs THAT DO NOT CREATE, AND THAT IS THE WHOLE OF SHAT-2678.
   *
   * A caller-supplied id sits in the middle of each path and the last segment is a verb, so both
   * looked like creates to a heuristic reading the tail of the string — and both were answered
   * "nothing in your request is wrong". apps/api api/v1/sandbox.go returns 404 here when the user
   * or purchase is absent, belongs to another publisher, or lives in the other environment: all
   * things the caller can check, and the only things it can.
   */
  /**
   * Create the publisher's OWN sandbox user, with the delegation that lets it buy.
   *
   * ⚠️ THIS IS THE FIRST STEP OF THE PUBLISHER'S PATH, AND IT WAS MISSING FROM THIS CLIENT. Without
   * it a publisher had to call the API by hand, outside the tools — which is precisely what the
   * owner's rule forbids: the concierge must use only what an external publisher has.
   *
   * One call provisions the lot (apps/api/api/v1/sandbox.go): the user, the publisher_user_links
   * row as 'verified', the profile and 3DS flags when `onboarded` is set, and an ACTIVE sandbox
   * delegation with a default budget. It is idempotent on all of them, so a demo can re-run.
   *
   * `agentId` is REQUIRED by the backend, and its error text explains why that is not a formality:
   * a sandbox user linked WITHOUT a delegation is found by the purchase and blocked with
   * delegation_unavailable. The agent itself is created by a PERSON in the publisher console — no
   * key issues one, deliberately — so the caller has to be given it, never invent it.
   *
   * addressing is 'fixed': the path carries no caller id, so a 404 here is about the route, not
   * about anything in the request.
   */
  async createSandboxUser(
    userId: string,
    agentId: string,
    opts: { onboarded?: boolean; currency?: string } = {},
  ): Promise<unknown> {
    return this.request(
      'POST',
      '/v1/sandbox/users',
      {
        user_id: userId,
        agent_id: agentId,
        onboarded: opts.onboarded ?? true,
        ...(opts.currency ? { currency: opts.currency } : {}),
        // SHAT-2633. This route is already idempotent server-side, which is a property of the
        // backend today and not a promise to this client — the key makes the guarantee ours.
        idempotency_key: deriveOperationKey('create_sandbox_user', userId, agentId),
      },
      'fixed',
    )
  }

  async sandboxCompleteOnboarding(userId: string): Promise<unknown> {
    // SHAT-2633: a write that builds the state a demo depends on.
    return this.request(
      'POST',
      `/v1/sandbox/users/${encodeURIComponent(userId)}/onboarding`,
      { idempotency_key: deriveOperationKey('sandbox_complete_onboarding', userId) },
      'caller-id',
    )
  }

  async sandboxApprovePurchase(purchaseId: string): Promise<unknown> {
    // ⚠️ SHAT-2633, AND THE MOST SERIOUS OF THE SET: THIS ISSUES A CARD.
    //
    // It was absent from the ticket's own list of four write tools — the same way cancel_purchase
    // fell out of SHAT-1104's list, one level up. A repeat without a key is indistinguishable from
    // a second intent, which is verbatim the argument that ticket makes for caring about
    // cancel_purchase, and it applies here with money attached.
    return this.request(
      'POST',
      `/v1/sandbox/purchases/${encodeURIComponent(purchaseId)}/approve`,
      { idempotency_key: deriveOperationKey('sandbox_approve_purchase', purchaseId) },
      'caller-id',
    )
  }
}
