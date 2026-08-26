#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ShataleClient } from './client.js'
import { resolveMoneyGo } from './money-gate.js'
import { installStdioErrorHandling } from './stdio-hardening.js'
import { VERSION } from './version.js'
import { createGuestTools } from './tools/guest.js'
import { createPurchaseTools } from './tools/purchase.js'
import { createCredentialTools } from './tools/credentials.js'
import { createCheckoutTools } from './tools/checkout.js'
import { createSandboxTools } from './tools/sandbox.js'
import { createOnboardingTools } from './tools/onboarding.js'
import { createCatalogTools } from './tools/catalog.js'
import { createCommonTools, isSandboxKey } from './tools/common.js'
import type { ToolDefinition, ToolHandler } from './types.js'
import { textResult } from './types.js'

const apiKey = process.env.SHATALE_API_KEY ?? ''

// ── Honest two-mode model: demo (sandbox) and live (prod). ──────────────────
// The backend issues LIVE keys as `sk_live_` (apps/api internal/identity/
// service.go GenerateAPIKeyWithEnv). A live key therefore MUST be accepted for
// the MCP to have a working normal/prod mode — but only under EXPLICIT operator
// intent (`SHATALE_MODE=live`). A bare live key without that intent fails fast:
// a local IDE/agent is not, by default, a trust boundary for live payments, and
// a fat-fingered live key must never silently move real money.
// ⚠️ SHAT-2557 — `sh_live_` USED TO BE ACCEPTED HERE, AND IT UNDID THE FIX 33 LINES BELOW.
//
// The backend has never issued that prefix: identity/service.go mints exactly `sk_live_` and
// `sk_sandbox_`, nothing else. So the second disjunct admitted a key that cannot exist — harmless in
// isolation, and not in place.
//
// The guard at "unrecognized API key" refuses anything that is neither guest, sandbox nor live, and
// its comment says it exists because such keys "previously fell into a phantom 'production' mode
// that could never authenticate". But `sh_live_anything` satisfied isLive, so it walked straight
// past that guard into live mode — measured, not reasoned: with SHATALE_MODE=live the server
// STARTED and reported "live(onboarding-only) mode, 7 tools". The phantom mode the guard was written
// to remove was recreated by a line above it.
//
// ⚠️ AND THE ERROR MESSAGE WAS ALREADY RIGHT while the code was wrong: it says "a live key
// (sk_live_) was supplied", naming one prefix. The code accepted two. When the text and the code
// disagree about the SAME set, the text is the one somebody read and believed.
//
// This is the second half of a pair. SHAT-1460/2484 narrowed the SANDBOX side to exactly
// `sk_sandbox_` and left the live side widened — the side where a key, if one ever existed, carries
// money.
const isLiveKey = apiKey.startsWith('sk_live_')
const liveIntent = process.env.SHATALE_MODE === 'live'

if (isLiveKey && !liveIntent) {
  console.error(
    'ERROR: a live key (sk_live_) was supplied without SHATALE_MODE=live. Refusing to run.\n' +
      'Set SHATALE_MODE=live ONLY in an environment cleared for real operations, or use a ' +
      'sandbox key (sk_sandbox_) for the demo.',
  )
  process.exit(1)
}
if (liveIntent && apiKey && !isLiveKey) {
  console.error('ERROR: SHATALE_MODE=live requires a live key (sk_live_); got a non-live key.')
  process.exit(1)
}

// F-005: Whitelist API URL
const ALLOWED_HOSTS = ['api.shatale.com', 'localhost', '127.0.0.1']
const apiBaseUrl = new URL(process.env.SHATALE_API_URL ?? 'https://api.shatale.com')
if (!ALLOWED_HOSTS.some(h => apiBaseUrl.hostname === h || apiBaseUrl.hostname.endsWith('.shatale.com'))) {
  console.error(`ERROR: Untrusted API URL: ${apiBaseUrl.hostname}. Only *.shatale.com and localhost are allowed.`)
  process.exit(1)
}
const apiBase = apiBaseUrl.toString().replace(/\/$/, '')

const isGuest = !apiKey
const isSandbox = isSandboxKey(apiKey)
const isLive = isLiveKey && liveIntent

// Reject keys that are neither sandbox nor live. Previously such a key fell into
// a phantom "production" mode that could never authenticate (the real live
// prefix was hard-rejected) — misleading. Fail fast with a clear message.
if (!isGuest && !isSandbox && !isLive) {
  console.error(
    'ERROR: unrecognized API key. Use a sandbox key (sk_sandbox_) for the demo, or a live ' +
      'key (sk_live_) together with SHATALE_MODE=live for production.',
  )
  process.exit(1)
}

