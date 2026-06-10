import type { ToolModule } from '../types.js'
import { textResult } from '../types.js'

/**
 * Runtime context handed to the guest tools so `explain_shatale` can act as a
 * mode-aware orchestrator (SHAT-1460): it reports the current mode and lists
 * the tools actually available in this session instead of a static blurb.
 */
export interface GuestContext {
  isGuest: boolean
  isSandbox: boolean
  /** Lazily evaluated so it reflects every module registered after guest. */
  getToolNames: () => string[]
}

const REGISTER_URL = 'https://admin.shatale.com/register?ref=mcp'
const GUEST_CAP_USD = 1000
const APPROVAL_THRESHOLD_USD = 500
const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF']

// Merchant keywords that map to categories blocked by a sane default policy.
const BLOCKED_KEYWORDS: Array<{ kw: string; mcc: string; label: string }> = [
  { kw: 'casino', mcc: '7995', label: 'Gambling' },
  { kw: 'gambl', mcc: '7995', label: 'Gambling' },
  { kw: 'bet', mcc: '7995', label: 'Gambling' },
  { kw: 'poker', mcc: '7995', label: 'Gambling' },
  { kw: 'alcohol', mcc: '5921', label: 'Alcohol' },
  { kw: 'liquor', mcc: '5921', label: 'Alcohol' },
  { kw: 'tobacco', mcc: '5993', label: 'Tobacco' },
  { kw: 'crypto', mcc: '6051', label: 'Crypto / quasi-cash' },
]

/** Tiny stable hash → short trace ids that are reproducible per input. */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function handleExplainShatale(ctx: GuestContext) {
  const mode = ctx.isGuest ? 'GUEST' : ctx.isSandbox ? 'SANDBOX' : 'PRODUCTION'
  const toolNames = ctx.getToolNames().filter((n) => n !== 'explain_shatale')
  const toolList = toolNames.map((n) => `- \`${n}\``).join('\n')

  const recommendedPrompt =
    'Use Shatale to simulate an AI agent buying a $25 developer tool subscription ' +
    'with a $100 monthly budget. Show the policy check, approval decision, virtual ' +
    'card step, and final timeline.'

  const modeBlock = ctx.isGuest
    ? `## You are in GUEST mode (no API key)
This is a self-serve, interactive demo of the agent payment lifecycle. **No real API
call or payment is made.** You can:
- Explore capabilities and merchant/MCC catalog
- Simulate the full purchase flow (approved / declined / requires-approval)
- Generate and validate a spending policy template

### Recommended first prompt
> ${recommendedPrompt}

### Unlock the same flow in Sandbox
No code changes required. Add a sandbox key and re-run the same prompt:
\`\`\`bash
npx shatale-mcp-server --env SHATALE_API_KEY=sk_sandbox_xxx
\`\`\`
Free sandbox key, no card required: ${REGISTER_URL}`
    : ctx.isSandbox
      ? `## You are in SANDBOX mode (\`sk_sandbox_*\` key)
Real integration dev-mode against Shatale Sandbox APIs with test data — no real money.
Onboarding, sandbox authorization simulation, approval, credential issuance, status and audit are live.
request_purchase is disabled here (use sandbox_simulate_authorization instead).`
      : `## PRODUCTION mode
Production keys (\`sk_live_*\`) are blocked in this MCP server by design.`

  return textResult(`# What is Shatale?

Shatale enables AI agents to make real purchases on the internet — safely and with full control.

**Current mode: ${mode}**

${modeBlock}

## How it works
1. **Publisher** integrates Shatale into their AI agent platform
2. **End user** sets spending policies (budgets, allowed merchants, categories)
3. **AI agent** requests a purchase via the Shatale API
4. **Shatale** validates the request against policies, handles payment, returns confirmation
5. **End user** gets notified and can review/approve purchases

## Tools available in this mode
${toolList}

## Modes
- **GUEST** (no key): explore, simulate, generate policy — no real call or payment
- **SANDBOX** (\`sk_sandbox_*\`): full API with test data, no real money
- **PRODUCTION** (\`sk_live_*\`): blocked in this MCP server by design — a local IDE/agent
  is not a trust boundary for live payment credentials; integrate via your backend

## Production safety note
Live payment credentials are never issued from a local IDE/agent context. That block is a
trust signal, not a limitation — production execution runs through your server-side integration.`)
}

