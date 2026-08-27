# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

<!-- This table said "0.2.x" while the published package was 0.5.2 — so the security policy told
     every reporter that the version everybody is running is unsupported. Corrected 2026-08-26
     (SHAT-2526). If you bump the package version, bump this row in the same commit: a support
     matrix is only read by someone deciding whether to bother telling us. Bumped to 1.0.x with
     the 1.0.0 version bump, per that instruction. -->

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@shatale.com
- **Do not** open a public GitHub issue for security vulnerabilities
- We will acknowledge receipt within 48 hours
- We will provide a detailed response within 7 days

## Security Design

This MCP server is designed with the following security principles:

- **Live keys are GATED, not rejected.** This line used to say production keys were rejected at startup, and that stopped being true in v0.4 — an operator reading it would believe real money movement was impossible through this server. What is actually true, in three deliberate acts with no accidental path between them: a live key (`sk_live_*`) supplied WITHOUT `SHATALE_MODE=live` refuses to start; `SHATALE_MODE=live` supplied WITHOUT a live key also refuses; and the purchase/credential tools are registered only when `SHATALE_MONEY_GO` matches the deploy-time SHA-256. A live key with the mode and no money-GO runs onboarding-only.
- **No card data in a tool result.** PAN and CVV are stripped from **every response this server
  returns**, not from a list of tools: the scrub (`redactPurchaseCard`, `src/redact.ts`) is applied
  once inside `ShataleClient.request`, so a tool added tomorrow that returns an upstream body is
  covered by construction rather than by somebody remembering.

  ⚠️ **This bullet said the opposite until 2026-08-27, and the correction is recorded rather than
  quietly swapped.** It described the scrub as living at four tool call sites, and stated that making
  it a property of the client "would close that, and is tracked separately". That change had already
  merged — `6b95e4f`, 2026-08-26 09:40:20 — **four seconds after this file's previous edit**
  (`46efaea`, 09:40:16), code last. The document understated a guarantee that already existed, and
  went on understating it for a day.

  **Boundary, stated because a scrub is easy to over-claim:** this removes card numbers and CVV from
  tool RESULTS — what reaches the agent's context. Card data reaches a merchant checkout
  out-of-band. It is not a statement about what the upstream API stores, logs, or returns to other
  clients.
- **Relay credentials ARE returned, deliberately.** This bullet used to read "No credentials:
  Email aliases and credential vault are not accessible", and that has not been true since the
  masking was removed on purpose (`src/tools/credentials.ts`): `request_temporary_credentials`
  returns the relay email alias and the single-use relay password IN FULL, because an agent cannot
  register with a merchant using a masked password — and `get_credential_status` returned the same
  value in cleartext one call away regardless, so the mask cost a round trip and bought a false
  impression. If the decision is that this value must not enter agent context, that is a product
  change to BOTH tools plus a flow that uses the password without revealing it — not a formatting
  one. What is NOT accessible is the card vault: see the PAN/CVV bullet above.
- **Local transport:** Runs as a local stdio process, no network server exposed
- **Host allowlist:** Outbound calls are restricted to `*.shatale.com` and localhost, over
  `https://` (loopback excepted, for the test harness and local development). A lookalike domain
  such as `evilshatale.com` is refused — the suffix carries the leading dot.
- **A live key goes to the canonical host.** `*.shatale.com` is a wide rule, and what passes it
  receives `Authorization: Bearer` — so a dangling CNAME or a taken-over subdomain of our own
  zone would be handed a live key and every purchase body after it. In live mode
  (`sk_live_*` + `SHATALE_MODE=live`) the host must be `api.shatale.com` unless
  `SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true` says otherwise, so that widening is something
  somebody typed rather than a default nobody noticed. Guest and sandbox are unaffected.
- **`SHATALE_API_URL` is the variable that decides all of the above**, and until SHAT-2558 no
  document mentioned it at all. It redirects every outbound call, and the API key travels with
  them. Leave it unset unless you know why you are changing it.
- **Input validation:** Tool inputs are validated (zod) before any API call — both the request
  BODIES (purchases, onboarding, credentials, sandbox authorization) and every ID that becomes a
  URL path segment. The second half is new: until SHAT-2526 the id-taking handlers interpolated
  `String(args.purchase_id)` straight into the path, so a missing argument was sent upstream as
  the literal `"undefined"` and an empty one collapsed the path — measured, including
  `POST /v1/sandbox/purchases//approve`, an empty segment on a write route. This bullet claimed
  the whole property while only half of it held; a refusal now happens here, and names the
  argument at fault rather than letting the backend answer for a mistake made in this process.
- **Error redaction:** Upstream API error detail is not forwarded to the LLM
- **Request timeout:** Each API call is bounded by a 30s timeout so a stalled backend cannot hang the agent
- **Sandbox tools include two writes.** This bullet used to say "only safe, non-destructive
  sandbox operations are available". Measured: `sandbox_complete_onboarding` is
  `POST /v1/sandbox/users/{id}/onboarding` and `sandbox_approve_purchase` is
  `POST /v1/sandbox/purchases/{id}/approve` (`src/client.ts`). They are non-destructive in the sense
  that they only move sandbox records forward, and they touch no production data — but they are
  writes, and this repo's own `docs/release-gate.md` already said so while this line said otherwise.
  `cancel_purchase` is a DELETE. What IS true: nothing here deletes or overwrites a live record.

> Note: this server does not implement its own request throttling. It surfaces
> the Shatale API's rate-limit (HTTP 429) responses but adds no client-side limiter.