// Separate gate for MONEY movement in live mode. Onboarding (no money) is always
// available once authenticated; purchase/credentials (which move money / issue
// cards) additionally require an explicit money-GO token. This keeps
// registration (free) and payment (real €) on DIFFERENT gates (council + Fable).
// SHATALE_MONEY_GO is Sergey's opaque go-code; money turns on ONLY when its
// SHA-256 equals SHATALE_MONEY_GO_SHA256 (exact match, resolveMoneyGo). The
// earlier length+deny-list heuristic kept the fatal polarity — an unknown ≥4-char
// value ('nope', 'money-off', a typo) still ENABLED money. A hash match has no
// such input: everything except the one real code is OFF, and a missing digest
// is OFF too (fail-closed).
const moneyGo = resolveMoneyGo(process.env.SHATALE_MONEY_GO, process.env.SHATALE_MONEY_GO_SHA256)

// get_credential_emails' backend (GET /v1/credentials/{id}/emails) ships in PR #361, not yet
// deployed. Keep the tool out of the advertised list until the backend is live so it never reads
// as a working-but-404ing tool. Flip this once #361 is merged AND deployed. (Odin review.)
const credentialEmailsEnabled = (process.env.SHATALE_CREDENTIAL_EMAILS_ENABLED ?? '').toLowerCase() === 'true'
// SHAT-1662: see src/tools/onboarding.ts — the register→status loop cannot close on any
// deployed backend, so the pair stays unadvertised until Funnel B is merged AND deployed.
const onboardingEnabled = (process.env.SHATALE_ONBOARDING_ENABLED ?? '').toLowerCase() === 'true'

const client = new ShataleClient(apiBase, apiKey)

// Collect all tool definitions and handlers
const allTools: ToolDefinition[] = []
const allHandlers: Record<string, ToolHandler> = {}

function registerModule(mod: { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> }) {
  allTools.push(...mod.tools)
  Object.assign(allHandlers, mod.handlers)
}

// Always register guest + common + catalog tools.
// explain_shatale reports the live tool list, so getToolNames is lazy — it reads
// allTools at call time, after every module below has registered.
// One context object for BOTH explain_shatale and list_capabilities, so they report the same four modes and
// the same live tool roster (SHAT-1461). getToolNames is lazy — it reads allTools at call time, after every
// module below has registered.
const toolContext = {
  isGuest,
  isSandbox,
  isLive,
  moneyEnabled: moneyGo,
  getToolNames: () => allTools.map((t) => t.name),
}
registerModule(createGuestTools(toolContext))
registerModule(createCommonTools(client, toolContext))
registerModule(createCatalogTools(client))

// Register authenticated tools once a key is present.
if (!isGuest) {
  // Onboarding moves no money and touches no PAN — available in demo and live.
  registerModule(createOnboardingTools(client, { enabled: onboardingEnabled }))

  if (isSandbox) {
    // Demo: request_purchase is registered but client-blocked (steers to the
    // side-effect-free simulator); sandbox lifecycle helpers are live.
    registerModule(createPurchaseTools(client, { isSandbox: true }))
    registerModule(createCredentialTools(client, { emailsEnabled: credentialEmailsEnabled }))
    registerModule(createSandboxTools(client))
  } else if (isLive && moneyGo) {
    // Live + explicit money-GO: real purchase/credentials. Without money-GO,
    // live mode is onboarding-only (can drive registration, cannot move money).
    registerModule(createPurchaseTools(client, { isSandbox: false }))
    registerModule(createCredentialTools(client, { emailsEnabled: credentialEmailsEnabled }))
    // Checkout identity is on the live money path (backend rejects sandbox keys) — register it only
    // here, alongside the real purchase flow.
    registerModule(createCheckoutTools(client))
  }
}

// ── Resources ──────────────────────────────────────────────────────────
const resources = [
  {
    uri: 'shatale://guides/quickstart',
    name: 'Shatale Quickstart Guide',
    description: '5-minute guide to get started with Shatale AI agent payments',
    mimeType: 'text/markdown',
  },
  {
    uri: 'shatale://guides/policies',
    name: 'Policy Engine Guide',
    description: 'How Shatale policies and skills control agent spending',
    mimeType: 'text/markdown',
  },
  {
    uri: 'shatale://guides/verticals',
    name: 'Vertical Use Cases',
    description: 'Examples of AI agent payment setups for different industries',
    mimeType: 'text/markdown',
  },
]

