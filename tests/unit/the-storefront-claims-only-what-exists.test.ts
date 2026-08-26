import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rosterFromRuntime } from '../harness/toolRoster.js'

// SHAT-2604. smithery.yaml is the listing people read on the registry before they install anything,
// and it was checked by nothing.
//
// The README beside it is defended: its tool matrix is generated from the running server and its
// counts carry markers that are verified. The storefront — the file with the widest audience — had
// no check at all, and it showed: its headline offered "Create agents, issue virtual cards, set
// spending policies" when no tool creates an agent, no tool returns a card number (the same file
// says so ten lines lower), and the policy tool generates a template rather than setting anything.
//
// ⚠️ AN ALLOWLIST, NOT A DENYLIST, AND THE DIFFERENCE IS THE WHOLE DESIGN. A list of forbidden
// phrases only catches the lie somebody already told. Here every unit of the description must be
// DECLARED — either as a claim, naming the tools that make it true, or as framing that promises
// nothing executable. An unrecognised unit fails, so the next capability invented in marketing
// cannot arrive quietly.
//
// The unit is a paragraph or bullet, unwrapped. Re-flowing the text must not fail the test;
// changing what it says must.

const ROOT = resolve(__dirname, '..', '..')

/** Paragraphs and bullets of the YAML block scalar, with line wrapping undone. */
function descriptionUnits(): string[] {
  const y = readFileSync(resolve(ROOT, 'smithery.yaml'), 'utf8')
  const block = /^description: \|\n([\s\S]*?)\n(?=[a-z_]+:)/m.exec(y)
  if (!block) throw new Error('smithery.yaml has no `description: |` block — this test read nothing')
  const units: string[] = []
  for (const raw of block[1].split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ')
    if (!line) {
      units.push('')
      continue
    }
    const startsUnit = line.startsWith('- ') || units.length === 0 || units[units.length - 1] === ''
    if (startsUnit) units.push(line)
    else units[units.length - 1] += ' ' + line
  }
  return units.filter(Boolean)
}

/**
 * Every unit, declared. `tools` names what makes the claim true; an empty array means the unit
 * claims nothing executable and `why` says what it is doing there instead.
 */
const DECLARED: { unit: string; tools: string[]; why: string }[] = [
  {
    unit:
      'Give your AI agents the ability to spend money within delegated budgets and policy controls. ' +
      'Request purchases, generate and validate spending policies, and simulate authorisations — all from your IDE.',
    tools: ['request_purchase', 'generate_policy_template', 'sandbox_simulate_authorization'],
    why: 'the headline. Each verb names a tool that exists — this is the line that offered "create agents" and "issue virtual cards" until SHAT-2527',
  },
  { unit: 'Features:', tools: [], why: 'a heading' },
  {
    unit: '- Guest mode (no signup): simulated purchase flow, policy templates, merchant/MCC catalog',
    tools: ['simulate_purchase_flow', 'generate_policy_template', 'search_merchants', 'list_mcc_codes'],
    why: 'the guest roster, item by item',
  },
  {
    unit:
      '- Sandbox mode (free API key): the full lifecycle against sandbox data — onboarding, ' +
      'authorization simulation, approval, credentials, status and audit',
    tools: [
      'sandbox_complete_onboarding',
      'sandbox_simulate_authorization',
      'sandbox_approve_purchase',
      'request_temporary_credentials',
      'get_purchase_status',
    ],
    why: 'the sandbox lifecycle, item by item',
  },
  {
    unit: '- Policy engine: spend limits, MCC blocking, balance checks',
    tools: ['generate_policy_template'],
    why: 'describes what the SERVER-SIDE policy engine enforces, which this client can generate and validate templates for. Not a claim that a tool sets a limit — the wording says "engine", not "set"',
  },
  {
    unit: '- Works with Claude Desktop, Cursor, Windsurf, Claude Code',
    tools: [],
    why: 'names MCP hosts, not capabilities of this server',
  },
  {
    unit:
      "No card number or CVV is ever returned into the agent's context. Live mode exists and moves " +
      'real money, behind three separate deliberate acts (a live key, SHATALE_MODE=live, and a ' +
      'SHA-256-matched SHATALE_MONEY_GO); with a sandbox key none of it is reachable.',
    tools: [],
    why: 'states a limit and a refusal, not a capability. Its truth is guarded by tests/unit/no-tool-result-carries-a-card and tests/unit/money-gate',
  },
]

describe('the storefront claims only what the server can do', () => {
  const units = descriptionUnits()
  const roster = rosterFromRuntime()

  // POSITIVE CONTROLS on both readers. A description that failed to parse, or a roster that came
  // back empty, would make every assertion below pass over nothing.
  it('both sides were read', () => {
    expect(units.length).toBeGreaterThanOrEqual(5)
    expect(roster.length).toBeGreaterThanOrEqual(20)
    expect(units.join(' ')).toContain('Shatale' in {} ? '' : 'AI agents')
  })

  // THE ALLOWLIST. An unrecognised unit is a refusal, not a pass.
  it('every unit of the description is declared', () => {
    const declared = new Set(DECLARED.map((d) => d.unit))
    const undeclared = units.filter((u) => !declared.has(u))
    expect(undeclared).toEqual([])
  })

  // And the table cannot rot: an entry describing text that is no longer there is a decision about
  // nothing, and it hides the next real one behind a name that means nothing.
  it('every declaration describes text that is still in the file', () => {
    const present = new Set(units)
    expect(DECLARED.filter((d) => !present.has(d.unit)).map((d) => d.unit)).toEqual([])
  })

  // The point of the whole file: a named capability must resolve to a tool that exists.
  it('every tool a claim rests on is one the server registers', () => {
    const missing = DECLARED.flatMap((d) => d.tools.filter((t) => !roster.includes(t)).map((t) => `${t} (claimed by: ${d.unit.slice(0, 40)}…)`))
    expect(missing).toEqual([])
  })

  // A claim with no tools behind it must say what it is doing instead — that is what stops
  // `tools: []` becoming the quiet way to add a capability nobody has to justify.
  //
  // ⚠️ THE FIRST VERSION MEASURED THE LENGTH OF THE REASON, AND CAUGHT A CORRECT ENTRY. "a heading"
  // is nine characters and says everything there is to say about `Features:`. A length threshold is
  // a STAND-IN for "did somebody think about this", and enforcing a stand-in means refusing work
  // that is right — the same mistake as a guard that recognises correctness by spelling. The harm
  // is an ABSENT reason, so absence is what is checked.
  it('a unit that names no tool gives a reason', () => {
    const unexplained = DECLARED.filter((d) => d.tools.length === 0 && d.why.trim() === '')
    expect(unexplained.map((d) => d.unit)).toEqual([])
  })
})
