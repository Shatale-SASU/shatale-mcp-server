import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * /!\ `test:public` WAS A HAND-TYPED LIST OF FILENAMES, AND IT DID NOT NEED TO EXIST AT ALL.
 *
 * It is the only suite that gates a pull request: ci-public.yml runs it on push and pull_request
 * with no API key, while ci-sandbox.yml is workflow_dispatch-only and nightly.yml runs at 03:00 —
 * and both of those refuse to start without SHATALE_TEST_KEY.
 *
 * Measured before this change: 19 test files on disk, 12 in the list. Four of the seven left out
 * needed no key at all —
 *
 *     tests/unit/checkout-tools.test.ts
 *     tests/unit/credential-idempotency-window.test.ts     <- the SHAT-1686 regression test
 *     tests/unit/purchase-redact.test.ts
 *     tests/unit/sandbox-card-enum.test.ts
 *
 * 36 assertions, fully deterministic, and not one of them could turn a pull request red. One is the
 * regression test for a money bug fixed the same week — an hour-grid idempotency key handing out two
 * live credentials at the boundary. It was watching no merge.
 *
 * /!\ AND THEN THE MEASUREMENT CHANGED THE ANSWER. My first fix added the four to the list and wrote
 * a guard so the list could not drift again. My second attempt DERIVED the list, excluding files
 * that mention SHATALE_TEST_KEY. Running that showed it excluding three files the hand-written list
 * had always included — because those mention the variable only to SKIP on it.
 *
 * So I ran the whole suite with no key at all:
 *
 *     Test Files  17 passed | 2 skipped (19)
 *     Tests      159 passed | 27 skipped (186)      22 seconds, twice, identical
 *
 * ⇒ EVERY key-requiring test already skips itself cleanly. The list, the guard and the classifier
 * were all solving a problem that no longer existed — presumably since SHAT-1449 taught these tests
 * to skip, at which point the split stopped being load-bearing and nobody noticed.
 *
 * `test:public` is now `vitest run`. No list to drift, no classifier with a blind spot, nothing for
 * a new test file to be forgotten by — and coverage goes UP, from 13 files to 19.
 *
 * THIS TEST IS WHAT STOPS THE SPLIT COMING BACK. If a future test cannot run without a key, it must
 * SKIP rather than fail, because the alternative — reintroducing a curated list — is the defect
 * above, and it returns silently.
 */

const repoRoot = resolve(__dirname, "..", "..");

describe("the gating suite needs no curated list (SHAT-1325)", () => {
  it("test:public runs everything", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const script: string = pkg.scripts?.["test:public"] ?? "";

    expect(
      script,
      `test:public is "${script}". If it has become a list of filenames again, every test written ` +
        `after that list was typed runs in NO workflow that can block a merge — and the exclusion ` +
        `is indistinguishable from coverage. Measured when this was last true: four deterministic ` +
        `files were outside it, including the SHAT-1686 regression test for a money bug.\n\n` +
        `Every key-requiring test in this repo skips itself without a key (17 passed, 2 skipped, 0 ` +
        `failed with no key set), so the suite does not need curating. If a new test CANNOT skip, ` +
        `make it skip — do not reintroduce the list.`,
    ).not.toMatch(/tests\//);

    expect(script).toContain("vitest run");
  });

  // /!\ THERE WAS A SECOND TEST HERE AND I DELETED IT, WHICH IS THE MORE USEFUL HALF OF THIS FILE.
  //
  // It walked every test file, and for each one mentioning SHATALE_TEST_KEY it required a visible
  // skip guard — so that a file which would THROW without a key could not quietly force the next
  // person to curate a list of "safe" tests again. Reasonable, and wrong.
  //
  // It flagged six files. All six are correctly guarded; they simply spell it
  // `const describeIfKey = TEST_KEY ? describe : describe.skip`, which my regex — looking for
  // `skipIf`, `.skip(`, `hasKey` — did not match. A guard that cries on honest code gets disabled,
  // and this one would have deserved it.
  //
  // The deeper reason not to fix the regex: it was inferring FROM TEXT something the RUNTIME already
  // demonstrates. ci-public.yml runs this whole suite with no key on every push and pull request. A
  // file that fails without one turns that job red, by name, immediately — which is a better
  // detector than any pattern over source, and it cannot be fooled by an idiom nobody thought of.
  //
  // Measured, twice, identically: 17 passed | 2 skipped (19 files), 159 passed | 27 skipped, 0
  // failed, ~22s. That IS the assertion; it just lives in the workflow rather than here.
});
