# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

<!-- This table said "0.2.x" while the published package was 0.5.2 — so the security policy told
     every reporter that the version everybody is running is unsupported. Corrected 2026-08-26
     (SHAT-2526). Bumped to 1.0.x with the 1.0.0 version bump, per the instruction that stood here —
     and the instruction is now enforced as well: tests/unit/the-support-table-tracks-the-version.test.ts
     fails a bump that leaves this row behind (SHAT-2527). Both halves are worth recording. It was
     followed this time because somebody remembered, and "somebody remembered" is the part that does
     not survive a busy release: a support matrix is only read by someone deciding whether to bother
     telling us. -->

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@shatale.com
- **Do not** open a public GitHub issue for security vulnerabilities
- We will acknowledge receipt within 48 hours
- We will provide a detailed response within 7 days

## Security Design

This MCP server is designed with the following security principles:

- **Live keys are GATED, not rejected.** This line used to say production keys were rejected at startup, and that stopped being true in v0.4 — an operator reading it would believe real money movement was impossible through this server. What is actually true, in three deliberate acts with no accidental path between them: a live key (`sk_live_*`) supplied WITHOUT `SHATALE_MODE=live` refuses to start; `SHATALE_MODE=live` supplied WITHOUT a live key also refuses; and the purchase/credential tools are registered only when `SHATALE_MONEY_GO` matches the deploy-time SHA-256. A live key with the mode and no money-GO runs onboarding-only.
- **The card we issued IS returned, deliberately. The person's card never is.**
  Until 2026-08-27 this bullet said PAN and CVV were stripped from every response this server
  returns. That is no longer true, by decision, and the reason is a distinction the earlier text
  did not make.

  **The card whose details are returned is OURS.** We mint it for one purchase, the cardholder is
  Shatale SASU, and it is handed to the agent precisely so the agent can pay with it. An agent
  cannot fill a merchant checkout with a masked PAN, for the same reason it cannot register with a
  masked relay password — see the bullet below, which reached this conclusion first.

  ⚠️ **The PERSON's saved card is never returned, in any mode, on any path.** It is the funding
  instrument and it does not leave our side. These are two different objects and the earlier
  blanket scrub did not tell them apart: it fired on any object carrying `number`/`cvv`, whoever
  owned it. Removing it wholesale would have opened ours AND stopped protecting theirs.

  **How the two are told apart, and why not the obvious way.** Disclosure is an allowlist of API
  paths, not a property read off the response body. The obvious signal lies: the sandbox approval
  answers `merchant_locked: true` while the issuer request carries no merchant field at all
  (measured 2026-08-27). **A response that describes itself incorrectly cannot decide whether to
  reveal a PAN.** What is known reliably is which endpoint we called. Anything not on the list is
  still scrubbed, including response shapes we have not seen yet.

  **Boundaries, stated because a disclosure is easy to under-describe:**
  - The card is capped at the purchase amount. It is **not** merchant-locked — that is a decision,
    not an oversight. It stays usable until one of three things ends it: **the card expires, it is
    locked, or it is quarantined.** Nothing about completing a purchase ends it by itself. So the
    returned details permit spending the capped amount **at any merchant** until one of those three
    happens.
  - This says nothing about what the upstream API stores, logs, or returns to other clients.

  ⚠️ **Honest history: this bullet has been wrong twice in twenty-four hours.** It first understated
  a guarantee that already existed (the scrub had become a property of the client four seconds
  after the file's previous edit — `6b95e4f` at 2026-08-26 09:40:20 against `46efaea` at 09:40:16,
  code last), was corrected to "stripped from every response", and now there is no blanket strip at
  all. Recorded rather than quietly swapped, because an external document has a version history and
  a silent edit is found out worse than a loud one.
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
