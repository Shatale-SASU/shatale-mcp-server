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

- **Sandbox only:** Production API keys (`sh_live_*` / `sk_live_*`) are rejected at startup
- **No card data:** PAN, CVV, and card details are never exposed through MCP tools
- **No credentials:** Email aliases and credential vault are not accessible
- **Local transport:** Runs as a local stdio process, no network server exposed
- **Host allowlist:** Outbound calls are restricted to `*.shatale.com` and localhost
- **Input validation:** Sensitive tool inputs (purchases, onboarding, credentials, sandbox) are validated (zod) before any API call
- **Error redaction:** Upstream API error detail is not forwarded to the LLM
- **Request timeout:** Each API call is bounded by a 30s timeout so a stalled backend cannot hang the agent
- **Scoped access:** Only safe, non-destructive sandbox operations are available

> Note: this server does not implement its own request throttling. It surfaces
> the Shatale API's rate-limit (HTTP 429) responses but adds no client-side limiter.
