import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SHAT-2674 — a workflow step whose exit code is a pipe's last command decides nothing.
 *
 * ⚠️ FOUND LIVE IN nightly.yml, AND IT HAD SILENCED THREE THINGS AT ONCE. The step was
 * `npm test ... 2>&1 | tee /tmp/test-output.txt`. A runner `run:` with no explicit `shell:` is
 * `bash -e {0}` — `-e`, but NOT `pipefail` — so the step's exit code was tee's, and tee always
 * succeeds. Every reaction in that file hangs off `if: failure()`: the server-log artifact, the
 * Telegram message, the Jira issue. A condition that can never be true turned all three off
 * together, and the nightly suite could fail every night behind a green check.
 *
 * Reproduced, not reasoned: `bash -e -c 'false | tee /dev/null'` exits 0, and the same line under
 * `bash -eo pipefail -c` does not.
 *
 * ## Why this is a text check, and why that is the right instrument here
 *
 * A text guard is usually a proxy for a property it cannot see. Not here: the subject IS the text
 * of a shell script embedded in YAML, and `pipefail` is a literal in it. There is no aliasing or
 * indirection for the check to miss.
 *
 * What it CAN miss is a pipe this parser fails to recognise, so quoted regions are stripped before
 * looking — `grep -E "FAIL|WARN"` is not a pipeline, and a guard that called it one would be
 * disabled inside a week. The counter-risk is a false GREEN on an exotic quoting form; that is the
 * side to err on for a rule about CI hygiene, where a false red costs a day and a false green costs
 * the same silence it already caught once.
 */

const WORKFLOWS = join(process.cwd(), '.github', 'workflows')

/** Shell text with quoted regions blanked, so a `|` inside a string is not read as a pipeline. */
function withoutQuotes(s: string): string {
  return s
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
}

/** A real pipeline: a single `|` that is not `||`, outside quotes. */
function hasPipeline(script: string): boolean {
  const bare = withoutQuotes(script)
  return /(^|[^|])\|([^|]|$)/.test(bare)
}

interface Step {
  file: string
  line: number
  script: string
  declaresBashShell: boolean
}

/**
 * Every `run:` step in a workflow, with its script body.
 *
 * Block form (`run: |`) collects the indented lines beneath; inline form takes the rest of the
 * line. `shell:` is read from the same step — an explicit `shell: bash` gets pipefail from the
 * runner, so it satisfies the rule on its own.
 */
function stepsIn(file: string): Step[] {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
  const steps: Step[] = []

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(\|-?|>-?)?\s*(.*)$/.exec(lines[i])
    if (m === null) continue

    const indent = m[1].length
    const isBlock = m[2] !== undefined && m[2] !== ''
    let script = isBlock ? '' : m[3]
    let j = i + 1

    if (isBlock) {
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '') { script += '\n'; continue }
        const thisIndent = l.length - l.trimStart().length
        if (thisIndent <= indent) break
        script += l + '\n'
      }
    }

    // `shell:` belongs to the step, so look at the sibling keys around this `run:` — the ones at
    // the same indent, up to the next list item (`- `) in either direction.
    let declaresBashShell = false
    for (let k = j; k < lines.length; k++) {
      const l = lines[k]
      if (l.trim() === '') continue
      const ind = l.length - l.trimStart().length
      if (ind < indent || /^\s*-\s/.test(l)) break
      if (ind === indent && /^\s*shell:\s*bash\s*$/.test(l)) declaresBashShell = true
    }
    for (let k = i - 1; k >= 0; k--) {
      const l = lines[k]
      if (l.trim() === '') continue
      const ind = l.length - l.trimStart().length
      if (ind < indent) break
      if (ind === indent && /^\s*shell:\s*bash\s*$/.test(l)) declaresBashShell = true
      if (/^\s*-\s/.test(l)) break
    }

    steps.push({ file, line: i + 1, script, declaresBashShell })
    i = j - 1
  }

  return steps
}

describe('a pipe must not swallow the verdict', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

  // ⚠️ THE INSTRUMENT FIRST. Every assertion below is about a set, and an empty set satisfies all
  // of them. If the directory moved or the extension changed, this file must say it measured
  // nothing rather than report agreement it never checked.
  it('finds the workflows at all', () => {
    expect(
      files.length,
      `no workflow files were found under ${WORKFLOWS}. Nothing below was measured, so this is the ` +
        `guard losing its subject — not a repository with clean CI.`,
    ).toBeGreaterThan(0)
  })

  it('finds run: steps in them', () => {
    const all = files.flatMap(stepsIn)
    expect(
      all.length,
      'no `run:` steps were parsed out of the workflows. Same reason as above: an empty set passes ' +
        'the rule for free.',
    ).toBeGreaterThan(0)
  })

  // ⚠️ AND THE PARSER MUST BE ABLE TO SEE A PIPELINE, or the rule below is satisfied by a blindness
  // rather than by a repository. This is the positive control the rule itself cannot supply: the
  // clean tree is expected to have NO offenders, and "no offenders" is exactly what a detector that
  // never fires also reports.
  it('recognises a pipeline, and does not mistake a quoted bar for one', () => {
    expect(hasPipeline('npm test | tee out.txt')).toBe(true)
    expect(hasPipeline('set -e\nnpm test 2>&1 | tee /tmp/o.txt\n')).toBe(true)
    expect(hasPipeline('grep -c "FAIL|WARN" file')).toBe(false)
    expect(hasPipeline("grep -oP '\\d+ passed|failed' f")).toBe(false)
    expect(hasPipeline('a || b')).toBe(false)
    expect(hasPipeline('echo hello')).toBe(false)
  })

  it('every piped step decides its own exit code', () => {
    const offenders = files
      .flatMap(stepsIn)
      .filter((s) => hasPipeline(s.script))
      .filter((s) => !s.declaresBashShell && !/pipefail/.test(s.script))
      .map((s) => `${s.file}:${s.line}`)

    expect(
      offenders,
      `these workflow steps pipe a command and do not set pipefail, so their exit code is the LAST ` +
        `command's — usually tee, or a formatter, which cannot fail. The step goes green whatever ` +
        `the real command decided, and anything gated on \`if: failure()\` downstream never runs.\n\n` +
        `Fix either way: open the script with \`set -euo pipefail\` (this repo's own convention — ` +
        `ci-public.yml and publish.yml both do), or give the step \`shell: bash\`, which the runner ` +
        `starts with pipefail already set.\n\noffenders: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
