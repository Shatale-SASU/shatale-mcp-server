# Shatale MCP Server

MCP server for [Shatale](https://shatale.com) — AI-native payment infrastructure. Give your AI agents the ability to make purchases, issue virtual cards, and manage spending within delegated budgets and policy controls.

**19 tools** for the complete agent payment lifecycle: from merchant discovery to card issuance to purchase completion.

## Quick Start

### 1. Install and run

```bash
npx shatale-mcp-server
```

The server starts in **guest mode** with discovery tools. No API key needed to explore.

### 2. Get full access

Sign up at [admin.shatale.com/register](https://admin.shatale.com/register?ref=mcp) (free, no credit card) and set your sandbox key:

```bash
export SHATALE_API_KEY=sh_test_your_key_here
npx shatale-mcp-server
```

Now you have **19 tools** — full purchase flow, merchant catalog, user onboarding, card credentials, and sandbox testing.

## Configure Your IDE

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
| `list_mcc_codes` | Browse merchant category codes for policy design |
| `explain_shatale` | Learn what Shatale is and how it works |
| `list_capabilities` | See all available tools and capabilities |
| `generate_policy_template` | Generate a spending policy template for your use case |

### Purchase Flow

| Tool | Description |
|------|-------------|
| `request_purchase` | Request a purchase on behalf of a user — starts the full flow |
| `get_purchase_status` | Check the status of an existing purchase request |
| `cancel_purchase` | Cancel a pending purchase |
| `simulate_purchase_flow` | Simulate an end-to-end purchase flow for testing |

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
AI Agent → MCP Server → Shatale API → Card Issuer → Visa/Mastercard
```

1. **Agent requests purchase** via `request_purchase` with merchant and amount
2. **Shatale evaluates policy** — checks delegation scope, amount limits, MCC rules
3. **User verifies** (if new) — opens personalized onboarding URL, confirms identity
4. **Virtual card issued** — issuing partner provisions a Visa card locked to the merchant and amount
5. **Agent receives credentials** — PAN, CVV, expiry via `request_temporary_credentials`
6. **Agent completes purchase** — uses card at the merchant

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
