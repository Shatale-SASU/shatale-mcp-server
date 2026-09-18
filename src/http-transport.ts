import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

/**
 * SHAT-3520 slice A — a SECOND transport, added beside stdio and not replacing it.
 *
 * 🔴 STDIO IS THE SHIPPED PATH. It is what Claude Desktop and Cursor speak, which is everybody who
 * installs this package from npm today. Nothing here may change how that path starts.
 */

export type TransportChoice = 'stdio' | 'http'

export class UnknownTransportError extends Error {
  constructor(public readonly given: string) {
    super(
      `SHATALE_MCP_TRANSPORT=${JSON.stringify(given)} is not a transport this server speaks. ` +
        `Use "stdio" (the default) or "http".`,
    )
    this.name = 'UnknownTransportError'
  }
}

/**
 * Which transport to start, from an EXPLICIT declaration.
 *
 * ⚠️ IT DOES NOT ASK WHAT KIND OF ENVIRONMENT THIS IS, and acceptance ① says so in as many words.
 * "No TTY on stdin, so this must be a server" and "PORT is set, so this must be hosted" are both
 * guesses that are right until a CI runner, a container or a supervisor makes them wrong — and when
 * they are wrong the server comes up speaking a protocol nobody on the other end is speaking, which
 * looks like a hang rather than a misconfiguration.
 *
 * ⚠️ AN UNSET VARIABLE MEANS STDIO, AND THAT IS A DECLARED DEFAULT RATHER THAN A GUESS: it is the
 * transport every existing installation already uses, so the absence of a choice keeps them working
 * unchanged. A value we do not recognise is REFUSED rather than folded into that default — falling
 * back would start stdio for somebody who asked for "HTTP", "Http " or "htpp" and leave them
 * debugging a network they can reach.
 */
export function resolveTransport(raw: string | undefined): TransportChoice {
  if (raw === undefined || raw.trim() === '') return 'stdio'
  const given = raw.trim()
  if (given === 'stdio') return 'stdio'
  if (given === 'http') return 'http'
  throw new UnknownTransportError(given)
}

export type AuthVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_key'; status: 401 }
  | { ok: false; reason: 'key_not_accepted'; status: 401 }

/**
 * Whether a request may speak to this server, and — when it may not — WHICH of the two refusals it
 * earned.
 *
 * ⚠️ THE TWO REFUSALS ARE DIFFERENT ANSWERS TO DIFFERENT QUESTIONS, which is acceptance ③. "No key"
 * is a caller that has not been wired up yet; "key not accepted" is a caller wired up to the wrong
 * server or holding a retired key. Collapsing them into one "unauthorized" sends both to the same
 * dead end, and the second one — the one that looks configured — is the expensive one to diagnose.
 *
 * ⚠️ COMPARED IN CONSTANT TIME, and never echoed. A plain `===` on a secret leaks its prefix to
 * anyone who can time the refusal, and the whole point of this endpoint is that it stands on the
 * open internet. Lengths are compared first because timingSafeEqual throws on unequal lengths —
 * that comparison leaks the LENGTH of the expected key and nothing about its content.
 */
export function authoriseRequest(
  headerValue: string | string[] | undefined,
  expectedKey: string,
): AuthVerdict {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const presented = typeof raw === 'string' ? stripBearer(raw) : ''
  if (presented === '') return { ok: false, reason: 'missing_key', status: 401 }

  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expectedKey, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'key_not_accepted', status: 401 }
  }
  return { ok: true }
}

function stripBearer(value: string): string {
  const trimmed = value.trim()
  const m = /^Bearer\s+(.*)$/i.exec(trimmed)
  return (m ? m[1] : trimmed).trim()
}

/** The sentence a refused caller is given. It names the reason and carries no key material. */
export function refusalBody(reason: 'missing_key' | 'key_not_accepted'): string {
  const message =
    reason === 'missing_key'
      ? 'This endpoint requires a publisher key. Send it as: Authorization: Bearer <key>.'
      : 'The publisher key presented was not accepted by this server.'
  return JSON.stringify({ error: reason, message })
}

export interface HttpTransportOptions {
  port: number
  host: string
  /** The publisher key a caller must present. */
  expectedKey: string
  /** Builds a server per request — see the note on statelessness below. */
  createServer: () => Server
  onListening?: (address: { port: number; host: string }) => void
}

/**
 * Start the streamable-HTTP endpoint.
 *
 * ⚠️ STATELESS: A NEW SERVER AND A NEW TRANSPORT PER REQUEST. One `Server` holds one transport, so
 * sharing a single instance across callers would cross their replies — the defect that made the
 * module-level singleton untenable in the first place. Per-request construction costs a roster
 * rebuild and buys the property that two callers cannot observe each other at all.
 */
export async function startHttpTransport(options: HttpTransportOptions): Promise<void> {
  const http = createServer((req, res) => {
    void handle(req, res, options)
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host, () => {
      http.removeListener('error', reject)
      options.onListening?.({ port: options.port, host: options.host })
      resolve()
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<void> {
  const verdict = authoriseRequest(req.headers.authorization, options.expectedKey)
  if (!verdict.ok) {
    const body = refusalBody(verdict.reason)
    res.writeHead(verdict.status, {
      'content-type': 'application/json',
      // Names the scheme so a caller knows WHAT to present, without naming any key.
      'www-authenticate': 'Bearer realm="shatale-mcp"',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
    return
  }

  const server = options.createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  // Closing the transport when the response ends releases the per-request pair; without it every
  // request would leak a Server for the lifetime of the process.
  res.on('close', () => {
    void transport.close().catch(() => {})
    void server.close().catch(() => {})
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    process.stderr.write(`[shatale-mcp] http request failed: ${(err as Error).message}\n`)
    if (!res.headersSent) {
      const body = JSON.stringify({ error: 'internal_error' })
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(body)
    }
  }
}
