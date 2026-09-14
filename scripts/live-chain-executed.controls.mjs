#!/usr/bin/env node
/**
 * Negative — and positive — controls for live-chain-executed.mjs.
 *
 * 🔴 A CHECK THAT ALWAYS REFUSES IS AS USELESS AS ONE THAT ALWAYS PASSES, and it is the easier one
 * to ship by accident: it makes a workflow red, somebody adds `|| true`, and from then on the
 * pipeline reports that the chain runs. So the first control below is a POSITIVE one — a report in
 * which the chain really executed MUST be accepted — and the rest are the refusals.
 *
 * ⚠️ AND THE TWO KINDS OF NO ARE ASSERTED SEPARATELY. "Skipped" (1) and "could not measure" (2) are
 * different facts: the first says something about the chain, the second only about the instrument.
 * A control that accepted "any non-zero" would let them collapse, and the collapse is what turns a
 * broken reporter into "the chain was skipped, we will look tomorrow".
 */
import { verdict } from './live-chain-executed.mjs'

let failures = 0
const check = (name, got, want) => {
  if (got.code === want) {
    console.log(`  ok   ${name} → ${got.code}`)
    return
  }
  failures++
  console.error(`  FAIL ${name} → got ${got.code}, want ${want}\n       ${got.why}`)
}

// Filler so every fixture clears the report floor; the floor itself is controlled below.
const filler = (n, prefix = 'other suite > case') =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${prefix} ${i}`, status: 'passed' }))

const reportOf = (live, fillerCount = 25) => ({
  testResults: [{ name: 'tests/e2e/one-purchase-walked-through-the-contract.test.ts', assertionResults: [...live, ...filler(fillerCount)] }],
})

const liveCase = (status) => ({
  fullName: `SHAT-3023: one purchase, walked through the contract (live sandbox) > provision → request → approve → status → reveal, on the same purchase`,
  status,
})

console.log('live-chain-executed controls:')

// ── POSITIVE: the whole point. If this ever fails, the check has stopped being able to say yes.
check('a report where the live chain PASSED is accepted', verdict(reportOf([liveCase('passed')])), 0)

// ── The defect this check exists for: green run, skipped chain.
check('a skipped live chain is refused as NOT EXECUTED', verdict(reportOf([liveCase('skipped')])), 1)
check('a pending live chain is refused as NOT EXECUTED', verdict(reportOf([liveCase('pending')])), 1)
check('a failing live chain is refused', verdict(reportOf([liveCase('failed')])), 1)

// ── Could not measure: says nothing about the chain, and must not read as either answer.
check('an empty report cannot measure', verdict({ testResults: [] }), 2)
check('a report with no testResults cannot measure', verdict({ numTotalTests: 40 }), 2)
check('a truncated run cannot measure', verdict(reportOf([liveCase('passed')], 3)), 2)
check(
  'a run with no live-chain suite at all cannot measure',
  verdict({ testResults: [{ name: 'x', assertionResults: filler(30) }] }),
  2,
)

// ⚠️ THE CONTROL ON THE MARKER ITSELF. A suite renamed past the marker must give 2 (could not
// measure), never 0 — otherwise a rename silently turns this check into decoration.
check(
  'a renamed live suite cannot measure (it must not pass)',
  verdict(reportOf([{ fullName: 'SHAT-3023: the chain, live', status: 'passed' }])),
  2,
)

// ⚠️ AND A CONTROL THAT THE FLOOR IS THE FLOOR AND NOT A COINCIDENCE: one case above the minimum is
// accepted, one below is not. Written because a floor nobody probes drifts into a number that
// happens to pass whatever the tree currently has.
check('exactly at the floor is accepted', verdict(reportOf([liveCase('passed')], 19)), 0)
check('one case below the floor is refused', verdict(reportOf([liveCase('passed')], 18)), 2)

if (failures > 0) {
  console.error(`\n${failures} control(s) failed — the live-chain check does not discriminate, so its verdict cannot be trusted.`)
  process.exit(1)
}
console.log('\nall controls pass: the check accepts an executed chain and refuses a skipped one, a failed one, and every report it cannot read.')
