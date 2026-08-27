# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

> Entries for 0.5.0, 0.5.1 and 0.5.2 were added in 1.0.0. They are reconstructed from the git
> history between the tags and from the GitHub release bodies.

## [Unreleased]

### Changed

- `request_purchase` is no longer refused under a sandbox key. The refusal cited a property of the
  backend — "`/v1/purchases` is NOT sandbox-gated, so a `sk_sandbox_*` key can reach a live,
  side-effectful path" — and SHAT-2373 changed exactly that property while this client went on
  citing it. The endpoint now serves sandbox keys deliberately: the environment is stamped from the
  key, never from the request body, and the money-movers resolve to sandbox implementations. A
  sandbox key using the same public contract an outsider uses is the product; a privileged
  `/v1/sandbox/purchases` bypass is what the ticket forbids. (SHAT-2611)
- The two sentences the server SAYS about it were corrected with the code. `explain_shatale` and
  `list_capabilities` told a sandbox caller that `request_purchase` was "disabled"/"BLOCKED"; an
  agent that reads that does not call the tool, so the refusal survived its own removal in prose.
  Both are now pinned by a test. (SHAT-2611)
- The refusal's suggested fix pointed at real money — "run with a live key (`sk_live_`) plus
  `SHATALE_MODE=live` and `SHATALE_MONEY_GO`" — as the way out of a sandbox that was safe by
  construction. That advice is gone and is asserted absent. (SHAT-2611)

## [1.0.0] — unreleased

No code change. `dist/` in the 1.0.0 tarball is byte-identical to `dist/` in the published
0.5.2. Upgrading from 0.5.2 changes the documentation and the packaging, not the server.

