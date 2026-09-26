/**
 * SHAT-2556 — `get_merchant_details` answered a 404 whose advice pointed away from the cause.
 *
 * Measured in production on 2026-08-27, in guest mode with no key:
 *
 *     GET /v1/merchants/catalog        -> 200 {"catalog_state":"not_published","merchants":[],"total":0}
 *     get_merchant_details("starbucks") -> isError, code not_found, suggested_fix offering FOUR causes:
 *           the id never existed · it belongs to another publisher ·
 *           it came from the other environment · the route may not be deployed
 *
 * With an unpublished catalogue every one of those is wrong. A partner who follows the advice
 * starts three hunts — a bad id, a tenancy problem, a deployment problem — and none of them is the
 * cause.
 *
 * /!\ A HINT THAT POINTS AWAY FROM THE CAUSE IS WORSE THAN NO HINT. Silence makes someone ask us;
 * advice makes them search on their own, confidently, in the wrong place. The 404 itself was
 * correct — the catalogue holds no such merchant — which is why nothing here was ever going to show
 * up as a failure.
 *
 * /!\ AND THE EXPLANATION IS READ FROM THE SAME PLACE THE NEIGHBOUR READS IT. search_merchants
 * already returns `catalog_state`; this handler now asks the same endpoint rather than composing a
 * second account of the same fact in its own words. Two sites answering one question out of
 * separate knowledge drift apart, and the one that drifts is the one nobody touches.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createCatalogTools } from '../../src/tools/catalog.js'

const BASE = 'http://127.0.0.1:9'

/** The advice that sends a reader after an id. Matched as a phrase, not a whole sentence. */
const BLAMES_THE_ID = /verify the id/i

/**
 * Answer the merchant-detail path with 404 and the catalogue path with whatever the case needs.
 * `catalogBody === null` means the catalogue probe itself fails.
 */
