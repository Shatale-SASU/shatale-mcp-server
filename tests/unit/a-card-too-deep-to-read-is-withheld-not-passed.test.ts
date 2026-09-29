import { describe, it, expect } from 'vitest'
import * as redact from '../../src/redact.js'

// SHAT-4307 (2). The PCI scrub walks a response to a fixed depth, and what lay BELOW that depth used
// to come back exactly as it arrived: `if (depth > 12 …) return node`. So a card nested 13 levels
// down kept its PAN and CVV on a path off the allowlist — the one place the scrub exists for. Second
// hand on shatale-mcp-server#93 measured it at depth 14. No API response nests that deep today; the
// scrub is a defence for the response nobody has seen yet, and a defence with a depth below which it
// silently stands aside is a defence with a documented way round.
//
// ⇒ AT THE LIMIT THE WHOLE SUBTREE IS REPLACED BY A MARKER. The scrub cannot vouch for what it did
// not read, so it does not pass it. The limit itself stays (a walk must end), and it is named:
// SCRUB_MAX_DEPTH in src/redact.ts.
//
// Depth here counts like the scrub counts: the root is depth 0, each object or array level adds one.

const PAN = '4111111111114307'
const CVV = '437'
// A path OFF the allowlist: the scrub applies. (The allowlisted reveal path skips the scrub on
// purpose, SHAT-2610 — it is not what this file is about.)
const OFF_ALLOWLIST = '/v1/purchases/pur_4307'

const card = () => ({ pan: PAN, cvv: CVV, exp_month: '12', exp_year: '2030', last4: '4307' })

/** The card at exactly `depth`, under a chain of single-key objects (or arrays, every other level). */
function nest(depth: number, arrays = false): unknown {
  let v: unknown = card()
  for (let i = 0; i < depth; i++) v = arrays && i % 2 === 0 ? [v] : { n: v }
  return v
}

/** Walks the result by the same chain and returns what stands at `depth`. */
function at(root: unknown, depth: number): unknown {
  let v = root
  for (let i = 0; i < depth; i++) {
    if (Array.isArray(v)) v = v[0]
    else if (v && typeof v === 'object') v = (v as Record<string, unknown>).n
    else return v
  }
  return v
}

/** Every string anywhere in the value, cycle-safe — JSON.stringify would throw on a cycle. */
function strings(v: unknown, seen = new Set<unknown>()): string[] {
  if (typeof v === 'string') return [v]
  if (!v || typeof v !== 'object' || seen.has(v)) return []
  seen.add(v)
  return Object.values(v as Record<string, unknown>).flatMap((x) => strings(x, seen))
}

function assertNoCard(v: unknown, what: string) {
  const all = strings(v)
  expect(all.includes(PAN), `${what}: the PAN passed the scrub`).toBe(false)
  expect(all.includes(CVV), `${what}: the CVV passed the scrub`).toBe(false)
}

describe('the scrub\'s depth limit is named, and a card below it is withheld, not passed', () => {
  it('the limit is named in the code: SCRUB_MAX_DEPTH = 12', () => {
    expect(redact.SCRUB_MAX_DEPTH).toBe(12)
    expect(typeof redact.TOO_DEEP_MARKER, 'the marker the subtree is replaced with').toBe('string')
  })

  // ── positive controls: inside the limit the scrub works as it always did ──────────────────────
  for (const depth of [0, 11, 12]) {
    it(`control: a card at depth ${depth} is scrubbed in place and keeps its last4`, () => {
      const out = redact.redactPurchaseCard(nest(depth), OFF_ALLOWLIST)
      assertNoCard(out, `depth ${depth}`)
      const c = at(out, depth) as Record<string, unknown>
      // Scrubbed IN PLACE, not replaced by the marker: the structure an agent reads is still there.
      expect(c, `depth ${depth} was replaced instead of scrubbed`).toMatchObject({ last4: '4307', exp_month: '12' })
      expect(c).not.toHaveProperty('pan')
      expect(c).not.toHaveProperty('cvv')
    })
  }

  // ── the defect: below the limit ───────────────────────────────────────────────────────────────
  for (const depth of [13, 14, 50]) {
    for (const arrays of [false, true]) {
      it(`a card at depth ${depth}${arrays ? ' (through arrays)' : ''} does not come back with its PAN or CVV`, () => {
        const input = nest(depth, arrays)
        // Positive control: the planted card IS in the input, at the depth named.
        expect(at(input, depth)).toEqual(card())
        const out = redact.redactPurchaseCard(input, OFF_ALLOWLIST)
        assertNoCard(out, `depth ${depth}`)
        // And the place where the scrub stopped reading says so, rather than holding a hole.
        expect(at(out, redact.SCRUB_MAX_DEPTH + 1)).toBe(redact.TOO_DEEP_MARKER)
      })
    }
  }

  it('control: the allowlisted reveal path is still untouched at any depth — the limit is the scrub\'s, not the allowlist\'s', () => {
    const input = nest(13)
    expect(redact.redactPurchaseCard(input, '/v1/purchases/pur_4307/card-credentials')).toBe(input)
  })

  it('control: a shallow response with no card is returned equal, marker-free', () => {
    const input = { purchase_id: 'p', payment: { card: { last4: '4242', card_ref: 'ic_1' } }, items: [{ a: 1 }] }
    expect(redact.redactPurchaseCard(input, OFF_ALLOWLIST)).toEqual(input)
  })
})

// ── the other ways round the walk, found while reading it ─────────────────────────────────────────
//
// The walk remembered every object it had entered and, on meeting one again, returned THE ORIGINAL —
// unscrubbed. A response parsed by JSON.parse never shares a reference, so this is not reachable from
// the API today; it is reachable from any caller that hands the scrub an object graph, and costs one
// map to close. The second visit now gets the SCRUBBED copy.
describe('a card met twice in the graph is scrubbed both times', () => {
  it('a shared reference (the same card under two keys) loses its PAN under both', () => {
    const c = card()
    const out = redact.redactPurchaseCard({ a: c, b: { c } }, OFF_ALLOWLIST) as Record<string, any>
    assertNoCard(out, 'shared reference')
    expect(out.a.last4).toBe('4307')
    expect(out.b.c.last4).toBe('4307')
  })

  it('a cycle back to a card does not hand the original card back', () => {
    const c: Record<string, unknown> = card()
    c.self = c
    const out = redact.redactPurchaseCard({ wrap: c }, OFF_ALLOWLIST) as Record<string, any>
    assertNoCard(out, 'cycle')
    expect(out.wrap.self, 'the cycle must close on the scrubbed copy').toBe(out.wrap)
  })
})
