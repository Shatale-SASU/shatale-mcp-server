/**
 * SHAT-1447 / F-009: unit coverage for the stdio hardening handler.
 *
 * Drives installStdioErrorHandling directly with a fake server + capturing sinks
 * so the close / anti-self-DoS semantics are deterministic (the spawned-process
 * e2e can only observe the emitted Parse error frame, not the session close).
 */
import { describe, test, expect } from 'vitest'
import {
  installStdioErrorHandling,
  isFrameDeserializeError,
  PARSE_ERROR_CODE,
  PARSE_ERROR_FRAME,
} from '../../src/stdio-hardening.js'

function makeSinks() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: { write: (c: string) => (out.push(c), true) },
    stderr: { write: (c: string) => (err.push(c), true) },
  }
}

describe('stdio-hardening unit', () => {
  test('PARSE_ERROR_FRAME is a newline-terminated JSON-RPC parse error', () => {
    expect(PARSE_ERROR_FRAME.endsWith('\n')).toBe(true)
    const obj = JSON.parse(PARSE_ERROR_FRAME.trim())
    expect(obj.jsonrpc).toBe('2.0')
    expect(obj.id).toBeNull()
    expect(obj.error.code).toBe(PARSE_ERROR_CODE)
    expect(PARSE_ERROR_CODE).toBe(-32700)
  })

  test('isFrameDeserializeError matches SyntaxError and ZodError, not others', () => {
    expect(isFrameDeserializeError(new SyntaxError('bad json'))).toBe(true)
    expect(isFrameDeserializeError({ name: 'ZodError' })).toBe(true)
    expect(isFrameDeserializeError(new Error('unknown message id'))).toBe(false)
    expect(isFrameDeserializeError(null)).toBe(false)
  })

  test('frame-deserialize error: emits parse-error frame and closes the session', () => {
    const s = makeSinks()
    let closed = 0
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => (closed++, Promise.resolve()) }
    const handler = installStdioErrorHandling(server, { stdout: s.stdout, stderr: s.stderr })
    handler(new SyntaxError('Unexpected token I in JSON'))
    expect(s.out.join('')).toBe(PARSE_ERROR_FRAME)
    expect(s.err.join('')).toContain('protocol error')
    expect(closed).toBe(1)
  })

  test('benign protocol error: logs to stderr but does NOT close (no self-DoS)', () => {
    const s = makeSinks()
    let closed = 0
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => (closed++, Promise.resolve()) }
    const handler = installStdioErrorHandling(server, { stdout: s.stdout, stderr: s.stderr })
    handler(new Error('Received a response for an unknown message ID 42'))
    expect(s.out.join('')).toBe('')
    expect(s.err.join('')).toContain('protocol error')
    expect(closed).toBe(0)
  })

  test('tolerates a closed stdout (EPIPE) and still closes the session', () => {
    const s = makeSinks()
    let closed = 0
    const throwingStdout = { write: () => { throw new Error('EPIPE') } }
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => (closed++, Promise.resolve()) }
    const handler = installStdioErrorHandling(server, { stdout: throwingStdout, stderr: s.stderr })
    handler(new SyntaxError('bad'))
    expect(closed).toBe(1)
  })

  test('does not throw if server.close() rejects', async () => {
    const s = makeSinks()
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => Promise.reject(new Error('already closing')) }
    const handler = installStdioErrorHandling(server, { stdout: s.stdout, stderr: s.stderr })
    expect(() => handler(new SyntaxError('bad'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 5))
  })

  test('installs the handler as server.onerror', () => {
    const s = makeSinks()
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => Promise.resolve() }
    const handler = installStdioErrorHandling(server, { stdout: s.stdout, stderr: s.stderr })
    expect(server.onerror).toBe(handler)
  })
})