### Added
- Publishing requires a tag whose `package.json` matches it, and the published code is checked
  out from that tag (#24).
- The README's tool matrix is generated from the running server and byte-compared in CI, so the
  documented tool surface cannot drift from the advertised one (#25, SHAT-2527).

### Fixed
- The pre-publish gate's success banner claimed more than the gate had measured (#23).

### Tool contract
- 20 tools are defined. What a session sees depends on the key and the flags:
  guest **7**, sandbox **15**, sandbox + flags **18**, live without money-GO **7**,
  live + money-GO **14**, live + money-GO + flags **17**. The per-tool matrix is in the README.
- Three of the 20 have no deployed backend and are OFF unless explicitly enabled:
  `register_user_profile` and `get_onboarding_status` (SHAT-1662) and `get_credential_emails`.

## [0.5.2] — 2026-08-26

### Changed — breaking
- `list_mcc_codes` now reads the server (`GET /v1/mcc-codes`) instead of a list compiled into the
  client. `_source: "built-in"` is **gone** from the response, and `code` is now a **string**
  (`"4511"`), preserving leading zeros, where 0.5.1 returned a **number** (`4511`).
  This took effect at the backend deploy on 2026-08-26, not at this release, so it also applies
  to 0.5.1. **If you compare MCC codes, compare strings.**

### Fixed
- The 30s request timeout covered the response headers but not the body, so an upstream that
  answered `200` and then stalled mid-body was never aborted.
- The `shatale://guides/quickstart` resource and `smithery.yaml` told the reader to `npx` a
  **scoped** package name that does not exist on the registry. The published package is
  `shatale-mcp-server`, unscoped.
- IDs reached the API unvalidated: a missing argument was sent upstream as the literal
  `"undefined"` and an empty one collapsed the path. Every id that becomes a URL path segment is
  now validated, and the error names the argument at fault.
- A live key could be sent to any `*.shatale.com` subdomain and over plain `http`. In live mode
  the host must now be `api.shatale.com` unless `SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true`, and
  plaintext is refused for any non-loopback host.
- Card redaction moved from four individual tool results into `ShataleClient`, so it applies to
  every response rather than to an enumerated list of call sites.
- `sandbox_simulate_authorization` returned a router-level 404 on production until the route was
  mounted on 2026-08-26. It now returns a decision with an `authorization_id`. Two things to know
  about that decision: an agent with no sandbox delegation is declined at the first gate, before
  policy runs; and **omitting `card_number` substitutes the force-approve test card `4242…`**,
  which overrides that decline to `approved` with a `[SANDBOX OVERRIDE]` prefix. Send
  `4111111111111111` for the real decision (SHAT-2566).
- Errors now carry the server-side `request_id` (the backend always sent it; the client dropped
  it).
- Live-key detection accepted an `sk_` prefix the server never issues (SHAT-2557).
- The credential idempotency key was computed on an hour grid, so two calls either side of the
  boundary produced two live credentials (SHAT-1686).

### Added
- **Pre-publish release gate** (SHAT-2165) — `npm run gate` drives the built server over stdio
  against a real deployment with a real sandbox key and requires a positive policy **decision**,
  which is reachable only if the request body decoded and the agent exists. It has no skip path:
  a missing key, an unreachable API or an empty agent list all fail.
  See [docs/release-gate.md](docs/release-gate.md).
- **Wire-body fixtures** (SHAT-2165) — the exact outbound bodies of six tool calls are captured
  into `tests/fixtures/wire/outbound-requests.json`, so a renamed or re-typed field is a
  reviewable diff rather than a passing mock.
- Documentation corrected against the code, including a security policy that listed `0.2.x` as
  the supported version while the published package was `0.5.2`.

## [0.5.1] — 2026-08-16

### Fixed
- `sandbox_simulate_authorization` sent `mcc` onto the wire as a JSON number where the backend
  expects a string, so the request never decoded and the tool could not work.
- `register_user_profile` and `get_onboarding_status` were advertised while the flow between them
  could not complete: the first returned an id the backend does not persist, so the second 404s
  for it. Both are now withheld unless `SHATALE_ONBOARDING_ENABLED=true`, and the handler is
  removed along with the listing — an unlisted tool otherwise stays callable by name.
- Card redaction was widened to more of the results that can carry one.

### Changed
- The package now ships `dist/` plus `README.md`, `LICENSE`, `SECURITY.md` and `CHANGELOG.md`,
  and nothing else (`files` in `package.json`). File count fell from **104 to 56**.

## [0.5.0] — 2026-08-07

Two-mode operation (demo / live) with a fail-closed money gate.

> **Note on the published artifact.** The 0.5.0 tarball on npm was not built from the code at the
> `v0.5.0` tag. If you are comparing the tag against the package, they differ. `dist/` is built
> from the same sources either way. From 1.0.0 the published code is checked out from the tag
> (#24).

### Added
- **Two modes, demo and live**, with a fail-closed SHA-256 money gate: the purchase and
  credential tools are registered only when `sha256(SHATALE_MONEY_GO) === SHATALE_MONEY_GO_SHA256`.
  Default OFF. A live key without `SHATALE_MODE=live` refuses to start, and `SHATALE_MODE=live`
  without a live key also refuses. A live key with the mode and no money-GO runs onboarding-only.
- **Checkout-identity tools** — `get_checkout_cardholder` (the legal cardholder / billing
  identity) and `get_checkout_customer` (the buyer), both returning an identity only: card
  number, expiry and CVV are not returned here.
- `get_credential_emails`, gated behind `SHATALE_CREDENTIAL_EMAILS_ENABLED` until its backend
  ships.

### Changed
- Server-side `RejectSandbox` plus PAN redaction on the tool results that can carry a card.

### Notes
- Reviewed by Odin (the SHA-256 gate was authored there) and Fable.

## [0.4.0] — 2026-06-10

Realign the sandbox tool surface to the routes the backend actually deploys, and
strengthen the guest/no-key demo. This is a **breaking change** to the public tool surface.

### Added
- `sandbox_simulate_authorization` (SHAT-1488) — runs the policy engine on a simulated
  authorization via `POST /v1/sandbox/authorizations`. Side-effect-free (no ledger, no
  money, no card issued). Returns approve/decline plus an explanation. Test cards: `4242…`
  forces approve, `4000…0002` forces decline, neutral cards let the real policy decide.
- Mode-aware `explain_shatale` (SHAT-1460) — reports live mode, the tools available in this
  session, the recommended first prompt, and a sandbox-unlock CTA. (Historical note: this entry
  originally said "GUEST / SANDBOX / blocked PRODUCTION". "Blocked PRODUCTION" stopped existing in
  0.4, when live keys became gated rather than rejected, and the server now reports FOUR modes:
  guest, demo(sandbox), live(onboarding-only), live+money-GO. Annotated rather than rewritten — a
  changelog entry records what shipped then, and correcting it silently would lose that.)
- `generate_policy_template` now returns a `validation` block (SHAT-1462) — `risk_level`,
  `warnings`, `recommended_controls`; never returns a silently unsafe policy.
- Structured error envelope across tools (SHAT-1463) and gated client attribution headers
  on authenticated sandbox calls only (SHAT-1465) — `User-Agent`, `X-Shatale-Client`,
  `X-Shatale-Client-Version`; guest mode stays fully offline with no headers.

### Changed
- `sandbox_approve_request` → **renamed** `sandbox_approve_purchase`, now pointing at the
  deployed `POST /v1/sandbox/purchases/{purchaseId}/approve`.
- `request_purchase` is **blocked when a sandbox key is set**. `POST /v1/purchases` is not
  sandbox-gated on the backend and would create real ledger/outbox state. The tool now
  returns a structured `sandbox_key_purchase_blocked` error and never reaches the network.
  Use `sandbox_simulate_authorization` to exercise the policy engine instead.
- `simulate_purchase_flow` (SHAT-1461) emits a deterministic guest verdict with non-happy
  paths (blocked category, over guest cap, over budget, approval-required) and a trace.
- README leads with the 60-second no-key demo and "run the same flow in sandbox" (SHAT-1464).
- Sandbox tool count: **5 → 3**. Total tools in sandbox mode: **19 → 17**.
- All user-facing key examples now use `sk_sandbox_*` (sandbox) / `sk_live_*` (rejected).

### Removed
- `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` — these called
  routes the backend does not deploy and could not succeed against a real sandbox.

### Notes
- Guest mode makes no network calls (3 simulation tools + catalog).
- No backend changes; this release only realigns the MCP client to the deployed contract.
