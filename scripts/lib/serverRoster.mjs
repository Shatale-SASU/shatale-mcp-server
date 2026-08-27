import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The tool roster, asked of the RUNNING SERVER over MCP, one process per mode.
//
// ⚠️ IT LIVES HERE BECAUSE TWO CALLERS NEED IT AND A SECOND COPY IS HOW THE FIRST GOES STALE —
// SHAT-2527. The README gate had this mechanism; the coverage gate grew its own, which read the
// source text under src/tools and called eight hardcoded factories. Both of those miss a tool
// declared OUTSIDE that directory, so they agreed with each other — and two readers sharing a blind
// spot is the very defect they exist to catch, one level up. Measured: a flag-gated tool in
// src/storefront.ts shipped with the whole suite green.
//
// Asking the server is the only derivation that CROSSES THE BOUNDARY: it does not care where a file
// sits, how a name is quoted, or which factory produced it. It reports what an MCP client is
// offered, which is the thing every one of these documents is about.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const GO_CODE = 'gate-local-money-go-not-a-real-code'
export const GO_SHA = createHash('sha256').update(GO_CODE, 'utf8').digest('hex')

// Stub keys: prefix-shaped, never authenticated. tools/list needs no valid key, and
// SHATALE_API_URL is pinned to a dead loopback port so no probe can reach any real host.
export const MODES = [
  ['guest', 'guest (no key)', {}],
  ['sandbox', 'sandbox', { SHATALE_API_KEY: 'sk_sandbox_gate_stub' }],
  ['sandbox+flags', 'sandbox + flags', { SHATALE_API_KEY: 'sk_sandbox_gate_stub', SHATALE_ONBOARDING_ENABLED: 'true', SHATALE_CREDENTIAL_EMAILS_ENABLED: 'true' }],
  ['live', 'live, no money-GO', { SHATALE_API_KEY: 'sk_live_gate_stub', SHATALE_MODE: 'live' }],
  ['live+money', 'live + money-GO', { SHATALE_API_KEY: 'sk_live_gate_stub', SHATALE_MODE: 'live', SHATALE_MONEY_GO: GO_CODE, SHATALE_MONEY_GO_SHA256: GO_SHA }],
  ['live+money+flags', 'live + money-GO + flags', { SHATALE_API_KEY: 'sk_live_gate_stub', SHATALE_MODE: 'live', SHATALE_MONEY_GO: GO_CODE, SHATALE_MONEY_GO_SHA256: GO_SHA, SHATALE_ONBOARDING_ENABLED: 'true', SHATALE_CREDENTIAL_EMAILS_ENABLED: 'true' }],
]

const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, SHATALE_API_URL: 'http://127.0.0.1:9' }

/** Speaks MCP to one freshly spawned server and reports what it advertised. */
export function speak(entry, extraEnv, calls = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env: { ...BASE_ENV, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'roster', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    calls.forEach((c, i) => send({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: c, arguments: {} } }))
    setTimeout(() => {
      child.stdin.end(); child.kill()
      const frames = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const byId = new Map(frames.map((f) => [f.id, f]))
      const listed = byId.get(2)?.result?.tools ?? null
      resolve({
        exit: child.exitCode,
        stderr: err.trim(),
        tools: listed?.map((t) => t.name) ?? null,
        descriptions: listed ? new Map(listed.map((t) => [t.name, t.description ?? ''])) : null,
        calls: calls.map((c, i) => [c, byId.get(100 + i)?.result?.content?.[0]?.text ?? null]),
      })
    }, calls.length ? 3500 : 1200)
  })
}

/**
 * What each mode advertises, and the union in registration order.
 *
 * A mode that advertises nothing is an ERROR, not an empty set: the server failed to start, and an
 * empty list silently shrinks every count computed from it.
 */
export async function measureRoster(entry = path.join(REPO, 'dist/index.js')) {
  const advertised = new Map()
  const describes = new Map()
  const failures = []
  for (const [id, , env] of MODES) {
    const r = await speak(entry, env)
    if (!r.tools) {
      failures.push(`mode "${id}": the server advertised no tool list (exit ${r.exit}). stderr: ${r.stderr || '(empty)'}`)
      advertised.set(id, [])
      continue
    }
    advertised.set(id, r.tools)
    for (const [n, d] of r.descriptions) if (!describes.has(n)) describes.set(n, d)
  }
  const union = []
  for (const [id] of MODES) for (const t of advertised.get(id)) if (!union.includes(t)) union.push(t)
  return { advertised, describes, union, failures }
}
