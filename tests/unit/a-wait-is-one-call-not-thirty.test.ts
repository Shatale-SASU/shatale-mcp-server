import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ShataleClient } from '../../src/client.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import type { ToolContext } from '../../src/types.js'

/**
 * SHAT-2802 — an agent can wait for the person's answer instead of asking thirty times.
 *
 * The surface had no incoming channel at all: an agent learned an outcome by polling
 * get_purchase_status, while our own error text told it "Avoid tight polling loops on
 * get_*_status". We forbade the only thing we offered.
 *
 * /!\ THE REAL CLIENT AGAINST A REAL UPSTREAM, not a stubbed client. The property under test is
 * how many requests leave the process and where they go — which a stub answers by construction.
 * The upstream below COUNTS them.
 */

let upstream: Server
let base: string
let awaitCalls: string[] = []
let statusCalls: string[] = []
/** How many still_waiting answers to give before the outcome lands. */
let stallFor = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    if (url.includes('/await-approval')) {
      awaitCalls.push(url)
      if (awaitCalls.length <= stallFor) {
        res.end(JSON.stringify({ outcome: 'still_waiting', purchase: { status: 'pending_approval' } }))
        return
      }
      res.end(JSON.stringify({ outcome: 'approved', purchase: { status: 'payment_ready' } }))
      return
    }
    statusCalls.push(url)
    res.end(JSON.stringify({ status: 'pending_approval' }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()))
})

function tools() {
  awaitCalls = []
  statusCalls = []
  const client = new ShataleClient(base, 'sk_sandbox_test', 5_000)
  return createPurchaseTools(client, { isSandbox: true, moneyEnabled: true })
}

/** A context that says a listener is present and records what it was told. */
function listeningCtx(): ToolContext & { progress: string[] } {
  const progress: string[] = []
  return {
    hasProgressToken: true,
    progress,
    reportProgress: async (m: string) => {
      progress.push(m)
    },
  } as ToolContext & { progress: string[] }
}

describe('waiting is one call, and it never polls the status tool', () => {
  it('returns the outcome, and asks the STATUS endpoint nothing', async () => {
    stallFor = 0
    const mod = tools()
    const res = await mod.handlers.await_purchase_approval({ purchase_id: 'pur_1' })

    expect(JSON.stringify(res)).toContain('approved')

    // /!\ THE DECISIVE ASSERTION. If waiting were get_purchase_status under another name, this is
    // where it would show — and every other assertion here would still pass.
    expect(
      statusCalls,
      'the wait reached GET /v1/purchases/{id} — it is polling the status endpoint with a new name, ' +
        'which is the substitution this ticket exists to avoid',
    ).toEqual([])
    expect(awaitCalls.length).toBe(1)
    expect(awaitCalls[0]).toContain('/await-approval')
  })

  it('keeps waiting across still_waiting answers, and reports progress while it does', async () => {
    stallFor = 3
    const ctx = listeningCtx()
    const mod = tools()
    const res = await mod.handlers.await_purchase_approval({ purchase_id: 'pur_2' }, ctx)

    expect(JSON.stringify(res)).toContain('approved')
    expect(
      awaitCalls.length,
      'the tool gave up after the first still_waiting — an agent would be back to polling',
    ).toBe(4)
    expect(
      ctx.progress.length,
      'nothing was reported while waiting; a client that resets its timeout on progress would have ' +
        'given up on us mid-wait',
    ).toBeGreaterThan(0)
    expect(statusCalls).toEqual([])
  })

  /**
   * /!\ THE FAIL-SAFE, AND IT IS MANDATORY RATHER THAN NICE. resetTimeoutOnProgress is the HOST's
   * option — ChatGPT, Claude — not ours, and it cannot be verified from here. So the tool must be
   * able to say "still waiting" and be called again. Promising a long wait on a host that never
   * agreed to one is a promise made at somebody else's expense.
   */
  it('gives up its own budget and says still_waiting rather than failing', async () => {
    stallFor = Number.MAX_SAFE_INTEGER // nobody ever answers
    const mod = tools()

    // No context at all: the same position as a host that sent no progress token.
    const res = await mod.handlers.await_purchase_approval({ purchase_id: 'pur_3' })
    const body = JSON.stringify(res)

    expect(
      body,
      'a wait nobody answered came back as an error. Running out of budget is an ordinary answer ' +
        'to "has it been decided yet"; an error teaches the agent the tool is unreliable and sends ' +
        'it back to polling.',
    ).not.toContain('await_approval_failed')
    expect(body).toContain('still_waiting')
    expect(statusCalls).toEqual([])
  }, 70_000)

  /**
   * /!\ THE LOOP PACES ITSELF, AND IT DID NOT AT FIRST. The first version leaned on the API to hold
   * each call for its own budget — true today, and a property of the OTHER side. Measured against an
   * upstream that answers still_waiting instantly: 520,008 requests in 50 seconds, over ten thousand
   * a second. The tool written to END tight polling became the worst polling client in the product,
   * and nothing here would have noticed: every other assertion in this file passed.
   *
   * So the pace is ours now, and this is what says so. It asserts a CEILING on requests rather than
   * a sleep, because the property is "how hard can this hit the API", not "which call was used".
   */
  it('cannot hammer the API even when every answer comes back instantly', async () => {
    stallFor = Number.MAX_SAFE_INTEGER
    const mod = tools()
    await mod.handlers.await_purchase_approval({ purchase_id: 'pur_spin' })

    // A 50s budget at a 2s floor is ~25 calls. 40 leaves room for timing slack and still fails by
    // three orders of magnitude if the floor is removed.
    expect(
      awaitCalls.length,
      `the wait made ${awaitCalls.length} requests inside its budget. The floor between iterations ` +
        `is gone, so an upstream that answers quickly turns this tool into the tightest polling ` +
        `loop we ship — which is the thing it was built to remove.`,
    ).toBeLessThan(40)
    expect(awaitCalls.length, 'it made no requests at all — the test is measuring nothing').toBeGreaterThan(2)
  }, 70_000)

  it('a missing id is refused before any request leaves the process', async () => {
    const mod = tools()
    await mod.handlers.await_purchase_approval({})
    expect(awaitCalls).toEqual([])
    expect(statusCalls).toEqual([])
  })
})
