#!/usr/bin/env node
// The tarball carries exactly what src/ builds, plus the five root files. Nothing else.
//
// SHAT-8133. Measured twice (Voland 05.11.2026, Buklya 21.11.2026):
//   - `npm run build` did not clean dist/, so a build over an older tree packed compiled files whose
//     source was gone — dist/resources/guides.js (wording SHAT-3592 removed from public surfaces) and
//     dist/tools/onboarding.js (a tool removed in 2.0.0, still loadable by path);
//   - `files: ["dist"]` filtered nothing inside dist/: a planted dist/.env, dist/.env.local,
//     *.test.js and dist/.claude-flow/* all went into the tarball. .gitignore does not apply there.
// CI publishes from a fresh checkout, so the published 2.1.3 is clean (68 files). The risk is a
// local publish from a lived-in tree, and nothing compared the tarball with what it should hold.
//
// The prebuild step and the narrowed `files` close both ways in. This closes the question: it asks
// npm what it WOULD pack (`npm pack --dry-run --json`, scripts off) and compares that set with the
// set derived from src/. Any difference, in either direction, is a refusal that names the paths.
//
// It runs as `prepack`, so `npm pack` and `npm publish` refuse a tarball that differs — locally and in
// CI alike — and as `npm run gate:pack` on its own.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The files that ship besides the build. package.json is added by npm itself. */
export const ROOT_FILES = ['LICENSE', 'README.md', 'SECURITY.md', 'package.json', 'server.json']

/**
 * What the tarball must hold, derived from the sources: each src/**\/*.ts (not a declaration, not a
 * test) compiles to one .js and one .d.ts under dist/.
 *
 * @param {string} root the package root
 * @returns {string[]} sorted package-relative paths
 */
export function expectedFromSrc(root) {
  const out = [...ROOT_FILES]
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/\.test\./.test(e.name)) {
        const rel = path.relative(path.join(root, 'src'), p).split(path.sep).join('/').replace(/\.ts$/, '')
        out.push(`dist/${rel}.js`, `dist/${rel}.d.ts`)
      }
    }
  }
  walk(path.join(root, 'src'))
  return out.sort()
}

/**
 * What npm would put in the tarball, asked of npm. Lifecycle scripts are OFF, or this would call
 * itself through `prepack`.
 *
 * @param {string} root the package root
 * @returns {string[]} sorted package-relative paths
 */
export function packedFiles(root) {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const name = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name
  return filesOfPackJson(raw, name)
}

/**
 * The file list out of `npm pack --json`. Two shapes are known and both are read exactly:
 *   npm ≤ 11: an ARRAY with one entry per package — `[{ name, files: [...] }]`;
 *   npm 12:   an OBJECT keyed by package name     — `{ "<name>": { name, files: [...] } }`.
 * The 2.1.4 release run died on the second (publish.yml installs npm@latest, which became 12.x)
 * while every earlier job, on the runner's npm 10/11, saw the first. Anything else — more than one
 * package, no `files` array — is still refused: a gate that guesses at a shape it cannot read is a
 * gate that passes a tarball it never looked at.
 *
 * @param {string} raw stdout of `npm pack --dry-run --json`
 * @param {string} [expectedName] our package name; in the npm 12 object form the key must equal it
 * @returns {string[]} sorted package-relative paths
 */
export function filesOfPackJson(raw, expectedName) {
  const parsed = JSON.parse(raw)
  let entries = null
  if (Array.isArray(parsed)) entries = parsed
  else if (parsed && typeof parsed === 'object') {
    // npm 12: the key IS the package name. When the caller knows ours, a value under another key is
    // not our tarball and is refused, not read.
    const keys = Object.keys(parsed)
    if (expectedName === undefined || (keys.length === 1 && keys[0] === expectedName)) entries = Object.values(parsed)
  }
  if (!entries || entries.length !== 1 || !Array.isArray(entries[0]?.files)) {
    throw new Error(`npm pack --json answered in a shape this gate cannot read: ${raw.slice(0, 200)}`)
  }
  return entries[0].files.map((f) => f.path).sort()
}

/**
 * @param {string[]} packed
 * @param {string[]} expected
 * @returns {{ok: boolean, extra: string[], missing: string[]}}
 */
export function verdict(packed, expected) {
  const p = new Set(packed)
  const e = new Set(expected)
  const extra = packed.filter((f) => !e.has(f))
  const missing = expected.filter((f) => !p.has(f))
  return { ok: extra.length === 0 && missing.length === 0, extra, missing }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // The package being packed is the one npm runs this in (npm sets the cwd to the package root for
  // its scripts) — NOT the directory this file sits in, or a copy of the package would be judged by
  // the original's tarball.
  const root = process.cwd()
  const expected = expectedFromSrc(root)
  const packed = packedFiles(root)
  const v = verdict(packed, expected)
  if (!v.ok) {
    console.error('pack-contents-gate: the tarball is not what src/ builds.')
    for (const f of v.extra) console.error(`  + ${f}   (packed, but nothing in src/ builds it)`)
    for (const f of v.missing) console.error(`  - ${f}   (src/ builds it, the tarball lacks it — run npm run build)`)
    process.exit(1)
  }
  // stderr, not stdout: as prepack this runs inside `npm pack --json`, whose stdout is the JSON.
  console.error(`pack-contents-gate: ${packed.length} files, exactly what src/ builds plus ${ROOT_FILES.length} root files.`)
}
