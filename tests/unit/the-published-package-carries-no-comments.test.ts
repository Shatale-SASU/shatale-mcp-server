import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

// SHAT-8313 / SHAT-8333. Everything under dist/ is published to npm, and before removeComments a
// source comment travelled with it: an internal explanation became a public statement about how
// Shatale works (2.1.2 shipped one that was also false). The package carries code, not commentary.
// Read with the TypeScript scanner, so a "//" inside a string or a URL is not mistaken for a comment.

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, "..", "..", "dist")

function commentsIn(text: string): string[] {
  // Parsed, not scanned: a template literal like `https://${host}` or a regex is read as what it is,
  // and comments are collected from the real trivia around every token of the tree.
  const sf = ts.createSourceFile("x.js", text, ts.ScriptTarget.Latest, true)
  const seen = new Set<number>()
  const found: string[] = []
  const take = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue
      seen.add(r.pos)
      const c = text.slice(r.pos, r.end)
      // The one comment a compiler legitimately emits: the source-map pointer.
      if (!/^\/\/# sourceMappingURL=/.test(c)) found.push(c)
    }
  }
  const visit = (n: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, n.getFullStart()))
    take(ts.getTrailingCommentRanges(text, n.getEnd()))
    n.getChildren(sf).forEach(visit)
  }
  visit(sf)
  return found
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(js|d\.ts)$/.test(n) ? [p] : []
  })
}

describe("the published package carries no comments (SHAT-8333)", () => {
  it("the reader discriminates (controls on known text)", () => {
    expect(commentsIn("const a = 1 // note\n")).toEqual(["// note"])
    expect(commentsIn("/* block */ const a = 1\n")).toEqual(["/* block */"])
    expect(commentsIn("const u = \"https://x.test/a\"; const s = \"a // b\"\n")).toEqual([])
    expect(commentsIn("const a = 1\n//# sourceMappingURL=a.js.map\n")).toEqual([])
    expect(commentsIn("const h = 1; const u = `https://${h}/a`; const r = /a\\/\\/b/\n")).toEqual([])
    expect(commentsIn("const h = 1; const u = `https://${h}/a` // tail\n")).toEqual(["// tail"])
  })

  it("no file under dist/ carries a comment", () => {
    const files = walk(DIST)
    expect(files.length, "dist/ is empty — the build did not run, so nothing was checked").toBeGreaterThan(10)
    const offenders = files
      .map((f) => ({ f: relative(DIST, f), c: commentsIn(readFileSync(f, "utf8")) }))
      .filter((x) => x.c.length > 0)
      .map((x) => `${x.f}: ${x.c[0].slice(0, 80)}`)
    expect(offenders).toEqual([])
  })
})
