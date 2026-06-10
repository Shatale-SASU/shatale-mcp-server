import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "shatale://guides/quickstart",
    "Shatale Quickstart Guide",
    {
      description:
        "5-minute guide to get started with Shatale AI agent payments",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "shatale://guides/quickstart",
          text: `# Shatale Quickstart

## What is Shatale?
AI-native payment infrastructure. Give your AI agents the ability to spend money within delegated budgets and policy controls.

## Quick Start (5 minutes)

### 1. Create an Account
Sign up at https://admin.shatale.com/register — free sandbox access, no credit card required.

### 2. Get Your API Key
After signup, your sandbox API key (\`sk_sandbox_...\`) is on the dashboard. Copy it.

### 3. Connect MCP Server
\`\`\`bash
export SHATALE_API_KEY=sk_sandbox_your_key_here
npx @shatale/mcp-server
\`\`\`

### 4. Try It
Ask your AI assistant:
- "Create a shopping agent with a €1000 monthly budget"
- "Simulate a €150 purchase at Nike Store"
- "Block gambling and alcohol categories"

## Key Concepts
- **Agent**: AI entity that can make payments
- **Card**: Virtual card issued to an agent
- **Policy**: Rules governing what an agent can spend on
- **Authorization**: Real-time approve/decline decision based on policy

## Links
- Documentation: https://shatale.com/mcp
- API Reference: https://shatale.com/mcp
- GitHub: https://github.com/shatale/mcp-server`,
        },
      ],
    }),
  );

  server.registerResource(
    "shatale://guides/policies",
    "Policy Engine Guide",
    {
      description:
        "How Shatale policies and skills control agent spending",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "shatale://guides/policies",
          text: `# Shatale Policy Engine Guide

## What Are Policies?
Policies are rule sets that govern how an AI agent can spend money. Each policy contains one or more **skills** — individual checks that run against every transaction in real time.

When an agent's card is used, the transaction is evaluated against all skills in the policy. If any skill fails (in closed mode), the transaction is declined.

## Skills

### spend_limit_check
Enforces spending limits per transaction and/or per time period.
- \`max_per_transaction\`: Maximum amount for a single transaction
- \`max_per_month\`: Maximum total spend in a calendar month
- Example: Per-transaction limit of €500, monthly limit of €5,000

### mcc_block
Blocks transactions based on Merchant Category Code (MCC).
- \`blocked_mccs\`: Array of MCC codes to decline
- Example: Block gambling (MCC 7995), alcohol (MCC 5921), tobacco (MCC 5993)

### balance_check
Ensures a minimum balance reserve is maintained before approving.
- \`min_balance\`: Minimum balance that must remain after the transaction
- Example: Maintain a €100 reserve — a €950 purchase on a €1,000 balance is declined

### transaction_notify
Sends a notification for each transaction (does not block).
- \`webhook_url\`: URL to receive transaction notifications
- Always passes — used for monitoring, not enforcement

## Evaluation Model
Skills are evaluated **sequentially** in the order they are listed in the policy.

### fail_mode
- **closed** (default): If a skill fails, the transaction is **declined**. Fail-safe — deny unless explicitly allowed.
- **open**: If a skill fails, the transaction is still **approved**. Permissive — allow unless explicitly blocked.

All skills run **inline** during authorization, so the approve/decline decision is made in real time (typically under 100ms).

## Examples

### Per-Transaction Limit
\`\`\`json
{
  "skill": "spend_limit_check",
  "params": { "max_per_transaction": 500 }
}
\`\`\`
A €600 purchase is declined. A €400 purchase is approved.

### Block Gambling
\`\`\`json
{
  "skill": "mcc_block",
  "params": { "blocked_mccs": [7995] }
}
\`\`\`
Any transaction at a gambling merchant (MCC 7995) is declined.

### Maintain Reserve
\`\`\`json
{
  "skill": "balance_check",
  "params": { "min_balance": 100 }
}
\`\`\`
On a €500 balance, a €450 purchase is declined (would leave only €50). A €350 purchase is approved (leaves €150).`,
        },
      ],
    }),
  );

  server.registerResource(
    "shatale://guides/verticals",
    "Vertical Use Cases",
    {
      description:
        "Examples of AI agent payment setups for different industries",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "shatale://guides/verticals",
          text: `# Vertical Use Cases

## 1. Shopping Agent

### Typical Agent Config
- **Purpose**: Browse online stores and purchase items on behalf of a user
- **Budget**: €1,000/month
- **Card type**: Single-use virtual cards per merchant

### Recommended Policy
- Per-transaction limit: €500
- Monthly limit: €1,000
- Blocked MCCs: 7995 (gambling), 5921 (alcohol), 5993 (tobacco), 6011 (ATM/cash)
- Minimum balance reserve: €50

### Example Transactions
| Amount | Merchant | MCC | Result | Reason |
|--------|----------|-----|--------|--------|
| €150 | Nike Store | 5699 | ✅ Approved | Within limits, allowed category |
| €89 | Amazon | 5999 | ✅ Approved | Within limits, allowed category |
| €600 | Electronics Hub | 5732 | ❌ Declined | Exceeds €500 per-tx limit |
| €50 | Online Casino | 7995 | ❌ Declined | Blocked MCC |

---

## 2. Travel Agent

### Typical Agent Config
- **Purpose**: Book flights, hotels, and car rentals
- **Budget**: €5,000/month
- **Card type**: Multi-use virtual card

### Recommended Policy
- Per-transaction limit: €2,000
- Monthly limit: €5,000
- Allowed MCCs only: 4511 (airlines), 7011 (hotels), 7512 (car rental), 4722 (travel agencies)
- Minimum balance reserve: €200

### Example Transactions
| Amount | Merchant | MCC | Result | Reason |
|--------|----------|-----|--------|--------|
| €350 | British Airways | 4511 | ✅ Approved | Allowed MCC, within limits |
| €180 | Hilton Hotels | 7011 | ✅ Approved | Allowed MCC, within limits |
| €75 | Restaurant | 5812 | ❌ Declined | MCC not in allow list |
| €2,500 | Luxury Resort | 7011 | ❌ Declined | Exceeds €2,000 per-tx limit |

---

## 3. Procurement Agent

### Typical Agent Config
- **Purpose**: Purchase office supplies, software licenses, and equipment
- **Budget**: €10,000/month
- **Card type**: Multi-use virtual card with department tagging

### Recommended Policy
- Per-transaction limit: €3,000
- Monthly limit: €10,000
- Blocked MCCs: 7995 (gambling), 5921 (alcohol), 5993 (tobacco), 7273 (dating), 5816 (games)
- Minimum balance reserve: €500

### Example Transactions
| Amount | Merchant | MCC | Result | Reason |
|--------|----------|-----|--------|--------|
| €1,200 | Dell Technologies | 5045 | ✅ Approved | Office equipment, within limits |
| €299 | Adobe | 5734 | ✅ Approved | Software, within limits |
| €4,000 | Server Rack Co | 5045 | ❌ Declined | Exceeds €3,000 per-tx limit |
| €50 | Steam Games | 5816 | ❌ Declined | Blocked MCC |

---

## 4. Expense Management Agent

### Typical Agent Config
- **Purpose**: Handle employee expense reimbursements and corporate card spending
- **Budget**: €2,000/month per employee card
- **Card type**: Named virtual cards per employee

### Recommended Policy
- Per-transaction limit: €500
- Monthly limit: €2,000
- Blocked MCCs: 7995 (gambling), 6011 (ATM/cash), 6051 (money transfer)
- Minimum balance reserve: €100
- Notification webhook for all transactions

### Example Transactions
| Amount | Merchant | MCC | Result | Reason |
|--------|----------|-----|--------|--------|
| €35 | Uber | 4121 | ✅ Approved | Transport, within limits |
| €120 | Business Lunch | 5812 | ✅ Approved | Restaurant, within limits |
| €200 | ATM Withdrawal | 6011 | ❌ Declined | Blocked MCC (cash) |
| €800 | Conference Ticket | 7941 | ❌ Declined | Exceeds €500 per-tx limit |`,
        },
      ],
    }),
  );
}
