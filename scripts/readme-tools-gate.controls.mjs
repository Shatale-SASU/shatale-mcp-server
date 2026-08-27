#!/usr/bin/env node
//
// Negative controls for scripts/readme-tools-gate.mjs.
//
// A gate that passes on the good README proves only that it runs. Five passing samples
// prove exactly what one proves. What has to be shown is that the gate DISCRIMINATES:
// each control below plants one specific defect — including each of the four this ticket
// was opened for — and the gate must NAME it, not merely go red, and certainly not stay
// green. The last two controls plant the gate's OWN words in the README and require it to
// stay green, because a gate that catches itself is the failure mode we hit three times.
//
// Run: node scripts/readme-tools-gate.controls.mjs
// Exits non-zero if any control does not behave as required.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE = path.join(HERE, 'readme-tools-gate.mjs')
const GOOD = readFileSync(path.join(REPO, 'README.md'), 'utf8')

function runGate(readmeText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readme-gate-control-'))
  const rp = path.join(dir, 'README.md')
  writeFileSync(rp, readmeText)
  copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'))
  try {
    const out = execFileSync(process.execPath, [GATE, '--readme', rp, '--entry', path.join(REPO, 'dist/index.js')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

const controls = []
const control = (name, text, expect) => {
  // ⚠️ A MUTATION THAT DID NOT APPLY IS NOT A CONTROL — SHAT-2527. Every planted defect below is a
  // String.replace against a literal from the README. `replace` with no match returns the string
  // UNCHANGED and reports nothing, so the "mutated" input equals GOOD, the gate passes, and the
  // control announces that the gate does not discriminate — when in truth nothing was ever planted.
  //
  // That happened: two counts were written as '15 tools <!-- count:sandbox -->', the sandbox roster
  // moved to 16, and both controls silently stopped mutating. The gate was fine; the CONTROLS had
  // gone quiet, which is worse, because a quiet control is the thing that tells you the gate works.
  //
  // ⚠️ ONLY FOR CONTROLS THAT EXPECT RED. The positive control passes GOOD deliberately — it exists
  // to show the gate is green on a correct file — so requiring IT to differ caught a correct
  // control. The harm is narrower than "text equals GOOD": it is a control that expects a failure
  // and planted nothing to cause one.
  if (expect?.red && text === GOOD) {
    console.error(`control "${name}" did not change the README — its literal no longer matches. ` +
      `Nothing was planted, so a green gate proves nothing. Fix the literal.`)
    process.exit(1)
  }
  controls.push({ name, text, expect })
}

// ── The four defects this ticket was opened for ─────────────────────────────

// (a) a tool presented as available in a mode where it is not registered.
// The defect is planted in the SANDBOX cell by name, not by "the first em dash on the row" —
// that shortcut flipped the GUEST column instead, so the control went red on a cell other
// than the one it advertised, and the assertion below could not tell the difference. The
// mode is now asserted verbatim, so a red on the wrong column is a FAIL, not a pass.
control('(a) onboarding claimed available in sandbox',
  GOOD.replace('| `register_user_profile` | — | — | yes | — | — | yes |',
    '| `register_user_profile` | — | yes | yes | — | — | yes |'),
  { red: true, mustName: ['register_user_profile', 'is available in "sandbox"'] })

// (a2) the mirror of (a): a real tool marked unavailable where it IS registered.
//
// ⚠️ THE LITERAL IS DELIBERATE AND IT HAS ALREADY EARNED ITS KEEP. When SHAT-2674 opened the
// checkout reads in the sandbox, this row changed from `— — — — yes` to `— yes yes — yes`, the
// replace stopped matching, and the control REFUSED rather than passing on a plant that never
// happened. That refusal is the control working: a canary whose plant silently misses is a green
// run that proves nothing. Update the literal when the row changes — do not loosen it to a pattern
// that always matches.
control('(a2) get_checkout_cardholder marked unavailable in live+money',
  GOOD.replace(/^\| `get_checkout_cardholder` \| — \| yes \| yes \| — \| yes \|/m, '| `get_checkout_cardholder` | — | yes | yes | — | — |'),
  { red: true, mustName: ['get_checkout_cardholder', 'live+money'] })

// (c2) the tool stays in the matrix but loses its description.
control('(c2) description of get_credential_status deleted',
  GOOD.replace(/^- `get_credential_status` — .*\n/m, ''),
  { red: true, mustName: ['get_credential_status', 'no description'] })

// (b) an example prompt that invites a tool the mode does not advertise.
control('(b) prompt invites register_user_profile in sandbox',
  GOOD.replace('## Example Prompts\n', '## Example Prompts\n\n- *"Register a new user with email alice@startup.io"* <!-- prompt:register_user_profile@sandbox -->\n'),
  { red: true, mustName: ['register_user_profile', 'Unknown tool'] })

// (b2) an example prompt with no annotation at all — the shape the old README had.
control('(b2) unannotated example prompt',
  GOOD.replace('## Example Prompts\n', '## Example Prompts\n\n- *"Register a new user with email alice@startup.io and country US"*\n'),
  { red: true, mustName: ['not annotated'] })

// (c) a real tool missing from the README entirely.
control('(c) get_checkout_cardholder deleted from the matrix',
  GOOD.replace(/^\| `get_checkout_cardholder` \|.*\n/m, '').replace(/- `get_checkout_cardholder` — .*\n/, ''),
  { red: true, mustName: ['get_checkout_cardholder'] })

// ── (d)/(d2): the counts are READ FROM THE README, not typed here ───────────
// The first version of (d) carried '16 tools <!-- count:sandbox -->' as a literal. The sandbox
// roster moved to 17 (SHAT-2698 added a tool), the literal stopped matching, and the applied-
// mutation check above refused to run — an honest red about the CONTROL, not the gate. A
// hand-typed count in a control drifts exactly the way a hand-typed count in the README does,
// so both numbers are now derived from the README being mutated:
//   - the annotated sandbox sentence gives the true count to replace;
//   - the matrix totals row gives a planted count that is REAL for another mode, because (d)'s
//     whole point is that "is this number real anywhere" must not be the rule — the original
//     defect, "17", was true of a mode nobody could reach.
const sandboxSentence = GOOD.match(/(\d+) tools <!-- count:sandbox -->/)
if (!sandboxSentence) {
  console.error('controls (d)/(d2): the README no longer says "<N> tools <!-- count:sandbox -->" — ' +
    'the controls cannot find the sentence they mutate. Nothing was planted, so a green gate ' +
    'proves nothing. Fix the pattern here to match the README.')
  process.exit(1)
}
const sandboxCount = Number(sandboxSentence[1])
const totalsRow = GOOD.match(/^\| \*\*total advertised\*\* \|(.*)\|\s*$/m)
const totals = totalsRow ? [...totalsRow[1].matchAll(/\*\*(\d+)\*\*/g)].map((m) => Number(m[1])) : []
// Prefer a planted number that shares no substring with the real one, so "named the planted
// number" below cannot be satisfied by the real number's own digits (17 contains 7).
const foreign = totals.find((n) => n !== sandboxCount &&
    !String(n).includes(String(sandboxCount)) && !String(sandboxCount).includes(String(n))) ??
  totals.find((n) => n !== sandboxCount)
if (foreign === undefined) {
  console.error('controls (d)/(d2): every mode in the totals row advertises the sandbox count — ' +
    'there is no foreign number to plant. Fix the totals-row pattern or the README.')
  process.exit(1)
}

// (d) a true number attached to the wrong mode.
control(`(d) count ${foreign} attached to sandbox`,
  GOOD.replace(`${sandboxCount} tools <!-- count:sandbox -->`, `${foreign} tools <!-- count:sandbox -->`),
  { red: true, mustName: [String(foreign), 'sandbox', String(sandboxCount)] })

// (d2) a bare count with no mode — real for another mode, so a
//      "is this number real anywhere" rule would pass it verbatim.
control(`(d2) bare "${foreign} tools" with no mode`,
  GOOD.replace(`${sandboxCount} tools <!-- count:sandbox -->`, `${foreign} tools`),
  { red: true, mustName: ['no mode'] })

// ── The classic control: a tool that simply does not exist ──────────────────
// The name is assembled at runtime so this literal appears nowhere on disk — a repo-wide
// grep for it finds nothing, and the gate cannot be tripped by its own canary.
const CANARY = ['get', 'phantom', 'ledger'].join('_')
control('canary: a tool that exists nowhere',
  GOOD.replace(/^\| `get_purchase_status` \|/m, `| \`${CANARY}\` | — | — | — | — | — | — |\n| \`get_purchase_status\` |`),
  { red: true, mustName: [CANARY] })

control('canary in prose, outside the matrix',
  GOOD.replace('## Example Prompts', `Call \`${CANARY}\` to read the ledger.\n\n## Example Prompts`),
  { red: true, mustName: [CANARY] })

// ── The symmetric claims: absence asserted, and checked ─────────────────────
control('a "gone" declaration about a tool that is still advertised',
  GOOD.replace('<!-- gone:sandbox_reset -->', '<!-- gone:explain_shatale -->'),
  { red: true, mustName: ['explain_shatale'] })

control('a "removed because unreachable" note about a tool that IS reachable',
  GOOD.replace('<!-- prompt-unreachable:register_user_profile@sandbox -->', '<!-- prompt-unreachable:register_user_profile@sandbox+flags -->'),
  { red: true, mustName: ['Restore the prompt'] })

// ── Self-catch controls: the gate must not eat its own words ────────────────
control('the gate\'s entire source pasted into the README inside a fence',
  GOOD.replace('## Example Prompts', '```js\n' + readFileSync(GATE, 'utf8') + '\n```\n\n## Example Prompts'),
  { red: false })

control('this control file pasted into the README inside a fence',
  GOOD.replace('## Example Prompts', '```js\n' + readFileSync(fileURLToPath(import.meta.url), 'utf8') + '\n```\n\n## Example Prompts'),
  { red: false })

// ── Positive control: the unmodified README stays green ─────────────────────
control('positive control: the README as committed', GOOD, { red: false })

// ── Run ─────────────────────────────────────────────────────────────────────
let bad = 0
for (const c of controls) {
  const r = runGate(c.text)
  const red = r.code !== 0
  if (red !== c.expect.red) {
    bad++
    console.log(`FAIL  ${c.name}\n      expected ${c.expect.red ? 'RED' : 'GREEN'}, got ${red ? 'RED' : 'GREEN'}\n${r.out.split('\n').slice(0, 8).map((l) => '      | ' + l).join('\n')}`)
    continue
  }
  const missing = (c.expect.mustName ?? []).filter((s) => !r.out.includes(s))
  if (missing.length) {
    bad++
    console.log(`FAIL  ${c.name}\n      went red but did not NAME: ${missing.join(', ')}\n${r.out.split('\n').slice(0, 8).map((l) => '      | ' + l).join('\n')}`)
    continue
  }
  console.log(`ok    ${c.name} — ${c.expect.red ? 'red, and named it' : 'green'}`)
}
if (bad) { console.log(`\n${bad} control(s) failed. The gate does not discriminate as claimed.`); process.exit(1) }
console.log(`\nall ${controls.length} controls behaved as required`)
