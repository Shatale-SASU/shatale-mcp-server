import { describe, it, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { redactPurchaseCard, pathReturnsOurCard } from '../../src/redact.js'
import {
  API_CARD_CREDENTIALS,
  API_CHECKOUT_IDENTITY,
  SENTINEL_CVV,
  SENTINEL_PAN,
  cardCredentials,
  checkoutIdentity,
} from '../fixtures/api-response-shapes'

// SHAT-3023. The last two steps of a purchase through ONE MCP — reveal_card and the checkout
// identity — read two API responses. This file holds those reads to the API's OWN field names
// (tests/fixtures/api-response-shapes.ts cites the producer by sha and line), in both directions:
// the right names come through intact, and a renamed, missing or extra name is REFUSED by name.
//
// ⚠️ WHY REFUSE RATHER THAN PASS THROUGH. Both tools used to hand the upstream body back unread, and
// the only check was "not empty". So when the mock and the API disagreed about every card field name
// (card_number vs pan, expiry_month vs exp_month), nothing noticed: a lenient reader turns a name
// mismatch into silence. At a merchant form that silence becomes an agent filling the expiry field
// with `undefined`, or the cardholder's city with nothing, and reporting success.
//
// ⚠️ THE REAL CLIENT RUNS; ONLY `fetch` IS A DOUBLE. The PCI scrub decides inside ShataleClient.request,
// by the path. A test with a fake client would skip the one layer these names also have to cross.

const BASE = 'https://api.example.test'
const PURCHASE = 'pur_3023_names'
const PERSON = 'usr_3023_person'

type FetchFn = ReturnType<typeof vi.fn>

function answerWith(body: unknown, status = 200): FetchFn {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const urlOf = (fn: FetchFn, i = 0) => new URL(String(fn.mock.calls[i][0]))
const textOf = (res: { content: Array<{ text: string }> }) => res.content[0].text

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('reveal_card reads the card in the API\'s own names', () => {
  // POSITIVE CONTROL for everything below: the right shape passes, unchanged, all five fields.
  // Without it, every "refused" further down would also be what a tool that refuses EVERYTHING says.
  it('the five fields the API sends arrive intact, and nothing else is added', async () => {
    answerWith(cardCredentials())
    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: PERSON,
    })
    expect(res.isError, `the right shape was refused: ${textOf(res)}`).toBeFalsy()
    expect(JSON.parse(textOf(res))).toEqual(API_CARD_CREDENTIALS)
  })

  for (const field of Object.keys(API_CARD_CREDENTIALS)) {
    it(`a response without \`${field}\` is refused by name, not handed to the agent`, async () => {
      const body: Record<string, unknown> = cardCredentials()
      delete body[field]
      // The rename this whole file is about: the same datum under a neighbour's name.
      body[`card_${field}`] = 'RENAMED'
      answerWith(body)
      const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
        purchase_id: PURCHASE,
        publisher_user_id: PERSON,
      })
      expect(res.isError, `a response missing ${field} was returned as a success`).toBe(true)
      expect(textOf(res)).toContain('card_credentials_unrecognised')
      expect(textOf(res), 'the refusal must say WHICH name was missing').toContain(field)
      // And the refusal itself is not a channel: whatever the body carried stays out of it.
      expect(textOf(res)).not.toContain(SENTINEL_PAN)
      expect(textOf(res)).not.toContain(SENTINEL_CVV)
    })
  }

  it('an extra field is refused — three_ds_password coming back is SHAT-2259 reopening, not a feature', async () => {
    answerWith({ ...cardCredentials(), three_ds_password: 'MOCK-3DS' })
    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: PERSON,
    })
    expect(res.isError, 'an unexpected field was passed through to the agent').toBe(true)
    expect(textOf(res)).toContain('card_credentials_unrecognised')
    expect(textOf(res)).toContain('three_ds_password')
    expect(textOf(res)).not.toContain('MOCK-3DS')
  })

  it('a field of the wrong type is refused — the API sends strings, all five', async () => {
    answerWith({ ...cardCredentials(), exp_month: 12 })
    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: PERSON,
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('card_credentials_unrecognised')
  })

  // ── the person scope (SHAT-4016 / SHAT-4051) ──────────────────────────────────────────────────
  //
  // shatale-api RevealCard reads `publisher_user_id` from the QUERY and refuses a purchase that is
  // not that person's. Without it the API cannot tell one person of a publisher from another, and
  // its own comment names this tool as the one live caller that does not send it — the reason the
  // gate is still open for everyone.
  it('the person reaches the API as the query parameter the person gate reads', async () => {
    const fn = answerWith(cardCredentials())
    await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: PERSON,
    })
    expect(fn).toHaveBeenCalledTimes(1)
    const url = urlOf(fn)
    expect(url.pathname).toBe(`/v1/purchases/${PURCHASE}/card-credentials`)
    expect(url.searchParams.get('publisher_user_id'), 'the reveal was asked without the person').toBe(PERSON)
    // And the query does not move the call off the allowlist: the scrub decides on the path alone.
    expect(pathReturnsOurCard(`${url.pathname}${url.search}`)).toBe(true)
  })

  for (const [label, args] of [
    ['no publisher_user_id', { purchase_id: PURCHASE }],
    ['an empty publisher_user_id', { purchase_id: PURCHASE, publisher_user_id: '' }],
    ['a whitespace publisher_user_id', { purchase_id: PURCHASE, publisher_user_id: '   ' }],
  ] as const) {
    it(`${label}: nothing is sent, and the refusal names the argument`, async () => {
      const fn = answerWith(cardCredentials())
      const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card(
        args as Record<string, unknown>,
      )
      expect(fn, 'a reveal without a person left the process').not.toHaveBeenCalled()
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('publisher_user_id')
    })
  }

  // ── nothing of the card reaches a log ─────────────────────────────────────────────────────────
  //
  // The server writes its diagnostics to stderr (stdout is the MCP transport). The card belongs in
  // the RESULT to the caller who asked, and nowhere else.
  it('a successful reveal writes nothing of the card to any console or stderr channel', async () => {
    answerWith(cardCredentials())
    const written: string[] = []
    const keep = (...a: unknown[]) => {
      written.push(a.map(String).join(' '))
    }
    vi.spyOn(console, 'error').mockImplementation(keep)
    vi.spyOn(console, 'warn').mockImplementation(keep)
    vi.spyOn(console, 'log').mockImplementation(keep)
    vi.spyOn(console, 'info').mockImplementation(keep)
    vi.spyOn(console, 'debug').mockImplementation(keep)
    const origWrite = process.stderr.write.bind(process.stderr)
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk))
      return (origWrite as (...x: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write)

    const res = await createRevealTools(new ShataleClient(BASE, 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: PURCHASE,
      publisher_user_id: PERSON,
    })
    // Control: the card really did pass through this call — otherwise "not in the log" is trivial.
    expect(textOf(res)).toContain(SENTINEL_PAN)
    const log = written.join('\n')
    expect(log, 'the PAN was written to a log').not.toContain(SENTINEL_PAN)
    expect(log, 'the CVV was written to a log').not.toContain(SENTINEL_CVV)
  })
})

