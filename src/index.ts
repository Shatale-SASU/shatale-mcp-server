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
import { installStdioErrorHandling } from './stdio-hardening.js'
import { VERSION } from './version.js'
import { createGuestTools } from './tools/guest.js'
import { createPurchaseTools } from './tools/purchase.js'
import { createCredentialTools } from './tools/credentials.js'
import { createSandboxTools } from './tools/sandbox.js'
import { createOnboardingTools } from './tools/onboarding.js'
import { createCatalogTools } from './tools/catalog.js'
import { createCommonTools } from './tools/common.js'
import type { ToolDefinition, ToolHandler } from './types.js'
import { textResult } from './types.js'

const apiKey = process.env.SHATALE_API_KEY ?? ''

// F-001/F-010: Reject production keys
if (apiKey.startsWith('sh_live_') || apiKey.startsWith('sk_live_')) {
  console.error('ERROR: Production keys are not allowed. Use a sandbox key (sk_test_*).')
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
const isSandbox = apiKey.startsWith('sk_test_') || apiKey.startsWith('sh_test_') || apiKey.startsWith('sk_sandbox_')

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
registerModule(
  createGuestTools({
    isGuest,
    isSandbox,
    getToolNames: () => allTools.map((t) => t.name),
  }),
)
registerModule(createCommonTools(client))
registerModule(createCatalogTools(client))

// Register authenticated tools if API key provided
if (!isGuest) {
  registerModule(createPurchaseTools(client))
  registerModule(createCredentialTools(client))
  registerModule(createOnboardingTools(client))
  if (isSandbox) {
    registerModule(createSandboxTools(client))
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
After signup, your sandbox API key (\`sh_test_...\`) is on the dashboard. Copy it.

### 3. Connect MCP Server
\`\`\`bash
export SHATALE_API_KEY=sh_test_your_key_here
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
  const mode = isGuest ? 'guest' : isSandbox ? 'sandbox' : 'production'
  const toolCount = allTools.length
  process.stderr.write(`Shatale MCP server started (${mode} mode, ${toolCount} tools)\n`)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
