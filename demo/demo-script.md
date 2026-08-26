# Shatale MCP Server — Demo Script

## For recording (asciinema / screen recording)

### Setup
```bash
# Terminal 1: Start MCP server
export SHATALE_API_KEY=sk_sandbox_demo_key
npx @shatale/mcp-server
# Output on stderr: Shatale MCP server started (demo(sandbox) mode, 15 tools)
```

### Demo Flow (in Claude Desktop / Cursor)

**Prompt 1:**
> Create a shopping agent with a €1000 monthly budget. Block gambling and alcohol.

**Expected MCP calls:**
1. `register_user_profile` → starts onboarding for an end user (requires `SHATALE_ONBOARDING_ENABLED=true`)
2. Shows: Agent ID, Card ID, Policy config

**Prompt 2:**
> Simulate buying sneakers for €150 at Nike Store

**Expected MCP calls:**
1. `sandbox_simulate_authorization` (amount_cents: 15000, merchant: "Nike Store", mcc: "5691")
2. Shows: ✓ APPROVED — all rules passed

**Prompt 3:**
> Now try €50 at an online casino

**Expected MCP calls:**
1. `sandbox_simulate_authorization` (amount_cents: 5000, merchant: "Online Casino", mcc: "7995")
2. Shows: ✗ DECLINED — MCC 7995 blocked by policy

**Prompt 4:**
> Explain why it was declined

**Expected MCP calls:**
1. `explain_shatale` 
2. Shows detailed breakdown: spend_limit ✓, mcc_block ✗ (7995 in blocked list), balance_check ✓

**Prompt 5:**
> Run a full test of my setup

**Expected MCP calls:**
1. `simulate_purchase_flow` — walks one transaction end to end, offline
2. Shows summary table:
   - €150 retail → APPROVED
   - €5000 electronics → DECLINED (over limit)
   - €50 gambling → DECLINED (MCC blocked)
   - €25 restaurant → APPROVED

### Timing
- Total flow: ~90 seconds
- Each prompt response: 10-15 seconds
- Good for GIF or short video

### Recording Commands
```bash
# Option 1: asciinema (terminal recording)
asciinema rec demo.cast

# Option 2: Screen recording of Claude Desktop
# Use QuickTime Player → New Screen Recording
# Crop to Claude Desktop window

# Convert asciinema to GIF:
# npm install -g asciicast2gif
# asciicast2gif demo.cast demo.gif
```
