import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

/**
 * SHAT-3520 — adding a transport must not tax the one that was already there.
 *
 * 🔴 THIS GUARD EXISTS BECAUSE THE REGRESSION ALREADY HAPPENED, and it was found by accident. When
 * the HTTP endpoint was first imported at the top of `index.ts`, every stdio launch loaded the SDK's
 * streamable-HTTP transport, `node:http` and `node:crypto` — on a path that never speaks HTTP, which
 * is every Claude Desktop and Cursor session in existence. Measured: cold start went 0.16-0.25s to
 * 0.24-0.43s.
 *
 * ⚠️ NOBODY WOULD HAVE NOTICED IT AS A SLOWDOWN. It surfaced as the ROSTER GATE going red — that
 * harness gives a spawned server 1200ms to print its banner, six per file under parallel workers,
 * and the margin it had been living inside was quietly spent. The failure moved between files from
 * run to run, which reads as flakiness rather than as a cost somebody added.
 *
 * ⚠️ IT WALKS THE MODULE GRAPH RATHER THAN GREPPING FOR A NAME. A substring search would pass the
 * moment the import moved one file deeper — and one file deeper is exactly where it would go, since
 * the endpoint is reached through a module of ours. Static `import` in ESM is a top-level statement,
 * so the graph it forms can be read exactly; `await import()` is not part of it, which is the whole
 * distinction under test.
 */

const DIST = resolve(import.meta.dirname, '../../dist')

/** Top-level STATIC import specifiers of one built module. Dynamic `import(...)` is not one. */
function staticImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  // `import ... from 'x'`, `import 'x'`, `export ... from 'x'` — all static, all top-level.
  const re = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2]) as string)
  return out
}

/** Everything reachable from `entry` through STATIC imports, following our own files. */
function staticGraph(entry: string): { ours: string[]; external: Set<string> } {
  const seen = new Set<string>()
  const external = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of staticImports(file)) {
      if (!spec.startsWith('.')) {
        external.add(spec)
        continue
      }
      const next = resolve(dirname(file), spec)
      if (existsSync(next)) queue.push(next)
    }
  }
  return { ours: [...seen], external }
}

describe('the stdio path does not pay for a transport it never speaks', () => {
  test('the built entry point exists (otherwise everything below passes by measuring nothing)', () => {
    expect(existsSync(join(DIST, 'index.js'))).toBe(true)
  })

  test('nothing reachable by static import from the entry pulls the HTTP transport', () => {
    const { ours, external } = staticGraph(join(DIST, 'index.js'))

    // A floor: an entry that resolved to nothing would report a clean graph for the wrong reason.
    expect(ours.length).toBeGreaterThan(1)
    expect(external.size).toBeGreaterThan(1)

    const httpish = [...external].filter(
      (s) => s.includes('streamableHttp') || s === 'node:http' || s === 'node:https',
    )
    const ourHttp = ours.filter((f) => f.endsWith('http-transport.js'))

    expect({ httpish, ourHttp }).toEqual({ httpish: [], ourHttp: [] })
  })

  // The control in the other direction: the endpoint must still be REACHABLE, or the guard above
  // would be satisfied by deleting the feature.
  test('the HTTP transport is still shipped, and reached by a dynamic import', () => {
    expect(existsSync(join(DIST, 'http-transport.js'))).toBe(true)
    const entry = readFileSync(join(DIST, 'index.js'), 'utf8')
    expect(entry).toMatch(/await import\(\s*['"]\.\/http-transport\.js['"]\s*\)/)
  })

  // And the transport CHOICE is still made statically — it has to be, it decides which path runs.
  test('the transport choice is reached statically, from a module with no heavy imports', () => {
    const { ours } = staticGraph(join(DIST, 'index.js'))
    expect(ours.some((f) => f.endsWith('transport-choice.js'))).toBe(true)
    const choiceDeps = staticImports(join(DIST, 'transport-choice.js'))
    expect(choiceDeps).toEqual([])
  })
})
