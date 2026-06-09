# MCP Tool Test Coverage Matrix

Last updated: 2026-06-09

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
| 15 | `sandbox_create_test_user` | ✅ | ✅ | - | - | sandbox-tools, validation |
| 16 | `sandbox_complete_onboarding` | ✅ | - | - | - | happy-path |
| 17 | `sandbox_approve_request` | ✅ | - | - | - | happy-path |
| 18 | `sandbox_decline_request` | ✅ | - | - | - | happy-path |
| 19 | `sandbox_reset` | ✅ | - | - | - | happy-path |

## Coverage Summary

- **Happy path**: 19/19 (100%)
- **Input validation**: 3/19 (tools with user input)
- **Contract (Zod)**: 6/19 (all guest tools + schema checks)
- **Security edge cases**: 1/19 + global injection/leak tests

## Test Files

| File | Tests | Requires Key |
|------|:-----:|:---:|
| `guest-mode.test.ts` | 9 | No |
| `security.test.ts` | 16 | No |
| `contract.test.ts` | 7 | Partial |
| `sandbox-tools.test.ts` | 5 | Yes |
| `validation.test.ts` | 8 | Yes |
| `happy-path-all-tools.test.ts` | 12 | Partial |
| **Total** | **57** | |
