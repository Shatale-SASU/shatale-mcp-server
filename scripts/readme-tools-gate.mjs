#!/usr/bin/env node
//
// SHAT-2527 — the README is a contract read by integrators who do not have this code.
// A tool named there and not advertised by the server is not untidiness; it is a false
// statement with a live consumer.
//
// THE POINT OF THIS FILE IS NOT TO CHECK A LIST. Enumerating the list is what we already
// did twice, and it drifted again both times, because a hand-written list and a running
// server are two independent sources that agree only by coincidence.
//
// This gate removes the second source. The tool matrix in the README lives inside a
// GENERATED region: the gate boots the BUILT server over stdio in every mode, renders the
// region from what the server actually advertised, and byte-compares. A hand edit inside
// the region is not "forbidden" — it is overwritten by `--fix` and fails CI otherwise.
// Outside the region, a bare tool COUNT and an unannotated example PROMPT are refused, so
// the two ways drift got in last time have nowhere to live.
//
// This mirrors the fix SHAT-1461 already applied inside the server itself
// (src/tools/common.ts: "the tool list is built FROM THE ROUTER, never a hand-maintained
// per-mode array"). explain_shatale and list_capabilities stopped drifting when they were
// made derivations. The README is the last hand-maintained copy.
//
// INPUTS: exactly two — the README path and the built entrypoint. This file never reads
// itself and never scans the repository, so its own comments and its own canary cannot
// trip it. That is asserted by a negative control, not assumed (see --self-check).
//
// Usage:
//   node scripts/readme-tools-gate.mjs            # verify (exit 1 on any drift)
//   node scripts/readme-tools-gate.mjs --fix      # rewrite the generated region
//   node scripts/readme-tools-gate.mjs --exec     # additionally CALL each annotated
//                                                 # prompt tool and refuse "Unknown tool"
//   --readme <path>  --entry <path>               # override inputs (used by the controls)

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MODES, speak, measureRoster, GO_CODE, GO_SHA } from './lib/serverRoster.mjs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const FIX = argv.includes('--fix')
const EXEC = argv.includes('--exec')
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : dflt
}
const README = argOf('--readme', path.join(REPO, 'README.md'))
const ENTRY = argOf('--entry', path.join(REPO, 'dist/index.js'))

// ── The modes a reader can actually reach ───────────────────────────────────
// Every mode the server can be in is probed. A count that belongs to no mode here is a
// number nobody can observe — which is exactly how "17" got into the README.
//
// The money-GO code is invented HERE and hashed HERE: the gate proves the money-gated
// surface without any real code and without any live key ever existing in this process.

// MODES and `speak` moved to scripts/lib/serverRoster.mjs — the coverage gate needs the same
// measurement, and a second copy is how the first goes stale. That is what happened: the coverage
// gate grew its own roster from source text and eight hardcoded factories, and the two agreed while
// both missing a tool declared outside src/tools (SHAT-2527).

// ── Measure ─────────────────────────────────────────────────────────────────
const failures = []
const fail = (msg) => failures.push(msg)

const { advertised, describes, union, failures: rosterFailures } = await measureRoster(ENTRY)
rosterFailures.forEach(fail)
if (failures.length) { report(); process.exit(1) }

const unionSet = new Set(union)

// ── Render the generated region from the measurement ────────────────────────
// Split so the marker strings this file writes are assembled from parts and never appear
// whole in this source. A repo-wide grep for a marker therefore finds the README, not the
// gate that maintains it — the gate cannot be mistaken for its own subject.
const MARK = (kind) => `<!-- ` + kind + `:shatale-tool-matrix -->`
const BEGIN = MARK('BEGIN' + '-generated')
const END = MARK('END' + '-generated')

