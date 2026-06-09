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
SHATALE_API_KEY=sh_test_xxx npx shatale-mcp-server
```

…or just add the key to the `env` block of your IDE's MCP config (see below) — same prompt, no other changes.

Free sandbox key, no card required → [admin.shatale.com/register?ref=mcp](https://admin.shatale.com/register?ref=mcp)

> Guest = **explore** (3 simulation tools + catalog). Sandbox = **build** (full 19-tool lifecycle). Production keys (`sh_live_*`) are blocked in this MCP server by design — a local IDE/agent is not a trust boundary for live payment credentials; integrate via your backend.

## Configure Your IDE

> Omit the `SHATALE_API_KEY` env entirely to run in guest mode (60-second demo). Add a `sh_test_*` key to unlock the full sandbox.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shatale": {
      "command": "npx",
      "args": ["shatale-mcp-server"],
      "env": {
        "SHATALE_API_KEY": "sh_test_your_key_here"
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
        "SHATALE_API_KEY": "sh_test_your_key_here"
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
| `sandbox_create_test_user` | Create a test user with verified status for sandbox testing |
| `sandbox_complete_onboarding` | Instantly complete user onboarding (skip verification) |
| `sandbox_approve_request` | Approve a pending purchase request |
| `sandbox_decline_request` | Decline a pending purchase request |
| `sandbox_reset` | Reset sandbox state — clear test data |

## Example Prompts

Try these with your AI assistant:

- *"Search for electronics merchants in Germany"*
- *"Request a purchase of $49.99 at Amazon for user john@example.com"*
- *"Check the status of my last purchase"*
- *"Register a new user with email alice@startup.io and country US"*
- *"Create a test user and simulate a complete purchase flow"*
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

- Only sandbox keys (`sk_test_*` / `sh_test_*`) are accepted — production keys are rejected
- Card credentials are encrypted (JWE) and delivered only to authorized agents
- Local stdio transport — no network server exposed
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

## Links

- [Shatale Website](https://shatale.com)
- [Publisher Admin](https://admin.shatale.com)
- [Sign Up](https://admin.shatale.com/register?ref=mcp)
- [GitHub](https://github.com/solskiysb/shatale-mcp-server)

## License

MIT
