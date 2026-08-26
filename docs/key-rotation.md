# SHATALE_TEST_KEY Rotation Procedure

Rotate the sandbox API key used for E2E tests quarterly to limit exposure.

## Steps

1. **Generate new key** via internal admin:
   ```bash
   source ~/.secrets/shatale.env
   curl -X POST \
     -H "Authorization: Bearer $SHATALE_STAFF_TOKEN" \
     -H "Content-Type: application/json" \
     "https://api.shatale.com/v1/internal/admin/publishers/01KPRCP549731E9H8GW4QQCT2X/api-keys" \
     -d '{"name":"MCP E2E Test Key (rotated)","environment":"sandbox"}'
   ```

2. **Update GitHub Secret:**
   ```bash
   gh secret set SHATALE_TEST_KEY --body "sk_sandbox_NEW_KEY_HERE" \
     --repo Shatale-SASU/shatale-mcp-server
   ```

3. **Update local env:**
   ```bash
   # Edit ~/.secrets/shatale.env
   SHATALE_TEST_KEY=sk_sandbox_NEW_KEY_HERE
   ```

4. **Verify:**
   ```bash
   SHATALE_TEST_KEY=sk_sandbox_NEW_KEY_HERE npm test
   ```

5. **Revoke old key** (optional — sandbox keys have limited scope).

## Schedule

Rotate every **3 months**: February, May, August, November.

Current key info:
- Publisher: `01KPRCP549731E9H8GW4QQCT2X` (Smoke Test Publisher)
- Created: 2026-05-11
- Next rotation: 2026-08-11
