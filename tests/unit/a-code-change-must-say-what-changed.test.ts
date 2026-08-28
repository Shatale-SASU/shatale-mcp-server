import { describe, test, expect } from 'vitest'
// @ts-expect-error — plain .mjs script, no types, deliberately shared rather than reimplemented here.
import { verdict } from '../../scripts/a-code-change-must-say-what-changed.mjs'

// The controls for the changelog guard.
//
// ⚠️ A GUARD GOING GREEN PROVES IT RUNS. Only a planted case proves it DISCRIMINATES. That is the
// discipline the README gate's controls already follow in this repository, and it is what separated
// a real check from a decorative one an hour ago: the publish guard from #57 was verified by
// constructing a tag on a side branch and watching it be REFUSED, not by watching a legitimate
// release pass.
//
// So this file feeds the decision synthetic file lists and requires the right answer in BOTH
// directions. It imports the same function the CI step runs — a reimplementation here would test my
// belief about the rule rather than the rule.

describe('a code change must say what changed', () => {
  test('shipped code without a changelog entry is REFUSED', () => {
    const v = verdict(['src/tools/checkout.ts'])
    expect(v.ok).toBe(false)
    expect(v.shipped).toEqual(['src/tools/checkout.ts'])
  })

  test('shipped code WITH a changelog entry passes', () => {
    const v = verdict(['src/tools/checkout.ts', 'CHANGELOG.md'])
    expect(v.ok).toBe(true)
  })

  // ⚠️ THE HALF THAT KEEPS THE GUARD ALIVE. A check that also fired on tests, scripts, workflows or
  // the README would be red on most pull requests here, and a check that cries on ordinary work gets
  // switched off — correctly, by somebody with a deadline. These cases are the scope, and they are
  // asserted so that widening it later is a deliberate act rather than a quiet one.
  test('a change that ships nothing passes without a changelog entry', () => {
    for (const files of [
      ['tests/unit/something.test.ts'],
      ['scripts/readme-tools-gate.mjs'],
      ['.github/workflows/ci-public.yml'],
      ['README.md'],
      ['package-lock.json'],
      ['tests/unit/a.test.ts', 'scripts/b.mjs', 'docs/c.md'],
    ]) {
      expect(verdict(files).ok, `${files.join(', ')} should not require a changelog entry`).toBe(true)
    }
  })

  test('one shipped file among many unshipped ones still requires the entry', () => {
    const v = verdict(['tests/unit/a.test.ts', 'README.md', 'src/client.ts'])
    expect(v.ok).toBe(false)
    expect(v.shipped).toEqual(['src/client.ts'])
  })

  // A release commit moves the changelog and no code. It must not be refused for the inverse reason —
  // the rule is one-directional on purpose.
  test('a changelog-only change passes', () => {
    expect(verdict(['CHANGELOG.md']).ok).toBe(true)
  })

  // POSITIVE CONTROL ON THE CONTROLS. Every assertion above is about a small hand-written list, and a
  // verdict() that returned {ok:true} unconditionally would satisfy all but the two refusals. This
  // pins that the refusals are the ONLY thing standing between those two cases and a pass, by
  // checking the function distinguishes the same file list with and without one entry.
  test('the entry is what changes the answer, nothing else', () => {
    const code = ['src/index.ts']
    expect(verdict(code).ok).toBe(false)
    expect(verdict([...code, 'CHANGELOG.md']).ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The second half of the instrument.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ TWO GUARDS, ONE FORGETFULNESS. The empty [Unreleased] section and the un-bumped version are not
// independent oversights: the same person writes both at the same moment and forgets them together.
// A guard closing one half therefore does not halve the chance of the other — it does not reduce it
// at all, because the cause is shared.
//
// And the PR guard above lives on pull requests, so it cannot see a divergence that ALREADY exists.
// Tonight's did: three commits sat on main past the published tag, and the pull requests that created
// them are closed. A guard that physically cannot fire on the only known instance of its own defect
// is indistinguishable from an absent one.

// @ts-expect-error — plain .mjs, shared rather than reimplemented.
import { verdict as driftVerdict } from '../../scripts/main-must-not-drift-past-its-published-version.mjs'

describe('main must not drift past its published version', () => {
  // This is tonight's state exactly: v1.0.3 published, src/ moved, package.json still 1.0.3.
  test('shipped code past the tag under the tag’s own version is REFUSED', () => {
    const v = driftVerdict({
      packageVersion: '1.0.3',
      latestTagVersion: '1.0.3',
      shippedChangedSinceTag: 4,
    })
    expect(v.ok).toBe(false)
  })

  // ⚠️ THE CASE THAT KEEPS IT FROM BEING RED FOR EVER. Once the version is bumped — which is what a
  // release-prep change does before the tag exists — the state is correct and must pass. Without
  // this the guard would refuse the very commit that fixes it.
  test('shipped code past the tag with the version ALREADY bumped passes', () => {
    const v = driftVerdict({
      packageVersion: '1.0.4',
      latestTagVersion: '1.0.3',
      shippedChangedSinceTag: 4,
    })
    expect(v.ok).toBe(true)
  })

  test('no shipped change since the tag passes, bumped or not', () => {
    expect(driftVerdict({ packageVersion: '1.0.3', latestTagVersion: '1.0.3', shippedChangedSinceTag: 0 }).ok).toBe(true)
  })

  test('a repository with no tags is not judged', () => {
    expect(driftVerdict({ packageVersion: '1.0.0', latestTagVersion: null, shippedChangedSinceTag: 9 }).ok).toBe(true)
  })

  // POSITIVE CONTROL ON THE CONTROLS: the version equality is what decides, nothing else. A verdict()
  // returning ok unconditionally would satisfy three of the four cases above.
  test('the version match is what changes the answer', () => {
    const base = { latestTagVersion: '1.0.3', shippedChangedSinceTag: 1 }
    expect(driftVerdict({ ...base, packageVersion: '1.0.3' }).ok).toBe(false)
    expect(driftVerdict({ ...base, packageVersion: '1.0.4' }).ok).toBe(true)
  })
})
