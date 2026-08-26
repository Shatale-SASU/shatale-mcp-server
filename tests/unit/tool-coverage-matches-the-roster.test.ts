import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '../../src/types.js'
import { createGuestTools } from '../../src/tools/guest.js'
import { createCommonTools } from '../../src/tools/common.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'

// SHAT-2527. tests/tool-coverage.md is hand-maintained, and it has been wrong in both directions:
// first 17 rows against 20 tools while reporting 100%, then three rows added and marked "not
// covered" by hand when all three were covered by five to eight files each.
//
// 🔴 AND THE FIRST VERSION OF THIS GATE HAD THE SAME DISEASE AS THE THING IT GUARDS. Its roster
// came from a text scan: `readdirSync('src/tools')` with NO RECURSION, and a regex that knew only
// SINGLE quotes. Two mutations left it green at 4/4 — a tool declared with double quotes, and a
// tool in a subdirectory. Either one puts a tool OUTSIDE THE COUNT with everything reporting
// success, which is precisely the defect this file exists to make impossible. Before, you had to
// forget a row; after, different quotes were enough.
//
// ⚠️ AND THE COUNT CHECK WAS NOT A SECOND OPINION. "Tools defined in code: 20" was compared to the
// same reader that had undercounted, so both sides moved together and the number stayed consistent
// and wrong. THAT IS AGREEMENT BETWEEN COPIES, NOT VERIFICATION: a check has to cross the boundary
// of the thing it is concluding about.
//
// So there are two derivations here and they share nothing:
//
//   TEXT    — every .ts under src/tools, RECURSIVELY, matching all three quote forms.
//   RUNTIME — every tool factory called and its declarations read. No file layout, no quoting, no
//             regex: what the modules actually produce, which is what index.ts registers.
//
// A disagreement between them is itself a finding, and it fails.

const ROOT = resolve(__dirname, '..', '..')

/** Derivation 1: the source text, recursively, in every quoting style TypeScript allows. */
const rosterFromText = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = resolve(dir, e.name)
      if (e.isDirectory()) return walk(p)
      return e.name.endsWith('.ts') ? [p] : []
    })
  const names = walk(resolve(ROOT, 'src/tools')).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/name:\s*['"`]([a-z0-9_]+)['"`]/g)].map((m) => m[1]),
  )
  return [...new Set(names)].sort()
}

/**
 * Derivation 2: what the modules produce when called.
 *
 * Every factory, with every flag ON, because no single MODE registers all of them — guest is 7,
 * sandbox 15, live-with-money 14. The matrix documents the whole surface, so the union is the right
 * comparison. The client is never used: only declarations are read, and nothing here makes a
 * request.
 */
const rosterFromRuntime = (): string[] => {
  const client = {} as never
  const ctx = {
    isGuest: false,
    isSandbox: true,
    isLive: false,
    moneyEnabled: true,
    getToolNames: () => [] as string[],
  }
  const modules = [
    createGuestTools(ctx),
    createCommonTools(client, ctx),
    createCatalogTools(client),
    createOnboardingTools(client, { enabled: true }),
    createPurchaseTools(client, { isSandbox: true }),
    createCredentialTools(client, { emailsEnabled: true }),
    createCheckoutTools(client),
    createSandboxTools(client),
  ]
  const names = modules.flatMap((m) => (m.tools as ToolDefinition[]).map((t) => t.name))
  return [...new Set(names)].sort()
}

const matrixRows = (): string[] => {
  const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
  // A row of the coverage table: | n | `tool_name` | … — the leading index is what separates a row
  // from the prose above, which quotes tool names on purpose.
  const rows = [...md.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1])
  return [...new Set(rows)].sort()
}

describe('the coverage matrix lists exactly the tools that exist', () => {
  const runtime = rosterFromRuntime()

  // ⚠️ CONTROLS SIT AT THE POPULATION, NOT BELOW IT. The first version asked for `>= 15` against a
  // real 20 — a floor five under the truth, which catches a reader that has died and misses one
  // that has merely gone half-blind. That is the failure mode being fixed, so the control must not
  // share it.
  it('both readers see the whole roster, and agree', () => {
    expect(runtime.length).toBeGreaterThanOrEqual(20)
    expect(rosterFromText()).toEqual(runtime)
    expect(matrixRows().length).toBe(runtime.length)
    expect(runtime).toContain('request_purchase')
  })

  it('no tool is missing a row', () => {
    expect(runtime.filter((t) => !matrixRows().includes(t))).toEqual([])
  })

  it('no row describes a tool that no longer exists', () => {
    expect(matrixRows().filter((t) => !runtime.includes(t))).toEqual([])
  })

  // The summary's number is checked against the RUNTIME roster, not against the text scan that
  // produces it — otherwise the two agree by construction and prove nothing.
  it('the stated tool count matches what the modules register', () => {
    const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
    const stated = /\*\*Tools defined in code\*\*:\s*(\d+)/.exec(md)?.[1]
    expect(stated).toBeDefined()
    expect(Number(stated)).toBe(runtime.length)
  })
})
