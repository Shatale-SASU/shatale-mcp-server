#!/usr/bin/env node
// A change to the shipped code must say what changed.
//
// ⚠️ THIS EXISTS BECAUSE THE SAME OMISSION HAPPENED TWICE, TO TWO DIFFERENT PEOPLE. The 1.0.3 release
// commit had to write the missing entries for #51 and #50 after the fact. Then 1.0.4 had to write
// them again for #56, #57 and #58: the `[Unreleased]` section was EMPTY while three merged pull
// requests sat unreleased — a new user-facing tool pair, an idempotency change across five write
// tools, and the publish guard itself. All three would have reached the registry unannounced.
//
// Twice is not inattention. Twice is a missing instrument: nothing asked the question, so the answer
// depended on whoever happened to remember. Writing the entries by hand fixes the release; it does
// not fix the next one.
//
// ── THE RULE, AND WHY IT IS THIS NARROW ───────────────────────────────────────
//
// A change under src/ must come with a change to CHANGELOG.md. That is all.
//
// The scope is deliberately small. A guard that also fired on tests, scripts, workflows or the README
// would be red on most pull requests in this repository, and a check that cries on ordinary work gets
// switched off — correctly, by someone with a deadline. src/ is what npm ships; everything else is
// how we build it.
//
// ⚠️ AND AN INTERNAL-ONLY CHANGE IS NOT AN EXCEPTION, IT IS A ONE-LINE ENTRY. The temptation is to
// exempt refactors, and the exemption is exactly where the next miss hides: whether a change is
// user-visible is a judgment the author makes about their own work, and every one of the five misses
// above was made by someone who thought so too. Writing "internal: X, no behaviour change" costs a
// line and leaves a record. The rule stays mechanical because judgments are what failed.

import { execFileSync } from 'node:child_process';

/** Files whose change obliges an entry. */
const SHIPPED = /^src\//;

/** The file that has to move with them. */
const CHANGELOG = 'CHANGELOG.md';

/**
 * verdict decides on a list of changed paths. Pure, so the controls can feed it synthetic sets and
 * prove it DISCRIMINATES without a git repository — the same discipline the README gate's controls
 * follow.
 *
 * @param {string[]} changed
 * @returns {{ok: boolean, shipped: string[], reason: string}}
 */
export function verdict(changed) {
  const shipped = changed.filter((f) => SHIPPED.test(f));
  if (shipped.length === 0) {
    return { ok: true, shipped, reason: 'no shipped code changed' };
  }
  if (changed.includes(CHANGELOG)) {
    return { ok: true, shipped, reason: 'shipped code changed and the changelog moved with it' };
  }
  return {
    ok: false,
    shipped,
    reason: `shipped code changed and ${CHANGELOG} did not`,
  };
}

// ── Run mode ──────────────────────────────────────────────────────────────────
//
// Invoked as `node scripts/a-code-change-must-say-what-changed.mjs <base-ref>`, it asks git what
// changed between the merge base and HEAD. Invoked with `--files a b c`, it takes the list directly,
// which is how the controls drive it.

function changedFromGit(base) {
  // ⚠️ IMPORTED AT THE TOP, NOT REQUIRED HERE. The first version of this line used require() inside
  // an ES module and threw ReferenceError the first time the git path ran — a branch the unit
  // controls never reach, because they import verdict() and never this. Found by RUNNING it, which is
  // the only way an untested branch is ever found.
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function main(argv) {
  let changed;
  const filesAt = argv.indexOf('--files');
  if (filesAt !== -1) {
    changed = argv.slice(filesAt + 1);
  } else {
    const base = argv[0];
    if (!base) {
      console.error('usage: a-code-change-must-say-what-changed.mjs <base-ref> | --files <paths...>');
      process.exit(2);
    }
    changed = changedFromGit(base);
    // ⚠️ AN EMPTY DIFF IS NOT A PASS, IT IS AN UNANSWERED QUESTION. A shallow clone, a wrong base ref
    // or a detached HEAD all produce zero changed files, and zero changed files satisfies this check
    // perfectly. Refusing here is the difference between "nothing shipped changed" and "I could not
    // see what changed".
    if (changed.length === 0) {
      console.error(
        `::error::no changed files between ${base} and HEAD.\n` +
          'That is almost certainly a shallow checkout or the wrong base ref, not an empty pull\n' +
          'request — and an empty answer passes this check for the wrong reason. Fetch enough\n' +
          'history (fetch-depth: 0) and pass the pull request base SHA.',
      );
      process.exit(1);
    }
  }

  const v = verdict(changed);
  if (v.ok) {
    console.log(`ok — ${v.reason} (${changed.length} files changed)`);
    return;
  }

  console.error(`::error::${v.reason}.`);
  console.error('');
  console.error('  changed under src/:');
  for (const f of v.shipped) console.error(`    ${f}`);
  console.error('');
  console.error('src/ is what npm ships. A change there that says nothing reaches the registry');
  console.error('unannounced, and the person installing it has no way to learn what moved — which is');
  console.error('what happened to #51, #50, #56, #57 and #58, twice over two releases.');
  console.error('');
  console.error('Add a line under ## [Unreleased] in CHANGELOG.md. If the change is internal, say');
  console.error('that: "internal: X, no behaviour change" is a valid entry and takes one line.');
  console.error('Exempting refactors is where the next miss would hide — every one of the five above');
  console.error('was made by somebody who judged their change too small to mention.');
  process.exit(1);
}

// Only run when executed, not when imported by the controls.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