type SimResult = 'approved' | 'declined' | 'requires_approval'

interface PolicyEvaluation {
  result: SimResult
  matched_rules: string[]
  monthly_budget: number
  remaining_budget: number
  reason: string
  blocked_category?: string
}

/**
 * Deterministic guest-mode policy evaluation. Same inputs → same verdict, so the
 * demo is reproducible on stage. Covers the council's required non-happy paths:
 * blocked category, amount over the guest cap, and approval-required.
 */
function evaluatePurchase(merchant: string, amount: number, budget: number): PolicyEvaluation {
  const lc = merchant.toLowerCase()
  const blocked = BLOCKED_KEYWORDS.find((b) => lc.includes(b.kw))

  if (blocked) {
    return {
      result: 'declined',
      matched_rules: [`mcc_block:${blocked.mcc}`],
      monthly_budget: budget,
      remaining_budget: budget,
      reason: `Merchant maps to a blocked category (${blocked.label}, MCC ${blocked.mcc}).`,
      blocked_category: blocked.label,
    }
  }
  if (amount > GUEST_CAP_USD) {
    return {
      result: 'declined',
      matched_rules: ['guest_cap'],
      monthly_budget: budget,
      remaining_budget: budget,
      reason: `Amount ${amount} exceeds the guest demo cap of $${GUEST_CAP_USD}. Use sandbox for larger amounts.`,
    }
  }
  if (amount > budget) {
    return {
      result: 'declined',
      matched_rules: ['spend_limit_check:monthly_budget'],
      monthly_budget: budget,
      remaining_budget: budget,
      reason: `Amount ${amount} exceeds the remaining monthly budget of ${budget}.`,
    }
  }
  if (amount > APPROVAL_THRESHOLD_USD) {
    return {
      result: 'requires_approval',
      matched_rules: [`require_human_approval_above:${APPROVAL_THRESHOLD_USD}`],
      monthly_budget: budget,
      remaining_budget: budget,
      reason: `Amount ${amount} is above the human-approval threshold of $${APPROVAL_THRESHOLD_USD}.`,
    }
  }
  return {
    result: 'approved',
    matched_rules: ['spend_limit_check:pass', 'mcc_allow'],
    monthly_budget: budget,
    remaining_budget: Math.max(0, budget - amount),
    reason: 'Within budget, allowed category, below approval threshold.',
  }
}

