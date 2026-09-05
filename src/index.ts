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
import { createRevealTools } from './tools/reveal.js'
import { createSandboxTools } from './tools/sandbox.js'
import { createOnboardingTools } from './tools/onboarding.js'
import { createCatalogTools } from './tools/catalog.js'
import { createCommonTools, isSandboxKey } from './tools/common.js'
import type { ToolContext, ToolDefinition, ToolHandler } from './types.js'
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

// F-005 / SHAT-2558: where SHATALE_API_URL may point, and what may be sent there.
//
// ⚠️ WHAT THIS CHECK GUARDS IS NOT "A URL". IT IS THE API KEY. client.ts attaches
// `Authorization: Bearer ${apiKey}` to whatever host survives this block, unconditionally. So every
// line below is really about one question: who ends up holding a live key.
//
// ⚠️ THE OLD EXPRESSION READ LIKE AN ALLOWLIST AND WAS NOT ONE:
//
//     ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.shatale.com'))
//
// The second disjunct never mentions `h`. It is a constant inside the callback, so it was simply
// OR-ed onto the whole test and evaluated once per array element — the three named hosts only ever
// contributed exact matches, and the real rule was the wildcard. A reader checking "is this host
// allowed" reads the array and gets the wrong answer.
//
// ⚠️ AND ONE WORRY DOES NOT REPRODUCE, WHICH IS WORTH RECORDING SO NOBODY RE-RAISES IT: a LOOKALIKE
// domain is refused. The suffix carries the leading dot, so `evilshatale.com`.endsWith('.shatale.com')
// is false. Measured: SHATALE_API_URL=https://evilshatale.com exits 1.
//
// What IS true is narrower and still serious: ANY subdomain of shatale.com receives the key. A
// dangling CNAME on a marketing subdomain, or one third-party service with a takeover, is enough to
// be handed `Bearer sk_live_*` and every purchase body that follows.
const SHATALE_SUFFIX = '.shatale.com'
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
const CANONICAL_API_HOST = 'api.shatale.com'

// ⚠️ THREE CASES, AND TWO OF THEM USED TO BE SILENT (SHAT-2711).
//
// UNSET meant PRODUCTION, quietly. The variable is optional and defaults to the real API, so a
// launcher that forgot it did not fail — it pointed at money and said nothing. Measured: the banner
// was BYTE-IDENTICAL for a run against api.shatale.com and a run against a dead
// http://127.0.0.1:9, so the startup log could not tell prod from a hole.
//
// EMPTY was worse. `??` falls back on undefined only, so an empty string travelled into
// `new URL('')`, which throws AT MODULE SCOPE — before any handler exists. The parent sees a raw
// Node stack and a child that dies during the MCP handshake, which arrives as a TIMEOUT rather than
// as a message. That is exactly what a config writing `SHATALE_API_URL: process.env.X ?? ""` would
// produce, and one did (SHAT-2703).
//
// So the value is read once, judged here, and both outcomes are named out loud.
const rawApiUrl = process.env.SHATALE_API_URL
const apiUrlWasGiven = rawApiUrl !== undefined

if (apiUrlWasGiven && rawApiUrl.trim() === '') {
  console.error(
    'ERROR: SHATALE_API_URL is set but EMPTY. An empty value is not "unset": it does not fall back ' +
      'to the default, it is not a URL, and left alone it would crash this process at import time ' +
      'with a Node stack the parent reads as a handshake timeout. Either unset the variable to use ' +
      `https://${CANONICAL_API_HOST}, or give it a URL.`,
  )
  process.exit(1)
}

let apiBaseUrl: URL
try {
  apiBaseUrl = new URL(rawApiUrl ?? `https://${CANONICAL_API_HOST}`)
} catch {
  // The VALUE is not echoed: a URL can carry credentials in its userinfo, and a message that helps
  // debugging by printing them is not a help. Its length is enough to tell a typo from a variable
  // that expanded to something unexpected.
  console.error(
    `ERROR: SHATALE_API_URL is not a URL (${rawApiUrl?.length ?? 0} characters). Expected something ` +
      `like https://${CANONICAL_API_HOST}.`,
  )
  process.exit(1)
}
const host = apiBaseUrl.hostname
const isLoopback = LOOPBACK_HOSTS.includes(host)
const isShataleHost = host === CANONICAL_API_HOST || host.endsWith(SHATALE_SUFFIX)

