#!/usr/bin/env node
//
// The nightly's report to Jira: ONE ticket per defect, not one per night (SHAT-3141).
//
// 🔴 THE DEFECT THIS REPLACES IS SIX TICKETS FOR ONE FAULT. The step this script takes over always
// POSTed a new issue with a date in its summary, so the same nightly failure arrived as
// SHAT-3141 (04.09) · 3074 (03.09) · 2970 (02.09) · 2882 (01.09) · 2835 (31.08) · 2811 (30.08) —
// six rows, six nights, one defect, all still in To Do.
//
// ⚠️ AND THE HARM IS NOT UNTIDINESS. There IS an addressee, and he receives the same thing six
// times. A signal that opens a new record on every repetition teaches its reader to stop looking —
// which is the failure the nightly exists to prevent, moved one level up.
//
// ⚠️ THE RECOVERY IS REPORTED TOO, AND THAT HALF IS EASY TO FORGET. A ticket that only ever grows
// becomes permanent: nothing in it would ever say the fault stopped. When the nightly passes and an
// open report exists, this comments that it passed — it does NOT close the ticket. Closing is a
// person's judgement about whether the cause was understood, and a green run is not that judgement.
//
// ⚠️ AND IT DOES NOT SWALLOW ITS OWN RESULT. The step it replaces ended in `>/dev/null 2>&1 || true`,
// so a failed POST and a successful one looked identical — a reporter that cannot report was
// indistinguishable from one that did. Every call here is checked and its status printed.
//
// Usage:
//   node scripts/nightly-jira.mjs --outcome=failed|passed --run-url=<url>
//   node scripts/nightly-jira.mjs --self-test        (no network, no secrets)

import { pathToFileURL } from 'node:url'

const CLASS_SUMMARY = 'MCP Nightly E2E failure'

/**
 * What to do, given what the tracker says. Pure, so the controls can drive every branch.
 *
 * ⚠️ THE DEGRADED BRANCH IS THE ONE WORTH READING. If the SEARCH fails we cannot know whether a
 * report is already open — and the two ways of being wrong are not equal. Creating a duplicate
 * repeats today's defect once; creating nothing loses a real failure silently. So it creates, and
 * says in the issue that deduplication could not be performed, which is the fact the next reader
 * needs in order to merge them by hand.
 */
export function chooseAction({ outcome, searchOk, openKeys }) {
  const open = openKeys ?? []
  if (outcome === 'failed') {
    if (!searchOk) return { kind: 'create', degraded: true }
    if (open.length > 0) return { kind: 'comment', key: open[0], alsoOpen: open.slice(1) }
    return { kind: 'create', degraded: false }
  }
  if (outcome === 'passed') {
    if (searchOk && open.length > 0) return { kind: 'recovered', key: open[0], alsoOpen: open.slice(1) }
    // ⚠️ NOTHING, DELIBERATELY. A green night with no open report is the ordinary case, and posting
    // "still fine" every morning is the same noise this script exists to end, wearing a friendly face.
    return { kind: 'nothing' }
  }
  throw new Error(`unknown outcome ${JSON.stringify(outcome)} — refusing to guess`)
}

/** The JQL that finds an already-open report of THIS class. */
export function searchJql() {
  // Keyed on the label the creator sets and on the class summary WITHOUT a date, because the date is
  // what made every night look like a different defect.
  return `project = SHAT AND statusCategory != Done AND labels = nightly AND labels = e2e ` +
    `AND summary ~ "${CLASS_SUMMARY}" ORDER BY created ASC`
}

