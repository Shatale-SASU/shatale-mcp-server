#!/usr/bin/env node
//
// SHAT-2527 — what we published is a DIFFERENT SUBJECT from what our suite measured.
//
// ⚠️ EVERY GREEN THIS REPOSITORY PRODUCES IS ABOUT THE WORKING TREE. The tests spawn dist/ built
// from src/; the gates spawn the same dist/. Nothing anywhere asks what the REGISTRY actually
// serves — and between the two sit `files`, `.npmignore`, the build script, the publish workflow and
// whatever tag the release used. A tarball missing a directory, or built from a different commit,
// passes every check in this repo unnoticed.
//
// This is not hypothetical here. CHANGELOG records it in this project's own words: "The 0.5.0
// tarball on npm was not built from the code at that tag."
//
// ⚠️ AND THE CRITERION IS FIXED BEFORE THE MEASUREMENT, ON PURPOSE. Deciding what counts as "the
// same" after seeing the diff is how a criterion gets fitted to the answer. So:
//
//   PASS  — for every mode, the published package advertises EXACTLY the tools our build does,
//           and reports the version we intended to publish.
//   FAIL  — any difference in either, named tool by tool and mode by mode.
//
// It compares ROSTERS, not descriptions: wording is checked against the README by another gate, and
// duplicating that here would give two answers to one question.
//
// Usage: node scripts/verify-published.mjs <expected-version> [--tag latest]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureRoster, MODES } from './lib/serverRoster.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expected = process.argv[2]
if (!expected) {
  console.error('usage: node scripts/verify-published.mjs <expected-version> [--tag latest]')
  process.exit(2)
}
const tag = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'latest'

const pkgName = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).name
const localEntry = path.join(REPO, 'dist/index.js')
if (!existsSync(localEntry)) {
  console.error(`no local build at ${localEntry} — run \`npm run build\` first. Comparing against ` +
    `nothing would report agreement, which is the failure this script exists to catch.`)
  process.exit(2)
}

const work = mkdtempSync(path.join(tmpdir(), 'shatale-published-'))
const failures = []
try {
  console.error(`installing ${pkgName}@${tag} into ${work} …`)
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', `${pkgName}@${tag}`], {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })

  const installed = path.join(work, 'node_modules', pkgName)
  const installedPkg = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'))
  if (installedPkg.version !== expected) {
    failures.push(`the registry serves ${installedPkg.version} under "${tag}", not ${expected}`)
  }

  const publishedEntry = path.join(installed, installedPkg.main ?? 'dist/index.js')
  if (!existsSync(publishedEntry)) {
    failures.push(`the published tarball has no ${installedPkg.main ?? 'dist/index.js'} — it ships ` +
      `nothing runnable, and every test in this repo would still be green`)
  } else {
    const ours = await measureRoster(localEntry)
    const theirs = await measureRoster(publishedEntry)
    ours.failures.forEach((f) => failures.push(`local build: ${f}`))
    theirs.failures.forEach((f) => failures.push(`published: ${f}`))

    for (const [id] of MODES) {
      const a = new Set(ours.advertised.get(id) ?? [])
      const b = new Set(theirs.advertised.get(id) ?? [])
      const missing = [...a].filter((t) => !b.has(t))
      const extra = [...b].filter((t) => !a.has(t))
      if (missing.length) failures.push(`mode "${id}": published is MISSING ${missing.join(', ')}`)
      if (extra.length) failures.push(`mode "${id}": published has EXTRA ${extra.join(', ')}`)
    }
    if (!failures.length) {
      console.error(`published ${pkgName}@${installedPkg.version} advertises the same tools as this ` +
        `build, in all ${MODES.length} modes: ` +
        MODES.map(([id]) => `${id}=${(theirs.advertised.get(id) ?? []).length}`).join(' '))
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nwhat shipped is not what we tested — ${failures.length} finding(s):\n`)
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
