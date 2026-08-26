import { readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'

/**
 * ⚠️ THE SUITE CERTIFIED A BUILD THAT DID NOT CONTAIN THE CODE UNDER TEST — SHAT-2527.
 *
 * Several suites drive the COMPILED server. `requireBuiltServer` checked that dist/index.js exists,
 * and existence is not the property that matters. Measured, on this repository:
 *
 *   - Delete the live-key refusal from src/index.ts, do NOT rebuild, run `npx vitest run`:
 *     215 passed, 0 failed. Rebuild the same source: 3 failed. THE GREEN WAS STALENESS.
 *   - Build, then remove dist/tools/: index.js is still there, the existence check passes, and the
 *     suites report failed ASSERTIONS about a server that never started.
 *
 * A security guard could therefore be deleted and the suite would certify the result. That is the
 * worst form of the thing this whole sweep is about: not a check that fails to run, but one that
 * RUNS AND AGREES about the wrong artifact.
 *
 * So the precondition is freshness and completeness, not existence: every TypeScript source must
 * have a compiled counterpart, and that counterpart must be newer than it. Refused before any suite
 * is allowed to make a claim, because a refusal here is "nothing was measured" and must never look
 * like "the code is wrong".
 */
export function requireFreshBuild(root: string): void {
  const srcDir = resolve(root, 'src')
  const distDir = resolve(root, 'dist')

  if (!existsSync(join(distDir, 'index.js'))) {
    throw new Error(
      `the built server is missing at ${join(distDir, 'index.js')}. These suites drive the compiled ` +
        `output, not the sources, so nothing has been measured. Run \`npm run build\` (or \`npm test\`, ` +
        `which builds first). This is a missing precondition, not a failing assertion.`,
    )
  }

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : []
    })

  const missing: string[] = []
  const stale: string[] = []
  for (const src of walk(srcDir)) {
    const out = join(distDir, relative(srcDir, src).replace(/\.ts$/, '.js'))
    if (!existsSync(out)) {
      missing.push(relative(root, src))
      continue
    }
    if (statSync(out).mtimeMs < statSync(src).mtimeMs) stale.push(relative(root, src))
  }

  if (missing.length || stale.length) {
    throw new Error(
      `the build does not match the sources, so these suites would be measuring something else.\n` +
        (missing.length ? `  never compiled: ${missing.join(', ')}\n` : '') +
        (stale.length ? `  compiled from an older source: ${stale.join(', ')}\n` : '') +
        `Run \`npm run build\`. MEASURED once on this repository: deleting the live-key refusal from ` +
        `src/index.ts without rebuilding left the whole suite green at 215 passed, and rebuilding the ` +
        `same source turned three security assertions red. Nothing below this line is evidence until ` +
        `the build matches.`,
    )
  }
}

/** vitest globalSetup: one gate for every suite, so a spawner cannot forget to ask. */
export default function setup(): void {
  requireFreshBuild(resolve(import.meta.dirname, '..', '..'))
}
