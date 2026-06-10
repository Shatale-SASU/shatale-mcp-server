# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] — 2026-06-10

Sandbox surface realigned to the routes the backend actually deploys (SHAT-1488).
This is a **breaking change** to the public tool surface.

### Added
- `sandbox_simulate_authorization` — runs the policy engine on a simulated authorization
  via `POST /v1/sandbox/authorizations`. Side-effect-free (no ledger, no money, no card
  issued). Returns approve/decline plus an explanation. Test cards: `4242…` forces approve,
  `4000…0002` forces decline, neutral cards let the real policy decide.

### Changed
- `sandbox_approve_request` → **renamed** `sandbox_approve_purchase`, now pointing at the
  deployed `POST /v1/sandbox/purchases/{purchaseId}/approve`.
- `request_purchase` is **blocked when a sandbox key is set**. `POST /v1/purchases` is not
  sandbox-gated on the backend and would create real ledger/outbox state. The tool now
  returns a structured `sandbox_key_purchase_blocked` error and never reaches the network.
  Use `sandbox_simulate_authorization` to exercise the policy engine instead.
- Sandbox tool count: **5 → 3**. Total tools in sandbox mode: **19 → 17**.
- All user-facing key examples now use `sk_sandbox_*` (sandbox) / `sk_live_*` (rejected).

### Removed
- `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` — these called
  routes the backend does not deploy and could not succeed against a real sandbox.

### Notes
- Guest mode is unchanged (3 simulation tools + catalog, no network calls).
- No backend changes; this release only realigns the MCP client to the deployed contract.
