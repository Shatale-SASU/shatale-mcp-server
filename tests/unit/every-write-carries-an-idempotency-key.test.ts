/**
 * SHAT-2633 — every write this client makes carries an idempotency key.
 *
 * SHAT-1104 was titled "enforce idempotency_key on all write MCP tools" and closed over the word
 * "all". cancel_purchase fell out of its list. SHAT-2633 then reported that — and named four tools,
 * one of which (create_email_alias) does not exist, while THREE sandbox writers fell out of ITS
 * list the same way. The most serious of those was sandbox_approve_purchase, which issues a card.
 *
 * /!\ SO THE LIST IS DERIVED FROM THE SOURCE, NOT WRITTEN DOWN. Twice now a hand-written list has
 * lost a writer, and each time the ticket about the loss carried a hand-written list of its own. A
 * test that enumerates by hand would drop the next one added, and would look thorough while doing
 * it.
 *
 * The rule: a method that issues a non-GET request must put an idempotency key in the body. The one
 * exemption is stated below with the measurement that earns it, not with an assertion.
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLIENT = resolve(import.meta.dirname, '../../src/client.ts')
const source = readFileSync(CLIENT, 'utf8')

/**
 * Every method in ShataleClient that issues a non-GET request, with its body text.
 *
 * Bounded to each method's own body. An earlier measurement of this same question used a fixed
 * line window and straddled method boundaries, producing a result that CONTRADICTED the ticket on
 * two entries — the window was wrong, not the ticket. A run with wrong boundaries is not a run;
 * it is reading with extra steps.
 */
function writeMethods(): Array<{ name: string; verb: string; body: string }> {
  const lines = source.split('\n')
  const starts: Array<{ i: number; name: string }> = []
  lines.forEach((l, i) => {
    const m = /^  (?:async )?([a-zA-Z_]+)\(/.exec(l)
    if (m) starts.push({ i, name: m[1] })
  })

  const out: Array<{ name: string; verb: string; body: string }> = []
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length
    const body = lines.slice(s.i, end).join('\n')
    const verb = /request\(\s*'(POST|PUT|PATCH|DELETE)'/.exec(body)
    if (verb) out.push({ name: s.name, verb: verb[1], body })
  })
  return out
}

/**
 * The single exemption, and the measurement that earns it.
 *
 * sandbox_simulate_authorization is a POST that persists nothing and — since SHAT-2489 — holds
 * nothing. Its dry-run engine suppresses every outward effect in the DEPENDENCIES: the row, the
 * ledger hold, the outbox event, the circuit breaker, the notify webhook. It previously took
 * SELECT ... FOR UPDATE on a live budget row while writing nothing ("nothing was written; something
 * was still held"), which is why "side-effect-free" is not taken on the word here.
 *
 * A repeat therefore produces no second effect, which is the property a key exists to provide.
 *
 * /!\ THIS EXEMPTION EXPIRES SILENTLY if a writer is added to the auth chain without a dry-run
 * counterpart. Nothing in this repository can see that happen — the dependency lives in apps/api.
 * Tracked as SHAT-2724.
 */
const EXEMPT = new Set(['sandboxSimulateAuthorization'])

describe('SHAT-2633: every write carries an idempotency key', () => {
  // POSITIVE CONTROL. Every assertion below is "no method is missing a key", which an empty list
  // satisfies perfectly — and an empty list is what a drifted regex returns. This is the only thing
  // standing between a broken parser and a guard that reports success for ever.
  test('the writers were actually found', () => {
    const writers = writeMethods()
    expect(writers.length).toBeGreaterThanOrEqual(8)
    const names = writers.map((w) => w.name)
    // Named individually because each of these fell out of a hand-written list at some point.
    expect(names).toContain('cancelPurchase')
    expect(names).toContain('sandboxApprovePurchase')
    expect(names).toContain('createSandboxUser')
    expect(names).toContain('sandboxCompleteOnboarding')
    expect(names).toContain('registerUserProfile')
    expect(names.filter((n) => /^requestPurchase$/.test(n))).toHaveLength(1)
  })

  /**
   * A method counts as covered if it names the key itself, OR if it delegates body construction to
   * toPurchaseWireBody — which sets one unconditionally.
   *
   * /!\ THE DELEGATION IS ONLY NOT A LOOPHOLE BECAUSE THE HELPER'S GUARANTEE IS ASSERTED BELOW.
   * An allowance for "some other function handles it" that never checks the other function is how a
   * guard becomes decorative. The test immediately after this one is what earns this line.
   */
  const DELEGATES_BODY = /toPurchaseWireBody\(/

  test('no writer sends a body without an idempotency key', () => {
    const missing = writeMethods()
      .filter((w) => !EXEMPT.has(w.name))
      .filter((w) => !/idempotency/i.test(w.body) && !DELEGATES_BODY.test(w.body))
      .map((w) => `${w.verb} ${w.name}`)
    expect(missing).toEqual([])
  })

  test('the helper that writers delegate to always sets a key', () => {
    const start = source.indexOf('function toPurchaseWireBody')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 2500)
    // Explicit caller key wins, otherwise a derived one — and there is no path that sets neither.
    expect(body).toContain('body.idempotency_key = input.idempotency_key')
    expect(body).toContain('deriveIdempotencyKey')
  })

  /**
   * requestPurchase derives its key in a helper rather than in the method body, so the check above
   * passes for it by way of the type's field. Asserted separately so that path is not merely
   * assumed — it is the oldest of these and the one with money attached.
   */
  test('requestPurchase still derives a stable key rather than a random one', () => {
    expect(source).toContain('deriveIdempotencyKey')
    // A per-call random key turns every retry into a second real purchase — SHAT-1682.
    expect(source).not.toMatch(/idempotency_key:\s*randomUUID\(\)/)
  })

  /**
   * The keys added here are derived from the OPERATION AND ITS TARGET, not random, for the same
   * reason: these calls address a row that already exists, so a repeat means "do that again to the
   * same thing" and must de-dup.
   */
  test('the added keys are deterministic, not random', () => {
    expect(source).toContain('deriveOperationKey')
    const helper = source.slice(source.indexOf('export function deriveOperationKey'))
    expect(helper).toContain('createHash')
    expect(helper.slice(0, 400)).not.toContain('randomUUID')
  })

  test('the exemption is declared with a reason, not silently omitted', () => {
    const self = readFileSync(resolve(import.meta.dirname, 'every-write-carries-an-idempotency-key.test.ts'), 'utf8')
    expect(self).toContain('SHAT-2489')
    expect(self).toContain('SHAT-2724')
  })
})
