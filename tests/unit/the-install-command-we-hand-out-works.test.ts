import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * /!\ THE SERVER WAS TELLING AGENTS TO INSTALL A PACKAGE THAT DOES NOT EXIST.
 *
 * `shatale://guides/quickstart` — an MCP resource, served to whatever model is driving this server —
 * said `npx @shatale/mcp-server`. That package 404s. The published one is `shatale-mcp-server`,
 * unscoped, and package.json has said so all along.
 *
 * The same wrong name was in smithery.yaml's commandFunction, so every Smithery install ran the 404
 * too, and in `src/resources/guides.ts`, a third copy of the whole quickstart that NOTHING IMPORTS —
 * dead code that compiled into dist/ and shipped, guaranteeing the copies would drift.
 *
 * /!\ THIS IS THE SAME STRING THAT COST TWO PEOPLE HOURS IN THE MONOREPO. A two-file stub in
 * apps/concierge called itself `@shatale/mcp-server` in its package.json and was believed over npm,
 * for four months (SHAT-2549/2550). Here the name was not merely believed — it was HANDED OUT, by
 * the real server, as the command to run.
 *
 * /!\ AND THE UNLOCK INSTRUCTION SHOWN TO EVERY GUEST DID NOT WORK EITHER:
 *
 *     npx shatale-mcp-server --env SHATALE_API_KEY=sk_sandbox_xxx
 *
 * `npx` has no `--env` flag. The arguments landed in the server's own argv, which nothing reads.
 * Measured: pasting the key exactly as instructed left the session in guest mode with 7 tools and NO
 * ERROR ANYWHERE — the failure of a working key looked identical to not having one.
 *
 * This guard is about NAMES AND COMMANDS WE HAND TO SOMEBODY ELSE. Those are the ones nobody can
 * check against reality from inside the process: a wrong internal identifier breaks a build, a wrong
 * install command breaks somebody else's afternoon and reports nothing back to us.
 */

import { walkRepoFiles } from "../harness/repoWalk.js";

const repoRoot = resolve(__dirname, "..", "..");

/**
 * Every text file we author, so a name cannot come back in a corner nobody greps.
 *
 * ⚠️ THE SKIP LIST MOVED TO tests/harness/repoWalk.ts, AND THAT IS THE POINT OF SHAT-2713. It was
 * learned HERE, by this test going red on a clean main because it had descended into a git worktree
 * under .claude/ and read a second copy of its own source. An exclusion that lives in the one file
 * that was bitten protects that file; the next sweep somebody writes starts from the four obvious
 * names again and meets the same copy.
 */
function authoredFiles(): string[] {
  return walkRepoFiles(
    repoRoot,
    (name) => /\.(ts|js|mjs|json|yaml|yml|md)$/.test(name) && name !== "package-lock.json",
  );
}

const SELF = "tests/unit/the-install-command-we-hand-out-works.test.ts";

/**
 * /!\ TWO EXEMPTIONS, BOTH DELIBERATE, BOTH NARROW — and a guard that flagged either one would be
 * switched off within the week for crying about honest text.
 *
 * `Discussions/` is a RECORD OF WHAT WAS SAID. Editing it to remove a wrong package name would be
 * falsifying a minute, and the record is the more valuable for containing the mistake: the June
 * council log names this exact fix — "`@shatale/mcp-server` 404 → `shatale-mcp-server` is real
 * user-facing breakage; do not hold" — and it sat undone for two and a half months.
 *
 * A COMMENT is prose about code, not an instruction to a package manager. The explanation of why a
 * dead name is dead necessarily contains the dead name. Same conflation as the monorepo's
 * table_ownership guard, which records a table as written by main.go on the strength of a
 * commented-out statement.
 *
 * The blind spot that buys: a LIVE instruction hidden after a comment marker on the same line. No
 * such form exists — a yaml `args:` entry, an import, or a fenced shell command cannot begin with
 * `//`, `*` or `#`.
 */
function isProse(rel: string, line: string): boolean {
  if (rel.startsWith("Discussions/")) return true;
  const s = line.trim();
  return ["//", "*", "/*", "#", "<!--"].some((m) => s.startsWith(m));
}

