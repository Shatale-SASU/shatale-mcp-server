import { describe, test, expect } from 'vitest'
import { resolveMoneyGo, sha256Hex } from '../../src/money-gate.js'

// The money gate is the single switch between "onboarding only" and "real €".
// Its contract: money turns on for EXACTLY ONE input (the code whose SHA-256
// matches the configured digest) and for nothing else — no value class, typo,
// or missing configuration may enable it. These tests enumerate the inputs
// that defeated the two previous designs (bare non-empty check: 'false' → ON;
// length+deny-list heuristic: 'nope'/'money-off'/'0000' → ON).
describe('resolveMoneyGo', () => {
  const CODE = 'sergey-go-2026-verre-souffle'
  const DIGEST = sha256Hex(CODE)

  test('the one real code with its matching digest → ON', () => {
    expect(resolveMoneyGo(CODE, DIGEST)).toBe(true)
  })

  test('digest comparison is case-insensitive on the digest side', () => {
    expect(resolveMoneyGo(CODE, DIGEST.toUpperCase())).toBe(true)
  })

  test('surrounding whitespace on the code is trimmed, not part of the code', () => {
    expect(resolveMoneyGo(`  ${CODE}  `, DIGEST)).toBe(true)
  })

  test.each([
    'nope', 'money-off', '0000', 'TODO', 'false', 'true', 'yes', 'on',
    'n', 'f', '0', 'off', 'no', 'none', 'null', 'undefined', 'disabled',
    'go', 'GO-MONEY', 'sergey-go-2026-verre-souffle-typo',
  ])('wrong code %j with a valid digest configured → OFF', (raw) => {
    expect(resolveMoneyGo(raw, DIGEST)).toBe(false)
  })

  test('empty / unset code → OFF even with a valid digest', () => {
    expect(resolveMoneyGo('', DIGEST)).toBe(false)
    expect(resolveMoneyGo('   ', DIGEST)).toBe(false)
    expect(resolveMoneyGo(undefined, DIGEST)).toBe(false)
  })

  test.each([
    undefined, '', '   ', 'not-a-digest', DIGEST.slice(0, 63), `${DIGEST}0`,
    'z'.repeat(64), // right length, not hex
  ])('missing/malformed expected digest %j → OFF even for the real code', (digest) => {
    expect(resolveMoneyGo(CODE, digest)).toBe(false)
  })

  test('the digest itself passed as the code → OFF (hash(digest) ≠ digest)', () => {
    expect(resolveMoneyGo(DIGEST, DIGEST)).toBe(false)
  })
})
