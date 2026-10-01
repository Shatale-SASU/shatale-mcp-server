/**
 * SHAT-4438 — `agent_intent`: the agent's WHY, carried by request_purchase to the API and from there to
 * the person's approval card (and NOT back to the agent: get_purchase_status does not return it).
 *
 * Held here, in-process against a mock upstream with the real ShataleClient:
 *   - the wire body carries it trimmed, and omits it when nothing visible was said;
 *   - a reason the API would refuse is refused HERE, before any request, in words that never quote it;
 *   - it is NOT part of the derived idempotency key — a retry that rephrases its reason is the same
 *     purchase, so it must not mint a new key and buy twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MockUpstream } from '../harness/mockUpstream.js'
import { ShataleClient, toPurchaseWireBody } from '../../src/client.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { agentIntentProblem, normaliseAgentIntent, MAX_AGENT_INTENT_CHARS } from '../../src/validate.js'
import type { PurchaseInput } from '../../src/types.js'

const PERSONAL = 'for Marie Dupont, allergic to penicillin. '

const base = {
  publisher_user_id: 'pub-1',
  agent_id: 'agent-1',
  merchant: 'shoes.example',
  amount: 99,
  currency: 'EUR',
  description: 'Running shoes, size 42',
}

describe('the rule, in characters the API counts', () => {
  const cases: Array<[string, string, boolean]> = [
    ['an ordinary sentence', 'Cheapest of the three the person shortlisted.', true],
    ['line breaks and tab', 'one\r\ntwo\tthree', true],
    ['markup is text', '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a>', true],
    ['500 Cyrillic characters', 'ж'.repeat(MAX_AGENT_INTENT_CHARS), true],
    // Code points, not UTF-16 units: 500 emoji are 1000 units and still 500 characters to Go and Postgres.
    ['500 emoji', '👍'.repeat(MAX_AGENT_INTENT_CHARS), true],
    ['Persian with a zero-width non-joiner', 'خانه‌ها', true],
    ['an emoji joined by a zero-width joiner', '👩‍💻', true],
    ['501 characters', 'a'.repeat(MAX_AGENT_INTENT_CHARS + 1), false],
    ['NUL', 'buy\u0000this', false],
    ['escape', 'buy \u001b[2J this', false],
    ['C1', 'buy \u0085 this', false],
    ['right-to-left override', 'pay ‮01 EUR', false],
    ['isolate', 'pay ⁦x⁩', false],
    ['right-to-left mark', 'Approve‏10 EUR', false],
    ['Arabic letter mark', 'Approve؜10 EUR', false],
  ]
  for (const [name, text, ok] of cases) {
    it(`${name}: ${ok ? 'accepted' : 'refused'}`, () => {
      const problem = agentIntentProblem(text)
      if (ok) {
        expect(problem).toBeUndefined()
      } else {
        expect(problem).toMatch(/agent_intent/)
        expect(problem).not.toMatch(/buy|pay|Approve/)
      }
    })
  }

  it('nothing visible is no intent; trimmed otherwise', () => {
    expect(normaliseAgentIntent(undefined)).toBeUndefined()
    expect(normaliseAgentIntent('  \n\t ')).toBeUndefined()
    expect(normaliseAgentIntent(' ​​﻿ ')).toBeUndefined()
    expect(normaliseAgentIntent('  because the person asked \n')).toBe('because the person asked')
    // THE CONTROL: one visible character keeps the whole text.
    expect(normaliseAgentIntent('​x')).toBe('​x')
  })
})

describe('the derived key does not depend on the reason', () => {
  it('rephrasing the why is the same purchase — same key, no second buy', () => {
    const a = toPurchaseWireBody({ ...base, agent_intent: 'first wording' } as PurchaseInput, true)
    const b = toPurchaseWireBody({ ...base, agent_intent: 'second wording' } as PurchaseInput, true)
    const none = toPurchaseWireBody(base as PurchaseInput, true)
    expect(a.idempotency_key).toBe(b.idempotency_key)
    expect(a.idempotency_key).toBe(none.idempotency_key)
    // THE CONTROL: a field that IS part of the purchase still changes the key.
    const other = toPurchaseWireBody({ ...base, amount: 100 } as PurchaseInput, true)
    expect(other.idempotency_key).not.toBe(none.idempotency_key)
  })
})

describe('request_purchase carries the why to the API', () => {
  let upstream: MockUpstream
  let tools: ReturnType<typeof createPurchaseTools>

  beforeAll(async () => {
    upstream = await MockUpstream.start()
    tools = createPurchaseTools(new ShataleClient(upstream.url, 'sk_sandbox_test'), { isSandbox: true })
  })
  afterAll(async () => {
    await upstream.close()
  })

  const lastBody = () => upstream.lastRequest('POST', '/v1/purchases')?.body as Record<string, unknown> | undefined

  it('sends it trimmed, beside the description', async () => {
    const res = await tools.handlers.request_purchase({ ...base, agent_intent: '  The person asked for shoes under €120.  ' })
    expect(res.isError).toBeFalsy()
    const body = lastBody()!
    expect(body.agent_intent).toBe('The person asked for shoes under €120.')
    expect(body.description).toBe(base.description)
  })

  it('omits it when the agent said nothing visible', async () => {
    for (const intent of [undefined, '   ', '​']) {
      const before = upstream.requests.length
      const res = await tools.handlers.request_purchase(intent === undefined ? { ...base } : { ...base, agent_intent: intent })
      expect(res.isError).toBeFalsy()
      expect(upstream.requests.length).toBe(before + 1)
      expect(lastBody()).not.toHaveProperty('agent_intent')
    }
  })

  it('refuses a reason the API would refuse, before any request, without quoting it', async () => {
    for (const intent of [PERSONAL.repeat(15), `${PERSONAL}‮01 EUR`]) {
      const before = upstream.requests.length
      const res = await tools.handlers.request_purchase({ ...base, agent_intent: intent })
      expect(res.isError).toBe(true)
      const text = (res.content[0] as { text: string }).text
      expect(text).toMatch(/Invalid input: agent_intent/)
      expect(text).not.toContain('Marie')
      expect(upstream.requests.length).toBe(before)
    }
  })

  it('judges the trimmed length, the one the API stores', async () => {
    const res = await tools.handlers.request_purchase({ ...base, agent_intent: `   ${'a'.repeat(MAX_AGENT_INTENT_CHARS)}   ` })
    expect(res.isError).toBeFalsy()
    expect((lastBody()!.agent_intent as string).length).toBe(MAX_AGENT_INTENT_CHARS)
  })
})
