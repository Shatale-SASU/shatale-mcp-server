import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // ⚠️ ONE PRECONDITION FOR THE WHOLE SUITE, because two spawners had bypassed the per-file one.
    // tests/e2e/stdio-hardening.test.ts and tests/e2e/security.test.ts each build their own ENTRY
    // and spawn it without asking anything — 13 failed assertions with no server in existence, and
    // three of them reported SUCCESS: bare `not.toContain` checks that a MODULE_NOT_FOUND satisfies.
    // A gate a caller can forget to call is a gate for the callers who did not need it.
    globalSetup: ['tests/harness/requireFreshBuild.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // SHAT-1449: no retry — tests must be deterministic. The mcpClient harness
    // already retries only the readiness/initialize handshake.
  },
})
