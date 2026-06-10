import { describe, test, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { ShataleApiError } from '../../src/errors.js'
import { VERSION } from '../../src/version.js'

const BASE = 'http://127.0.0.1:9'

function mockFetch(status: number, payload: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function lastHeaders(fn: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fn.mock.calls[fn.mock.calls.length - 1][1] as RequestInit
  return init.headers as Record<string, string>
}

afterEach(() => vi.unstubAllGlobals())

describe('SHAT-1465 attribution headers', () => {
  test('sandbox (authenticated) requests carry attribution headers', async () => {
    const fn = mockFetch(200, { ok: true })
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')
    await client.getPurchaseStatus('pur_1')
    const h = lastHeaders(fn)
    expect(h['Authorization']).toBe('Bearer sk_sandbox_abc')
    expect(h['User-Agent']).toBe(`shatale-mcp-server/${VERSION}`)
    expect(h['X-Shatale-Client']).toBe('shatale-mcp-server')
    expect(h['X-Shatale-Client-Version']).toBe(VERSION)
  })

  test('guest (no key) requests send NO attribution headers — stays untracked', async () => {
    const fn = mockFetch(200, { merchants: [] })
    const client = new ShataleClient(BASE, '')
    // catalog/mcc are the only guest-reachable network calls
    await client.request('GET', '/v1/merchants/catalog')
    const h = lastHeaders(fn)
    expect(h['Authorization']).toBeUndefined()
    expect(h['User-Agent']).toBeUndefined()
    expect(h['X-Shatale-Client']).toBeUndefined()
    expect(h['X-Shatale-Client-Version']).toBeUndefined()
    expect(h['Content-Type']).toBe('application/json')
  })
})

describe('SHAT-1463 client throws structured ShataleApiError', () => {
  test('401 → ShataleApiError auth_failed', async () => {
    mockFetch(401, { error: 'nope' })
    const client = new ShataleClient(BASE, 'sk_sandbox_abc')
    await expect(client.getPurchaseStatus('x')).rejects.toMatchObject({
      code: 'auth_failed',
    })
    await expect(client.getPurchaseStatus('x')).rejects.toBeInstanceOf(ShataleApiError)
  })

  test('listMCCCodes falls back to built-in list on upstream error (no throw)', async () => {
    mockFetch(500, { error: 'boom' })
    const client = new ShataleClient(BASE, '')
    const res = (await client.listMCCCodes('travel')) as { source: string; codes: unknown[] }
    expect(res.source).toBe('built-in')
    expect(res.codes.length).toBeGreaterThan(0)
  })
})