if (!isLoopback && !isShataleHost) {
  console.error(
    `ERROR: Untrusted API URL: ${host}. Only ${CANONICAL_API_HOST}, *${SHATALE_SUFFIX} and ` +
      `localhost are allowed — this process would otherwise send your API key there.`,
  )
  process.exit(1)
}

// ⚠️ THE SCHEME WAS NEVER CHECKED, AND NOTHING DOCUMENTED THAT. `new URL()` accepts any protocol,
// so SHATALE_API_URL=http://api.shatale.com started normally and sent `Bearer sk_live_*` in
// cleartext — measured against a local recorder. Nothing legitimate needs it: the API is HTTPS, and
// a plaintext bearer token is not a trade-off anyone would choose on purpose.
//
// Loopback is exempt because the test harness serves http://127.0.0.1 and a packet that never
// leaves the machine is not the subject of this rule.
if (!isLoopback && apiBaseUrl.protocol !== 'https:') {
  console.error(
    `ERROR: SHATALE_API_URL uses ${apiBaseUrl.protocol}//. Refusing to send an API key in cleartext ` +
      `— use https:// (loopback is exempt for local development).`,
  )
  process.exit(1)
}

// ⚠️ AND IN LIVE MODE THE WILDCARD IS NOT ENOUGH, because the thing at stake changes.
//
// A sandbox key reaching an unexpected subdomain is a test credential in the wrong place. A LIVE key
// is money and a person's card. Live mode is already a deliberate act — a `sk_live_` key AND
// `SHATALE_MODE=live` — and this makes the third element of that act deliberate too: a live key
// goes to the canonical host unless somebody says otherwise in as many words.
//
// The pattern is this codebase's own (SHATALE_MONEY_GO, ALLOW_DEV_CRYPTO_FALLBACK in the API): the
// absence of a variable must not widen a permission, and a widening must be a thing someone TYPED.
//
// It refuses nothing anyone does today: guest and sandbox keep the wildcard untouched, so pointing
// a sandbox key at sandbox.api.shatale.com or at the test harness is unaffected.
if (isLiveKey && liveIntent && host !== CANONICAL_API_HOST && !isLoopback) {
  if (process.env.SHATALE_ALLOW_NONSTANDARD_LIVE_HOST !== 'true') {
    console.error(
      `ERROR: a LIVE key would be sent to ${host}, which is not ${CANONICAL_API_HOST}.\n` +
        `Any subdomain of shatale.com passes the host allowlist, and a dangling CNAME or a taken-over ` +
        `subdomain is enough to receive Bearer sk_live_* and every purchase body after it.\n` +
        `If this host is genuinely intended, set SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true — so that ` +
        `it is a decision somebody made rather than a default nobody noticed.`,
    )
    process.exit(1)
  }
  console.error(
    `WARNING: sending a LIVE key to ${host} (SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true).`,
  )
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

// SHATALE_CREDENTIAL_EMAILS_ENABLED is gone (SHAT-2527): the condition it named — "#361 merged AND
// deployed" — has been met on both halves, measured. See src/tools/credentials.ts for the probe and
// its control. A flag whose condition is satisfied is a switch nobody looks at again, and the next
// reader takes it for a live decision.
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
    // Demo: request_purchase runs the ordinary path — the server stamps the environment from the
    // key (SHAT-2373), so nothing here reaches live money; the client-side refusal was removed in
    // SHAT-2611. sandbox_simulate_authorization remains the narrower tool, for a policy decision
    // without a purchase. Sandbox lifecycle helpers are live.
    registerModule(createPurchaseTools(client, { isSandbox: true }))
    registerModule(createCredentialTools(client))
    registerModule(createSandboxTools(client))
    // ⚠️ SHAT-2674: THE REASON THIS USED TO BE LIVE-ONLY WAS A PROPERTY THE BACKEND DOES NOT HAVE.
    //
    // The comment said "checkout identity is on the live money path (backend rejects sandbox keys)".
    // Measured 2026-08-27 against api.shatale.com, with the key the deployed Concierge uses:
    //
    //   POST /v1/sandbox/users                     -> 201   (fresh user provisioned)
    //   POST /v1/purchases  amount_cents 2500      -> payment_ready
    //   GET  /v1/purchases/{id}/checkout-identity  -> 200, billing_identity +
    //                                                 merchant_customer_identity
    //
    // Negative control, the same route on a purchase still in onboarding_required: JSON 404
    // "checkout identity not available" — a refusal by BUSINESS STATE, not by key. The server
    // distinguishes "there is no identity yet" from "you may not have it", and it never refuses
    // on the key. What the environment does is ISOLATE (purchases.go: a sandbox key can never read
    // a LIVE purchase's customer), which is not the same as reject.
    //
    // The route is mounted in the ordinary purchases group behind RequireAPIKeyScope only — no
    // SandboxOnly, no live-only middleware (main.go:5448).
    registerModule(createCheckoutTools(client))
    // reveal_card goes wherever the checkout tools go, because it completes the SAME job: the
    // fields of a merchant form. Splitting them by mode would leave an agent able to read the
    // cardholder and not the card — a checkout it can start and cannot finish.
    registerModule(createRevealTools(client))
  } else if (isLive && moneyGo) {
    // Live + explicit money-GO: real purchase/credentials. Without money-GO,
    // live mode is onboarding-only (can drive registration, cannot move money).
    registerModule(createPurchaseTools(client, { isSandbox: false }))
    registerModule(createCredentialTools(client))
    registerModule(createCheckoutTools(client))
    registerModule(createRevealTools(client))
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
npx shatale-mcp-server
\`\`\`

### 4. Who does what
Creating the agent is YOUR step, not the assistant's: you create it yourself in the publisher
console, by hand. That is deliberate — no API key issues an agent, and no tool here can.

Once you have an agent id, ask your AI assistant:
- "Draft a spending policy with a 1000 EUR monthly budget and gambling blocked"
- "Simulate a 150 EUR purchase at Nike Store and read the verdict"
- "Run a few authorizations for agent <your agent id> through the policy engine"

## Key Concepts
- **Agent**: AI entity that can make payments
- **Card**: Virtual card issued to an agent
- **Policy**: Rules governing what an agent can spend on
- **Authorization**: Real-time approve/decline decision based on policy

## Links
- Documentation: https://shatale.com/mcp
- API Reference: https://shatale.com/mcp
- GitHub: https://github.com/Shatale-SASU/shatale-mcp-server`,

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
//
// ⚠️ THESE SOLD A PRODUCT THIS SERVER DOES NOT HAVE — SHAT-2604.
//
// They told the model, in the imperative: "Create a shopping agent with a monthly budget of 1000
// EUR. Block gambling, alcohol, and tobacco categories. Set per-transaction limit to 500 EUR."
// NOTHING HERE CREATES AN AGENT, STORES A POLICY OR BLOCKS A CATEGORY. The union of every tool over
// every mode is 21, and not one of them does any of it: generate_policy_template returns text and
// makes no request at all. (sandbox_create_user creates a sandbox USER and its delegation — it
// still cannot create an AGENT, which is why it has to be GIVEN an agent_id.)
//
// The cost lands on the model, which is the worst place for it. Handed an instruction it cannot
// carry out, it improvises — inventing an agent id, or reporting a limit it never set — and the
// person watching sees a setup that does not exist. The same wording had already been removed from
// smithery.yaml and the README; the surface an MCP client actually reads kept it.
//
// ⚠️ AND THEY WERE NOT MODE-FILTERED, while the tools always have been. A guest with seven tools was
// offered a prompt whose instructions need the sandbox simulator. `modes` fixes that: a prompt is
// offered only where the tools behind it exist.
const prompts = [
  {
    name: 'shopping-policy',
    description: 'Draft a spending policy for shopping and try it against simulated purchases',
    arguments: [{ name: 'budget', description: 'Monthly budget in EUR (default: 1000)', required: false }],
    modes: 'any' as const,
  },
  {
    name: 'travel-policy',
    description: 'Draft a spending policy for travel and try it against simulated bookings',
    arguments: [{ name: 'budget', description: 'Monthly budget in EUR (default: 5000)', required: false }],
    modes: 'any' as const,
  },
  {
    name: 'policy-designer',
    description: 'Design a spending policy for an AI agent, then check it against simulated purchases',
    arguments: [{ name: 'use_case', description: 'What the agent will be used for', required: true }],
    modes: 'any' as const,
  },
  {
    name: 'exercise-the-policy-engine',
    description: 'Run several authorizations through the real policy engine and read each decision',
    // agent_id is REQUIRED because sandbox_simulate_authorization requires it and cannot invent one.
    // Optional here meant the model was invited to make one up.
    arguments: [{ name: 'agent_id', description: 'The agent whose policy to exercise', required: true }],
    modes: 'sandbox' as const,
  },
]

function getPromptMessages(name: string, args: Record<string, string | undefined>) {
  switch (name) {
    case 'shopping-policy':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Draft a spending policy for shopping with a monthly budget of ${args.budget ?? '1000'} EUR, a 500 EUR per-transaction limit, and gambling, alcohol and tobacco blocked. Use generate_policy_template, which also validates it and names the risks. Then run simulate_purchase_flow for sneakers at 150 EUR from Nike Store and read the verdict. Note what this does and does not do: it produces a policy DOCUMENT and a simulated decision. It does not create an agent or store a policy anywhere — no tool here can, and creating the agent is the person's own step in the publisher console.` },
      }]
    case 'travel-policy':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Draft a spending policy for travel with a budget of ${args.budget ?? '5000'} EUR and a 2000 EUR per-transaction limit, allowing airlines (MCC 4511), hotels (MCC 7011), car rental (MCC 7512) and travel agencies (MCC 4722). Use generate_policy_template. Then run simulate_purchase_flow for a 350 EUR British Airways booking and read the verdict. This produces a policy document and a simulated decision; it does not create an agent or store a policy — the agent is created by the person, by hand, in the publisher console.` },
      }]
    case 'policy-designer':
      return [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `I need to design a spending policy for an AI agent that will be used for: ${args.use_case ?? 'general'}. Help me choose: 1) Monthly budget limit 2) Per-transaction limit 3) Which MCC categories to allow or block 4) Minimum balance reserve. Then test the policy with 5 different simulated transactions to verify it works correctly.` },
      }]
    case 'exercise-the-policy-engine':
      return [{
        role: 'user' as const,
        // ⚠️ THE HUMAN-STEP CLAUSE WAS SPLICED INTO THE MIDDLE OF THE INSTRUCTION AND STRANDED
        // "one call each" mid-sentence: "...nothing here can create one for them, one call each,
        // and read the rule explanation...". The fact was right and the sentence was rubble, and
        // this is a PROMPT — the model reads it verbatim as an instruction, so a garbled clause is
        // not a cosmetic defect. The clause now sits at the end, where it qualifies the whole thing.
        content: { type: 'text' as const, text: `Use sandbox_simulate_authorization for agent ${args.agent_id} to run these through the real policy engine, one call each, and read the rule explanation the server returns: 1) 100 EUR retail 2) 2000 EUR electronics 3) 50 EUR at a gambling merchant 4) 30 EUR at a restaurant 5) 500 EUR airline. Each call needs an amount, a currency, a merchant and a test card — 4242… forces approve, 4000…0002 forces decline, a neutral card lets the policy decide. These are side-effect-free: no purchase, no ledger, no money. If you do not have an agent id, ask the person for one — they create agents by hand in the publisher console, and nothing here can create one for them.` },
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
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params
  const handler = allHandlers[name]

  if (!handler) {
    return textResult(`Unknown tool: ${name}`, true)
  }

  // ⚠️ THE PROGRESS TOKEN IS THE CLIENT'S, AND ITS ABSENCE IS INFORMATION (SHAT-2802). A progress
  // notification resets the client's request timeout only if the client asked for progress and
  // enabled `resetTimeoutOnProgress` — both are the host's choice. When no token arrives there is
  // nobody to notify and the SDK's 60s default stands, so a waiting tool must finish inside it
  // rather than assume time it was never granted.
  const progressToken = request.params._meta?.progressToken
  const ctx: ToolContext = {
    hasProgressToken: progressToken !== undefined && progressToken !== null,
    reportProgress: async (message: string) => {
      if (progressToken === undefined || progressToken === null) return
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: 0, message },
      })
    },
  }

  return handler(args ?? {}, ctx)
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
  // ⚠️ FILTERED LIKE THE TOOLS ARE, AND FOR THE SAME REASON. A prompt is an instruction the model
  // will try to carry out; offering one whose tools are absent in this mode does not fail, it makes
  // the model improvise. Guest has seven tools and no simulator, so a prompt needing
  // sandbox_simulate_authorization is not offered there.
  return { prompts: prompts.filter((p) => p.modes === 'any' || (p.modes === 'sandbox' && isSandbox)) }
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
  // ⚠️ THE HOST IS IN THE BANNER, AND THAT IS THE WHOLE POINT OF SHAT-2711. Two runs against
  // different APIs used to print the same line, so the one question an operator asks of a startup
  // log — "where is this thing pointed?" — could not be answered from it. `(default)` marks the
  // case nobody chose: an unset variable is how a process ends up talking to production without
  // anyone deciding that it should.
  const where = apiUrlWasGiven ? apiBaseUrl.origin : `${apiBaseUrl.origin} (default)`
  process.stderr.write(`Shatale MCP server started (${mode} mode, ${toolCount} tools, api=${where})\n`)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
