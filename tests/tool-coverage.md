# MCP Tool Test Coverage Matrix

Last updated: 2026-08-26 (SHAT-2527)

> ⚠️ **THIS IS A HAND-MAINTAINED SNAPSHOT, AND IT HAD DRIFTED BY THREE TOOLS.** The matrix listed
> 17 rows and reported "Happy path 17/17 (100%)" while the code defined **20** tools. The three it
> never gained a row for are `get_checkout_cardholder`, `get_checkout_customer` and
> `get_credential_emails` — so the denominator moved and the percentage stayed at 100%, which is
> the one number a coverage document exists to make honest.
>
> No mode registers 17 tools, either: the live roster is 7 (guest), 15 (sandbox, 18 with both
> feature flags), 7 (live onboarding-only) or 14 (live + money-GO). "17" was never a count of
> anything the server does.
>
> **A hand-written list silently excludes everything added after it.** The same shape put four
> deterministic test files outside the only suite that gates a pull request (SHAT-1325). Treat the
> percentages below as illustration, not as a measurement; the roster of record is
> `grep -h "name: '" src/tools/*.ts`.

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
| 16 | `sandbox_complete_onboarding` | ✅ | - | ✅ | - | mock-contract, happy-path |
| 17 | `sandbox_approve_purchase` | ✅ | - | ✅ | - | mock-contract, happy-path |
| 18 | `get_checkout_cardholder` | - | - | - | - | **no row until 2026-08-26; not covered here** |
| 19 | `get_checkout_customer` | - | - | - | - | **no row until 2026-08-26; not covered here** |
| 20 | `get_credential_emails` | - | - | - | - | **no row until 2026-08-26; not covered here** |

> **Note (v0.4.0, SHAT-1488):** sandbox surface realigned to deployed backend routes. Removed `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` (non-deployed routes); renamed `sandbox_approve_request` → `sandbox_approve_purchase`. `request_purchase` is **blocked when a sandbox key is set** (would create real ledger/outbox) — use `sandbox_simulate_authorization` instead.

## Coverage Summary

- **Tools defined in code**: 20
- **Happy path**: 17/20 — the three added rows above have none
- **Input validation**: 3/20 as recorded here. Since SHAT-2526 every id-taking tool also refuses a
  missing, empty or whitespace id before any request leaves the process
  (`tests/unit/ids-never-reach-the-api-unvalidated.test.ts`, 24 cases), which this table predates.
- **Contract (Zod)**: 6/20
- **Security edge cases**: 1/20 + global injection/leak tests + `request_purchase` sandbox-guard

## Test Files

| File | Tests | Requires Key |
|------|:-----:|:---:|
| `guest-mode.test.ts` | 9 | No |
| `security.test.ts` | 16 | No |
| `contract.test.ts` | 7 | Partial |
| `mock-contract.test.ts` | 8 | No (mock upstream) |
| `sandbox-tools.test.ts` | 6 | Yes |
| `validation.test.ts` | 9 | Yes |
| `happy-path-all-tools.test.ts` | 12 | Partial |
