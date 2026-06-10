# MCP Tool Test Coverage Matrix

Last updated: 2026-06-10

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

> **Note (v0.4.0, SHAT-1488):** sandbox surface realigned to deployed backend routes. Removed `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` (non-deployed routes); renamed `sandbox_approve_request` → `sandbox_approve_purchase`. `request_purchase` is **blocked when a sandbox key is set** (would create real ledger/outbox) — use `sandbox_simulate_authorization` instead.

## Coverage Summary

- **Happy path**: 17/17 (100%)
- **Input validation**: 3/17 (tools with user input)
- **Contract (Zod)**: 6/17 (all guest tools + schema checks)
- **Security edge cases**: 1/17 + global injection/leak tests + `request_purchase` sandbox-guard

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
