import { describe, test, expect } from 'vitest'
// @ts-expect-error — plain .mjs script, no types, deliberately shared rather than reimplemented here.
import { verdict, emptyDiffCause } from '../../scripts/a-code-change-must-say-what-changed.mjs'

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

// SHAT-3456. An empty diff is refused either way — these cases pin that the refusal names the cause
// it MEASURED. The old single cause ("almost certainly a shallow checkout") sent a ticket to the
// checkout while the real cause was a pull request whose content was already squash-merged.
describe('an empty diff names the cause it measured', () => {
  test('base absent from the clone → a checkout or base-ref problem', () => {
    const c = emptyDiffCause({ baseExists: false, treeChanges: 0 })
    expect(c.cause).toBe('missing-base')
    expect(c.message).toMatch(/shallow checkout or a wrong base ref/)
  })

  test('base present and the trees equal → the pull request changes nothing (the #77 case)', () => {
    const c = emptyDiffCause({ baseExists: true, treeChanges: 0 })
    expect(c.cause).toBe('nothing-changes')
    // ⚠️ AND IT MUST NOT BLAME THE CHECKOUT: that is exactly the misattribution this replaces.
    expect(c.message).not.toMatch(/shallow/)
    expect(c.message).toMatch(/duplicate/)
  })

  test('base present, trees differ, three-dot diff empty → a merge-base surprise, named as such', () => {
    const c = emptyDiffCause({ baseExists: true, treeChanges: 6 })
    expect(c.cause).toBe('unexpected-merge-base')
    expect(c.message).toMatch(/6 file\(s\)/)
  })

  // 🔴 THE FOURTH STATE, WHICH USED TO CRASH INSTEAD OF BEING NAMED — review of #78. A base can be
  // PRESENT and share no history with HEAD (an unrelated commit, a force-push, a grafted clone), and
  // `git diff base...HEAD` needs a merge base: without one it throws and the check died on a stack
  // trace before anything could be measured.
  test('base present but unrelated to HEAD → no-merge-base, and NOT a fetch-more-history answer', () => {
    const c = emptyDiffCause({ baseExists: true, mergeBase: false, treeChanges: 0 })
    expect(c.cause).toBe('no-merge-base')
    // ⚠️ THE REMEDY IS THE ASSERTION. 'missing-base' says "fetch enough history", and fetching will
    // never produce a merge base that does not exist — sending somebody there is the same
    // misattribution this whole function replaced. So the message must REFUSE that remedy in words.
    expect(c.message).toMatch(/cannot fix this/i)
    expect(c.message).toMatch(/shares no history/i)
  })

  // The default matters: every caller that predates this state omits `mergeBase`, and they must keep
  // their old cause rather than silently becoming no-merge-base.
  test('an omitted mergeBase keeps the previous causes', () => {
    expect(emptyDiffCause({ baseExists: true, treeChanges: 0 }).cause).toBe('nothing-changes')
    expect(emptyDiffCause({ baseExists: true, treeChanges: 4 }).cause).toBe('unexpected-merge-base')
  })

  // Positive control across the FOUR: the causes must all be DIFFERENT, or the function has
  // collapsed back into one message wearing four labels.
  test('the four measured states produce four different causes and messages', () => {
    const a = emptyDiffCause({ baseExists: false, treeChanges: 0 })
    const b = emptyDiffCause({ baseExists: true, treeChanges: 0 })
    const d = emptyDiffCause({ baseExists: true, treeChanges: 3 })
    const e = emptyDiffCause({ baseExists: true, mergeBase: false, treeChanges: 0 })
    expect(new Set([a.cause, b.cause, d.cause, e.cause]).size).toBe(4)
    expect(new Set([a.message, b.message, d.message, e.message]).size).toBe(4)
  })
})
