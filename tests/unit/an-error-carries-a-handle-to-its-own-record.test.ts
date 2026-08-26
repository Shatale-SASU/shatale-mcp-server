import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ShataleClient } from '../../src/client.js'
import { ShataleApiError, extractRequestId } from '../../src/errors.js'

/**
 * /!\ AN MCP CALL MUST RETURN A HANDLE TO THE SERVER-SIDE RECORD OF ITSELF. SHAT-1463/1468.
 *
 * The backend has always sent one. `writeErrorCtx` (apps/api/api/v1/authorizations.go) puts
 * `request_id` in every error body, and on a REDACTED 5xx it MINTS a correlation id for exactly this
 * purpose: the message the client sees is stripped, and `logRedactedError` writes the real detail to
 * the server log under that id. The id is the join between the two.
 *
 * client.ts threw the whole body away. So the one field that existed to make a failure traceable
 * never left the process, and a person debugging a 500 had a fixed sentence — "This is a transient
 * server-side issue" — and no way at all to find the record behind it.
 *
 * /!\ AND READING IT DOES NOT WEAKEN THE REDACTION, WHICH IS THE OBJECTION THIS FILE HAS TO ANSWER,
 * because SECURITY.md's promise is real and must survive: "upstream API error detail is not
 * forwarded to the LLM". The rule is about DETAIL. It is kept by extracting exactly one field by
 * name and discarding the rest of the body unread — never `error`, never `detail`, never a message.
 * A pointer to a record is not the record: the detail stays where only somebody with log access can
 * read it. The leak test below is what holds that line, and it matters more than the feature.
 *
 * 1469 (audit_log_id) and 1470 (CSV export) are the same subject at other granularities and ride on
 * this plumbing — which is why they are one piece of work with three faces rather than three
 * tickets over one file.
 */

let server: Server | undefined

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  }
})

/** An upstream that fails with a given status and body. */
async function failingUpstream(status: number, body: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function callAndCatch(url: string): Promise<ShataleApiError> {
  const client = new ShataleClient(url, 'sk_sandbox_test', 2000)
  try {
    await client.request('GET', '/v1/purchases/pur_1')
  } catch (err) {
    if (err instanceof ShataleApiError) return err
    throw err
  }
  throw new Error('the call did not throw, so there is no error to inspect')
}

describe('an error carries the id of its own server-side record (SHAT-1468)', () => {
  it('a redacted 5xx surfaces the correlation id the backend minted for it', async () => {
    const url = await failingUpstream(500, {
      error: 'internal error',
      code: 'internal_error',
      suggested_fix: 'Retry later; quote the request_id if it persists.',
      request_id: 'req_01J8XYZCORRELATION',
    })
    const err = await callAndCatch(url)
    expect(
      err.request_id,
      'the correlation id did not survive. On a redacted 5xx it is the ONLY link between the fixed ' +
        'sentence the agent is shown and the real detail in the server log — the backend mints it ' +
        'for that purpose. Without it the person debugging has a sentence and nothing to search.',
    ).toBe('req_01J8XYZCORRELATION')
    expect(err.toStructured().request_id).toBe('req_01J8XYZCORRELATION')
  })

  it('a 404 surfaces it too', async () => {
    const url = await failingUpstream(404, { error: 'not found', request_id: 'req_404' })
    const err = await callAndCatch(url)
    expect(err.code).toBe('not_found')
    expect(err.request_id).toBe('req_404')
  })

  // /!\ THE LINE THAT MATTERS MORE THAN THE FEATURE. If reading the body ever widens past the one
  // whitelisted key, this is the test that says so — and it asserts on the SERIALISED error, which
  // is what actually reaches the model.
  it('NOTHING ELSE from the upstream body reaches the agent', async () => {
    const url = await failingUpstream(500, {
      error: 'pq: duplicate key value violates unique constraint "cards_pan_key"',
      detail: 'PAN 4242424242424242 CVV 123',
      internal_hint: 'connection string postgres://user:hunter2@db',
      request_id: 'req_leaktest',
    })
    const err = await callAndCatch(url)
    const serialised = JSON.stringify(err.toStructured())

    expect(err.request_id).toBe('req_leaktest')
    for (const secret of ['4242424242424242', 'hunter2', 'cards_pan_key', 'duplicate key', 'postgres://']) {
      expect(
        serialised,
        `upstream detail reached the structured error: ${secret}\n\n` +
          `SECURITY.md promises "upstream API error detail is not forwarded to the LLM", and the ` +
          `whole justification for reading the error body at all is that exactly ONE key is taken ` +
          `by name and the rest is discarded unread. If the extraction has widened, this is the ` +
          `leak that closes SHAT-1463's original finding re-opening.`,
      ).not.toContain(secret)
    }
    expect(err.message).toBe('Shatale API server error (HTTP 500).')
  })

  // /!\ AND THE READ MUST NOT BECOME A NEW FAILURE MODE. The body is attacker-influenced in the
  // general case and merely unreliable in the normal one; either way, a malformed body must leave
  // the error exactly as it was before this change.
  it.each([
    ['an empty body', ''],
    ['not JSON at all', '<html>502 Bad Gateway</html>'],
    ['JSON with no request_id', JSON.stringify({ error: 'nope' })],
    ['a request_id that is not a string', JSON.stringify({ request_id: { nested: 'object' } })],
    ['a request_id that is absurdly long', JSON.stringify({ request_id: 'x'.repeat(5000) })],
  ])('%s still yields the ordinary structured error', async (_label, body) => {
    const url = await failingUpstream(500, body)
    const err = await callAndCatch(url)
    expect(err.code).toBe('upstream_error')
    expect(err.request_id, 'a malformed body must not populate the id').toBeUndefined()
    expect(JSON.stringify(err.toStructured())).not.toContain('nested')
    expect(JSON.stringify(err.toStructured())).not.toContain('xxxxx')
  })

  // The extractor's own two-way control, on inputs this test owns — so a change that made it return
  // undefined for everything would fail here rather than quietly disabling the feature everywhere.
  it('the extractor separates a usable id from everything else', () => {
    expect(extractRequestId({ request_id: 'req_1' })).toBe('req_1')
    expect(extractRequestId({ request_id: '  req_2  ' })).toBe('req_2')
    expect(extractRequestId({ request_id: '' })).toBeUndefined()
    expect(extractRequestId({ request_id: '   ' })).toBeUndefined()
    expect(extractRequestId({ request_id: 42 })).toBeUndefined()
    expect(extractRequestId(null)).toBeUndefined()
    expect(extractRequestId('a string body')).toBeUndefined()
    expect(extractRequestId({ error: 'no id here' })).toBeUndefined()
  })
})
