#!/usr/bin/env node
/**
 * SHAT-3340 / SHAT-3023 — acceptance BY NUMBER, not by colour.
 *
 * 🔴 THE FAILURE THIS EXISTS AGAINST IS A GREEN RUN. A skipped vitest suite makes the run pass, and
 * the default reporter prints neither skipped suite names nor logs from passing tests (measured
 * 2026-09-14, and written into the workflows for that reason). So "the sandbox workflow was green"
 * has never distinguished "the live chain ran" from "the live chain was skipped" — and once the
 * opt-in is lifted, that is exactly the difference somebody will report as done.
 *
 * ⇒ This reads the run's own JSON report and answers with a COUNT: how many cases of the live chain
 * suite executed. Nothing else in the pipeline can tell.
 *
 * ⚠️ THREE OUTCOMES, THREE EXIT CODES, because "it was skipped" and "I could not tell" are
 * different facts and a single non-zero would merge them — the same distinction
 * scripts/check-deferral-expired.sh in shatale-api draws for its own three answers:
 *
 *   0  the live chain suite executed        (and the number is printed)
 *   1  it is present in the report and was NOT executed (skipped / pending / todo)
 *   2  COULD NOT MEASURE — no report, unparsable, an empty report, or no live-chain suite in it
 *
 * A 2 is not a pass with a warning. A report this script cannot read says nothing about the chain,
 * and a check that answered 0 on it would be the very defect above with extra steps.
 */
import { readFileSync } from 'node:fs'

// The marker the live suite's name carries. Deliberately the parenthetical rather than the whole
// title: the title also carries the ticket and has been edited twice, and a check pinned to an
// entire sentence goes red on a typo fix while a check pinned to nothing at all goes green on a
// rename. If the suite is renamed past this marker the answer is 2 — could not measure — which is
// the honest verdict and not a silent pass.
const LIVE_SUITE_MARKER = '(live sandbox)'

// A floor on the whole report. A run that executed almost nothing — a crashed reporter, a filter
// left in an argument — would otherwise let a single matching case stand in for the suite.
const MIN_TOTAL_TESTS = 20

const NOT_EXECUTED = new Set(['pending', 'skipped', 'todo'])

export function verdict(report, { minTotal = MIN_TOTAL_TESTS, marker = LIVE_SUITE_MARKER } = {}) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { code: 2, why: 'the report has no testResults array — this is not a vitest JSON report' }
  }
  const cases = report.testResults.flatMap((f) => (Array.isArray(f.assertionResults) ? f.assertionResults : []))
  if (cases.length === 0) {
    return { code: 2, why: 'the report contains no test cases at all — nothing ran, or the reporter wrote nothing' }
  }
  if (cases.length < minTotal) {
    return {
      code: 2,
      why: `the report contains only ${cases.length} case(s), fewer than the ${minTotal} this suite has had for months — ` +
        'a filtered or truncated run cannot answer for the chain',
    }
  }
  const live = cases.filter((c) => typeof c.fullName === 'string' && c.fullName.includes(marker))
  if (live.length === 0) {
    return {
      code: 2,
      why: `no case whose name contains ${JSON.stringify(marker)} is in the report. Either the live suite was ` +
        'renamed past this check, or it was not collected at all — both mean this run says nothing about the chain',
    }
  }
  const executed = live.filter((c) => !NOT_EXECUTED.has(c.status))
  const failed = live.filter((c) => c.status === 'failed')
  if (executed.length === 0) {
    return {
      code: 1,
      why: `all ${live.length} live-chain case(s) are ${[...new Set(live.map((c) => c.status))].join('/')} — ` +
        'SKIPPED, not passed. The run is green and the chain did not run: set SHATALE_E2E_LIVE_CHAIN=1 ' +
        'and give the job a SHATALE_TEST_KEY whose account owns an agent',
      executed: 0,
      total: cases.length,
    }
  }
  return {
    code: failed.length > 0 ? 1 : 0,
    why: failed.length > 0
      ? `${failed.length} of ${live.length} live-chain case(s) FAILED — the chain ran and did not hold`
      : `${executed.length} live-chain case(s) EXECUTED out of ${cases.length} in the run`,
    executed: executed.length,
    total: cases.length,
  }
}

function main(argv) {
  const path = argv[2]
  if (!path) {
    console.error('usage: live-chain-executed.mjs <vitest-json-report>')
    return 2
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`::error title=Could not measure::no report at ${path}: ${err.message}. ` +
      'This is not "the chain was skipped" and not "the chain ran" — it is an instrument that did not run.')
    return 2
  }
  let report
  try {
    report = JSON.parse(raw)
  } catch (err) {
    console.error(`::error title=Could not measure::${path} is not JSON: ${err.message}`)
    return 2
  }
  const v = verdict(report)
  if (v.code === 0) {
    console.log(`::notice title=SHAT-3023 live chain: EXECUTED::${v.why}`)
    return 0
  }
  const title = v.code === 1 ? 'SHAT-3023 live chain: NOT EXECUTED' : 'Could not measure'
  console.error(`::error title=${title}::${v.why}`)
  return v.code
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv))
}
