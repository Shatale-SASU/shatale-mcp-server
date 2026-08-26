import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ⚠️ FOUR TEST FILES RAN NOWHERE THAT COULD BLOCK A MERGE, AND NOTHING SAID SO.
 *
 * `test:public` is the only suite that gates a pull request: ci-public.yml runs it on push and PR
 * with no API key. The other two workflows both refuse to start without SHATALE_TEST_KEY —
 * ci-sandbox.yml is workflow_dispatch only, and nightly.yml runs at 03:00 UTC, after the merge.
 *
 * And `test:public` is a HAND-WRITTEN LIST of filenames in package.json. Measured before this guard
 * was written: 19 test files on disk, 12 in the list, and four of the seven left out need no key at
 * all —
 *
 *     tests/unit/checkout-tools.test.ts
 *     tests/unit/credential-idempotency-window.test.ts
 *     tests/unit/purchase-redact.test.ts
 *     tests/unit/sandbox-card-enum.test.ts
 *
 * — 36 assertions, 266ms, fully deterministic, and none of them could ever turn a pull request red.
 *
 * ⚠️ ONE OF THEM IS THE REGRESSION TEST FOR A MONEY BUG WE FIXED THIS WEEK.
 * credential-idempotency-window covers SHAT-1686, where an hour-grid idempotency key handed out two
 * live credentials at the boundary. The test that proves it stays fixed was not watching any merge.
 *
 * ⚠️ AND NOTHING WAS WRONG WITH ANY OF THOSE FILES. They were written, they passed, and they were
 * simply never added to a list somebody has to remember to edit. That is the whole failure: a
 * suite defined by enumeration silently excludes everything written after it, and the exclusion
 * looks exactly like coverage — `npm test` locally runs all 19, so the author sees green.
 *
 * This test replaces the remembering. A new deterministic test file is either in the gating suite
 * or this goes red naming it.
 *
 * ⚠️ THE HEURISTIC, AND ITS BLIND SPOT, STATED. "Needs a live key" is decided by whether the file
 * mentions SHATALE_TEST_KEY. That is a text match: a file that names it only in a comment would be
 * excused wrongly, and one that reaches a live API through some other variable would be demanded
 * wrongly. It is the same signal the workflows themselves gate on, so it cannot disagree with them
 * about which suite a file belongs to — and the failure message asks for the reason rather than
 * assuming, because the answer is a decision.
 */

const repoRoot = resolve(__dirname, "..", "..");

function publicSuiteFiles(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const script: string = pkg.scripts?.["test:public"] ?? "";
  return script.split(/\s+/).filter((t) => t.startsWith("tests/"));
}

// readdirSync({recursive:true}) rather than fs.globSync: globSync landed in Node 22 and the
// workflows run Node 20, so it would be undefined exactly where this guard is supposed to work.
function allTestFiles(): string[] {
  return readdirSync(resolve(repoRoot, "tests"), { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".test.ts"))
    .map((p) => "tests/" + p.split("\\").join("/"))
    .sort();
}

function needsLiveKey(relPath: string): boolean {
  return readFileSync(resolve(repoRoot, relPath), "utf8").includes("SHATALE_TEST_KEY");
}

describe("the gating suite covers every test that can gate (SHAT-1325)", () => {
  // ⚠️ POSITIVE CONTROL FIRST. Everything below is of the form "no file is missing from the list",
  // and if the glob or the package.json read broke, that is exactly what an empty result looks like.
  it("can see both the test files and the list", () => {
    const files = allTestFiles();
    const listed = publicSuiteFiles();
    expect(
      files.length,
      "the glob found no test files — the search is broken, not the repo, and every assertion " +
        "below would pass while measuring nothing",
    ).toBeGreaterThan(10);
    expect(
      listed.length,
      "package.json's test:public script parsed to no test paths — it was renamed or its shape " +
        "changed, and this guard is now comparing against an empty list, which excuses everything",
    ).toBeGreaterThan(5);
  });

  it("every deterministic test file is in test:public", () => {
    const listed = new Set(publicSuiteFiles());
    const orphans = allTestFiles().filter((f) => !listed.has(f) && !needsLiveKey(f));

    expect(
      orphans,
      `these test files need no live key and are NOT in test:public, so they run in NO workflow ` +
        `that can block a merge:\n  ${orphans.join("\n  ")}\n\n` +
        `ci-public.yml is the only suite on push and pull_request; ci-sandbox.yml is dispatch-only ` +
        `and nightly.yml runs at 03:00 UTC — both refuse to start without SHATALE_TEST_KEY. So a ` +
        `pull request breaking any of the above merges green, and the failure surfaces the next ` +
        `morning wearing somebody else's name.\n\n` +
        `Add them to the test:public script in package.json. If one genuinely cannot run without a ` +
        `live key, say so IN THE FILE — this guard reads SHATALE_TEST_KEY as that statement, which ` +
        `is the same signal the workflows gate on.`,
    ).toEqual([]);
  });

  // ⚠️ AND THE GUARD MUST NOT EXCUSE ITSELF, which it does for free and did on its first run.
  //
  // The heuristic asks whether a file mentions SHATALE_TEST_KEY. This file mentions it constantly —
  // in the function that reads it, in the failure message, in this very paragraph — so it classifies
  // itself as needing a live key and drops out of its own check. A guard that is not in the gating
  // suite is a guard nobody runs, which is the exact thing it was written to detect.
  //
  // Asserted by NAME rather than by relaxing the heuristic, because the heuristic is right about
  // every other file and the exception is one specific path.
  it("this guard is itself in the gating suite", () => {
    const self = "tests/unit/public-suite-covers-every-deterministic-test.test.ts";
    expect(
      publicSuiteFiles(),
      `${self} is not in test:public, so the check that every deterministic test gates a pull ` +
        `request does not itself gate one. It would go quiet the moment somebody removed a file ` +
        `from the list — which is the whole scenario.`,
    ).toContain(self);
  });

  // ⚠️ THE OTHER DIRECTION, and it is the half that fails silently. `vitest run <path>` on a file
  // that does not exist is an error, but a list that has drifted past a rename is the kind of thing
  // that gets "fixed" by deleting the entry — taking whatever it covered with it.
  it("test:public lists no file that has been renamed or deleted", () => {
    const missing = publicSuiteFiles().filter((f) => !existsSync(resolve(repoRoot, f)));
    expect(
      missing,
      `test:public names files that are not on disk:\n  ${missing.join("\n  ")}\n\n` +
        `They were renamed or deleted. Point the list at the new path rather than dropping the ` +
        `entry — a shorter list is not the same as a smaller job.`,
    ).toEqual([]);
  });
});
