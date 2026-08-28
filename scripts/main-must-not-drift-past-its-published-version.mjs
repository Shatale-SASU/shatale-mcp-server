#!/usr/bin/env node
// main must not carry unreleased shipped code under an already-published version number.
//
// ⚠️ THIS IS THE SECOND HALF OF ONE INSTRUMENT, NOT A BACKUP FOR THE FIRST.
//
// a-code-change-must-say-what-changed.mjs runs on pull requests: it asks "did somebody just create a
// divergence?". It therefore cannot see a divergence that ALREADY EXISTS — anything merged before the
// guard existed, or arriving by any route other than a pull request, is invisible to it for ever.
// Tonight's defect is exactly that case: three commits sat on main past the published tag, and the PR
// guard would never fire on them, because the pull requests that created them are closed.
//
// A guard that physically cannot fire on the only known instance of the defect it names is
// indistinguishable from an absent one.
//
// ── AND WHY BOTH, RATHER THAN THE CHEAPER ONE ─────────────────────────────────
//
// The empty [Unreleased] section and the un-bumped version were not two independent oversights. They
// are one: the same person writes both entries at the same moment, and forgets them together. So a
// guard closing one half does not halve the chance of the other — it does not reduce it at all,
// because the cause is shared.
//
// TWO SYMPTOMS OF ONE FORGETFULNESS CANNOT BE INSURED BY ONE GUARD.
//
// ── THE QUESTION IT ASKS ──────────────────────────────────────────────────────
//
// Is there shipped code on main that is newer than the newest published tag, while package.json still
// claims that tag's version? If so, the number on main and the number on npm describe DIFFERENT
// CONTENT — which is precisely how 1.0.3 came to mean two things, and why nobody installing it could
// tell.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * verdict is the decision, kept pure so the controls can prove it discriminates without a repository.
 *
 * @param {{packageVersion: string, latestTagVersion: string|null, shippedChangedSinceTag: number}} state
 */
export function verdict({ packageVersion, latestTagVersion, shippedChangedSinceTag }) {
  if (latestTagVersion === null) {
    return { ok: true, reason: 'no published tag to compare against' };
  }
  if (shippedChangedSinceTag === 0) {
    return { ok: true, reason: `nothing under src/ has changed since v${latestTagVersion}` };
  }
  if (packageVersion !== latestTagVersion) {
    return {
      ok: true,
      reason: `shipped code changed since v${latestTagVersion} and the version has already moved to ${packageVersion}`,
    };
  }
  return {
    ok: false,
    reason:
      `main carries ${shippedChangedSinceTag} changed file(s) under src/ since v${latestTagVersion}, ` +
      `and package.json still says ${packageVersion}`,
  };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** The newest tag by version order, or null when there is none. */
function newestVersionTag() {
  const out = git('tag', '--list', 'v[0-9]*', '--sort=-v:refname');
  const first = out.split('\n').filter(Boolean)[0];
  return first ?? null;
}

function main() {
  const tag = newestVersionTag();
  if (tag === null) {
    // ⚠️ NO TAGS IS NOT A PASS WHEN TAGS ARE THE SUBJECT. A shallow clone has none, and "no tags"
    // then means "I cannot see" rather than "there are none" — the same distinction that let a
    // published package and a repository disagree unnoticed.
    console.error(
      '::error::no version tags visible. This check compares main against the newest published tag,\n' +
        'and a shallow checkout has no tags at all — so an answer here would be about the clone, not\n' +
        'about main. Use fetch-depth: 0.',
    );
    process.exit(1);
  }

  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const changed = git('diff', '--name-only', `${tag}...HEAD`).split('\n').filter(Boolean);
  const shipped = changed.filter((f) => f.startsWith('src/'));

  const v = verdict({
    packageVersion,
    latestTagVersion: tag.replace(/^v/, ''),
    shippedChangedSinceTag: shipped.length,
  });

  if (v.ok) {
    console.log(`ok — ${v.reason}`);
    return;
  }

  console.error(`::error::${v.reason}.`);
  console.error('');
  console.error('  shipped files changed since the tag:');
  for (const f of shipped.slice(0, 20)) console.error(`    ${f}`);
  if (shipped.length > 20) console.error(`    … and ${shipped.length - 20} more`);
  console.error('');
  console.error('The number on main and the number on npm now describe DIFFERENT CONTENT. Anybody who');
  console.error(`installs ${packageVersion} receives the older code and has no way to notice, because`);
  console.error('the version is the only thing they can compare and it matches.');
  console.error('');
  console.error('That is not hypothetical: shatale-mcp-server@1.0.3 was published without three merged');
  console.error('pull requests, and the published tarball announced 17 tools where main announced 19.');
  console.error('');
  console.error('Bump the version and write the changelog entries, then tag and publish.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