describe('the PCI scrub knows the API\'s name for a card number', () => {
  const OFF_ALLOWLIST = `/v1/purchases/${PURCHASE}/card`

  it('the reveal shape from a path OFF the allowlist loses its pan and its cvv', () => {
    expect(pathReturnsOurCard(OFF_ALLOWLIST)).toBe(false)
    const out = JSON.stringify(redactPurchaseCard(cardCredentials(), OFF_ALLOWLIST))
    expect(out, '`pan` survived the scrub — it recognised card_number/number and not the API\'s own name')
      .not.toContain(SENTINEL_PAN)
    expect(out).not.toContain(SENTINEL_CVV)
  })

  it('the same shape nested one level down is scrubbed as well', () => {
    const out = JSON.stringify(redactPurchaseCard({ purchase: { card: cardCredentials() } }, OFF_ALLOWLIST))
    expect(out).not.toContain(SENTINEL_PAN)
    expect(out).not.toContain(SENTINEL_CVV)
  })

  // The other direction, asserted in the same breath: a scrub that deleted every `pan` everywhere
  // would pass the two tests above and make reveal_card useless.
  it('control: on the allowlisted reveal path the same body is untouched', () => {
    const ours = `/v1/purchases/${PURCHASE}/card-credentials`
    expect(redactPurchaseCard(cardCredentials(), ours)).toEqual(API_CARD_CREDENTIALS)
  })
})

