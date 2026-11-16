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

  // 🔴 A VALUE THAT IS NOT A CURRENCY CODE IS REFUSED HERE, AND THE REASON IS NOT TIDINESS.
  // The API compares the string with the purchase's currency and, on a difference, REFUSES THE REVEAL
  // AND CANCELS THE PURCHASE — it never asks whether the string is a code at all (measured by the
  // second hand, 16.11.2026). So a model that read «$» or a zero-width space off the page would not
  // report a mismatch: it would cancel the person's purchase over an answer nobody could read.
  // U+200B is in this list on purpose: it is NOT whitespace, so `trim` leaves it and only the shape
  // check catches it.
  for (const [name, value] of [
    ['a symbol', '$'],
    ['a word', 'dollars'],
    ['a zero-width space inside a code', 'US\u200BD'],
    ['a code with a stray character', 'USD='],
    ['blank', '   '],
    ['empty', ''],
    ['not a string', 7],
  ] as const) {
    it(`refuses ${name} rather than letting it cancel the purchase`, async () => {
      const fn = captureFetch()
      const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
        purchase_id: PURCHASE,
        page_currency: value,
      })
      // Nothing was sent: a refusal that still called the API would have cancelled the purchase.
      expect(fn).not.toHaveBeenCalled()
      const err = JSON.parse(String(res.content[0].text)).error as Record<string, unknown>
      expect(err.code).toBe('page_currency_unreadable')
      expect(String(err.suggested_fix)).toContain('OMIT page_currency')
    })
  }

  // CONTROL: the refusal is about the SHAPE, not about the field. An absent field is still the
  // compatibility path, and a readable code still goes out.
  it('CONTROL: an absent field is not a refusal, and a readable code is sent', async () => {
    const fn = captureFetch()
    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
    })
    // The call WENT OUT — that is what "not a refusal" means here. (The body this harness returns is a
    // stand-in and the tool judges its shape separately; the assertion is about the gate, not the card.)
    expect(fn).toHaveBeenCalled()
    const err = JSON.parse(String(res.content[0].text)).error as Record<string, unknown> | undefined
    expect(err?.code).not.toBe('page_currency_unreadable')
    expect(urlOf(fn).search).toBe('')
  })

  it('surrounding spaces are trimmed, not refused', async () => {
    const fn = captureFetch()
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      page_currency: '  usd  ',
    })
    expect(urlOf(fn).searchParams.get('page_currency')).toBe('usd')
  })

  // The second hand's surviving mutant: nothing held the ENCODING. A value carrying '&' would have
  // appended a parameter of its own — here a second publisher_user_id, which the API answers 400
  // (so no hole today), but a test that cannot see the encoding cannot see the next value either.
  // The shape check above refuses '&' now; this keeps the encoder honest for whatever shape comes next.
  it('the value is encoded, not spliced into the query', async () => {
    const fn = captureFetch()
    await new ShataleClient(BASE, 'sk_sandbox_abc').getCardCredentials(PURCHASE, 'u1', 'US&publisher_user_id=x')
    const url = urlOf(fn)
    expect(url.searchParams.getAll('publisher_user_id')).toEqual(['u1'])
    expect(url.searchParams.get('page_currency')).toBe('US&publisher_user_id=x')
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
