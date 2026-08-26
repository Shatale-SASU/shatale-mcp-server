# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes       |
| < 0.5   | No        |

<!-- This table said "0.2.x" while the published package was 0.5.2 — so the security policy told
     every reporter that the version everybody is running is unsupported. Corrected 2026-08-26
     (SHAT-2526). If you bump the package version, bump this row in the same commit: a support
     matrix is only read by someone deciding whether to bother telling us. -->

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@shatale.com
- **Do not** open a public GitHub issue for security vulnerabilities
- We will acknowledge receipt within 48 hours
- We will provide a detailed response within 7 days

## Security Design

This MCP server is designed with the following security principles:

- **Live keys are GATED, not rejected.** This line used to say production keys were rejected at startup, and that stopped being true in v0.4 — an operator reading it would believe real money movement was impossible through this server. What is actually true, in three deliberate acts with no accidental path between them: a live key (`sk_live_*`) supplied WITHOUT `SHATALE_MODE=live` refuses to start; `SHATALE_MODE=live` supplied WITHOUT a live key also refuses; and the purchase/credential tools are registered only when `SHATALE_MONEY_GO` matches the deploy-time SHA-256. A live key with the mode and no money-GO runs onboarding-only.
- **No card data:** PAN, CVV and card details are never exposed through MCP tools — enforced by
  `redactPurchaseCard` at the four tool results that can carry a card
  (`request_purchase`, `get_purchase_status`, `cancel_purchase`, `sandbox_approve_purchase`).
  Stated as call sites rather than as an invariant because that is what it is: a tool added tomorrow
  that returns an upstream body gets no redaction from anywhere. Making it a property of
  `ShataleClient.request` instead would close that, and is tracked separately.
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
- **Host allowlist:** Outbound calls are restricted to `*.shatale.com` and localhost
- **Input validation:** Sensitive tool inputs (purchases, onboarding, credentials, sandbox) are validated (zod) before any API call
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
