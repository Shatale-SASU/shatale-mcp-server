# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Pre-publish release gate** (SHAT-2165) — `npm run gate` drives the built `dist/index.js`
  over stdio against a real deployment with a real sandbox key and asserts a positive policy
  **decision** (`approved`/`declined` + `is_sandbox` + explanation), which is reachable only
  if the request body decoded AND the agent exists. Asserting "no error" would not do: the
  backend returns HTTP 400 for *agent not found* exactly as for a *decode reject*, and the
  MCP discards upstream bodies — so a naive gate would have gone green on the broken 0.5.0
  build. Includes a build-freshness check, runtime agent discovery (no agent → loud failure,
  never a skip) and a negative control. Wired into `publish.yml` between test and publish,
  with no skip path. See [docs/release-gate.md](docs/release-gate.md).
- **Wire-body fixtures** (SHAT-2165) — `tests/e2e/wire-fixtures.test.ts` captures the exact
  outbound bodies of six tool calls into `tests/fixtures/wire/outbound-requests.json`, so a
  renamed or re-typed field is a reviewable diff instead of a green mock. Runs in
  `test:public`. The Go-side replay test is specified in `tests/fixtures/wire/README.md` but
  is **not written** — it belongs in the `shatale` repo.

### Fixed
- Three key-gated tests still expected the tool surface from before three tools were
  unadvertised (18/17 tools, `register_user_profile` callable). They were green-by-skip in
  PR CI, which runs keyless, and would have failed the next nightly — the same
  skipped-but-green trap this release gate exists to close.

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
