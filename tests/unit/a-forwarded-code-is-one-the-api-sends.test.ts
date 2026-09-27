import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { extractForwardedCode } from '../../src/errors.js'

/**
 * SHAT-3371. FORWARDED_CODES IS HALF OF A DICTIONARY WHOSE OTHER HALF LIVES IN ANOTHER REPOSITORY.
 *
 * src/errors.ts forwards a closed list of upstream `code` values to the agent verbatim. The list is
 * only right while every entry is a code the API actually sends — a forwarded code the API stopped
 * sending is a named refusal that silently falls back to our generic envelope, and both
 * repositories stay green, each honestly measuring its own half.
 *
 * Neither CI can read the other repository, so the dictionary is committed as
 * tests/fixtures/forwarded-codes.contract.json, with the SAME BYTES as
 * apps/api/testdata/forwarded-codes.contract.json in Shatale-SASU/shatale. There, a Go test proves
 * the file's error_codes / status_derived are what the server sends; here, this test proves its
 * `forwarded` list IS FORWARDED_CODES, and that every forwarded code is a domain code the file says
 * the API sends.
 *
 * ⚠️ WHAT THIS DOES NOT CLOSE: nothing compares the two copies of the file. Changing a forwarded code
 * means editing it here AND in shatale-api, and a change made to one copy only stays green in both.
 */

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..')

interface Contract {
  about: string
  error_codes: string[]
  status_derived: string[]
  forwarded: string[]
}

/** Keys of the object literal assigned to `const FORWARDED_CODES`, read with the compiler's parser. */
function forwardedCodesIn(source: string): string[] {
  const sf = ts.createSourceFile('errors.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[][] = []
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'FORWARDED_CODES') {
      const init = n.initializer
      if (!init || !ts.isObjectLiteralExpression(init)) {
        throw new Error('FORWARDED_CODES is no longer an object literal — this reader cannot list it')
      }
      found.push(
        init.properties.map((p) => {
          // A spread, a computed key or a shorthand would hide an entry from a static reader, so
          // each is refused rather than skipped.
          if (!ts.isPropertyAssignment(p)) throw new Error(`FORWARDED_CODES has a non-plain entry: ${p.getText(sf)}`)
          if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
          throw new Error(`FORWARDED_CODES has a computed key: ${p.name.getText(sf)}`)
        }),
      )
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (found.length !== 1) throw new Error(`expected exactly one FORWARDED_CODES declaration, found ${found.length}`)
  return found[0]
}

const contract: Contract = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'forwarded-codes.contract.json'), 'utf8'),
)
const forwarded = forwardedCodesIn(readFileSync(join(ROOT, 'src', 'errors.ts'), 'utf8'))

describe('SHAT-3371: FORWARDED_CODES agrees with the dictionary shared with shatale-api', () => {
  it('the reader discriminates (controls on known source)', () => {
    expect(forwardedCodesIn("const FORWARDED_CODES: R = { a_code: {}, 'b_code': {} }")).toEqual(['a_code', 'b_code'])
    expect(forwardedCodesIn('const FORWARDED_CODES = {}')).toEqual([])
    expect(() => forwardedCodesIn('const FORWARDED_CODES = { ...other }')).toThrow(/non-plain/)
    expect(() => forwardedCodesIn('const FORWARDED_CODES = { [k]: {} }')).toThrow(/computed key/)
    expect(() => forwardedCodesIn('const NOT_IT = { a: {} }')).toThrow(/found 0/)
  })

  it('the contract file is the one both repositories keep (floors measured on shatale ca9ac556d)', () => {
    // 27 / 11 / 1 when written. A file that parsed to empty lists would satisfy every check below.
    expect(contract.error_codes.length).toBeGreaterThanOrEqual(20)
    expect(contract.status_derived.length).toBeGreaterThanOrEqual(8)
    expect(forwarded.length).toBeGreaterThanOrEqual(1)
    for (const list of [contract.error_codes, contract.status_derived, contract.forwarded]) {
      expect(list).toEqual([...list].sort())
    }
  })

  it('FORWARDED_CODES is exactly the contract\'s `forwarded` list', () => {
    // Both directions: a code added here without the contract is unchecked against the API; a code
    // in the contract but not here means shatale-api is guarding a forwarding that does not exist.
    expect([...forwarded].sort()).toEqual(contract.forwarded)
  })

  it('every forwarded code is a code the API sends, and a DOMAIN code', () => {
    const sent = new Set(contract.error_codes)
    const derived = new Set(contract.status_derived)
    expect(forwarded.filter((c) => !sent.has(c)), 'forwarded codes the API never sends').toEqual([])
    // A status-derived code says nothing the status does not, and forwarding it would replace
    // mapHttpError's own answer (the 404 advice that knows who built the path) with a fixed text.
    expect(forwarded.filter((c) => derived.has(c)), 'forwarded codes that are status-derived').toEqual([])
  })

  it('the parse is the runtime: each forwarded code passes extractForwardedCode, each status-derived one does not', () => {
    for (const c of forwarded) expect(extractForwardedCode({ code: c }), c).toBe(c)
    for (const c of contract.status_derived) expect(extractForwardedCode({ code: c }), c).toBeUndefined()
  })
})