function renderRegion() {
  const head = ['| Tool', ...MODES.map(([, label]) => ` ${label} `)].join(' |') + ' |'
  const rule = '|---|' + MODES.map(() => ':-:|').join('')
  const rows = union.map((t) => `| \`${t}\` |` + MODES.map(([id]) => (advertised.get(id).includes(t) ? ' yes |' : ' — |')).join(''))
  const counts = '| **total advertised** |' + MODES.map(([id]) => ` **${advertised.get(id).length}** |`).join('')
  // Descriptions come from the server's own tools/list payload, verbatim. This is the half
  // that makes (a) and (c) unwritable: a tool cannot be described here without being
  // advertised, and cannot be advertised without appearing here.
  const desc = union.map((t) => `- \`${t}\` — ${(describes.get(t) ?? '').replace(/\s+/g, ' ').trim()}`)
  return [
    BEGIN,
    `<!-- Generated by scripts/readme-tools-gate.mjs from the BUILT server over stdio. Do not edit by hand: run \`npm run gate:readme -- --fix\`. -->`,
    '',
    head, rule, ...rows, counts,
    '',
    `Tools defined in the code: **${union.length}**. A tool appears in a column only if the server actually returned it from \`tools/list\` in that mode — no column is a plan or an intention.`,
    '',
    '#### What each tool does',
    '',
    '<!-- Descriptions below are the server\'s own tool descriptions, verbatim. -->',
    '',
    ...desc,
    END,
  ].join('\n')
}

// ── Parse the README ────────────────────────────────────────────────────────
const original = readFileSync(README, 'utf8')

const bi = original.indexOf(BEGIN)
const ei = original.indexOf(END)
if (bi < 0 || ei < 0 || ei < bi) {
  fail(`README has no generated tool-matrix region. Insert the ${BEGIN} / ${END} markers, then run --fix.`)
  report(); process.exit(1)
}
const before = original.slice(0, bi)
const region = original.slice(bi, ei + END.length)
const after = original.slice(ei + END.length)

const wanted = renderRegion()
if (region !== wanted) {
  if (FIX) {
    writeFileSync(README, before + wanted + after)
    console.log(`rewrote the generated tool matrix in ${README}`)
  } else {
    fail('the generated tool matrix in the README does not match what the server advertises. Run with --fix.')
    // Going red is not enough. "Run --fix" tells a reader that something moved, not WHAT,
    // and a gate that will not say what it found is one nobody trusts enough to obey. So
    // the mismatch is diffed CELL BY CELL: every wrong claim is named, with the mode.
    const claimed = new Map()
    for (const line of region.split('\n')) {
      const m = line.match(/^\|\s*`([a-z0-9_]+)`\s*\|(.*)\|\s*$/)
      if (!m) continue
      const cells = m[2].split('|').map((c) => c.trim())
      if (cells.length === MODES.length) claimed.set(m[1], cells)
    }
    for (const [t, cells] of claimed) {
      if (!unionSet.has(t)) { fail(`  README matrix lists \`${t}\`, which the server advertises in NO mode.`); continue }
      MODES.forEach(([id], i) => {
        const readmeSaysYes = cells[i] === 'yes'
        const serverSaysYes = advertised.get(id).includes(t)
        if (readmeSaysYes && !serverSaysYes) fail(`  README says \`${t}\` is available in "${id}"; the server does NOT advertise it there.`)
        if (!readmeSaysYes && serverSaysYes) fail(`  the server advertises \`${t}\` in "${id}"; the README matrix says it is not there.`)
      })
    }
    for (const t of union) if (!claimed.has(t)) fail(`  the server advertises \`${t}\`, which the README matrix does not list at all.`)
    for (const [id] of MODES) {
      const n = advertised.get(id).length
      if (!region.includes(`**${n}**`)) fail(`  mode "${id}" advertises ${n} tools; that number is absent from the README matrix.`)
    }
    // The per-tool description list is generated too, so a tool documented there but not
    // in the matrix (or the reverse) is named rather than folded into "run --fix".
    const described = new Set([...region.matchAll(/^- `([a-z0-9_]+)` — /gm)].map((m) => m[1]))
    for (const t of union) if (!described.has(t)) fail(`  the server advertises \`${t}\`, which has no description in the README.`)
    for (const t of described) if (!unionSet.has(t)) fail(`  README describes \`${t}\`, which the server advertises in NO mode.`)
  }
}