function stubCatalog(catalogBody: Record<string, unknown> | null) {
  const fn = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/v1/merchants/catalog') {
      if (catalogBody === null) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify(catalogBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Anything deeper is a specific merchant, and there is none.
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

const details = async () => {
  const tools = createCatalogTools(new ShataleClient(BASE, 'sk_sandbox_test'))
  const result = await tools.handlers.get_merchant_details({ merchant_id: 'starbucks' })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('SHAT-2556: an empty catalogue explains itself', () => {
  test('an unpublished catalogue is named as the reason, not the caller’s id', async () => {
    stubCatalog({ catalog_state: 'not_published', merchants: [], total: 0 })
    const { result, text } = await details()

    expect(text).toContain('not_published')
    // The four wrong causes must be gone — this is the whole defect.
    expect(text).not.toMatch(BLAMES_THE_ID)
    expect(text).not.toMatch(/another publisher|other environment|not be deployed/i)
    // And it is not reported as the caller's failure, because it is not one.
    expect(result.isError).not.toBe(true)
  })

  /**
   * /!\ THE HALF THAT KEEPS THE PENDULUM FROM SWINGING BACK. If the catalogue IS published, a 404
   * really does mean an unknown id, and the original advice is the CORRECT advice. A fix that
   * blamed the catalogue for every 404 would pass the case above and re-open the defect that the
   * id-blaming text exists to close (SHAT-2678). Both halves, or neither.
   */
  test('a published catalogue keeps the original not-found advice', async () => {
    // SHAT-4031: this fixture said `'published'`, which the producer of this field has never
    // emitted (it answers ok / out_of_range / not_published / no_match). The case therefore passed
    // against an invented value while the axis it names stayed open. `ok` is what a published
    // catalogue actually answers.
    stubCatalog({ catalog_state: 'ok', merchants: [{ id: 'x' }], total: 1 })
    const { result, text } = await details()

    expect(text).toMatch(BLAMES_THE_ID)
    expect(text).not.toContain('not_published')
    expect(result.isError).toBe(true)
  })

  /**
   * The probe is an addition, never a replacement: if it cannot establish the catalogue's state,
   * the caller keeps the error they would have had. A diagnostic that can make the answer WORSE
   * when it fails is not a diagnostic.
   */
  test('a failing catalogue probe leaves the original error untouched', async () => {
    stubCatalog(null)
    const { result, text } = await details()

    expect(result.isError).toBe(true)
    expect(text).toMatch(BLAMES_THE_ID)
  })

  /** An unrecognised state is not an excuse to invent one. Only the catalogue's own word counts. */
  test('an unexpected catalog_state does not become a story', async () => {
    stubCatalog({ merchants: [], total: 0 }) // no catalog_state at all
    const { result, text } = await details()

    expect(result.isError).toBe(true)
    expect(text).toMatch(BLAMES_THE_ID)
  })
})

/**
 * SHAT-4031 — THE HALF ABOVE WAS WRITTEN AGAINST A STATE THE API DOES NOT HAVE.
 *
 * The case named "a published catalogue keeps the original not-found advice" stubs
 * `catalog_state: 'published'`, and the handler compares `state !== 'published'`. Both agree with
 * each other and with nothing else: the ONLY producer of this field is
 * apps/api/api/v1/merchant_catalog.go, func catalogState, and it returns exactly one of
 *
 *     "ok" · "out_of_range" · "not_published" · "no_match"
 *
 * measured on shatale-api origin/main on 2026-09-27. `published` is not among them, so
 * `state !== 'published'` is TRUE for every answer the catalogue can give — including a healthy
 * `ok`. A real 404 on a healthy catalogue is therefore replaced by
 * `{catalog_state:"ok", merchant:null}`, and the advice that was correct is thrown away.
 *
 * /!\ THE FIXTURE IS WHY IT SURVIVED. The guard for the second half exists, runs, and passes — on a
 * value invented for it. A test whose fixture agrees with the bug cannot see the bug, and it reads
 * as coverage of exactly the axis it leaves open. So these cases use the states the producer emits,
 * one case per state, and the reason each answer is what it is:
 *
 *   ok           → the catalogue answered with rows. A 404 for an id is an unknown id → keep advice.
 *   no_match     → published merchants exist, the (unfiltered) probe just matched none → keep advice.
 *   out_of_range → matches exist past this page → keep advice.
 *   not_published→ nothing is published, so no id can be found → the catalogue is the reason.
 *
 * Only `not_published` explains a 404. Every other state means the catalogue HAS merchants, and
 * then the caller's id is the thing to look at.
 */
describe('SHAT-4031: only a state the catalogue actually emits may silence a 404', () => {
  test('a healthy catalogue (ok) keeps the original not-found advice', async () => {
    stubCatalog({ catalog_state: 'ok', merchants: [{ id: 'x' }], total: 1 })
    const { result, text } = await details()

    expect(text).toMatch(BLAMES_THE_ID)
    expect(text).not.toContain('"merchant": null')
    expect(result.isError).toBe(true)
  })

  test('no_match keeps the original not-found advice', async () => {
    stubCatalog({ catalog_state: 'no_match', merchants: [], total: 0 })
    const { result, text } = await details()

    expect(text).toMatch(BLAMES_THE_ID)
    expect(result.isError).toBe(true)
  })

  test('out_of_range keeps the original not-found advice', async () => {
    stubCatalog({ catalog_state: 'out_of_range', merchants: [], total: 7 })
    const { result, text } = await details()

    expect(text).toMatch(BLAMES_THE_ID)
    expect(result.isError).toBe(true)
  })

  /**
   * The other side of the same predicate, so that a fix cannot pass by refusing to explain
   * anything: the one state that DOES explain a 404 must still explain it.
   */
  test('not_published still names the catalogue as the reason', async () => {
    stubCatalog({ catalog_state: 'not_published', merchants: [], total: 0 })
    const { result, text } = await details()

    expect(text).toContain('not_published')
    expect(text).not.toMatch(BLAMES_THE_ID)
    expect(result.isError).not.toBe(true)
  })
})
