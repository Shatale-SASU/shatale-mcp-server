/**
 * SHAT-1450: stdio transport hardening tests.
 *
 * Asserts the server survives a hostile/garbled stdio peer and never leaks the
 * API key. Drives the child process directly (bypassing the friendly harness)
 * so we can send malformed framing and oversized payloads.
 */
import { describe, test, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

const ENTRY = resolve(import.meta.dirname, '../../dist/index.js')
const SECRET_KEY = 'sk_test_supersecret_marker_9f8a7b6c'

interface Harness {
  proc: ChildProcess
  send: (raw: string) => void
  waitForId: (id: number, ms?: number) => Promise<any>
  stdout: () => string
  stderr: () => string
  kill: () => void
}

function spawnServer(env: Record<string, string> = {}): Harness {
  const proc = spawn('node', [ENTRY], {
    env: { ...process.env, SHATALE_API_KEY: SECRET_KEY, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  proc.stdout!.on('data', (c: Buffer) => { out += c.toString() })
  proc.stderr!.on('data', (c: Buffer) => { err += c.toString() })
  proc.on('error', () => {})

  return {
    proc,
    send: (raw: string) => proc.stdin!.write(raw),
    stdout: () => out,
    stderr: () => err,
    kill: () => proc.kill(),
    waitForId: (id: number, ms = 4000) =>
      new Promise((res, rej) => {
        const deadline = setTimeout(() => rej(new Error(`timeout waiting id=${id}`)), ms)
        const tick = setInterval(() => {
          for (const line of out.split('\n')) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line)
              if (msg.id === id) {
                clearInterval(tick); clearTimeout(deadline); res(msg); return
              }
            } catch { /* partial / non-JSON line */ }
          }
        }, 25)
      }),
  }
}

/** Resolve with the first JSON-RPC Parse error frame (id:null, code -32700). */
function waitForParseError(h: Harness, ms = 4000): Promise<any> {
  return new Promise((res, rej) => {
    const deadline = setTimeout(() => rej(new Error('timeout waiting for parse error frame')), ms)
    const tick = setInterval(() => {
      for (const line of h.stdout().split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === null && msg.error?.code === -32700) {
            clearInterval(tick); clearTimeout(deadline); res(msg); return
          }
        } catch { /* partial / non-JSON line */ }
      }
    }, 25)
  })
}


const initFrame = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0', id, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  }) + '\n'

describe('stdio hardening', () => {
  test('completes the initialize handshake', async () => {
    const h = spawnServer()
    try {
      h.send(initFrame(1))
      const res = await h.waitForId(1)
      expect(res.result).toBeDefined()
      expect(res.result.serverInfo?.name).toBe('shatale-mcp')
    } finally {
      h.kill()
    }
  })

  test('emits a JSON-RPC Parse error frame on a malformed frame', async () => {
    // F-009: a frame that fails to deserialize has no recoverable request id, so
    // the server emits a spec Parse error (id:null, -32700) on stdout before it
    // tears down the session. (The close itself is covered deterministically by
    // the unit test against installStdioErrorHandling — it is not observable from
    // a spawned child, whose stdin pipe is held open by this parent harness.)
    const h = spawnServer()
    try {
      h.send('{ "jsonrpc": "2.0", broken\n')
      const frame = await waitForParseError(h)
      expect(frame.id).toBeNull()
      expect(frame.error.code).toBe(-32700)
    } finally {
      h.kill()
    }
  })

  test('emits a Parse error on an oversized malformed line without crashing', async () => {
    // ~1MB of junk on a single line: still a malformed frame, so the F-009 path
    // applies — a Parse error frame rather than an uncaught crash on stderr.
    const h = spawnServer()
    try {
      h.send('x'.repeat(1_000_000) + '\n')
      const frame = await waitForParseError(h)
      expect(frame.error.code).toBe(-32700)
      expect(h.stderr()).not.toContain('uncaughtException')
    } finally {
      h.kill()
    }
  })

  test('does not leak the API key on stdout or stderr', async () => {
    const h = spawnServer()
    try {
      h.send(initFrame(1))
      await h.waitForId(1)
      // Poke unknown methods / bad params to provoke error paths.
      h.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } }) + '\n')
      h.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' }) + '\n')
      await new Promise((r) => setTimeout(r, 300))
      expect(h.stdout()).not.toContain(SECRET_KEY)
      expect(h.stderr()).not.toContain(SECRET_KEY)
    } finally {
      h.kill()
    }
  })

  test('rejects production keys at startup without echoing the key', async () => {
    const h = spawnServer({ SHATALE_API_KEY: 'sk_live_prod_should_be_rejected' })
    try {
      const code: number = await new Promise((res) => h.proc.on('exit', (c) => res(c ?? -1)))
      expect(code).toBe(1)
      expect(h.stderr()).not.toContain('sk_live_prod_should_be_rejected')
      expect(h.stderr().toLowerCase()).toContain('production keys')
    } finally {
      h.kill()
    }
  })
})