if (process.argv.includes('--self-test')) {
  // The self-test is the controls file; this flag exists so the workflow can run one command.
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const here = path.dirname(fileURLToPath(import.meta.url))
  execFileSync(process.execPath, [path.join(here, 'nightly-jira.controls.mjs')], { stdio: 'inherit' })
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// From here down: the live path. Nothing above this line touches the network.
//
// ⚠️ AND IT RUNS ONLY WHEN THIS FILE IS EXECUTED, NOT WHEN IT IS IMPORTED. The controls import
// chooseAction; without this guard, importing them ran the live path and the controls died on
// "--outcome must be failed|passed" before asserting anything. A control file that cannot import its
// subject is a control file that tests nothing, and it would have failed loudly here — but the same
// shape in a quieter script is how a self-test comes to measure its own harness.
const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!executedDirectly) {
  // Imported for its pure functions; nothing else to do.
} else {

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const outcome = arg('outcome')
const runUrl = arg('run-url')
if (outcome !== 'failed' && outcome !== 'passed') {
  console.error(`nightly-jira: --outcome must be failed|passed, got ${JSON.stringify(outcome)}`)
  process.exit(2)
}

const { JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env
if (!JIRA_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  // ⚠️ REFUSE RATHER THAN CARRY ON. A reporter without credentials that exits 0 is the silence this
  // whole script is about, and the old step's `|| true` produced exactly that.
  console.error('nightly-jira: JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN must all be set')
  process.exit(2)
}

const auth = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')
const call = async (method, path, body) => {
  const res = await fetch(`${JIRA_URL}${path}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

const doc = (lines) => ({
  type: 'doc',
  version: 1,
  content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
})

const today = new Date().toISOString().slice(0, 10)

let searchOk = false
let openKeys = []
{
  const r = await call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(searchJql())}&fields=summary&maxResults=20`)
  if (r.ok) {
    try {
      openKeys = (JSON.parse(r.text).issues ?? []).map((i) => i.key)
      searchOk = true
    } catch {
      searchOk = false
    }
  }
  console.log(`search: ok=${searchOk} status=${r.status} open=${openKeys.join(',') || 'none'}`)
}

const action = chooseAction({ outcome, searchOk, openKeys })
console.log(`action: ${JSON.stringify(action)}`)

let r
switch (action.kind) {
  case 'nothing':
    console.log('nothing to report: the nightly passed and no report is open')
    process.exit(0)
    break
  case 'comment':
    r = await call('POST', `/rest/api/3/issue/${action.key}/comment`, {
      body: doc([
        `FAILED AGAIN on ${today}. Run: ${runUrl}`,
        'Recorded here rather than as a new issue: the same fault filed once per night produced six ' +
          'rows for one defect (SHAT-3141, 3074, 2970, 2882, 2835, 2811), which taught its reader to ' +
          'stop looking. The repetition is the news; a new row is not.',
        ...(action.alsoOpen.length
          ? [`⚠️ Other open reports of this class: ${action.alsoOpen.join(', ')} — they are duplicates ` +
             `of this one and should be merged into it by a person.`]
          : []),
      ]),
    })
    break
  case 'recovered':
    r = await call('POST', `/rest/api/3/issue/${action.key}/comment`, {
      body: doc([
        `The nightly PASSED on ${today}. Run: ${runUrl}`,
        'Reported because a ticket that only ever grows becomes permanent — nothing in it would ' +
          'otherwise say the fault stopped. ⚠️ THIS DOES NOT CLOSE THE TICKET: whether the cause was ' +
          'understood is a judgement, and a green run is not that judgement.',
      ]),
    })
    break
  case 'create':
    r = await call('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: 'SHAT' },
        issuetype: { id: '10008' },
        // No date in the summary — that is what made every night a different defect.
        summary: CLASS_SUMMARY,
        description: doc([
          `First recorded ${today}. Run: ${runUrl}`,
          'Subsequent failures of this class are added to THIS issue as comments rather than filed ' +
            'as new ones.',
          ...(action.degraded
            ? ['⚠️ THE SEARCH FOR AN EXISTING REPORT FAILED, so this issue may duplicate one that is ' +
               'already open. Creating is the deliberate choice: a duplicate repeats a known defect ' +
               'once, while creating nothing would lose a real failure silently.']
            : []),
        ]),
        labels: ['nightly', 'e2e', 'auto-created'],
      },
    })
    break
}

// ⚠️ THE RESULT IS CHECKED, NOT DISCARDED. The step this replaces ended in `|| true`.
console.log(`${action.kind}: status=${r.status}`)
if (!r.ok) {
  console.error(`nightly-jira: ${action.kind} FAILED (${r.status}): ${r.text.slice(0, 400)}`)
  process.exit(1)
}
}
