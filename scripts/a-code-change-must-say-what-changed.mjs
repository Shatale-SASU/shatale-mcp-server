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

/**
 * emptyDiffCause names WHY a pull request produced zero changed files. It never turns the empty
 * answer into a pass — it only stops the refusal from naming the wrong cause.
 *
 * ⚠️ THE OLD MESSAGE HAD ONE CAUSE AND IT MISLED A TICKET (SHAT-3456, 17.09.2026). It said "almost
 * certainly a shallow checkout or the wrong base ref". PR #77's run refused with that text, and the
 * ticket filed from it prescribed `fetch-depth: 0` — which the workflow had carried since 28.08. The
 * run's own log shows a full fetch (`+refs/heads/*`) and the merge ref. What actually happened:
 * #77's content had already been squash-merged as #73, so the merge ref had the SAME TREE as its base
 * and the pull request changed nothing. The zero was true, and the message sent the reader to the
 * checkout.
 *
 * So the causes are told apart by what can be measured, not guessed:
 *   - base commit ABSENT from the clone → shallow checkout or a wrong base ref;
 *   - base present, and the tree at HEAD equals the tree at base → the pull request changes nothing
 *     (typically: its content is already on the base branch, e.g. squash-merged earlier);
 *   - base present, trees differ, yet base...HEAD lists nothing → the merge base is not what the
 *     caller assumed; named as such rather than folded into one of the other two.
 *
 * @param {{baseExists: boolean, treeChanges: number}} m
 * @returns {{cause: 'missing-base'|'nothing-changes'|'unexpected-merge-base', message: string}}
 */
export function emptyDiffCause({ baseExists, treeChanges }) {
  if (!baseExists) {
    return {
      cause: 'missing-base',
      message:
        'the base commit is not in this clone — a shallow checkout or a wrong base ref.\n' +
        'Fetch enough history (fetch-depth: 0) and pass the pull request base SHA.',
    }
  }
  if (treeChanges === 0) {
    return {
      cause: 'nothing-changes',
      message:
        'the base commit IS present, and HEAD has the same tree as the base: this pull request\n' +
        'changes nothing. Most often its content is already on the base branch (squash-merged\n' +
        'before). This is not a checkout problem — check whether the pull request is a duplicate.',
    }
  }
  return {
    cause: 'unexpected-merge-base',
    message:
      `the base commit is present and the trees differ by ${treeChanges} file(s), yet base...HEAD\n` +
      'lists none: the merge base is not the commit this check was given. Pass the pull request\n' +
      'base SHA, and check that HEAD is the merge ref rather than an unrelated commit.',
  }
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

function baseIsPresent(base) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function measureEmptyDiff(base) {
  const baseExists = baseIsPresent(base);
  if (!baseExists) return { baseExists, treeChanges: 0 };
  // Two dots: the TREE difference between base and HEAD, which is what the merge ref would change.
  const out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' });
  return { baseExists, treeChanges: out.split('\n').filter(Boolean).length };
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
    // ⚠️ THE BASE IS CHECKED BEFORE THE DIFF, NOT AFTER IT. Measured 17.09.2026: with the base commit
    // absent, `git diff base...HEAD` does not return an empty list — it throws ("Invalid symmetric
    // difference expression") and the step dies on a stack trace. So the "shallow checkout" message
    // this file carried since 28.08 could never actually be printed for a shallow checkout: the one
    // case it named was the one case that never reached it.
    if (!baseIsPresent(base)) {
      const c = emptyDiffCause({ baseExists: false, treeChanges: 0 });
      console.error(`::error::cannot compare ${base} with HEAD — ${c.cause}.\n${c.message}`);
      process.exit(1);
    }
    changed = changedFromGit(base);
    // ⚠️ AN EMPTY DIFF IS NOT A PASS, IT IS AN UNANSWERED QUESTION. A shallow clone, a wrong base ref
    // or a pull request that changes nothing all produce zero changed files, and zero changed files
    // satisfies this check perfectly. It still refuses — but now says WHICH of those it measured.
    if (changed.length === 0) {
      const c = emptyDiffCause(measureEmptyDiff(base));
      console.error(`::error::no changed files between ${base} and HEAD — ${c.cause}.\n${c.message}`);
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
