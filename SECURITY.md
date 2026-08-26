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
- **Input validation:** Sensitive tool inputs (purchases, onboarding, credentials, sandbox) are validated (zod) before any API call
- **Error redaction:** Upstream API error detail is not forwarded to the LLM
- **Request timeout:** Each API call is bounded by a 30s timeout so a stalled backend cannot hang the agent
- **Scoped access:** Only safe, non-destructive sandbox operations are available

> Note: this server does not implement its own request throttling. It surfaces
> the Shatale API's rate-limit (HTTP 429) responses but adds no client-side limiter.