function handleSimulatePurchase(args: Record<string, unknown>) {
  const merchant = String(args.merchant ?? 'example.com')
  const amount = Number(args.amount ?? 0)
  const currency = String(args.currency ?? 'USD')
  const description = String(args.description ?? 'a purchase')
  const budget = Number(args.monthly_budget ?? GUEST_CAP_USD)

  const evaluation = evaluatePurchase(merchant, amount, budget)
  const traceId = `demo_trace_${shortHash(`${merchant}|${amount}|${currency}`)}`
  const idempotencyKey = `demo_auto_${shortHash(`${merchant}|${amount}|${currency}|${description}`)}`

  // Build a trace that reflects how far this verdict actually gets.
  const steps: Array<{ step: string; status: string }> = [
    { step: 'request_validation', status: 'ok' },
    {
      step: 'policy_check',
      status:
        evaluation.result === 'declined'
          ? 'declined'
          : evaluation.result === 'requires_approval'
            ? 'requires_approval'
            : 'ok',
    },
  ]
  if (evaluation.result === 'approved') {
    steps.push({ step: 'card_issued', status: 'ok' }, { step: 'payment_completed', status: 'ok' })
  } else if (evaluation.result === 'requires_approval') {
    steps.push({ step: 'card_issued', status: 'pending_human_approval' })
  }

  const summary = {
    mode: 'guest',
    summary: { result: evaluation.result, merchant, amount, currency, description },
    policy_evaluation: {
      matched_rules: evaluation.matched_rules,
      monthly_budget: evaluation.monthly_budget,
      remaining_budget: evaluation.remaining_budget,
      reason: evaluation.reason,
      ...(evaluation.blocked_category ? { blocked_category: evaluation.blocked_category } : {}),
    },
    trace: { trace_id: traceId, steps },
    idempotency_key: idempotencyKey,
    sandbox_equivalent_tools: ['request_purchase', 'get_purchase_status'],
    next_step: {
      label: 'Run the same flow against Shatale Sandbox APIs',
      register_url: REGISTER_URL,
      hint: 'Free sandbox key, no card required. Add SHATALE_API_KEY and re-run the same prompt.',
    },
  }

  const verdictLine =
    evaluation.result === 'approved'
      ? '✅ **APPROVED** — virtual card issued, payment completed (simulated).'
      : evaluation.result === 'requires_approval'
        ? '⏸️ **REQUIRES APPROVAL** — a human must approve before any card is issued.'
        : '⛔ **DECLINED** — no card issued.'

  return textResult(`# Simulated Purchase Flow

> Guest mode — **no real API call or payment is made.** This shows the Shatale agent
> payment lifecycle so you can see it before registering for a sandbox key.

## Request
- **Merchant**: ${merchant}
- **Amount**: ${amount} ${currency}
- **Description**: ${description}
- **Monthly budget**: ${budget} ${currency}

## Decision
${verdictLine}

- **Reason**: ${evaluation.reason}
- **Matched rules**: ${evaluation.matched_rules.join(', ')}
- **Remaining budget**: ${evaluation.remaining_budget} ${currency}
- **Trace**: \`${traceId}\`

## Machine-readable result
\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

## Next step
${summary.next_step.hint}
Register: ${REGISTER_URL}`)
}

function inferCategories(useCase: string): string[] {
  const lc = useCase.toLowerCase()
  if (lc.includes('saas') || lc.includes('software') || lc.includes('subscription')) {
    return ['5734 — Computer Software Stores', '5817 — Digital Goods', '5818 — Digital Goods: Large Seller']
  }
  if (lc.includes('cloud') || lc.includes('infrastructure') || lc.includes('hosting')) {
    return ['4816 — Computer Network Services', '7372 — Computer Programming', '5734 — Computer Software Stores']
  }
  if (lc.includes('office') || lc.includes('supplies')) {
    return ['5111 — Stationery Stores', '5943 — Office Supplies', '5944 — Jewelry & Watch Shops']
  }
  if (lc.includes('travel') || lc.includes('trip')) {
    return ['4511 — Airlines', '7011 — Hotels & Motels', '7512 — Car Rental']
  }
  return ['5411 — Grocery Stores', '5812 — Restaurants', '5999 — Miscellaneous Retail']
}

