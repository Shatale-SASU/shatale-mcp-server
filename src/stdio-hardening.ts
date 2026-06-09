import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

/**
 * F-009 — harden the stdio session against malformed JSON-RPC frames.
 *
 * A malformed frame (e.g. a line containing `Infinity`, which is not valid JSON)
 * makes the SDK's StdioServerTransport throw while deserializing. The SDK routes
 * that to Server.onerror, which this server never set — so the bad frame was
 * dropped silently and no response was written. A client awaiting that request id
 * then blocked forever (the transport itself stays alive, but the pending call
 * never resolves).
 *
 * stdio is a 1:1 pipe to a single client, so the robust, upgrade-safe recovery is:
 * surface every protocol error to stderr and, on a frame-deserialize error, emit a
 * best-effort JSON-RPC Parse error and gracefully close the session. Closing makes
 * the client observe the disconnect and reject its pending requests (and respawn) —
 * a spec-correct `id: null` response alone does NOT do this, because clients
 * correlate responses by request id and ignore `id: null`.
 *
 * We deliberately act ONLY on frame-deserialize errors (JSON syntax / schema
 * validation). Other Server.onerror events (e.g. "Received a response for an
 * unknown message ID") are benign and must NOT tear down the session — closing on
 * every onerror would be a self-inflicted denial of service. Those are logged only.
 *
 * This uses the public Server.onerror / Server.close() API only — no
 * monkey-patching of the SDK's internal ReadBuffer / processReadBuffer, which would
 * be fragile against the SDK version range.
 *
 * Ported from the monorepo @shatale/mcp-server copy (SHAT-1447 canonicalization)
 * so the canonical standalone gains the runtime hardening it lacked.
 */

/** JSON-RPC 2.0 Parse error code. */
export const PARSE_ERROR_CODE = -32700

/**
 * Serialized JSON-RPC Parse error frame, newline-terminated. `id` is null per the
 * JSON-RPC 2.0 spec: a frame that fails to deserialize has no recoverable id.
 */
export const PARSE_ERROR_FRAME =
  JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: PARSE_ERROR_CODE, message: 'Parse error' },
  }) + '\n'

/**
 * True when `err` is a transport frame-deserialize failure: a `JSON.parse`
 * SyntaxError, or a zod schema-validation error from `JSONRPCMessageSchema.parse`.
 * These mean the inbound byte stream is corrupted / non-conformant and the frame's
 * request id cannot be recovered. Matched by `name` for zod to avoid importing zod
 * and coupling to its version.
 */
export function isFrameDeserializeError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true
  const name = (err as { name?: unknown } | null | undefined)?.name
  return name === 'ZodError'
}

/** Minimal stream sink, satisfied by `process.stdout` / `process.stderr`. */
interface WritableSink {
  write(chunk: string): boolean
}

export interface StdioErrorHandlingOptions {
  stdout?: WritableSink
  stderr?: WritableSink
}

/** The subset of `Server` this module drives. */
type HardenableServer = Pick<Server, 'close'> & { onerror?: (error: Error) => void }

/**
 * Installs an upgrade-safe `Server.onerror` handler that hardens the stdio session
 * against malformed frames (F-009). Returns the installed handler (for testing).
 */
export function installStdioErrorHandling(
  server: HardenableServer,
  options: StdioErrorHandlingOptions = {},
): (error: Error) => void {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const handler = (error: Error): void => {
    const message = error instanceof Error ? error.message : String(error)
    try {
      stderr.write(`[shatale-mcp] protocol error: ${message}\n`)
    } catch {
      // stderr unavailable — nothing else we can do.
    }

    if (!isFrameDeserializeError(error)) return

    // Corrupted / non-conformant stream. Emit a best-effort spec Parse error frame
    // (harmless; aids logging clients), then close so the single stdio client
    // unblocks its pending requests and can respawn.
    try {
      stdout.write(PARSE_ERROR_FRAME)
    } catch {
      // stdout closed (EPIPE) — close the session anyway.
    }
    try {
      Promise.resolve(server.close()).catch(() => {})
    } catch {
      // close() threw synchronously (already closing) — ignore.
    }
  }

  server.onerror = handler
  return handler
}
