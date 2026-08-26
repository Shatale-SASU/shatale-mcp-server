import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// SHAT-2527. tests/tool-coverage.md is hand-maintained, and it has now been wrong in both
// directions.
//
// First it listed 17 rows and reported "Happy path 17/17 (100%)" while the code defined 20 tools —
// the denominator moved and the percentage stayed at 100%, which is the one number a coverage
// document exists to make honest.
//
// 🔴 THEN THE CORRECTION WAS MADE THE SAME WAY AS THE DEFECT. The three missing rows were added and
// marked "not covered here", by hand, without looking. All three are covered, by five to eight test
// files each. A hand-maintained document repaired by hand went wrong the other way — first claiming
// coverage it did not have, then claiming a gap that did not exist. The second is worse in one
// respect: it hides work that is already done, and invites somebody to do it again.
//
// So the table is compared to the roster of record by a machine. Not the ticks — those still say
// what a person believes and are worth reading — but the SET OF ROWS, which is the part that goes
// stale silently and the part a percentage is computed from.
//
// LIMIT, stated so a green run is not read for more than it earns: this proves the table lists
// every tool and no others. It does not prove a ✅ is deserved. Whoever writes a tick still has to
// have looked; what they can no longer do is leave a tool out of the count entirely.

const ROOT = resolve(__dirname, '..', '..')

const roster = (): string[] => {
  const dir = resolve(ROOT, 'src/tools')
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...readFileSync(resolve(dir, f), 'utf8').matchAll(/name: '([a-z0-9_]+)'/g)].map((m) => m[1]))
  return [...new Set(names)].sort()
}

const matrixRows = (): string[] => {
  const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
  // Rows of the coverage table: | n | `tool_name` | ... — the leading index is what distinguishes
  // a row from the prose above, which quotes tool names on purpose.
  const rows = [...md.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1])
  return [...new Set(rows)].sort()
}

describe('the coverage matrix lists exactly the tools that exist', () => {
  // POSITIVE CONTROLS on both readers. Either one going quiet turns "no difference" into "nothing
  // compared" — the failure this whole file is about, one level up.
  it('both sides are readable', () => {
    expect(roster().length).toBeGreaterThanOrEqual(15)
    expect(matrixRows().length).toBeGreaterThanOrEqual(15)
    expect(roster()).toContain('request_purchase')
  })

  it('no tool is missing a row', () => {
    const missing = roster().filter((t) => !matrixRows().includes(t))
    expect(missing).toEqual([])
  })

  it('no row describes a tool that no longer exists', () => {
    const orphan = matrixRows().filter((t) => !roster().includes(t))
    expect(orphan).toEqual([])
  })

  // The summary counts the rows. A count that disagrees with the table is the original defect in
  // its smallest form.
  it('the stated tool count matches the roster', () => {
    const md = readFileSync(resolve(ROOT, 'tests/tool-coverage.md'), 'utf8')
    const stated = /\*\*Tools defined in code\*\*:\s*(\d+)/.exec(md)?.[1]
    expect(stated).toBeDefined()
    expect(Number(stated)).toBe(roster().length)
  })
})