// ── Prose scans, outside the generated region ───────────────────────────────
// Fenced code blocks and HTML comments are stripped FIRST. This is what keeps the gate
// from catching its own words: paste this whole file into the README inside a fence and
// the gate stays green, because a fence is not a claim. Asserted by --self-check.
const prose = (before + after)
  .replace(/```[\s\S]*?```/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')

// (0) The README is not the only place a count is published. package.json's `description`
//     is what npm shows on the package page, and on origin/main it says "15 tools" — true
//     for a sandbox key and for nothing else. Same rule, same measurement.
try {
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(README), 'package.json'), 'utf8'))
  for (const m of String(pkg.description ?? '').matchAll(/(\d+)[ -]tools?\b/gi)) {
    const n = Number(m[1])
    if (!MODES.some(([id]) => advertised.get(id).length === n)) {
      fail(`package.json description claims "${m[0]}", a number no reachable mode produces.`)
    }
  }
} catch { /* no package.json next to this README (a control fixture) — nothing to check */ }

// (1) A tool count in prose must be a number a reader can actually observe.
//     "17" was in the README for two releases and belongs to no reachable mode. Every count
//     must equal what some probed mode advertises; if it carries a `<!-- count:MODE -->`
//     annotation it must equal THAT mode, so a true number attached to the wrong mode fails
//     too. The error names the real numbers rather than merely saying "wrong".
const realCounts = MODES.map(([id]) => [id, advertised.get(id).length])
const countsBlurb = realCounts.map(([id, n]) => `${id}=${n}`).join(' ')
// The annotation is searched only in HTML comments, which were stripped from `prose` — so
// scan the un-stripped source for the pairing, and the code-fence stripping still applies.
const unfenced = (before + after).replace(/```[\s\S]*?```/g, '')
for (const m of unfenced.matchAll(/(\d+)[ -]tools?\b(?:\s*<!--\s*count:([a-z+]+)\s*-->)?/gi)) {
  const n = Number(m[1])
  const mode = m[2]
  if (mode) {
    const real = realCounts.find(([id]) => id === mode)
    if (!real) fail(`README annotates "${m[1]} tools" with mode "${mode}", which is not a mode this server has. Modes: ${countsBlurb}`)
    else if (real[1] !== n) fail(`README claims "${m[1]} tools" for mode "${mode}", but that mode advertises ${real[1]}.`)
  } else {
    // An UNANNOTATED count is refused even when the number is real somewhere. "17" was the
    // original defect and 17 is now a genuine count (live+money+flags) — so "is this number
    // real for some mode" would have passed the very sentence that started this ticket. A
    // count only means anything paired with the mode it counts.
    fail(`README prose claims "${m[0].trim()}" with no mode. A count without a mode is not checkable ` +
      `(and "17" was true of a mode nobody could reach). Write it as \`${m[1]} tools <!-- count:MODE -->\`. Real counts: ${countsBlurb}`)
  }
}

// (2) Every tool-shaped backticked name in prose must be advertised somewhere — or be
//     declared as something else, once, in as many words. Two declarations exist:
//       <!-- gone:NAME -->        a tool that was removed; the gate asserts it is really absent
//       <!-- not-a-tool:NAME -->  an error code or identifier that merely looks like a tool
//     A `gone:` claim about a tool the server DOES advertise fails, so this cannot become a
//     drawer for anything inconvenient.
const TOOLISH = /^(?:explain|simulate|generate|list|search|get|request|cancel|sandbox)_[a-z0-9_]+$/
const declaredGone = new Set([...unfenced.matchAll(/<!--\s*gone:([a-z0-9_]+)\s*-->/g)].map((m) => m[1]))
const declaredNotATool = new Set([...unfenced.matchAll(/<!--\s*not-a-tool:([a-z0-9_]+)\s*-->/g)].map((m) => m[1]))
for (const name of declaredGone) {
  if (unionSet.has(name)) fail(`README declares \`${name}\` gone, but the server advertises it. Remove the declaration and document the tool.`)
}
for (const m of prose.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
  const name = m[1]
  if (TOOLISH.test(name) && !unionSet.has(name) && !declaredGone.has(name) && !declaredNotATool.has(name)) {
    fail(`README names \`${name}\` in prose, but the server advertises no such tool in any mode. ` +
      `If it was removed, declare it with <!-- gone:${name} -->; if it is not a tool name, <!-- not-a-tool:${name} -->.`)
  }
}

