import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

export interface CapturedRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  authorization?: string
}

/**
 * Deterministic stand-in for the Shatale API.
 *
 * Lets the MCP server's authenticated/sandbox tools run in CI with no live
 * SHATALE_TEST_KEY: point the server at this server via SHATALE_API_URL
 * (127.0.0.1 is in the server's host allowlist) and a fake `sk_test_` key.
 *
 * Every request is recorded so tests can assert on the exact outbound wire
 * body (e.g. that request_purchase sends merchant_ref + integer amount_cents).
 */
export class MockUpstream {
  private server: Server
  readonly requests: CapturedRequest[] = []

  private constructor(server: Server) {
    this.server = server
  }

  static async start(): Promise<MockUpstream> {
    let mock!: MockUpstream
    const server = createServer((req, res) => mock.handle(req, res))
    mock = new MockUpstream(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return mock
  }

  /** Base URL the MCP server should be pointed at (SHATALE_API_URL). */
  get url(): string {
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  /** Most recent captured request for a given METHOD + path prefix. */
  lastRequest(method: string, pathPrefix: string): CapturedRequest | undefined {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i]
      if (r.method === method && r.path.startsWith(pathPrefix)) return r
    }
    return undefined
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      this.requests.push({
        method: req.method ?? 'GET',
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body,
        authorization: req.headers['authorization'] as string | undefined,
      })
      const { status, payload } = MockUpstream.route(req.method ?? 'GET', u.pathname)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  }

  /** Canned, deterministic responses keyed by METHOD + path shape. */
  private static route(method: string, path: string): { status: number; payload: unknown } {
    const ok = (payload: unknown) => ({ status: 200, payload })

    if (method === 'GET' && path === '/v1/mcc-codes') {
      return ok({ codes: [{ code: 5732, description: 'Electronics Stores', category: 'retail' }] })
    }
    if (method === 'GET' && path.startsWith('/v1/merchants/catalog/')) {
      return ok({ id: path.split('/').pop(), name: 'Mock Merchant', mcc: 5732, country: 'US' })
    }
    if (method === 'GET' && path === '/v1/merchants/catalog') {
      return ok({ merchants: [{ id: 'mock-merchant', name: 'Mock Merchant', country: 'US' }] })
    }
    if (method === 'POST' && path === '/v1/purchases') {
      return ok({ purchase_id: 'pur_mock_1', status: 'pending' })
    }
    if (method === 'GET' && path.startsWith('/v1/purchases/')) {
      return ok({ purchase_id: path.split('/').pop(), status: 'pending' })
    }
    if (method === 'DELETE' && path.startsWith('/v1/purchases/')) {
      return ok({ purchase_id: path.split('/').pop(), status: 'cancelled' })
    }
    if (method === 'POST' && path === '/v1/credentials') {
      return ok({ credential_id: 'cred_mock_1', status: 'issued' })
    }
    if (method === 'GET' && path.startsWith('/v1/credentials/')) {
      return ok({ credential_id: path.split('/').pop(), status: 'issued' })
    }
    if (method === 'POST' && path === '/v1/onboarding/register') {
      return ok({ session_id: 'sess_mock_1', status: 'pending_verification' })
    }
    if (method === 'GET' && path.startsWith('/v1/onboarding/sessions/')) {
      return ok({ session_id: path.split('/').pop(), status: 'pending_verification' })
    }
    if (method === 'POST' && path === '/v1/sandbox/users') {
      return ok({ user_id: 'usr_mock_1', status: 'verified' })
    }
    if (method === 'POST' && /\/v1\/sandbox\/users\/[^/]+\/onboarding$/.test(path)) {
      return ok({ status: 'onboarded' })
    }
    if (method === 'POST' && /\/v1\/sandbox\/requests\/[^/]+\/approve$/.test(path)) {
      return ok({ status: 'approved' })
    }
    if (method === 'POST' && /\/v1\/sandbox\/requests\/[^/]+\/decline$/.test(path)) {
      return ok({ status: 'declined' })
    }
    if (method === 'POST' && path === '/v1/sandbox/reset') {
      return ok({ status: 'reset' })
    }
    return { status: 404, payload: { error: 'not_found', path } }
  }
}
