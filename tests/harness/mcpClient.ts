import { existsSync } from 'node:fs'
import { spawn, ChildProcess } from 'child_process'
import { resolve } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'

export class McpTestClient {
  private proc: ChildProcess
  private buffer = ''
  private stderrBuffer = ''
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>()
  private nextId = 1
  private testName: string

  constructor(env: Record<string, string> = {}, testName = 'default') {
    this.testName = testName
    const entryPoint = resolve(import.meta.dirname, '../../dist/index.js')
    requireBuiltServer(entryPoint)
    this.proc = spawn('node', [entryPoint], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.processBuffer()
    })

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString()
    })

    // Prevent unhandled error crashes in tests
    this.proc.on('error', () => {})
  }

  private processBuffer() {
    // JSON-RPC messages are newline-delimited
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.resolve(msg)
          this.pending.delete(msg.id)
        }
      } catch {
        // Not JSON — ignore (e.g. debug output)
      }
    }
  }

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`))
      }, 10_000)

      this.pending.set(id, {
        resolve: (msg: any) => {
          clearTimeout(timeout)
          resolve(msg)
        },
        reject: (err: any) => {
          clearTimeout(timeout)
          reject(err)
        },
      })

      const req = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }) + '\n'

      this.proc.stdin!.write(req)
    })
  }

  /**
   * Initialize MCP connection with readiness probe.
   * Retries the initialize handshake up to `maxRetries` times with exponential backoff.
   */
  async initialize(maxRetries = 3): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await Promise.race([
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-harness', version: '1.0.0' },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Readiness probe timeout (5s)')), 5000)
          ),
        ])
        return result
      } catch (err) {
        if (attempt === maxRetries) throw err
        // Exponential backoff: 500ms, 1000ms
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }

  async listTools(): Promise<string[]> {
    const res = await this.send('tools/list')
    return (res.result?.tools ?? []).map((t: any) => t.name)
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await this.send('tools/call', { name, arguments: args })
    return res.result ?? res.error
  }

  async listResources(): Promise<any[]> {
    const res = await this.send('resources/list')
    return res.result?.resources ?? []
  }

  async listPrompts(): Promise<any[]> {
    const res = await this.send('prompts/list')
    return res.result?.prompts ?? []
  }

  /** Get captured stderr output */
  getStderr(): string {
    return this.stderrBuffer
  }

  close() {
    // Save server logs if there's any stderr output (useful for CI artifacts)
    if (this.stderrBuffer) {
      try {
        const logPath = `/tmp/mcp-test-${this.testName}-${Date.now()}.log`
        writeFileSync(logPath, this.stderrBuffer)
      } catch {
        // Best effort — don't fail tests over log saving
      }
    }

    // Drain pending promises so tests don't hang
    for (const [id, handler] of this.pending) {
      handler.reject(new Error('Client closed'))
      this.pending.delete(id)
    }
    this.proc.kill()
  }
}

/**
 * ⚠️ A SUITE THAT CANNOT RUN MUST SAY SO, NOT FAIL AS IF IT HAD MEASURED — SHAT-2527.
 *
 * These tests drive the BUILT server, so without dist/ every spawn dies and the suites report
 * failures. That is what they did: 21 red across three files, including three cases labelled
 * CONTROL — and a run where the controls fail proves nothing in either direction, because the
 * instrument has not confirmed its own health.
 *
 * `npm test` now builds first, so the ordinary path cannot reach this. It exists for the path that
 * bypasses the script — `npx vitest run …`, which is what a person reaches for when re-running one
 * file, and how this was met in the first place.
 */
export function requireBuiltServer(entryPoint: string): void {
  if (existsSync(entryPoint)) return
  throw new Error(
    `the built server is missing at ${entryPoint}. These tests drive the compiled output, not the ` +
      `sources, so nothing here has been measured. Run \`npm run build\` (or \`npm test\`, which ` +
      `builds first). This is a missing precondition, not a failing assertion.`,
  )
}