function handleGeneratePolicy(args: Record<string, unknown>) {
  const useCase = String(args.use_case ?? 'general')
  const budget = Number(args.monthly_budget ?? 1000)
  const categories = (args.allowed_categories as string[] | undefined) ?? inferCategories(useCase)

  const singleMax = Math.round(budget * 0.25)
  const approvalAbove = Math.round(budget * 0.5)
  const merchantsProvided = Array.isArray(args.allowed_categories)

  // SHAT-1462: never hand back a silently unsafe policy. Surface the risk and the
  // controls a publisher should set before going live.
  const warnings: string[] = []
  warnings.push(
    'Merchant allowlist is empty — until you add merchants, an allowlist policy blocks everything.',
  )
  if (budget >= 5000) {
    warnings.push(`Monthly budget (${budget}) is high — verify the approval threshold matches your risk appetite.`)
  }
  if (!merchantsProvided) {
    warnings.push('Allowed categories were inferred from the use case — review them before going live.')
  }
  const riskLevel = budget >= 5000 ? 'high' : budget >= 1500 ? 'medium' : 'low'

  const validation = {
    risk_level: riskLevel,
    warnings,
    recommended_controls: {
      approval_required_above: approvalAbove,
      max_transaction_amount: singleMax,
      blocked_categories: ['7995 — Gambling', '5921 — Alcohol', '5993 — Tobacco', '6051 — Crypto / quasi-cash'],
    },
  }

  return textResult(`# Spending Policy Template

## Use case: ${useCase}

\`\`\`json
{
  "name": "${useCase} policy",
  "version": "1.0",
  "limits": {
    "monthly_budget": ${budget},
    "currency": "USD",
    "single_transaction_max": ${singleMax},
    "daily_transaction_count": 10,
    "daily_amount_max": ${Math.round(budget * 0.5)}
  },
  "allowed_categories": ${JSON.stringify(categories, null, 4)},
  "merchant_rules": {
    "mode": "allowlist",
    "merchants": []
  },
  "approval_rules": {
    "auto_approve_below": ${Math.round(budget * 0.05)},
    "require_human_approval_above": ${approvalAbove},
    "notify_on_every_purchase": true
  },
  "time_restrictions": {
    "allowed_days": ["mon", "tue", "wed", "thu", "fri"],
    "allowed_hours": { "start": "08:00", "end": "20:00", "timezone": "UTC" }
  }
}
\`\`\`

## Validation
\`\`\`json
${JSON.stringify(validation, null, 2)}
\`\`\`

**Risk level: ${riskLevel.toUpperCase()}**
${warnings.map((w) => `- ⚠️ ${w}`).join('\n')}

## Notes
- Adjust \`single_transaction_max\` based on typical purchase sizes
- Start with \`allowlist\` mode and add merchants as needed
- Set \`auto_approve_below\` to a comfortable threshold for hands-off operation
- Review and adjust after the first month of usage`)
}

export function createGuestTools(ctx: GuestContext): ToolModule {
  return {
    tools: [
      {
        name: 'explain_shatale',
        description:
          'Entry point. Reports the current mode (GUEST / SANDBOX / blocked PRODUCTION), the ' +
          'tools available in that mode, the recommended first prompt, and how to unlock the ' +
          'same flow in sandbox. Call this first. No API key required.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'simulate_purchase_flow',
        description:
          'Simulates the Shatale agent payment lifecycle in guest mode: policy check, ' +
          'approval decision (approved / declined / requires_approval), virtual card step and ' +
          'timeline. No real API call or payment is made. Use this before registering for a ' +
          'sandbox key.',
        inputSchema: {
          type: 'object',
          properties: {
            merchant: {
              type: 'string',
              description: 'Merchant name or domain (e.g. "amazon.com")',
            },
            amount: {
              type: 'number',
              exclusiveMinimum: 0,
              description: `Purchase amount (guest demo cap: ${GUEST_CAP_USD})`,
            },
            currency: {
              type: 'string',
              enum: ALLOWED_CURRENCIES,
              description: 'Currency code (e.g. "USD", "EUR")',
            },
            description: {
              type: 'string',
              description: 'What is being purchased',
            },
            monthly_budget: {
              type: 'number',
              exclusiveMinimum: 0,
              description: `Monthly budget to evaluate against (default: ${GUEST_CAP_USD})`,
            },
          },
          required: ['merchant', 'amount', 'description'],
        },
      },
      {
        name: 'generate_policy_template',
        description:
          'Generates a spending policy template for a use case AND validates it: risk level, ' +
          'warnings, and recommended controls (approval threshold, max transaction, blocked ' +
          'categories). Never returns a silently unsafe policy. No API key required.',
        inputSchema: {
          type: 'object',
          properties: {
            use_case: {
              type: 'string',
              description:
                'The use case for the policy (e.g. "SaaS subscriptions", "cloud infrastructure", "office supplies")',
            },
            monthly_budget: {
              type: 'number',
              exclusiveMinimum: 0,
              description: 'Monthly budget limit in USD',
            },
            allowed_categories: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of allowed spending categories',
            },
          },
          required: ['use_case'],
        },
      },
    ],
    handlers: {
      explain_shatale: async () => handleExplainShatale(ctx),
      simulate_purchase_flow: async (args) => handleSimulatePurchase(args),
      generate_policy_template: async (args) => handleGeneratePolicy(args),
    },
  }
}
