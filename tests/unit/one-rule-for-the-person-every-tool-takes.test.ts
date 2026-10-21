import { describe, test, expect } from 'vitest'
import { requireId, requirePersonId, personIdSchema } from '../../src/validate.js'
import { vi } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { z } from 'zod'

// SHAT-4823 — ONE RULE FOR publisher_user_id, ACROSS EVERY TOOL THAT TAKES IT.
//
// The field is not a path parameter. It travels as `?publisher_user_id=` and the API decides what
// it means: purchases/service.go:1608 PersonScope — EMPTY AFTER TrimSpace is "the field is absent",
// anything else is used AS SENT. So this server must not trim it: trimming answers a question that
// belongs to the API, and answers it differently. A caller sending " u1 " would be scoped to "u1"
// here and to " u1 " calling the API directly — same input, two meanings, difference invisible.
//
// Before this change the four tools that take the field disagreed with each other:
//   trimmed    — reveal_card (reveal.ts:118), checkout_identity (checkout.ts:110, :189) via requireId
//   untrimmed  — request_purchase (purchase.ts:10), request_credentials (credentials.ts:10) via zod
// ⚠️ The ticket's title named a different pair (get_purchase_status / await_purchase_approval /
// cancel_purchase); on main those three do not take the field at all. They arrive with
// mcp-server#99, and they take requirePersonId too.
describe('publisher_user_id: one rule, every tool', () => {
  // The two shapes the four tools use to read the field. If a fifth tool appears and uses neither,
  // this list is what a reviewer compares against.
  const READERS: ReadonlyArray<readonly [string, (raw: unknown) => { ok: boolean; value?: string }]> = [
    // reveal_card, checkout_identity
    ['requirePersonId', (raw) => {
      const r = requirePersonId({ publisher_user_id: raw } as Record<string, unknown>)
      return r.ok ? { ok: true, value: r.value } : { ok: false }
    }],
    // request_purchase, request_credentials
    ['personIdSchema', (raw) => {
      const r = z.object({ publisher_user_id: personIdSchema }).safeParse({ publisher_user_id: raw })
      return r.success ? { ok: true, value: r.data.publisher_user_id } : { ok: false }
    }],
  ]

  test.each(READERS)('%s passes the id through UNCHANGED, spaces and all', (_name, read) => {
    const r = read('  u1  ')
    expect(r.ok).toBe(true)
    expect(r.value).toBe('  u1  ')
  })

  test.each(READERS)('%s refuses blank — that is "absent", not a person', (_name, read) => {
    for (const blank of ['', '   ', '\t', '\n']) expect(read(blank).ok).toBe(false)
  })

  test.each(READERS)('%s refuses a non-string', (_name, read) => {
    for (const bad of [42, null, {}, []]) expect(read(bad).ok).toBe(false)
  })

  test('both readers agree on every input — that is what "one rule" means', () => {
    for (const raw of ['u1', '  u1  ', ' ', '', 'u 1', '\tu1\n', 42, null, undefined]) {
      const [a, b] = READERS.map(([, read]) => read(raw))
      expect(a.ok, `disagreement on ${JSON.stringify(raw)}`).toBe(b.ok)
      if (a.ok) expect(a.value).toBe(b.value)
    }
  })

  // ⚠️ THE TESTS ABOVE CALL THE TWO READERS DIRECTLY — AND THAT IS NOT ENOUGH. Measured: putting
  // `requireId(args, 'publisher_user_id')` back into reveal.ts left all 399 tests green, this file
  // included. A reader can be correct while a tool does not use it. So the rule has to be checked
  // where it is SPENT: on the wire, by the tool itself.
  test('reveal_card sends the id to the API exactly as given — spaces survive the whole tool', async () => {
    const seen: string[] = []
    const fn = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ pan: '4111111111111111', cvv: '123', exp_month: 1, exp_year: 2030, cardholder_name: 'X' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fn)
    try {
      await createRevealTools(new ShataleClient('https://api.example.test', 'sk_sandbox_abc')).handlers.reveal_card({
        purchase_id: 'pur_4823',
        publisher_user_id: '  u1  ',
      } as Record<string, unknown>)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen.length, 'the tool made no request at all').toBeGreaterThan(0)
    // '  u1  ' percent-encoded is %20%20u1%20%20. A trim anywhere on the path would send 'u1'.
    expect(seen.join('\n')).toContain(encodeURIComponent('  u1  '))
    expect(seen.join('\n')).not.toContain('publisher_user_id=u1&')
    expect(seen.join('\n')).not.toMatch(/publisher_user_id=u1$/)
  })

  // requireId keeps its trim for PATH ids — this change must not have touched it.
  test('requireId still trims, because a path id of "   " is not an id', () => {
    const r = requireId({ purchase_id: '  p1  ' }, 'purchase_id')
    expect(r.ok && r.value).toBe('p1')
    expect(requireId({ purchase_id: '   ' }, 'purchase_id').ok).toBe(false)
  })
})
