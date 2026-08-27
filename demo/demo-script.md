# Shatale MCP Server — Demo Script

## For recording (asciinema / screen recording)

### Setup
```bash
# Terminal 1: Start MCP server
export SHATALE_API_KEY=sk_sandbox_demo_key
npx shatale-mcp-server
# Output on stderr: Shatale MCP server started (demo(sandbox) mode, 17 tools)
```

### Demo Flow (in Claude Desktop / Cursor)

> ⚠️ **The agent is created by a PERSON, by hand, in the publisher console.** No API key issues one
> and no tool here can, so the demo starts from an agent id you already have. This script used to
> open with "Create a shopping agent with a €1000 monthly budget. Block gambling and alcohol." —
> the same imperative SHAT-2604 removed from the prompts, the README and `smithery.yaml`, left
> behind here. Nothing in this server creates an agent, stores a policy or blocks a category, and a
> model handed that instruction improvises an agent id rather than failing.

**Prompt 1:**
> I have agent `agt_demo_1` from the publisher console. Set up a sandbox user for it.

**Expected MCP calls:**
1. `sandbox_create_user` (`user_id`: yours to choose, `agent_id`: the one from the console)
2. Shows: the user, marked onboarded, **and the active delegation that lets it buy** — one call
   provisions all of it, and it is idempotent, so the demo can be re-run.

This is the first step, not a formality: `request_purchase` needs a `publisher_user_id` with an
active delegation, and nothing else in the tool surface creates one.

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
> What can this server actually do?

**Expected MCP calls:**
1. `explain_shatale`
2. Shows: the four modes and the tool roster THIS session actually has — it reports the live list,
   so what you see is what the key in Terminal 1 unlocked.

> The per-rule breakdown of the decline (spend_limit ✓, mcc_block ✗, balance_check ✓) comes back in
> `sandbox_simulate_authorization`'s OWN response in Prompt 3, not from `explain_shatale`. This step
> used to claim otherwise.

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
