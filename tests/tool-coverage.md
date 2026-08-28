# MCP Tool Test Coverage Matrix

Last updated: 2026-08-27 (SHAT-2698)

> ⚠️ **THIS IS A HAND-MAINTAINED SNAPSHOT, AND IT HAD DRIFTED BY THREE TOOLS.** The matrix listed
> 17 rows and reported "Happy path 17/17 (100%)" while the code defined **20** tools. The three it
> never gained a row for are `get_checkout_cardholder`, `get_checkout_customer` and
> `get_credential_emails` — so the denominator moved and the percentage stayed at 100%, which is
> the one number a coverage document exists to make honest.
>
> At the time, no mode registered 17 tools either: the roster was 7 (guest), 15 (sandbox, 18 with
> both feature flags), 7 (live onboarding-only) or 14 (live + money-GO). "17" was not a count of
> anything the server did. (Those figures are the 2026-08-26 measurement and are kept as the record
> of that defect — today's are below, and sandbox has since reached 17 by a different route.)
>
> **A hand-written list silently excludes everything added after it.** The roster of record is the
> BUILT SERVER asked over MCP, one process per mode and unioned
> (`tests/harness/toolRoster.ts` → `scripts/lib/serverRoster.mjs`); a text scan of `src/tools/*.ts`
> is kept only as a second, independent opinion. `tests/unit/tool-coverage-matches-the-roster.test.ts`
> fails if this table and that roster disagree.
>
> 🔴 **AND THE CORRECTION WAS MADE THE SAME WAY AS THE DEFECT (2026-08-27).** The three missing rows
> were added and marked "not covered here" — by hand, without looking. All three are covered, by
> five to eight files each: `get_checkout_cardholder` and `get_checkout_customer` in
> checkout-tools, mock-contract, wire-fixtures and no-tool-result-carries-a-card;
> `get_credential_emails` in those plus contract, sandbox-tools and
> ids-never-reach-the-api-unvalidated. A hand-maintained document was repaired by hand, and it went
> wrong in the opposite direction — first claiming 100% of a short list, then claiming a gap that
> did not exist. Both readings mislead; only the second also hides work already done.
>
> ⚠️ The SHAT-1325 line above is removed because it no longer holds: `test` and `test:public` are
> both `vitest run`, and vitest.config includes `tests/**/*.test.ts`, so no deterministic file sits
> outside the gating suite. A note about a fixed thing reads as a live warning.

| # | Tool | Happy Path | Validation | Contract | Security | File |
|---|------|:---:|:---:|:---:|:---:|------|
| 1 | `explain_shatale` | ✅ | - | ✅ | - | guest-mode, happy-path, contract |
| 2 | `simulate_purchase_flow` | ✅ | - | - | ✅ | guest-mode, security |
| 3 | `generate_policy_template` | ✅ | - | - | - | guest-mode |
| 4 | `list_capabilities` | ✅ | - | ✅ | - | guest-mode, sandbox-tools, contract |
| 5 | `list_mcc_codes` | ✅ | - | ✅ | - | happy-path, contract |
| 6 | `search_merchants` | ✅ | - | ✅ | - | sandbox-tools, contract |
| 7 | `get_merchant_details` | ✅ | - | - | - | happy-path |
| 8 | `request_purchase` | ✅ | ✅ | - | - | happy-path, validation |
| 9 | `get_purchase_status` | ✅ | - | - | - | happy-path |
| 10 | `cancel_purchase` | ✅ | - | - | - | happy-path |
| 11 | `request_temporary_credentials` | ✅ | - | - | - | happy-path |
| 12 | `get_credential_status` | ✅ | - | - | - | happy-path |
| 13 | `register_user_profile` | ✅ | ✅ | - | - | happy-path, validation |
| 14 | `get_onboarding_status` | ✅ | - | - | - | happy-path |
| 15 | `sandbox_simulate_authorization` | ✅ | ✅ | ✅ | - | mock-contract, sandbox-tools, validation, happy-path |
| 16 | `sandbox_create_user` | ✅ | ✅ | ✅ | - | mock-contract, wire-fixtures, ids-never-reach-the-api-unvalidated |
| 17 | `sandbox_complete_onboarding` | ✅ | - | ✅ | - | mock-contract, happy-path |
| 18 | `sandbox_approve_purchase` | ✅ | - | ✅ | - | mock-contract, happy-path |
| 19 | `get_checkout_cardholder` | ✅ | - | ✅ | ✅ | checkout-tools, mock-contract, wire-fixtures, no-tool-result-carries-a-card |
| 20 | `get_checkout_customer` | ✅ | - | ✅ | ✅ | checkout-tools, mock-contract, wire-fixtures, no-tool-result-carries-a-card |
| 21 | `get_credential_emails` | ✅ | ✅ | ✅ | ✅ | contract, mock-contract, sandbox-tools, wire-fixtures, ids-never-reach-the-api-unvalidated, no-tool-result-carries-a-card |

> **Note (v0.4.0, SHAT-1488):** sandbox surface realigned to deployed backend routes. Removed `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` (non-deployed routes); renamed `sandbox_approve_request` → `sandbox_approve_purchase`. `request_purchase` was **blocked when a sandbox key is set** — no longer true since SHAT-2373 made `/v1/purchases` serve sandbox keys deliberately (environment stamped from the key). The client-side refusal was removed in SHAT-2611; `sandbox_simulate_authorization` remains the narrower tool for a policy decision without a purchase.

## Coverage Summary

- **Tools defined in code**: 21
- **Happy path**: 21/21
- **Input validation**: 5/21 as recorded here. Since SHAT-2526 every id-taking tool also refuses a
  missing, empty or whitespace id before any request leaves the process
  (`tests/unit/ids-never-reach-the-api-unvalidated.test.ts`, 28 refusal cases plus 2 positive
  controls), which this table predates.
- **Contract (Zod)**: 11/21
- **Security edge cases**: 4/21 + global injection/leak tests + `request_purchase` sandbox-guard

> These four fractions are no longer hand-maintained claims: `tool-coverage-matches-the-roster.test.ts`
> counts the ✅ in each column and the live roster, and fails if either half of a fraction drifts.
> Before it existed, "Contract (Zod)" read `6/20` against a column holding 11 ticks over 21 tools —
> wrong in the numerator AND the denominator, under a row-count gate that was green the whole time.

## Test Files

Counts below are the `tests/e2e` files as MEASURED by a run (`vitest run tests/e2e`), not as
remembered. Three of them had drifted: `guest-mode` was recorded as 9 against 16, `security` as 16
against 18, and `mock-contract` as 8 against 14 — and the three files at the bottom had no row at
all. Unit tests under `tests/unit` are not listed here.

| File | Tests | Requires Key |
|------|:-----:|:---:|
| `guest-mode.test.ts` | 16 | No |
| `security.test.ts` | 18 | No |
| `contract.test.ts` | 7 | Partial |
| `mock-contract.test.ts` | 14 | No (mock upstream) |
| `sandbox-tools.test.ts` | 6 | Yes |
| `validation.test.ts` | 9 | Yes |
| `happy-path-all-tools.test.ts` | 12 | Partial |
| `stdio-hardening.test.ts` | 5 | No |
| `where-a-live-key-may-be-sent.test.ts` | 8 | No |
| `wire-fixtures.test.ts` | 4 | No (mock upstream) |
| `the-key-travels-only-in-the-environment.test.ts` | 3 | No |
| `the-banner-says-where-it-points.test.ts` | 4 | No |
