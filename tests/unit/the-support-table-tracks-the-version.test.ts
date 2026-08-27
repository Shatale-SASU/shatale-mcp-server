import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// SHAT-2527. SECURITY.md's supported-versions table is the one version claim in this repository's
// prose that is a PROPERTY rather than a fact on a date.
//
// Every other version in the docs names a release that had a defect or changed a behaviour — "since
// v0.4 a live key IS accepted", "0.2.1 and 0.5.0 both shipped green". Those stay true forever and
// need no maintenance. This table does not: it says which versions get security fixes, and it is
// wrong the moment the package moves.
//
// ⚠️ IT HAS ALREADY BEEN WRONG ONCE, IN THE WORST DIRECTION. It said "0.2.x" while the published
// package was 0.5.2 — so the security policy told every reporter that the version everybody is
// running is unsupported. Corrected under SHAT-2526, with a note added beside it: "If you bump the
// package version, bump this row in the same commit."
//
// That note is an INSTRUCTION, and an instruction is executed by whoever remembers it. The same
// sentence, enforced, costs nothing and cannot be forgotten — which matters more than usual right
// now, because a 1.0.0 release is one owner reply away and would leave the table naming 0.5.x.

const ROOT = resolve(__dirname, '..', '..')

describe('the security policy supports the version we actually publish', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }
  const security = readFileSync(resolve(ROOT, 'SECURITY.md'), 'utf8')
  const [major, minor] = pkg.version.split('.')

  // POSITIVE CONTROLS. A version that failed to parse, or a file read from the wrong path, would
  // make the assertions below pass over nothing.
  it('both sides were read', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(security).toMatch(/\|\s*Version\s*\|\s*Supported\s*\|/)
  })

  it('the published line is marked supported', () => {
    const rows = [...security.matchAll(/^\|\s*([^|]+?)\s*\|\s*(Yes|No)\s*\|/gm)].map((m) => [m[1], m[2]])
    const supported = rows.filter(([, verdict]) => verdict === 'Yes').map(([range]) => range)
    // The row may be written as "0.5.x" or "1.0.x" — what matters is that it names the published
    // major.minor, not that it uses one particular spelling.
    expect(supported.some((r) => r.startsWith(`${major}.${minor}`))).toBe(true)
  })

  it('and nothing at or above the published line is marked unsupported', () => {
    const unsupported = [...security.matchAll(/^\|\s*<\s*(\d+)\.(\d+)\s*\|\s*No\s*\|/gm)]
    // A "< X.Y | No" row must cut BELOW what we publish. Saying "< 1.0 | No" while publishing 0.5.2
    // is the exact defect this file already suffered, in the direction that tells a reporter their
    // version is abandoned.
    for (const [, cutMajor, cutMinor] of unsupported) {
      const cut = Number(cutMajor) * 1000 + Number(cutMinor)
      const published = Number(major) * 1000 + Number(minor)
      expect(cut).toBeLessThanOrEqual(published)
    }
  })
})
