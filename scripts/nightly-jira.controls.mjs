#!/usr/bin/env node
//
// Negative controls for scripts/nightly-jira.mjs (SHAT-3141).
//
// A decision that behaves correctly on the happy path proves only that it runs. What has to be shown
// is that it DISCRIMINATES — and here the branches differ by what they cost when wrong:
//
//   a failure with a report already open   → comment. Filing again is the defect being replaced.
//   a failure with nothing open            → create. Exactly one row per defect.
//   a failure and the SEARCH BROKE         → create AND say so. A duplicate repeats a known defect
//                                            once; creating nothing loses a real failure silently.
//   a pass with a report open              → comment that it recovered, and DO NOT close.
//   a pass with nothing open               → do nothing at all.
//
// ⚠️ THE LAST ONE IS A CONTROL, NOT A CASE. If "nothing" were ever an action, the script would post
// "still fine" every morning — the same noise it exists to end, wearing a friendlier face.
//
// Run: node scripts/nightly-jira.controls.mjs

import { chooseAction, searchJql } from './nightly-jira.mjs'

let bad = 0
const check = (why, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    console.error(`control FAILED: ${why}\n  got  ${g}\n  want ${w}`)
    bad++
  }
}

check(
  'a failure with a report already open is a COMMENT on it, never a new issue',
  chooseAction({ outcome: 'failed', searchOk: true, openKeys: ['SHAT-2811'] }),
  { kind: 'comment', key: 'SHAT-2811', alsoOpen: [] },
)

check(
  'the OLDEST open report is the one commented on, and the rest are named as duplicates',
  chooseAction({ outcome: 'failed', searchOk: true, openKeys: ['SHAT-2811', 'SHAT-3074', 'SHAT-3141'] }),
  { kind: 'comment', key: 'SHAT-2811', alsoOpen: ['SHAT-3074', 'SHAT-3141'] },
)

check(
  'a failure with nothing open creates exactly one issue, not a degraded one',
  chooseAction({ outcome: 'failed', searchOk: true, openKeys: [] }),
  { kind: 'create', degraded: false },
)

check(
  'a failure whose SEARCH BROKE still creates, and marks itself degraded',
  chooseAction({ outcome: 'failed', searchOk: false, openKeys: [] }),
  { kind: 'create', degraded: true },
)

// ⚠️ AND THE DEGRADED BRANCH MUST NOT BE REACHABLE THROUGH A SUCCESSFUL SEARCH, or "degraded" stops
// meaning anything and the warning it prints into the issue becomes decoration.
check(
  'a broken search is degraded even when it reports keys — an unusable answer is not an answer',
  chooseAction({ outcome: 'failed', searchOk: false, openKeys: ['SHAT-2811'] }),
  { kind: 'create', degraded: true },
)

check(
  'a pass with a report open says it recovered — and the action is a comment, NOT a close',
  chooseAction({ outcome: 'passed', searchOk: true, openKeys: ['SHAT-2811'] }),
  { kind: 'recovered', key: 'SHAT-2811', alsoOpen: [] },
)

check(
  'a pass with nothing open does NOTHING — no daily "still fine"',
  chooseAction({ outcome: 'passed', searchOk: true, openKeys: [] }),
  { kind: 'nothing' },
)

check(
  'a pass whose search broke also does nothing: we cannot claim a recovery we could not look up',
  chooseAction({ outcome: 'passed', searchOk: false, openKeys: [] }),
  { kind: 'nothing' },
)

// ⚠️ AN UNKNOWN OUTCOME MUST REFUSE. Defaulting to "failed" would file on a run that never failed;
// defaulting to "passed" would swallow one that did. Neither default is safe, so there is none.
try {
  chooseAction({ outcome: 'weird', searchOk: true, openKeys: [] })
  console.error('control FAILED: an unknown outcome was accepted instead of refused')
  bad++
} catch {
  /* expected */
}

// The search must be keyed on the CLASS, not on a date — the date in the summary is what made six
// nights look like six defects. Asserted on the query itself, because that is the thing that has to
// match tomorrow's ticket as well as today's.
const jql = searchJql()
for (const must of ['statusCategory != Done', 'labels = nightly', 'labels = e2e', 'MCP Nightly E2E failure']) {
  if (!jql.includes(must)) {
    console.error(`control FAILED: the search query does not constrain on ${JSON.stringify(must)}\n  ${jql}`)
    bad++
  }
}
if (/\d{4}-\d{2}-\d{2}/.test(jql)) {
  console.error(`control FAILED: the search query contains a DATE, which is the defect being fixed:\n  ${jql}`)
  bad++
}

console.log(bad === 0 ? 'controls: all passed' : `controls: ${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
