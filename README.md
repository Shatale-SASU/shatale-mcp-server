# Shatale MCP Server

MCP server for [Shatale](https://shatale.com) — AI-native payment infrastructure. Give your AI agents the ability to make purchases, issue virtual cards, and manage spending within delegated budgets and policy controls.

## 60-second demo, no API key required

See the whole agent payment lifecycle before you sign up. **Guest mode makes no real API call and no payment.**

**1. Run it:**

```bash
npx shatale-mcp-server
```

**2. Point your IDE at it** (Claude Code shown — see [Configure your IDE](#configure-your-ide) for Desktop/Cursor/Windsurf):

```bash
claude mcp add shatale -- npx shatale-mcp-server
```

**3. Ask your assistant:**

> Use Shatale to simulate an AI agent buying a $25 developer tool subscription with a $100 monthly budget. Show the policy check, approval decision, virtual card step, and final timeline.

You'll see the policy evaluation, the approve / decline / requires-approval decision, the (simulated) virtual card step, and a trace — all in guest mode, with no key.

> **Tip:** call `explain_shatale` first. It reports the current mode, the tools available to you, and the recommended first prompt.

## Run the same flow in sandbox

**No code changes required. Add a sandbox key and re-run the same prompt.** The guest simulation becomes a real sandbox integration — onboarding, purchase requests, approval, credential issuance, status and audit — against Shatale Sandbox APIs, with no real money.

```bash
SHATALE_API_KEY=sk_sandbox_xxx npx shatale-mcp-server
```

…or just add the key to the `env` block of your IDE's MCP config (see below) — same prompt, no other changes.

Free sandbox key, no card required → [admin.shatale.com/register?ref=mcp](https://admin.shatale.com/register?ref=mcp)

> Guest = **explore** (3 simulation tools + catalog). Sandbox = **build** (full 17-tool lifecycle). Production keys (`sk_live_*`) are blocked in this MCP server by design — a local IDE/agent is not a trust boundary for live payment credentials; integrate via your backend.

## Configure Your IDE

> Omit the `SHATALE_API_KEY` env entirely to run in guest mode (60-second demo). Add a `sk_sandbox_*` key to unlock the full sandbox.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shatale": {
      "command": "npx",
      "args": ["shatale-mcp-server"],
      "env": {
        "SHATALE_API_KEY": "sk_sandbox_your_key_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add shatale -- npx shatale-mcp-server
```

### Cursor / Windsurf

Add to `.cursor/mcp.json` or `~/.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "shatale": {
      "command": "npx",
      "args": ["shatale-mcp-server"],
      "env": {
        "SHATALE_API_KEY": "sk_sandbox_your_key_here"
      }
    }
  }
}
```

## Tools

### Discovery & Setup (no API key required)

| Tool | Description |
|------|-------------|
| `explain_shatale` | **Start here.** Reports the current mode (guest/sandbox/blocked production), the tools available to you, and the recommended first prompt |
| `simulate_purchase_flow` | Simulates the Shatale agent payment lifecycle in guest mode — policy check, approve/decline/requires-approval decision, virtual card step, timeline. No real API call or payment is made |
| `generate_policy_template` | Generates **and validates** a spending policy for your use case — returns risk level, warnings, and recommended controls (never a silently unsafe policy) |
| `list_mcc_codes` | Browse merchant category codes for policy design |
| `list_capabilities` | See all available tools and capabilities |

### Purchase Flow

| Tool | Description |
|------|-------------|
| `request_purchase` | Request a purchase on behalf of a user — starts the full flow |
| `get_purchase_status` | Check the status of an existing purchase request |
| `cancel_purchase` | Cancel a pending purchase |

### Merchant Catalog

| Tool | Description |
|------|-------------|
| `search_merchants` | Search for merchants by name, category, or country |
| `get_merchant_details` | Get detailed info about a specific merchant (MCC, country, limits) |

### User Onboarding (Cold Start)

| Tool | Description |
|------|-------------|
| `register_user_profile` | Pre-register a user with email, name, country — before any purchase |
| `get_onboarding_status` | Check if a user has completed verification and onboarding |

### Card Credentials

| Tool | Description |
|------|-------------|
| `request_temporary_credentials` | Get temporary virtual card credentials (PAN, CVV, exp) for a purchase |
| `get_credential_status` | Check the status of issued credentials |

### Sandbox Testing

| Tool | Description |
|------|-------------|
| `sandbox_simulate_authorization` | Run the policy engine on a simulated authorization — side-effect-free (no ledger, no money). Returns approve/decline + explanation. Test cards: `4242…` approve, `4000…0002` decline, neutral → real policy |
| `sandbox_complete_onboarding` | Instantly complete user onboarding (skip verification) |
| `sandbox_approve_purchase` | Approve a sandbox purchase that is pending approval |

> **Note (v0.4.0, SHAT-1488):** the sandbox surface now maps 1:1 to the routes the backend actually deploys. `request_purchase` is **disabled when a sandbox key is set** (it is not sandbox-gated on the backend and would create real ledger state) — use `sandbox_simulate_authorization` instead. The previous `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` and `sandbox_approve_request` tools have been removed/renamed.

## Example Prompts

Try these with your AI assistant:

- *"Search for electronics merchants in Germany"*
- *"Request a purchase of $49.99 at Amazon for user john@example.com"*
- *"Check the status of my last purchase"*
- *"Register a new user with email alice@startup.io and country US"*
- *"Run a sandbox authorization for a $49.99 charge at MCC 5732 and explain the policy decision"*
- *"What merchants are available in the travel category?"*
- *"Generate a spending policy for a procurement bot with $5000 monthly limit"*

## How It Works

```
AI Agent → MCP Server → Shatale Sandbox API → issuing partner → virtual card
```

1. **Agent requests purchase** via `request_purchase` with merchant and amount
2. **Shatale evaluates policy** — checks delegation scope, amount limits, MCC rules
3. **User verifies** (if new) — opens personalized onboarding URL, confirms identity
4. **Virtual card issued** — the issuing partner provisions a card locked to the merchant and amount
5. **Agent receives credentials** — PAN, CVV, expiry via `request_temporary_credentials`
6. **Agent completes purchase** — uses card at the merchant

In **guest mode** none of this hits the network — `simulate_purchase_flow` walks the same steps deterministically so you can see them before registering for a sandbox key.

## Resources

Built-in documentation available as MCP resources:

- `shatale://guides/quickstart` — 5-minute quickstart guide
- `shatale://guides/policies` — Policy engine and skills reference
- `shatale://guides/verticals` — Use case examples (shopping, travel, procurement, expense)

## Security

- Only sandbox keys (`sk_sandbox_*`) are accepted — production keys (`sk_live_*`) are rejected
- Card credentials are encrypted (JWE) and delivered only to authorized agents
- Local stdio transport — no network server exposed
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

## Privacy & telemetry

This server has **no telemetry**: no analytics endpoint, no beacons, no install ID, no fingerprinting.

- **Guest mode (no API key)** sends **no attribution headers and no telemetry**. The simulation tools (`simulate_purchase_flow`, `generate_policy_template`) run fully offline and make no network calls. Guest activity is intentionally **not measured remotely**.
- **Sandbox mode (`sk_sandbox_*`)** already authenticates to the Shatale Sandbox API. Those requests carry three static **attribution** headers so we can understand aggregate adoption of the official client:
  - `User-Agent: shatale-mcp-server/<version>`
  - `X-Shatale-Client: shatale-mcp-server`
  - `X-Shatale-Client-Version: <version>`

  These add no new transport, endpoint, or payload — they only label calls you are already making. Analytics are derived **server-side** from your authenticated activity.
- **Never collected:** API key values, prompts, policy contents, merchant/customer/card data, PAN, and no machine identifiers (OS, hostname, username, file path, or persistent install ID).

## Links

- [Shatale Website](https://shatale.com)
- [Publisher Admin](https://admin.shatale.com)
- [Sign Up](https://admin.shatale.com/register?ref=mcp)
- [GitHub](https://github.com/Shatale-SASU/shatale-mcp-server)

## License

MIT