const resourceContents: Record<string, string> = {
  'shatale://guides/quickstart': `# Shatale Quickstart

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
- "Create a shopping agent with a 1000 EUR monthly budget"
- "Simulate a 150 EUR purchase at Nike Store"
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

  'shatale://guides/policies': `# Shatale Policy Engine Guide

## What Are Policies?
Policies are rule sets that govern how an AI agent can spend money. Each policy contains one or more **skills** — individual checks that run against every transaction in real time.

## Skills

### spend_limit_check
Enforces spending limits per transaction and/or per time period.

### mcc_block
Blocks transactions based on Merchant Category Code (MCC).

### balance_check
Ensures a minimum balance reserve is maintained before approving.

### transaction_notify
Sends a notification for each transaction (does not block).

## Evaluation Model
Skills are evaluated sequentially. fail_mode can be "closed" (deny by default) or "open" (allow by default).`,

  'shatale://guides/verticals': `# Vertical Use Cases

## 1. Shopping Agent
Budget: 1,000 EUR/month. Block gambling, alcohol, tobacco. Per-tx limit: 500 EUR.

## 2. Travel Agent
Budget: 5,000 EUR/month. Allow only airlines, hotels, car rental, travel agencies.

## 3. Procurement Agent
Budget: 10,000 EUR/month. Block gambling, alcohol, tobacco, dating, games.

## 4. Expense Management Agent
Budget: 2,000 EUR/month per employee. Block gambling, ATM, money transfer.`,
}

// ── Prompts ────────────────────────────────────────────────────────────
const prompts = [
  {
    name: 'shopping-agent',
    description: 'Create a shopping agent with budget and category restrictions',
    arguments: [{ name: 'budget', description: 'Monthly budget in EUR (default: 1000)', required: false }],
  },
  {
    name: 'travel-agent',
    description: 'Create a travel booking agent for hotels and flights',
    arguments: [{ name: 'budget', description: 'Monthly budget in EUR (default: 5000)', required: false }],
  },
  {
    name: 'policy-designer',
    description: 'Design a spending policy for an AI agent',
    arguments: [{ name: 'use_case', description: 'What the agent will be used for', required: true }],
  },
  {
    name: 'test-my-setup',
    description: 'Test an existing agent setup with various transaction scenarios',
    arguments: [{ name: 'agent_id', description: 'Agent ID to test', required: false }],
  },
]

function getPromptMessages(name: string, args: Record<string, string | undefined>) {
  switch (name) {
    case 'shopping-agent':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Create a shopping agent with a monthly budget of ${args.budget ?? '1000'} EUR. Block gambling, alcohol, and tobacco categories. Set per-transaction limit to 500 EUR. Then simulate buying sneakers for 150 EUR at Nike Store to test the setup.` },
      }]
    case 'travel-agent':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Create a travel agent with budget ${args.budget ?? '5000'} EUR. Allow only airlines (MCC 4511), hotels (MCC 7011), car rental (MCC 7512), and travel agencies (MCC 4722). Set per-transaction limit to 2000 EUR. Simulate booking a flight for 350 EUR on British Airways.` },
      }]
    case 'policy-designer':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `I need to design a spending policy for an AI agent that will be used for: ${args.use_case ?? 'general'}. Help me choose: 1) Monthly budget limit 2) Per-transaction limit 3) Which MCC categories to allow or block 4) Minimum balance reserve. Then test the policy with 5 different simulated transactions to verify it works correctly.` },
      }]
    case 'test-my-setup':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Run a comprehensive test of my Shatale setup${args.agent_id ? ` for agent ${args.agent_id}` : ''}. Simulate these transactions: 1) Normal 100 EUR retail purchase 2) Large 2000 EUR electronics purchase 3) 50 EUR at a gambling site 4) 30 EUR at a restaurant 5) 500 EUR airline ticket. Explain each result.` },
      }]
    default:
      return []
  }
}

// Create server
const server = new Server(
  { name: 'shatale-mcp', version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

// F-009: harden the stdio session against malformed JSON-RPC frames.
installStdioErrorHandling(server)

// Register list_tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools }
})

// Register call_tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const handler = allHandlers[name]

  if (!handler) {
    return textResult(`Unknown tool: ${name}`, true)
  }

  return handler(args ?? {})
})

// Register resources handlers (F-002)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri
  const text = resourceContents[uri]
  if (!text) {
    throw new Error(`Resource not found: ${uri}`)
  }
  return { contents: [{ uri, text }] }
})

// Register prompts handlers (F-002)
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts }
})

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const prompt = prompts.find(p => p.name === name)
  if (!prompt) {
    throw new Error(`Prompt not found: ${name}`)
  }
  const messages = getPromptMessages(name, (args ?? {}) as Record<string, string | undefined>)
  return { messages }
})

// F-009: Process-level error handling for JSON-RPC edge cases
process.on('uncaughtException', (err) => {
  console.error('MCP server error:', err.message)
  process.exit(1)
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log mode to stderr so it does not interfere with stdio transport
  const mode = isGuest ? 'guest' : isSandbox ? 'demo(sandbox)' : moneyGo ? 'live+money-GO' : 'live(onboarding-only)'
  const toolCount = allTools.length
  process.stderr.write(`Shatale MCP server started (${mode} mode, ${toolCount} tools)\n`)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
