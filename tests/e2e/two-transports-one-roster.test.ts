import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { McpTestClient } from '../harness/mcpClient'

/**
 * SHAT-3520 slice A — the transport was ADDED, and both of them serve one roster.
 *
 * 🔴 THE POINT OF ACCEPTANCE ③ IS NOT "BOTH WORK". It is that the SETS MATCH. A tool present on one
 * path and absent on the other is the failure that diverges silently: every suite stays green, both
 * transports answer, and the difference is discovered by an integrator who was told a tool exists
 * and cannot see it.
 *
 * ⚠️ ASKED OF THE RUNNING SERVERS, NOT DERIVED FROM THE SOURCES — the rule this repository already
 * learned the hard way (SHAT-2527, the note on tests/harness/toolRoster.ts): two derivations that
 * share a blind spot AGREE, and their agreement is the defect. Two processes are started, each is
 * asked over its own protocol what it advertises, and the answers are compared.
 *
 * ⚠️ AND IT IS NOT KEY-GATED. The key here is SYNTHETIC — the mode is decided by the key's PREFIX
 * and listing tools touches no network — precisely so this cannot join the green-by-skip family
 * documented in sandbox-tools.test.ts, where a keyless CI never runs the file that would have gone
 * red.
 */

const KEY = 'sk_sandbox_0000000000000000000000'
const WRONG_KEY = 'sk_sandbox_1111111111111111111111'
const ENTRY = resolve(import.meta.dirname, '../../dist/index.js')

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(port))
    })
  })
}

/** Starts the server on HTTP and resolves once its banner says it is listening. */
function startHttp(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const proc = spawn('node', [ENTRY], {
    env: {
      ...process.env,
      SHATALE_API_KEY: KEY,
      SHATALE_MCP_TRANSPORT: 'http',
      SHATALE_MCP_HTTP_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.on('error', () => {})
  return new Promise((res, rej) => {
    let err = ''
    const timer = setTimeout(
      () => rej(new Error(`the http transport never said it was listening. stderr:\n${err}`)),
      15_000,
    )
    proc.stderr!.on('data', (c: Buffer) => {
      err += c.toString()
      if (err.includes(`listening=127.0.0.1:${port}`)) {
        clearTimeout(timer)
        res(proc)
      }
    })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`the http transport exited with ${code} before listening. stderr:\n${err}`))
    })
  })
}

/**
 * One MCP request over streamable HTTP, spoken directly rather than through the SDK client, so that
 * the REFUSALS can be read as HTTP — a client would turn both of them into one thrown error and the
 * distinction acceptance ③ is about would be invisible from here.
 */
async function rpc(port: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'two-transports-test', version: '0' },
  },
}

/** Reads a JSON-RPC result out of either a plain JSON body or an SSE frame. */
async function readResult(r: Response): Promise<any> {
  const text = await r.text()
  const line = text.includes('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : text
  return JSON.parse(line)
}

describe('two transports, one roster', () => {
  let http: ChildProcess
  let port: number

  beforeAll(async () => {
    port = await freePort()
    http = await startHttp(port)
  }, 30_000)

  afterAll(() => {
    http?.kill()
  })

  // Acceptance ①, the half that is about HTTP existing at all.
  test('the http transport answers an MCP initialize', async () => {
    const r = await rpc(port, INIT, { authorization: `Bearer ${KEY}` })
    expect(r.status).toBe(200)
    const msg = await readResult(r)
    expect(msg.result?.serverInfo?.name).toBe('shatale-mcp')
  })

  // 🔴 ACCEPTANCE ④ — THE CANARY. stdio is what every installed client speaks; adding a transport
  // must not have cost it anything. A mutant that breaks stdio has to redden HERE, in the same file
  // that proves HTTP works, so the two cannot be reasoned about separately.
  test('stdio still speaks, after a second transport was added beside it', async () => {
    const client = new McpTestClient({ SHATALE_API_KEY: KEY }, 'canary-stdio')
    try {
      const init = await client.initialize()
      expect(init.result?.serverInfo?.name).toBe('shatale-mcp')
      const tools = await client.listTools()
      expect(tools.length).toBeGreaterThan(0)
    } finally {
      client.close()
    }
  }, 30_000)

  // 🔴 ACCEPTANCE ③ — the sets, not the liveness.
  test('both transports advertise exactly the same tools', async () => {
    const client = new McpTestClient({ SHATALE_API_KEY: KEY }, 'roster-stdio')
    let overStdio: string[]
    try {
      await client.initialize()
      overStdio = (await client.listTools()).sort()
    } finally {
      client.close()
    }

    await rpc(port, INIT, { authorization: `Bearer ${KEY}` })
    const r = await rpc(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authorization: `Bearer ${KEY}` },
    )
    const msg = await readResult(r)
    const overHttp = (msg.result?.tools ?? []).map((t: { name: string }) => t.name).sort()

    // An empty list is not agreement: two servers that both failed to register anything would
    // "match" perfectly. The floor is what stops this from passing by mutual silence.
    expect(overStdio.length).toBeGreaterThan(0)
    expect(overHttp.length).toBeGreaterThan(0)

    const onlyStdio = overStdio.filter((n) => !overHttp.includes(n))
    const onlyHttp = overHttp.filter((n: string) => !overStdio.includes(n))
    expect({ onlyStdio, onlyHttp }).toEqual({ onlyStdio: [], onlyHttp: [] })
  }, 60_000)

  // 🔴 ACCEPTANCE ③ (auth) — refused, and the two refusals say different things.
  test('a request with no key is refused, and says that a key is missing', async () => {
    const r = await rpc(port, INIT)
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ error: 'missing_key' })
  })

  test('a request with the wrong key is refused DIFFERENTLY from one with no key', async () => {
    const r = await rpc(port, INIT, { authorization: `Bearer ${WRONG_KEY}` })
    expect(r.status).toBe(401)
    const body = await r.json()
    expect(body).toMatchObject({ error: 'key_not_accepted' })
    // The distinction is the point: a caller that has not been wired up and one wired to the wrong
    // server are different problems, and one "unauthorized" for both sends them to the same dead end.
    expect(body.error).not.toBe('missing_key')
  })

  test('a refusal never echoes key material', async () => {
    const r = await rpc(port, INIT, { authorization: `Bearer ${WRONG_KEY}` })
    const text = await r.text()
    expect(text).not.toContain(WRONG_KEY)
    expect(text).not.toContain(KEY)
  })
})
