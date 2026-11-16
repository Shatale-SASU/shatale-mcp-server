import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRevealTools } from '../../src/tools/reveal.js'
import { ShataleClient } from '../../src/client.js'

// SHAT-8390 — reveal_card CARRIES THE PAGE'S CURRENCY, AND THE DANGER IS A GREEN TEST, NOT A RED ONE.
//
// The API gained a gate at GET /v1/purchases/{id}/card-credentials: the node reports the currency of the
// open checkout page, the API compares it with the currency the MERCHANT priced the purchase in, and a
// mismatch refuses the reveal and cancels the purchase. The parameter is OPTIONAL by design — an older
// client behaves exactly as before — which is precisely what makes its loss silent: a tool that stopped
// sending it leaves the gate passing everything, and every test about the PATH stays green.
//
// ⚠️ THE SIBLING FILE CANNOT SEE THIS. the-reveal-tool-asks-the-allowlisted-path.test.ts asserts the URL
// through `new URL(...).pathname`, which drops the query — measured. Its subject is the path and it is
// right about it; the query needs its own eyes, and this file is them.
describe('reveal_card carries the currency of the page it will be typed into', () => {
  const PURCHASE = 'pur_8390'
  const BASE = 'https://api.example.test'
  const body = { purchase_id: PURCHASE, card: { number: '4242424242424242', cvv: '123' } }

  function captureFetch() {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const urlOf = (fn: ReturnType<typeof captureFetch>) => new URL(String(fn.mock.calls[0][0]))

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the page currency it was given, as the gate reads it', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      page_currency: 'USD',
    })
    const url = urlOf(fn)
    expect(url.pathname).toBe(`/v1/purchases/${PURCHASE}/card-credentials`)
    expect(url.searchParams.get('page_currency')).toBe('USD')
  })

  // 🔴 THE CASE THAT CATCHES THE SILENT LOSS. Without a parameter the URL must carry no query at all —
  // not an empty one — because the API reads an empty value as "not asked" and would pass, while a
  // reviewer reading `?page_currency=` would believe the gate is acting.
  it('sends no query at all when the page currency is unknown', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
    })
    const url = urlOf(fn)
    expect(url.pathname).toBe(`/v1/purchases/${PURCHASE}/card-credentials`)
    expect(url.search).toBe('')
  })

  it('a blank page currency is the same as none — never an empty parameter', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      page_currency: '   ',
    })
    expect(urlOf(fn).search).toBe('')
  })

  // 🔴 AND IT MUST NOT PUSH THE PERSON OFF THE WIRE. publisher_user_id is the gate shatale-api cannot
  // switch on while this tool is its one caller that does not send it (SHAT-4016); a page currency that
  // replaced it instead of joining it would reopen exactly that hole, and every test about the currency
  // would stay green. Both parameters, one query.
  it('carries the person and the page currency together, not one instead of the other', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: 'usr_8390',
      page_currency: 'USD',
    })
    const url = urlOf(fn)
    expect(url.searchParams.get('publisher_user_id')).toBe('usr_8390')
    expect(url.searchParams.get('page_currency')).toBe('USD')
  })

  // CONTROL: the person alone still goes out exactly as it did before this field existed.
  it('the person alone is unchanged by this field', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: 'usr_8390',
    })
    expect(urlOf(fn).search).toBe('?publisher_user_id=usr_8390')
  })

  // The tool must DECLARE the input, or a model that has the currency cannot pass it and the gate never
  // acts in production — the whole point of the change.
  it('the tool declares page_currency as an optional input', () => {
    const [tool] = createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).tools
    const props = (tool.inputSchema as { properties: Record<string, unknown>; required?: string[] })
    expect(Object.keys(props.properties)).toContain('page_currency')
    expect(props.required ?? []).not.toContain('page_currency')
    // The control: the id is still required, so "not required" above is about this field and not about
    // a schema that requires nothing.
    expect(props.required ?? []).toContain('purchase_id')
  })
})
