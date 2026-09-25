/**
 * SHAT-3796 — the first search_merchants call in guest mode answered an empty list with no word
 * about why.
 *
 * Measured on mcp main 4262bd2, through the real stdio server in guest mode against a local stub:
 *
 *     empty catalogue -> {"catalog_state":"not_published","merchants":[],"total":0}
 *     no match        -> {"catalog_state":"no_match",...}
 *
 * The API already said which case it was, but only as a machine field, and a mutant that stripped
 * that field survived the whole suite. An empty list agrees with every hypothesis — a broken
 * connection, a bad filter, a catalogue with nothing in it — so on launch day it reads as a
 * breakage. The cure is to DISTINGUISH: the answer says what happened.
 *
 * /!\ BOTH DIRECTIONS. "Not published" must be said when it is true AND must not be said when
 * merchants exist but the filters matched none — otherwise the fix just moves the wrong advice to
 * the other case. And a state we do not recognise gets no story at all (the same rule as
 * an-empty-catalogue-explains-itself.test.ts).
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createCatalogTools } from '../../src/tools/catalog.js'

const BASE = 'http://127.0.0.1:9'
const NOT_PUBLISHED = /not published|no published merchants/i

function stubCatalog(catalogBody: Record<string, unknown>) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(catalogBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

const search = async (args: Record<string, unknown> = {}) => {
  const tools = createCatalogTools(new ShataleClient(BASE, '')) // guest: no key
  const result = await tools.handlers.search_merchants(args)
  const text = result.content[0]?.text ?? ''
  return { result, text, body: JSON.parse(text) as Record<string, unknown> }
}

describe('SHAT-3796: an empty search_merchants answer says why it is empty', () => {
  test('an unpublished catalogue says so, and not as an error', async () => {
    stubCatalog({ catalog_state: 'not_published', merchants: [], total: 0 })
    const { result, body } = await search()

    expect(typeof body.message).toBe('string')
    expect(body.message).toMatch(NOT_PUBLISHED)
    expect(body.message).toMatch(/not caused by your filters/i)
    // The JSON the caller had is still there.
    expect(body.catalog_state).toBe('not_published')
    expect(body.merchants).toEqual([])
    expect(body.total).toBe(0)
    expect(result.isError).not.toBe(true)
  })

  test('no match says the filters matched none, and does NOT claim the catalogue is unpublished', async () => {
    stubCatalog({ catalog_state: 'no_match', merchants: [], total: 0 })
    const { result, body } = await search({ category: 'travel' })

    expect(typeof body.message).toBe('string')
    expect(body.message).toMatch(/none matched/i)
    expect(body.message).not.toMatch(NOT_PUBLISHED)
    expect(result.isError).not.toBe(true)
  })

  test('an offset past the end names the total', async () => {
    stubCatalog({ catalog_state: 'out_of_range', merchants: [], total: 3 })
    const { body } = await search()

    expect(body.message).toMatch(/past the end/i)
    expect(body.message).toContain('3')
    expect(body.message).not.toMatch(NOT_PUBLISHED)
  })

  test('ok carries no message', async () => {
    stubCatalog({ catalog_state: 'ok', merchants: [{ id: 'm1' }], total: 1 })
    const { body } = await search()

    expect(body).not.toHaveProperty('message')
  })

  test('an unknown or missing catalog_state does not become a story', async () => {
    stubCatalog({ catalog_state: 'something_new', merchants: [], total: 0 })
    expect((await search()).body).not.toHaveProperty('message')

    stubCatalog({ merchants: [], total: 0 })
    expect((await search()).body).not.toHaveProperty('message')
  })
})