describe('the checkout identity reads both halves in the API\'s own names', () => {
  const client = () => new ShataleClient(BASE, 'sk_sandbox_abc')

  it('control: both halves in the API\'s shape arrive intact', async () => {
    answerWith(checkoutIdentity())
    const tools = createCheckoutTools(client())
    const holder = await tools.handlers.get_checkout_cardholder({ purchase_id: PURCHASE })
    const buyer = await tools.handlers.get_checkout_customer({ purchase_id: PURCHASE })
    expect(holder.isError, textOf(holder)).toBeFalsy()
    expect(buyer.isError, textOf(buyer)).toBeFalsy()
    expect(JSON.parse(textOf(holder)).billing_identity).toEqual(API_CHECKOUT_IDENTITY.billing_identity)
    expect(JSON.parse(textOf(buyer)).merchant_customer_identity).toEqual(
      API_CHECKOUT_IDENTITY.merchant_customer_identity,
    )
  })

  for (const field of Object.keys(API_CHECKOUT_IDENTITY.billing_identity)) {
    it(`a cardholder half without \`${field}\` is refused by name`, async () => {
      const body = checkoutIdentity()
      delete (body.billing_identity as Record<string, string>)[field]
      ;(body.billing_identity as Record<string, string>)[`${field}1`] = 'RENAMED'
      answerWith(body)
      const res = await createCheckoutTools(client()).handlers.get_checkout_cardholder({ purchase_id: PURCHASE })
      expect(res.isError, `a cardholder half missing ${field} was returned as a success`).toBe(true)
      expect(textOf(res)).toContain('checkout_identity_unrecognised')
      expect(textOf(res)).toContain(field)
    })
  }

  for (const field of Object.keys(API_CHECKOUT_IDENTITY.merchant_customer_identity)) {
    it(`a buyer half without \`${field}\` is refused by name`, async () => {
      const body = checkoutIdentity()
      delete (body.merchant_customer_identity as Record<string, string>)[field]
      answerWith(body)
      const res = await createCheckoutTools(client()).handlers.get_checkout_customer({ purchase_id: PURCHASE })
      expect(res.isError, `a buyer half missing ${field} was returned as a success`).toBe(true)
      expect(textOf(res)).toContain('checkout_identity_unrecognised')
      expect(textOf(res)).toContain(field)
    })
  }

  it('an extra key in a half is refused — a field nobody named is a field nobody checked', async () => {
    const body = checkoutIdentity()
    ;(body.merchant_customer_identity as Record<string, string>).phone = 'MOCK-PHONE'
    answerWith(body)
    const res = await createCheckoutTools(client()).handlers.get_checkout_customer({ purchase_id: PURCHASE })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('checkout_identity_unrecognised')
    expect(textOf(res)).toContain('phone')
    expect(textOf(res)).not.toContain('MOCK-PHONE')
  })

  // The half a tool does NOT return is not its business: the cardholder tool must not refuse because
  // the buyer half changed shape, or one API change takes both tools down for a reason only one has.
  it('each tool judges only its own half', async () => {
    const body = checkoutIdentity()
    ;(body.merchant_customer_identity as Record<string, string>).phone = 'MOCK-PHONE'
    answerWith(body)
    const holder = await createCheckoutTools(client()).handlers.get_checkout_cardholder({ purchase_id: PURCHASE })
    expect(holder.isError, textOf(holder)).toBeFalsy()
  })
})
