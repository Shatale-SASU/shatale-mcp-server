# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@shatale.com
- **Do not** open a public GitHub issue for security vulnerabilities
- We will acknowledge receipt within 48 hours
- We will provide a detailed response within 7 days

## Security Design

This MCP server is designed with the following security principles:

- **Live keys are GATED, not rejected.** This line used to say production keys were rejected at startup, and that stopped being true in v0.4 — an operator reading it would believe real money movement was impossible through this server. What is actually true, in three deliberate acts with no accidental path between them: a live key (`sk_live_*`) supplied WITHOUT `SHATALE_MODE=live` refuses to start; `SHATALE_MODE=live` supplied WITHOUT a live key also refuses; and the purchase/credential tools are registered only when `SHATALE_MONEY_GO` matches the deploy-time SHA-256. A live key with the mode and no money-GO runs onboarding-only.
- **No card data:** PAN, CVV, and card details are never exposed through MCP tools
- **No credentials:** Email aliases and credential vault are not accessible
- **Local transport:** Runs as a local stdio process, no network server exposed
- **Host allowlist:** Outbound calls are restricted to `*.shatale.com` and localhost
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
- **Scoped access:** Only safe, non-destructive sandbox operations are available

> Note: this server does not implement its own request throttling. It surfaces
> the Shatale API's rate-limit (HTTP 429) responses but adds no client-side limiter.
