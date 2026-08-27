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

describe('the storefront claims only what the server can do', async () => {
  const units = descriptionUnits()
  const roster = await rosterFromRuntime()

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

// ⚠️ THE SAME RULE, ON THE SURFACE AN MCP CLIENT ACTUALLY READS — SHAT-2604.
//
// The listing was fixed and the README was fixed, and the PROMPTS went on saying "Create a shopping
// agent … Block gambling, alcohol, and tobacco categories. Set per-transaction limit to 500 EUR."
// No tool creates an agent, stores a policy or blocks a category.
//
// A false claim in a listing misleads a person, who can go and look. A false claim in a PROMPT is
// handed to a MODEL as an instruction, and a model that cannot carry one out improvises: it invents
// an agent id, or reports a limit it never set. The person watching sees a setup that does not
// exist. So this surface deserves the stricter treatment, not the looser one.
//
// Same allowlist as the listing above: every prompt must be declared, naming the tools its text
// tells the model to use.
const PROMPTS_DECLARED: { name: string; tools: string[]; why: string }[] = [
  {
    name: 'shopping-policy',
    tools: ['generate_policy_template', 'simulate_purchase_flow'],
    why: 'drafts a policy document and simulates one purchase against it',
  },
  {
    name: 'travel-policy',
    tools: ['generate_policy_template', 'simulate_purchase_flow'],
    why: 'the same, for travel MCCs',
  },
  {
    name: 'policy-designer',
    tools: ['generate_policy_template', 'simulate_purchase_flow'],
    why: 'chooses limits and categories for a use case, then exercises them',
  },
  {
    name: 'exercise-the-policy-engine',
    tools: ['sandbox_simulate_authorization'],
    why: 'runs authorizations through the real engine; sandbox-only, and the filter enforces that',
  },
]

describe('the prompts instruct the model in things the tools can do', () => {
  const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8')
  const promptNames = (() => {
    const block = src.slice(src.indexOf('const prompts = ['), src.indexOf('function getPromptMessages'))
    // ⚠️ ANCHORED TO A PROMPT'S OWN LINE, because ARGUMENTS carry `name:` too. The first version
    // matched the substring and returned budget, budget, use_case, agent_id alongside the four real
    // names — form-blindness again, caught by this test failing rather than by reading it.
    return [...block.matchAll(/^ {4}name: '([a-z0-9-]+)',$/gm)].map((m) => m[1])
  })()

  // POSITIVE CONTROL: a block that failed to parse would make every assertion below vacuous.
  it('the prompts were read', () => {
    expect(promptNames.length).toBeGreaterThanOrEqual(4)
    expect(promptNames).toContain('policy-designer')
  })

  it('every prompt is declared', () => {
    const declared = new Set(PROMPTS_DECLARED.map((d) => d.name))
    expect(promptNames.filter((n) => !declared.has(n))).toEqual([])
  })

  it('no declaration describes a prompt that is gone', () => {
    expect(PROMPTS_DECLARED.filter((d) => !promptNames.includes(d.name)).map((d) => d.name)).toEqual([])
  })

  // await, because rosterFromRuntime became async after this test was written (it now measures the
  // booted server per mode). Without it, `roster` is a Promise and `.includes` throws — which is how
  // this test announced that the code around it had moved while it sat in a dead branch.
  it('every tool a prompt rests on is one the server registers', async () => {
    const roster = await rosterFromRuntime()
    const missing = PROMPTS_DECLARED.flatMap((d) => d.tools.filter((t) => !roster.includes(t)).map((t) => `${t} (in prompt: ${d.name})`))
    expect(missing).toEqual([])
  })

  // ⚠️ THE WORDS THAT NAMED THE DEFECT. These are the imperatives no tool can carry out, and their
  // return would be the whole thing coming back — checked in the prompt TEXT, where the model reads
  // them, and with comments stripped so the note above explaining the removal does not trip it.
  it('no prompt tells the model to create an agent or set a limit', () => {
    const promptSource = src.slice(src.indexOf('const prompts = ['), src.indexOf('// Create server'))
    const code = promptSource.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/Create a (shopping|travel) agent/i)
    expect(code).not.toMatch(/Set per-transaction limit/i)
    expect(code).not.toMatch(/Block gambling, alcohol/i)
  })

  // ⚠️ ADDED ON RESTORATION, AND IT COULD NOT HAVE BEEN IN THE ORIGINAL. This work merged into a
  // dead branch yesterday and was rebuilt today, and in between the owner settled what had been an
  // open question: creating an agent is a HUMAN step, done by hand in the publisher console. So it
  // is no longer enough for the prompts to stop ordering the model to create one — silence would
  // leave the model to guess where an agent comes from, and a guessing model invents an id.
  //
  // Wherever the surface mentions an agent it must say WHOSE step it is. Checked over the prompt
  // texts and the quickstart resource together, because a reader meets whichever comes first.
  it('where an agent is mentioned, the surface says a person creates it', () => {
    const surface = src.slice(src.indexOf('const prompts = ['), src.indexOf('// Create server'))
    const code = surface.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

    const mentionsAgent = code.match(/does not create an agent|agent id|agent \$\{args\.agent_id\}/gi) ?? []
    expect(mentionsAgent.length, 'the prompts stopped mentioning agents at all — this check now asserts nothing').toBeGreaterThan(0)
    expect(code).toMatch(/publisher console/)

    // And the quickstart, which is the first thing a new reader opens.
    const quickstart = src.slice(src.indexOf('### 4.'), src.indexOf('## Key Concepts'))
    expect(quickstart, 'the quickstart must name the human step, not hide it').toMatch(/YOUR step|by hand/)
    expect(quickstart).not.toMatch(/Create a shopping agent/i)
  })

  // The mode filter is the difference between "not offered" and "offered and unusable".
  it('a prompt needing sandbox tools is not offered in guest mode', () => {
    expect(src).toMatch(/prompts\.filter\(\(p\) => p\.modes === 'any' \|\| \(p\.modes === 'sandbox' && isSandbox\)\)/)
    const block = src.slice(src.indexOf('const prompts = ['), src.indexOf('function getPromptMessages'))
    const sandboxOnly = block.slice(block.indexOf("name: 'exercise-the-policy-engine'"))
    expect(sandboxOnly).toMatch(/modes: 'sandbox'/)
  })
})