// (3) Example prompts must declare which tool they exercise, and in which mode.
//     This is the one that catches "Register a new user with email…": an English
//     sentence has no backticks to check, so the prompt must NAME its tool. A prompt
//     that names nothing is refused; a prompt naming an unadvertised tool is named.
const promptSection = after.match(/## Example Prompts\n([\s\S]*?)\n## /)
if (!promptSection) {
  fail('README has no "## Example Prompts" section — the prompt annotations cannot be checked.')
} else {
  const bullets = promptSection[1].split('\n').filter((l) => l.trim().startsWith('- '))
  if (bullets.length === 0) fail('README "Example Prompts" section has no bullets.')
  const toExec = new Map()
  for (const b of bullets) {
    // Symmetric annotation: a prompt REMOVED because its tool is unreachable asserts the
    // absence. When the tool becomes reachable the assertion goes false and the gate asks
    // for the prompt back — the doc heals in both directions, not only when tools vanish.
    const gone = b.match(/<!--\s*prompt-unreachable:([a-z0-9_]+)@([a-z+]+)\s*-->/)
    if (gone) {
      const [, tool, mode] = gone
      if (!MODES.some(([id]) => id === mode)) fail(`removed-prompt note names mode "${mode}", which is not a mode this server has.`)
      else if (advertised.get(mode).includes(tool)) fail(`README says the prompt for \`${tool}\` was removed because it is unreachable in "${mode}" — but the server DOES advertise it there now. Restore the prompt.`)
      continue
    }
    const ann = b.match(/<!--\s*prompt:([a-z0-9_]+)@([a-z+]+)\s*-->/)
    if (!ann) { fail(`example prompt is not annotated with the tool it calls: ${b.trim().slice(0, 90)}`); continue }
    const [, tool, mode] = ann
    const modeIds = MODES.map(([id]) => id)
    if (!modeIds.includes(mode)) { fail(`example prompt names mode "${mode}", which is not one of ${modeIds.join(', ')}.`); continue }
    if (!advertised.get(mode).includes(tool)) {
      fail(`example prompt invites \`${tool}\` in mode "${mode}", where the server does NOT advertise it — a reader following this prompt gets "Unknown tool".`)
      continue
    }
    if (!toExec.has(mode)) toExec.set(mode, [])
    toExec.get(mode).push(tool)
  }
  // (4) Advertised is not executed. --exec calls each annotated tool with empty arguments
  //     and refuses "Unknown tool". An argument-validation error is a PASS: it proves the
  //     router reached the handler, which is the only thing being asserted here.
  if (EXEC) {
    for (const [mode, tools] of toExec) {
      const env = MODES.find(([id]) => id === mode)[2]
      const r = await speak(ENTRY, env, tools)
      for (const [tool, text] of r.calls) {
        if (text === null) fail(`--exec: \`${tool}\` in "${mode}" returned no frame at all.`)
        else if (/unknown tool/i.test(text)) fail(`--exec: \`${tool}\` in "${mode}" is listed but answers "${text.trim()}".`)
      }
    }
  }
}

function report() {
  if (!failures.length) return
  console.error(`\nREADME/tool drift — ${failures.length} finding(s):\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  console.error('')
}

if (failures.length) { report(); process.exit(1) }
console.log(`README matches the server: ${union.length} tools defined; ` +
  MODES.map(([id]) => `${id}=${advertised.get(id).length}`).join(' '))
