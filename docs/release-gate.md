# Release gate (SHAT-2165)

## The problem it solves

This server shipped the same defect twice:

| Version | Defect | Effect |
|---|---|---|
| 0.2.1 | `mcc` sent as a JSON **number** | `apps/api` decodes `MCC string`; Go rejects the body → every `sandbox_simulate_authorization` call returned **HTTP 400 before the handler ran** |
| 0.5.0 | The identical defect, in the identical field | Same. 129 tests green. |

The suite could not catch it, and could not have. The mock upstream accepts any body — it is
*this* side of the contract — and the contract test asserted `body.mcc` was a **number**, so
the suite actively **certified the defect**. 0.5.1 fixes it and pins the fix as a regression
test, but a pin is not a contract check: rename a field on the Go side tomorrow and the mock
stays green exactly as before.

## What the gate does

`npm run gate` (`scripts/publish-gate.mjs`) drives the **built** server — `dist/index.js`,
the artifact npm publishes — over stdio JSON-RPC against a **real deployment** with a **real
sandbox key**, and demands a positive **policy decision** back.

### Why a decision, and not "no error"

The backend returns **HTTP 400** for *agent not found or does not belong to this publisher*
(`apps/api/api/v1/sandbox.go:194`) exactly as it returns 400 for a *decode reject*
(`sandbox.go:120`). The MCP discards upstream response bodies for leak safety, so through
the tool **those two are the same `api_error` / HTTP 400**.

A gate asserting "the call did not throw", or "a bad request produced a 400", would have gone
**green on the broken 0.5.0 build**. So the assertion is:

```
decision ∈ {approved, declined}  AND  is_sandbox === true
AND  explanation present  AND  authorization_id starts with "sandbox_"  AND  agent_id echoes back
```

That payload is only reachable when the request body **decoded** *and* the agent **exists**
under the key's publisher. There is no malformed body that satisfies it.

### Checks

1. **Build freshness** — `dist/` must not be older than `src/`. Certifying a stale artifact is
   the same unearned green the gate exists to end.
2. **A seeded agent that really exists** — discovered at runtime via `GET /v1/agents`
   (a hardcoded id rots into a permanent 400 the moment the seed changes), or pinned with
   `SHATALE_GATE_AGENT_ID`. **No agent → loud failure**, never a skip.
3. **String `mcc`** reaches a decision — the current tool schema's spelling.
4. **Numeric `mcc`** reaches a decision — the spelling 0.2.1/0.5.0 put on the wire raw, and
   the one an agent following an older tool description still sends. It must be normalised.
5. **Negative control** — the same call with a nonexistent agent must yield **no** decision.
   If it did, checks 3–4 would be satisfiable without the body ever decoding, and the gate
   would be theatre.

On failure it prints the backend's own error strings for both spellings, since the MCP has
already thrown them away — that is what separates a decode reject from a missing agent.

### Safety

Every request is read-only. `POST /v1/sandbox/authorizations` runs the policy engine and
writes nothing: no purchase, no ledger, no outbox, no money. The two sandbox routes that *do*
write (`users/{id}/onboarding`, `purchases/{id}/approve`) are never called. The gate refuses
to hold a live key.

## Running it

```bash
npm run build
SHATALE_GATE_API_KEY=sk_sandbox_… npm run gate
```

| Variable | Required | Meaning |
|---|---|---|
| `SHATALE_GATE_API_KEY` | yes (falls back to `SHATALE_TEST_KEY`) | Sandbox key. `sk_live_*` is refused. |
| `SHATALE_GATE_API_URL` | no | Target deployment. Default `https://api.shatale.com`; any `*.shatale.com` host is accepted. |
| `SHATALE_GATE_AGENT_ID` | no | Pin the agent instead of discovering it. Verified with `GET /v1/agents/{id}` before use. |

### On staging

The gate points at prod by default because that is where the only sandbox key currently
authenticates — the same key and the same target the nightly live suite already uses. Sandbox
keys are minted **per deployment**, and the key in use returns **401 on
`api-staging.shatale.com`**. To run against staging, mint a sandbox key on staging for a
publisher that owns a seeded agent (`apps/api/cmd/seedtest` seeds
`01KQ2J7XE6DSQ609814NSM7KWF` under publisher `PUBUATTEST0000000000000000`, but seeds **no**
API key), then set both `SHATALE_GATE_API_KEY` and
`SHATALE_GATE_API_URL=https://api-staging.shatale.com`.

## In CI

`.github/workflows/publish.yml` runs the gate between `test` and `publish`, so a release that
cannot be verified does not go out. It has **no skip path**: a missing secret, an unreachable
API or an empty agent list all fail the job.

It reads the existing `SHATALE_TEST_KEY` repo secret. Optional repo *variables*
`SHATALE_GATE_API_URL` / `SHATALE_GATE_AGENT_ID` override target and agent.

## The hermetic complement

`tests/e2e/wire-fixtures.test.ts` captures the exact bodies the built server puts on the wire
into `tests/fixtures/wire/outbound-requests.json`, so a renamed or re-typed field becomes a
reviewable diff on a committed file rather than a green mock. It runs in `test:public` (no
key, no network beyond loopback). See `tests/fixtures/wire/README.md` — including the shape
of the Go-side replay test that is **not yet written** (it lives in the `shatale` repo).
