import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // SHAT-1449: no retry — tests must be deterministic. The mcpClient harness
    // already retries only the readiness/initialize handshake.
  },
})
