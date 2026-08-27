import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { rosterFromRuntime } from '../harness/toolRoster.js'

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
//   RUNTIME — the BUILT SERVER asked over MCP, one process per mode, unioned. Not the factories:
//             an adversarial review showed that calling factories misses a tool registered
//             elsewhere, and misses a factory moved behind a flag. Only the server crosses the
//             boundary of what this file concludes about.
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

// Derivation 2 — what the modules produce when called — lives in tests/harness/toolRoster.ts,
// because the storefront gate needs the same roster and a second copy is how the first goes stale.

const matrixRows = (): string[] => {
  const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
  // A row of the coverage table: | n | `tool_name` | … — the leading index is what separates a row
  // from the prose above, which quotes tool names on purpose.
  const rows = [...md.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1])
  return [...new Set(rows)].sort()
}

describe('the coverage matrix lists exactly the tools that exist', async () => {
  const runtime = await rosterFromRuntime()

  // ⚠️ CONTROLS SIT AT THE POPULATION, NOT BELOW IT. The first version asked for `>= 15` against a
  // real 20 — a floor five under the truth, which catches a reader that has died and misses one
  // that has merely gone half-blind. That is the failure mode being fixed, so the control must not
  // share it.
  it('both readers see the whole roster, and agree', () => {
    // 21 as of SHAT-2698. This floor had been left at 20 when the roster moved to 21 — one under
    // the population, which is the exact drift the paragraph above condemns, reappearing in the
    // line that paragraph is attached to.
    expect(runtime.length).toBeGreaterThanOrEqual(21)
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

  // ⚠️ AND THE ROW COUNT WAS THE ONLY NUMBER GUARDED, SO EVERY OTHER NUMBER IN THE DOCUMENT DRIFTED
  // UNDERNEATH IT.
  //
  // Measured on this file before this test existed: the table had 21 rows with 11 ✅ in the Contract
  // column and 4 in Security, while the summary three lines below said "Contract (Zod): 6/20" and
  // "Security edge cases: 1/20". Both denominators were a release behind AND both numerators were
  // wrong by five and by three — the row-count gate above was green throughout, because a row count
  // is not a coverage number.
  //
  // ⚠️ WHICH IS THE DOCUMENT'S OWN STATED DEFECT, RECURRING. The banner at the top of
  // tool-coverage.md exists because it once "reported 17/17 (100%)" against a roster of 20: a
  // fraction that agrees with nothing is exactly what a coverage document is for, and it is the one
  // thing nothing checked. Half-fixing it — moving the denominator to 21 and leaving the numerator
  // at 6 — would have produced a line that is still false and now looks freshly maintained, which is
  // worse than an obviously stale one.
  //
  // So the fractions are derived from the table's own columns, and the denominators from the RUNTIME
  // roster. A ✅ added or removed moves the numerator here on the next run; a tool added moves every
  // denominator at once.
  const COLUMNS = ['Happy Path', 'Validation', 'Contract', 'Security'] as const

  /** Every data row, split into its four verdict cells. */
  const matrixCells = (): string[][] => {
    const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
    return [...md.matchAll(/^\|\s*\d+\s*\|\s*`[a-z0-9_]+`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/gm)]
      .map((m) => [m[1], m[2], m[3], m[4]])
  }

  const tickedIn = (column: number): number =>
    matrixCells().filter((cells) => cells[column].includes('✅')).length

  const summaryFraction = (label: string): { n: number; d: number } => {
    const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
    const m = new RegExp(`\\*\\*${label}\\*\\*:\\s*(\\d+)/(\\d+)`).exec(md)
    if (!m) throw new Error(`the summary line "${label}" is gone or no longer states a fraction`)
    return { n: Number(m[1]), d: Number(m[2]) }
  }

  it('the table has one verdict row per tool, so the columns can be counted at all', () => {
    // The control for everything below: if this regex stops matching rows, every count becomes 0
    // and the assertions would be comparing zeroes.
    expect(matrixCells().length).toBe(runtime.length)
  })

  // ⚠️ THE ONE TABLE IN THIS DOCUMENT THAT STILL HAD NO WATCHER, AND IT HAD DRIFTED FURTHEST.
  //
  // The "Test Files" table records a test count per e2e file. Measured against a run: it said
  // guest-mode 9 against 16, security 16 against 18, mock-contract 8 against 14, and three e2e
  // files had no row at all. Every OTHER number in this document is now derived; leaving this one
  // hand-written under a banner reading "a hand-written list silently excludes everything added
  // after it" is the document arguing against itself.
  //
  // ⚠️ COUNTED STATICALLY, AND THE LIMIT OF THAT IS STATED RATHER THAN HIDDEN. Running vitest
  // inside vitest to get the true number is not worth what it costs, so this counts `test(`/`it(`
  // declarations in the source. That is exact for every file here today (verified against a
  // `--reporter=json` run: all ten agree), and it would UNDERCOUNT a file that generates cases in
  // a loop, the way tests/unit/ids-never-reach-the-api-unvalidated.test.ts does. If that ever
  // happens to an e2e file this goes red — which is the correct outcome: the number in the
  // document would have stopped meaning what the column header says.
  const E2E_DIR = resolve(ROOT, 'tests/e2e')

  const declaredTestsIn = (file: string): number =>
    [...readFileSync(resolve(E2E_DIR, file), 'utf8').matchAll(/^\s*(?:test|it)\(/gm)].length

  const fileRows = (): Array<{ file: string; stated: number }> => {
    const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
    return [...md.matchAll(/^\|\s*`([a-z0-9-]+\.test\.ts)`\s*\|\s*(\d+)\s*\|/gm)]
      .map((m) => ({ file: m[1], stated: Number(m[2]) }))
  }

  it('the Test Files table lists every e2e file, with the count a run produces', () => {
    const rows = fileRows()
    // Control: a regex that stopped matching would make the loop below assert nothing.
    expect(rows.length, 'no rows parsed out of the Test Files table').toBeGreaterThanOrEqual(10)

    const onDisk = readdirSync(E2E_DIR).filter((f) => f.endsWith('.test.ts')).sort()
    expect(
      rows.map((r) => r.file).sort(),
      'the Test Files table and tests/e2e disagree about which files exist. A file with no row is ' +
        'the exact omission this document was already corrected for once.',
    ).toEqual(onDisk)

    for (const { file, stated } of rows) {
      expect(
        stated,
        `${file}: the table says ${stated} tests, the file declares ${declaredTestsIn(file)}.`,
      ).toBe(declaredTestsIn(file))
    }
  })

  for (const [column, label] of [
    [0, 'Happy path'],
    [1, 'Input validation'],
    [2, 'Contract \\(Zod\\)'],
    [3, 'Security edge cases'],
  ] as const) {
    it(`the "${label.replace('\\(', '(').replace('\\)', ')')}" summary matches the ${COLUMNS[column]} column`, () => {
      const { n, d } = summaryFraction(label)
      expect(
        d,
        `the denominator is ${d} but the server registers ${runtime.length} tools. A coverage ` +
          `fraction over a stale roster overstates coverage silently — the percentage moves the ` +
          `right way while the population underneath it grows.`,
      ).toBe(runtime.length)
      expect(
        n,
        `the summary claims ${n} but the ${COLUMNS[column]} column has ${tickedIn(column)} ticks. ` +
          `Update the summary from the table, not from memory.`,
      ).toBe(tickedIn(column))
    })
  }
})