function hits(needle: string): string[] {
  const found: string[] = [];
  for (const rel of authoredFiles()) {
    if (rel === SELF) continue;
    const lines = readFileSync(resolve(repoRoot, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(needle) && !isProse(rel, line)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("the install commands we hand to other people are real (SHAT-2527)", () => {
  // /!\ POSITIVE CONTROL FIRST. Every assertion here is an absence, and a walk that reads nothing
  // satisfies all of them at once, permanently and silently.
  it("the walk reads this repository", () => {
    const files = authoredFiles();
    expect(files.length, "the file walk found nothing — the search is broken, not the repo").toBeGreaterThan(20);
    expect(
      hits("shatale-mcp-server").length,
      "the REAL package name appears nowhere, which cannot be true — package.json is named that. " +
        "The line scan is broken and every absence below is vacuous.",
    ).toBeGreaterThan(0);

    // ⚠️ AND IT MUST READ THE RIGHT PLACES, NOT MERELY ENOUGH OF THEM (SHAT-2713). A count passes on
    // twenty files from anywhere, and the fix for that ticket ADDED a skip rule — so the failure it
    // invites is a rule one entry too wide, emptying the sweep of the very tree under test. Named
    // directories, not a threshold.
    expect(
      files.some((f) => f.startsWith("src/")),
      `the sweep found no file under src/. The shipped code is the subject, so skipping it makes ` +
        `every absence assertion below vacuously true. ${files.length} files were seen.`,
    ).toBe(true);
    expect(files, "the sweep no longer reads this test's own source").toContain(SELF);
  });

  it("the scoped name that 404s is nowhere in the tree", () => {
    // The stub in the monorepo claimed this name for four months and was believed over npm. It is
    // not an internal identifier we could rename at will; it is an instruction to a package manager.
    expect(
      hits("@shatale/mcp-server"),
      "`@shatale/mcp-server` is back. That package does not exist on npm — installing it 404s. The " +
        "published one is `shatale-mcp-server`, UNSCOPED (see package.json `name`). If it appears in " +
        "an MCP resource or in smithery.yaml it is not a typo in a document: it is an install " +
        "command this server hands to somebody else, and they get the 404, not us.",
    ).toEqual([]);
  });

  it("no `npx --env` instruction, because npx has no --env flag", () => {
    expect(
      hits("npx shatale-mcp-server --env"),
      "an instruction of the form `npx shatale-mcp-server --env KEY=value` is back. npx has no " +
        "--env flag; the arguments land in the server's argv, which nothing reads. Measured: a user " +
        "who pastes a valid key exactly as instructed stays in GUEST mode with no error anywhere — " +
        "a working key fails in a way indistinguishable from having no key. The form that works is " +
        "`SHATALE_API_KEY=... npx shatale-mcp-server`.",
    ).toEqual([]);
  });

  it("the repository we point people at is the one that exists", () => {
    expect(
      hits("solskiysb/shatale-mcp-server"),
      "a pre-transfer repository path is back. The repo is Shatale-SASU/shatale-mcp-server. This " +
        "matters beyond tidiness in docs/key-rotation.md, where the path is an argument to " +
        "`gh secret set --repo` — following that runbook writes the new key to the wrong repository " +
        "and leaves this one on the old one, with no error.",
    ).toEqual([]);
    expect(
      hits("github.com/shatale/mcp-server"),
      "the non-existent `shatale/mcp-server` GitHub path is back — it was served to agents as a " +
        "documentation link from the quickstart resource.",
    ).toEqual([]);
  });

  // /!\ AND THE PROSE RULE NEEDS ITS OWN CONTROL IN BOTH DIRECTIONS, or the guard could be silenced
  // by accident: an isProse that returned true for everything would leave every assertion above
  // green while reading nothing at all.
  it("the prose rule separates a record from an instruction", () => {
    const prose: [string, string][] = [
      ["Discussions/2026-06-09_council.md", "- Install-command fix (`@shatale/mcp-server` 404) is real breakage"],
      ["src/stdio-hardening.ts", " * a stub that called itself `@shatale/mcp-server`"],
      ["README.md", "<!-- the old @shatale/mcp-server name -->"],
    ];
    const instructions: [string, string][] = [
      ["smithery.yaml", '      args: ["@shatale/mcp-server"],'],
      ["src/index.ts", "npx @shatale/mcp-server"],
      ["docs/key-rotation.md", "     --repo solskiysb/shatale-mcp-server"],
    ];
    for (const [rel, line] of prose) {
      expect(isProse(rel, line), `treated as an instruction, should be a record: ${rel} — ${line}`).toBe(true);
    }
    for (const [rel, line] of instructions) {
      expect(
        isProse(rel, line),
        `treated as prose, should be an INSTRUCTION: ${rel} — ${line}. This is a command somebody ` +
          `else runs, and the guard would wave it through.`,
      ).toBe(false);
    }
  });

  // /!\ THE DEAD COPIES, which are how a name comes back after being fixed once. src/resources/
  // guides.ts and src/prompts/scenarios.ts each held a full second copy of text that index.ts also
  // has inline, and nothing imported either — so fixing the live copy left the dead one wrong, and a
  // later "let's use these properly" would resurrect it.
  it("the unimported duplicate copies stay deleted", () => {
    for (const dead of ["src/resources/guides.ts", "src/prompts/scenarios.ts"]) {
      expect(
        existsSync(resolve(repoRoot, dead)),
        `${dead} is back. It held a second copy of text index.ts already carries inline, and nothing ` +
          `imported it — so it compiled into dist/, shipped unused, and drifted out of step with the ` +
          `live copy. That is how the 404 package name survived being fixed once. If this content is ` +
          `wanted, have index.ts IMPORT it, so there is one copy and a rename reaches all of it.`,
      ).toBe(false);
    }
  });
});
