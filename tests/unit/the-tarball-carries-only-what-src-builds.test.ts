import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// @ts-expect-error — plain .mjs script, no types; the same functions `npm run gate:pack` and prepack run.
import { expectedFromSrc, packedFiles, verdict, ROOT_FILES, filesOfPackJson } from '../../scripts/pack-contents-gate.mjs'

/**
 * SHAT-8133 — THE TARBALL CARRIES EXACTLY WHAT src/ BUILDS, PLUS THE ROOT FILES.
 *
 * Measured (Buklya, 21.11.2026, HEAD a916b4b): with `files: ["dist", …]`, a planted dist/.env,
 * dist/.env.local, *.test.js and dist/.claude-flow/* all went into `npm pack`; a build over an older
 * tree packed dist/tools/onboarding.js, whose source was removed in 2.0.0. Three things close it, and
 * each has its own case below, run on a COPY of the package in a temp directory so the suite's own
 * dist/ — which other files are executing — is never touched:
 *   - `files` names dist/**\/*.js and dist/**\/*.d.ts, and excludes tests and dot-paths;
 *   - `prebuild` removes dist/ before tsc;
 *   - scripts/pack-contents-gate.mjs (prepack and `npm run gate:pack`) compares what npm would pack
 *     with what src/ builds, and refuses any difference.
 */
const ROOT = resolve(import.meta.dirname, '..', '..')

function copyOfThePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shat-8133-'))
  for (const f of [...ROOT_FILES, 'tsconfig.json']) cpSync(join(ROOT, f), join(dir, f))
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true })
  cpSync(join(ROOT, 'dist'), join(dir, 'dist'), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
  return dir
}

function plant(dir: string, rel: string, body = 'planted\n') {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

/** The gate, run as a process in `dir`, the way prepack runs it. */
function gate(dir: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/pack-contents-gate.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    return { ok: true, out }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('SHAT-8133: the tarball carries only what src/ builds', () => {
  it('reads both shapes of `npm pack --json` (npm ≤11 array, npm 12 object) and refuses anything else', () => {
    const files = [{ path: 'package.json' }, { path: 'dist/index.js' }]
    const one = { id: 'shatale-mcp-server@2.1.4', name: 'shatale-mcp-server', files }
    expect(filesOfPackJson(JSON.stringify([one]))).toEqual(['dist/index.js', 'package.json'])
    // npm 12.x: the 2.1.4 release run died here — keyed by package name.
    expect(filesOfPackJson(JSON.stringify({ 'shatale-mcp-server': one }))).toEqual(['dist/index.js', 'package.json'])
    expect(() => filesOfPackJson(JSON.stringify([one, one]))).toThrow(/shape this gate cannot read/)
    expect(() => filesOfPackJson(JSON.stringify({ a: one, b: one }))).toThrow(/shape this gate cannot read/)
    expect(() => filesOfPackJson(JSON.stringify({ 'shatale-mcp-server': { name: 'x' } }))).toThrow(/shape this gate cannot read/)
    expect(() => filesOfPackJson('null')).toThrow(/shape this gate cannot read/)
  })

  it('the gate decides in both directions (pure)', () => {
    expect(verdict(['a', 'b'], ['a', 'b'])).toEqual({ ok: true, extra: [], missing: [] })
    expect(verdict(['a', 'b', 'dist/.env'], ['a', 'b'])).toEqual({ ok: false, extra: ['dist/.env'], missing: [] })
    expect(verdict(['a'], ['a', 'dist/index.js'])).toEqual({ ok: false, extra: [], missing: ['dist/index.js'] })
  })

  it('the real package packs exactly what src/ builds', () => {
    const expected = expectedFromSrc(ROOT)
    // Positive control: the derivation sees the build (index, a tool module, the root files).
    expect(expected).toContain('dist/index.js')
    expect(expected).toContain('dist/tools/reveal.d.ts')
    for (const f of ROOT_FILES) expect(expected).toContain(f)
    expect(verdict(packedFiles(ROOT), expected)).toEqual({ ok: true, extra: [], missing: [] })
  }, 60_000)

  describe('on a copy of the package', () => {
    let dir = ''
    beforeEach(() => {
      dir = copyOfThePackage()
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('`files` keeps planted secrets, tests and dot-paths out of the tarball', () => {
      for (const f of ['dist/.env', 'dist/.env.local', 'dist/tools/planted.test.js', 'dist/.claude-flow/a.js', 'dist/tools/.hidden.js']) {
        plant(dir, f)
      }
      const packed = packedFiles(dir)
      expect(packed.filter((f: string) => /\.env|\.test\.|\/\./.test(f))).toEqual([])
      expect(gate(dir).ok).toBe(true)
    }, 60_000)

    // The positive control the ticket asks for: the gate itself sees a planted dist/.env, measured on
    // the `files` this branch replaced — so the gate is a second wall, not a restatement of the first.
    it('with the old `files: ["dist"]`, a planted dist/.env turns the gate red and is named', () => {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      pj.files = ['dist', 'server.json', 'README.md', 'LICENSE', 'SECURITY.md']
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pj, null, 2))
      plant(dir, 'dist/.env', 'SHATALE_API_KEY=planted\n')
      const g = gate(dir)
      expect(g.ok).toBe(false)
      expect(g.out).toContain('+ dist/.env')
    }, 60_000)

    it('a compiled module whose source is gone turns the gate red and is named', () => {
      plant(dir, 'dist/tools/onboarding.js', 'export const stale = true\n')
      const g = gate(dir)
      expect(g.ok).toBe(false)
      expect(g.out).toContain('+ dist/tools/onboarding.js')
    }, 60_000)

    it('`npm run build` removes what an older build left behind', () => {
      plant(dir, 'dist/tools/onboarding.js', 'export const stale = true\n')
      plant(dir, 'dist/.env')
      execFileSync('npm', ['run', 'build', '--silent'], { cwd: dir, stdio: 'ignore' })
      expect(existsSync(join(dir, 'dist/tools/onboarding.js'))).toBe(false)
      expect(existsSync(join(dir, 'dist/.env'))).toBe(false)
      // And the build is whole: the gate is green on what it produced.
      expect(existsSync(join(dir, 'dist/index.js'))).toBe(true)
      expect(gate(dir).ok).toBe(true)
    }, 120_000)
  })
})
