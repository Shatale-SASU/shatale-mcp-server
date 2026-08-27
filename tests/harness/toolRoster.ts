// @ts-expect-error — plain ESM shared with scripts/, no types alongside it
import { measureRoster } from '../../scripts/lib/serverRoster.mjs'

/**
 * The tool roster, asked of the RUNNING SERVER over MCP, one process per mode, unioned.
 *
 * ⚠️ IT USED TO BE DERIVED FROM THE SOURCES, AND THAT WAS A BLIND SPOT SHARED WITH ITS OWN SECOND
 * OPINION — SHAT-2527. One derivation scanned the text under src/tools; the other called eight
 * hardcoded factories. A tool declared OUTSIDE that directory was invisible to both, so they
 * AGREED — and two readers sharing a blind spot is the defect they exist to catch, one level up.
 * Measured by an adversarial review: a flag-gated tool in src/storefront.ts shipped with the whole
 * suite green, and the README gate printed "20 tools defined" while 21 existed.
 *
 * Asking the server is the only derivation that CROSSES THE BOUNDARY. It does not care where a file
 * sits, how a name is quoted, or which factory produced it — it reports what an MCP client is
 * offered, which is what every document being checked is about.
 *
 * It spawns six servers, so it is measured once per process and reused. The suite's globalSetup has
 * already refused a stale or partial build by the time this runs, so what it measures is the code
 * under test rather than yesterday's.
 */
type Measured = { union: string[]; advertised: Map<string, string[]>; failures: string[] }

let cached: Measured | null = null

async function measureOnce(): Promise<Measured> {
  if (cached) return cached
  const m = (await measureRoster()) as Measured
  if (m.failures.length) {
    // A mode that advertised nothing is an ERROR, not an empty set: the server failed to start, and
    // an empty list silently shrinks every count computed from it.
    throw new Error(`the server did not advertise its tools:\n  ${m.failures.join('\n  ')}`)
  }
  cached = m
  return m
}

export async function rosterFromRuntime(): Promise<string[]> {
  return [...(await measureOnce()).union].sort()
}

/**
 * The same measurement, kept PER MODE. The union answers "does this tool exist anywhere"; a question
 * about a gate is the opposite one — "which mode is it offered in" — and the union cannot answer it.
 * Same six spawned servers, measured once per process.
 */
export async function rosterByMode(mode: string): Promise<string[]> {
  const { advertised } = await measureOnce()
  const tools = advertised.get(mode)
  if (!tools) throw new Error(`no such mode measured: "${mode}" (have: ${[...advertised.keys()].join(', ')})`)
  return [...tools].sort()
}
