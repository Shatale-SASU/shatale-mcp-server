import { createHash } from 'node:crypto'

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

// The ONLY way money turns on. SHATALE_MONEY_GO is Sergey's opaque go-code; the
// server never knows the code itself, only its SHA-256 (SHATALE_MONEY_GO_SHA256,
// set at deploy time — same fail-closed shape as the prod-deploy approval code).
// Exact digest match or OFF. No length heuristics, no deny-lists: any typo,
// negative word, or unknown value simply fails the hash, and a missing or
// malformed expected digest keeps money OFF. There is no input that enables
// money by accident.
export function resolveMoneyGo(rawCode: string | undefined, expectedSha256: string | undefined): boolean {
  const code = (rawCode ?? '').trim()
  const want = (expectedSha256 ?? '').trim().toLowerCase()
  if (code === '' || !SHA256_HEX_RE.test(want)) return false
  return sha256Hex(code) === want
}
