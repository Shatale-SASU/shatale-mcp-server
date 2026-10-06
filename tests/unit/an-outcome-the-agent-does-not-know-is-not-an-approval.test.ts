import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ShataleClient } from '../../src/client.js'
import { createPurchaseTools, withUnknownOutcomeNamed } from '../../src/tools/purchase.js'

/**
 * SHAT-4363 (paired with shatale-api #3203) — `await_purchase_approval` gains a fifth outcome,
 * `ended`, and the rule that keeps every older and newer reader safe: ONLY `approved` is approval.
 *
 * The owner's decision (29.09.2026): a cancelled, abandoned or failed purchase is not "the person
 * declined" — it is a different message, with its reason. Until now the API folded those into
 * `declined`, and an agent told the person they had said no.
 *
 * /!\ THE REAL CLIENT AGAINST A REAL UPSTREAM, as in a-wait-is-one-call-not-thirty: what is under test
 * is what reaches the agent from what the wire said, and how many calls it took.
 */

let upstream: Server
let base: string
let answer: Record<string, unknown> = {}
let calls = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    calls++
    res.end(JSON.stringify(answer))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()))
})

async function awaitWith(wire: Record<string, unknown>): Promise<Record<string, unknown>> {
  answer = wire
  calls = 0
  const mod = createPurchaseTools(new ShataleClient(base, 'sk_sandbox_test', 5_000), { isSandbox: true, moneyEnabled: true })
  const res = (await mod.handlers.await_purchase_approval({ purchase_id: 'pur_1' })) as {
    content: { text: string }[]
  }
  return JSON.parse(res.content[0].text)
}

describe('the fifth outcome reaches the agent as the server said it', () => {
  it('ended ends the wait in one call and keeps its reason', async () => {
    const got = await awaitWith({ outcome: 'ended', reason: 'cancelled', purchase: { status: 'cancelled' } })
    expect(calls, 'ended was treated as still_waiting — the agent would wait on a purchase that is gone').toBe(1)
    expect(got.outcome).toBe('ended')
    expect(got.reason, 'the reason is what lets the agent say what happened instead of "you declined"').toBe('cancelled')
    expect(got.note, 'ended is a known outcome; a note on it would say the server spoke a word we do not know').toBeUndefined()
  })

  it('an outcome this release does not know is passed through, unchanged, and named NOT approved', async () => {
    const got = await awaitWith({ outcome: 'zz_future_outcome', purchase: { status: 'blocked' } })
    expect(calls, 'an unknown outcome kept the tool looping').toBe(1)
    expect(got.outcome, 'the server\'s word was rewritten').toBe('zz_future_outcome')
    expect(String(got.note)).toMatch(/NOT approved/)
  })

  // Coordinator's decision 04.10 (shatale-api #3203): a purchase the publisher's policy allowed without
  // asking the person answers approved WITH reason not_required. The reason must reach the agent intact —
  // it is the only thing that tells "policy allowed it" from "the person said yes".
  it('approved with reason not_required keeps its reason and gets no note', async () => {
    const got = await awaitWith({ outcome: 'approved', reason: 'not_required', purchase: { status: 'payment_ready' } })
    expect(calls).toBe(1)
    expect(got.outcome).toBe('approved')
    expect(got.reason).toBe('not_required')
    expect(got.note).toBeUndefined()
  })

  // POSITIVE CONTROL on the same instrument: approved is passed through bare, so the two cases above
  // are about the outcome and not about a tool that annotates everything.
  it('approved stays approved, with nothing added', async () => {
    const got = await awaitWith({ outcome: 'approved', purchase: { status: 'payment_ready' } })
    expect(got.outcome).toBe('approved')
    expect(got.note).toBeUndefined()
  })
})

describe('the rule is in code and in the description', () => {
  it('withUnknownOutcomeNamed never turns anything into approved', () => {
    for (const o of ['declined', 'expired', 'ended', 'still_waiting', 'APPROVED', 'approved ', '', 'approve']) {
      expect(withUnknownOutcomeNamed({ outcome: o }).outcome).toBe(o)
    }
    // Near-misses of "approved" are unknown, and so are named not approved.
    expect(withUnknownOutcomeNamed({ outcome: 'APPROVED' }).note).toMatch(/NOT approved/)
    expect(withUnknownOutcomeNamed({ outcome: 'approved ' }).note).toMatch(/NOT approved/)
  })

  it('the tool description lists ended and says only approved is approval', () => {
    const tool = createPurchaseTools({} as ShataleClient, { isSandbox: true }).tools.find(
      (t) => t.name === 'await_purchase_approval',
    )
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/\bended\b/)
    expect(tool!.description).toMatch(/Only approved means approved/)
    expect(tool!.description, 'the description must say what approved + not_required means').toMatch(/not_required/)
    expect(tool!.description, 'an expired hold is an ended purchase, and the description must say so').toMatch(/payment hold expired/)
    expect(tool!.description).toMatch(/including one not listed here, as not approved/)
  })
})
