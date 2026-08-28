import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Directories a filesystem sweep of this repository must not descend into.
 *
 * ⚠️ `.claude` IS THE ONE THAT COST US A CLEAN MAIN, AND IT IS THE REASON THIS LIST LIVES HERE
 * RATHER THAN IN THE ONE TEST THAT LEARNED IT (SHAT-2713). It holds git worktrees — COPIES OF THIS
 * REPOSITORY INSIDE ITSELF. A sweep that descends into one reads a second copy of every file it is
 * checking and counts each forbidden string in its OWN source as a hit: three absence checks went
 * red on a clean main, and not one of the three was true.
 *
 * The instrument measured itself. That is worse than a missed defect, because a guard which reddens
 * without cause teaches people to silence it — and the next red one, the true one, gets silenced
 * with the same reflex.
 *
 * ⚠️ AND AN EXCLUSION LIVING IN ONE FILE PROTECTS ONE FILE. The next person to write a sweep will
 * write the four obvious names (node_modules, dist, .git, coverage) — they are the ones everybody
 * knows — and will not think of a directory that holds checkouts, because nothing told them it
 * exists. That is why this is exported, named, and explained where it will be imported from.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.claude',
])

/**
 * Every file under `root` whose name matches `keep`, skipping SKIP_DIRS.
 *
 * Paths come back RELATIVE to root, so a caller's assertions read the same whoever checked the
 * repository out and wherever.
 */
export function walkRepoFiles(root: string, keep: (name: string) => boolean): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(resolve(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child)
        continue
      }
      if (keep(entry.name)) out.push(child)
    }
  }
  walk('')
  return out.sort()
}
