#!/usr/bin/env node
/**
 * SHAT-2165 — pre-publish gate.
 *
 * WHY THIS EXISTS
 *
 * The unit/e2e suite cannot catch a type divergence against the Go backend, and it has
 * shipped a broken server twice for the same reason:
 *
 *   0.2.1 — `mcc` went out as a JSON number while apps/api decodes `MCC string`. Go's
 *           decoder rejected the body, so every sandbox policy call returned HTTP 400
 *           before the handler ran.
 *   0.5.0 — the identical defect, in the identical field. 129 green tests did not catch
 *           it: the mock upstream accepts any body, and the contract test asserted that
 *           `body.mcc` was a NUMBER. The suite certified the defect.
 *
 * A mock cannot answer "does the other side accept this?", because the mock is this side.
 * So this gate drives the BUILT server over stdio — the same binary npm would publish —
 * against a real deployment with a real sandbox key.
 *
 * THE PART THAT MAKES A NAIVE VERSION WORSE THAN NOTHING
 *
 * The backend answers 400 for "agent not found or does not belong to this publisher"
 * (apps/api/api/v1/sandbox.go:194) exactly as it answers 400 for a decode reject
 * (sandbox.go:120). The MCP discards upstream response bodies for leak safety
 * (src/errors.ts / client.ts), so through the tool those two are the SAME
 * `api_error` / HTTP 400. A gate asserting "no exception was thrown", or "we got a 400
 * from a bad request", would have gone green on the broken 0.5.0 build.
 *
 * So the gate demands a positive DECISION — approve/decline from the policy engine, with
 * `is_sandbox: true` and an explanation — which is reachable only when the request body
 * DECODED and the agent EXISTS under the key's publisher. There is no way to satisfy that
 * assertion with a malformed body.
 *
 * The gate also runs a NEGATIVE CONTROL: the same call with a bogus agent id must NOT
 * yield a decision. If it did, the positive assertion would prove nothing about decoding.
 *
 * SAFETY: every request this script makes is read-only. POST /v1/sandbox/authorizations
 * runs the policy engine and writes nothing — no purchase, no ledger, no outbox, no money
 * (verified in apps/api/api/v1/sandbox.go: the handler only reads agent, delegation,
 * policy snapshot and skill bindings). GET /v1/agents is a read. The two sandbox routes
 * that DO write (users/{id}/onboarding, purchases/{id}/approve) are never called here.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'dist', 'index.js')

// The one deployment the existing live suite already targets (ci-sandbox.yml / nightly.yml
// run with SHATALE_TEST_KEY and no SHATALE_API_URL, i.e. the default prod base). Overridable
// so the gate can be pointed at staging the day a staging-issued sandbox key exists.
const DEFAULT_API_URL = 'https://api.shatale.com'

const NEUTRAL_TEST_CARD = '4111111111111111' // lets the REAL policy decide (not the forced-approve 4242)

let failures = 0

function log(msg = '') {
  process.stdout.write(msg + '\n')
}

/** Hard stop: the gate could not run, therefore it proved nothing. Never a skip. */
function abort(reason, hint) {
  log('')
  log('╔══════════════════════════════════════════════════════════════════════╗')
  log('║  GATE FAILED — it could not run, so it proved NOTHING                ║')
  log('╚══════════════════════════════════════════════════════════════════════╝')
  log(`  ${reason}`)
  if (hint) log(`  → ${hint}`)
  log('')
  process.exit(1)
}

function check(ok, label, detail) {
  if (ok) {
    log(`  PASS  ${label}`)
  } else {
    failures++
    log(`  FAIL  ${label}`)
    if (detail) log(`        ${detail}`)
  }
  return ok
}

/** Show enough of a key to identify it in a log, never enough to use it. */
function keyFingerprint(key) {
  const prefix = key.slice(0, 11)
  return `${prefix}…(${key.length} chars)`
}

// ── 1. Environment ────────────────────────────────────────────────────────────

const apiKey = process.env.SHATALE_GATE_API_KEY || process.env.SHATALE_TEST_KEY || ''
const apiUrl = (process.env.SHATALE_GATE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '')
const explicitAgentId = process.env.SHATALE_GATE_AGENT_ID || ''

if (!apiKey) {
  abort(
    'No sandbox API key. Set SHATALE_GATE_API_KEY (or SHATALE_TEST_KEY).',
    'Without a key nothing reaches the backend, and an unreached backend cannot certify anything.',
  )
}
if (apiKey.startsWith('sk_live_') || apiKey.startsWith('sh_live_')) {
  abort(
    'A LIVE key was supplied. This gate runs against real deployments and must never hold one.',
    'Use a sandbox key (sk_sandbox_*). The sandbox authorization route is read-only; the live surface is not.',
  )
}
if (!/^(sk_sandbox_|sk_test_|sh_test_)/.test(apiKey)) {
  abort(
    `Unrecognized API key prefix (${keyFingerprint(apiKey)}).`,
    'The sandbox policy route is mounted behind SandboxOnly() and 403s anything that is not a sandbox key.',
  )
}

let apiHost
try {
  apiHost = new URL(apiUrl).hostname
} catch {
  abort(`SHATALE_GATE_API_URL is not a URL: ${apiUrl}`)
}
if (!(apiHost.endsWith('.shatale.com') || apiHost === 'shatale.com')) {
  abort(`Refusing to send a real API key to ${apiHost}.`, 'Only *.shatale.com targets are allowed.')
}

// ── 2. The build under test must BE the build ─────────────────────────────────
//
// A gate that certifies a stale dist/ is the same unearned green this ticket exists to
// end: you would fix a bug in src/, forget to build, and the gate would bless the old
// artifact. npm publishes dist/, so dist/ is what gets driven — and it has to be current.

if (!existsSync(ENTRY)) {
  abort(`No build at ${ENTRY}.`, 'Run `npm run build` first — this gate drives the built artifact, not the sources.')
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    const t = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs
    if (t > newest) newest = t
  }
  return newest
}

const srcNewest = newestMtime(join(ROOT, 'src'))
const distMtime = statSync(ENTRY).mtimeMs
if (srcNewest > distMtime) {
  abort(
    'dist/ is older than src/ — the gate would certify a build that is not the current code.',
    'Run `npm run build` and re-run the gate.',
  )
}

// ── 3. Direct HTTP helpers (setup + diagnostics only, never the assertion) ─────

async function api(method, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'shatale-mcp-publish-gate',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

// ── 4. A seeded agent that really exists ──────────────────────────────────────
//
// The decision assertion is only reachable with an agent the key's publisher owns, so the
// agent id is part of the gate's premise — and an unverified premise is how a test ends up
// asserting nothing. Discovered at runtime rather than hardcoded (a hardcoded id rots into
// a permanent 400 the moment the seed changes), and a miss is a LOUD failure, never a skip.

async function resolveAgentId() {
  if (explicitAgentId) {
    const probe = await api('GET', `/v1/agents/${encodeURIComponent(explicitAgentId)}`)
    if (probe.status !== 200) {
      abort(
        `SHATALE_GATE_AGENT_ID=${explicitAgentId} does not resolve on ${apiHost} (HTTP ${probe.status}).`,
        'A gate pointed at a non-existent agent can only ever produce the 400 it cannot distinguish from a decode reject.',
      )
    }
    return explicitAgentId
  }

  const res = await api('GET', '/v1/agents')
  if (res.status === 401) {
    abort(
      `The API key is not valid on ${apiHost} (HTTP 401).`,
      'Sandbox keys are issued per deployment — a key minted on prod does not authenticate on staging, and vice versa.',
    )
  }
  if (res.status !== 200) {
    abort(`GET /v1/agents on ${apiHost} returned HTTP ${res.status}.`, res.text.slice(0, 300))
  }
  const list = Array.isArray(res.json) ? res.json : []
  const active = list.filter((a) => a && a.status === 'active' && typeof a.id === 'string')
  if (active.length === 0) {
    abort(
      `NO SEEDED AGENT — this gate proved nothing. ${apiHost} returned ${list.length} agent(s) for this key, none active.`,
      'Seed one (apps/api/cmd/seedtest) or set SHATALE_GATE_AGENT_ID. The gate refuses to report green without one.',
    )
  }
  return active[0].id
}

// ── 5. Minimal MCP stdio client ───────────────────────────────────────────────
//
// Deliberately hand-rolled and dependency-free: the gate must exercise the published
// artifact through the same newline-delimited JSON-RPC an editor speaks to it, without
// the test harness's TypeScript/vitest scaffolding in the way.

class StdioMcp {
  constructor(env) {
    this.proc = spawn('node', [ENTRY], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.buffer = ''
    this.stderr = ''
    this.pending = new Map()
    this.nextId = 1
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          waiter(msg)
        }
      }
    })
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
    })
    this.proc.on('error', () => {})
  }

  send(method, params) {
    const id = this.nextId++
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`timeout waiting for ${method}`))
      }, 45_000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
    })
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n')
  }

  async initialize() {
    const res = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'shatale-publish-gate', version: '1' },
    })
    this.notify('notifications/initialized')
    return res
  }

  async callTool(name, args) {
    const res = await this.send('tools/call', { name, arguments: args })
    return res.result ?? res.error
  }

  close() {
    this.proc.kill()
  }
}

/** Extract the tool's payload text, whatever the SDK wrapped it in. */
function resultText(result) {
  if (!result) return ''
  if (Array.isArray(result.content)) {
    return result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  }
  return JSON.stringify(result)
}

/**
 * THE assertion. A positive decision is only reachable past a successful decode AND a
 * real agent — which is why the gate demands one instead of demanding the absence of an
 * error. On the broken 0.5.0 build this returns false for every input.
 */
function assertDecision(label, result, expectedAgentId) {
  const text = resultText(result)
  if (result?.isError) {
    return check(false, label, `tool returned an error: ${text.slice(0, 300)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return check(false, label, `tool result is not JSON: ${text.slice(0, 300)}`)
  }
  const ok =
    (payload.decision === 'approved' || payload.decision === 'declined') &&
    payload.is_sandbox === true &&
    payload.explanation != null &&
    typeof payload.authorization_id === 'string' &&
    payload.authorization_id.startsWith('sandbox_') &&
    payload.agent_id === expectedAgentId
  return check(
    ok,
    label,
    ok
      ? undefined
      : `no positive decision in the payload: ${JSON.stringify({
          decision: payload.decision,
          is_sandbox: payload.is_sandbox,
          authorization_id: payload.authorization_id,
          agent_id: payload.agent_id,
          has_explanation: payload.explanation != null,
        })}`,
  )
}

/**
 * When the tool path fails, the MCP has already thrown the backend's message away. Ask the
 * backend directly with the two spellings so the operator sees WHICH 400 it was — a decode
 * reject and a missing agent are the same status through the tool, and the fix is different.
 */
async function diagnose(agentId) {
  log('')
  log('  Diagnostics — the MCP scrubs upstream bodies, so asking the backend directly:')
  const base = {
    agent_id: agentId,
    amount: 15000,
    currency: 'EUR',
    merchant_name: 'SHAT-2165 gate',
    card_number: NEUTRAL_TEST_CARD,
  }
  for (const [label, body] of [
    ['mcc as STRING "5999" (what the fixed client sends)', { ...base, mcc: '5999' }],
    ['mcc as NUMBER 5999 (the 0.2.1 / 0.5.0 defect)', { ...base, mcc: 5999 }],
    ['bogus agent id', { ...base, mcc: '5999', agent_id: 'AGENTDOESNOTEXIST000000000' }],
  ]) {
    const res = await api('POST', '/v1/sandbox/authorizations', body)
    const detail = res.json?.decision ?? res.json?.error ?? res.text.slice(0, 160)
    log(`    ${String(res.status).padEnd(4)} ${label} → ${detail}`)
  }
}

// ── 6. Run ────────────────────────────────────────────────────────────────────

async function main() {
  log('')
  log('SHAT-2165 pre-publish gate — built server over stdio against a real deployment')
  log(`  target      ${apiUrl}`)
  log(`  key         ${keyFingerprint(apiKey)}`)
  log(`  artifact    ${ENTRY}`)

  const health = await api('GET', '/healthz')
  if (health.status !== 200) {
    abort(`${apiHost} is not healthy (GET /healthz → HTTP ${health.status}).`)
  }

  const agentId = await resolveAgentId()
  log(`  agent       ${agentId}${explicitAgentId ? ' (from SHATALE_GATE_AGENT_ID)' : ' (discovered via GET /v1/agents)'}`)
  log('')

  const mcp = new StdioMcp({ SHATALE_API_KEY: apiKey, SHATALE_API_URL: apiUrl })
  try {
    const init = await mcp.initialize()
    check(init?.result?.serverInfo?.name === 'shatale-mcp', 'MCP server handshakes over stdio', JSON.stringify(init?.result?.serverInfo))

    const listed = await mcp.send('tools/list')
    const names = (listed.result?.tools ?? []).map((t) => t.name)
    if (!check(names.includes('sandbox_simulate_authorization'), 'sandbox_simulate_authorization is advertised', `tools: ${names.join(', ') || '(none)'}`)) {
      abort('The sandbox policy tool is not even registered — the key did not put the server in sandbox mode.')
    }

    const common = {
      agent_id: agentId,
      amount: 15000,
      currency: 'EUR',
      merchant_name: 'SHAT-2165 gate',
      card_number: NEUTRAL_TEST_CARD,
    }

    // The spelling the current tool schema documents.
    assertDecision(
      'string mcc "5999" reaches a policy DECISION (decode + agent both proven)',
      await mcp.callTool('sandbox_simulate_authorization', { ...common, mcc: '5999' }),
      agentId,
    )

    // The spelling 0.2.1 and 0.5.0 put on the wire raw. It must still reach a decision,
    // because the client normalises it — an agent following an older tool description
    // sends a number, and dropping that normalisation is a regression this gate must see.
    assertDecision(
      'numeric mcc 5999 is normalised and still reaches a DECISION',
      await mcp.callTool('sandbox_simulate_authorization', { ...common, mcc: 5999 }),
      agentId,
    )

    // Negative control. If a nonexistent agent ALSO produced a decision, the two
    // assertions above would be satisfiable without the request ever decoding correctly,
    // and this gate would be theatre.
    const bogus = await mcp.callTool('sandbox_simulate_authorization', {
      ...common,
      mcc: '5999',
      agent_id: 'AGENTDOESNOTEXIST000000000',
    })
    const bogusText = resultText(bogus)
    let bogusDecision
    try {
      bogusDecision = JSON.parse(bogusText).decision
    } catch {
      bogusDecision = undefined
    }
    check(
      bogus?.isError === true && bogusDecision === undefined,
      'negative control: a nonexistent agent yields NO decision',
      `got: ${bogusText.slice(0, 200)}`,
    )

    if (failures > 0) {
      log('')
      log(`  server stderr: ${mcp.stderr.trim().split('\n').slice(-3).join(' | ') || '(empty)'}`)
      await diagnose(agentId)
    }
  } finally {
    mcp.close()
  }

  log('')
  if (failures > 0) {
    log('╔══════════════════════════════════════════════════════════════════════╗')
    log(`║  GATE RED — ${String(failures).padEnd(2)} check(s) failed. DO NOT PUBLISH.                     ║`)
    log('╚══════════════════════════════════════════════════════════════════════╝')
    log('')
    process.exit(1)
  }
  log('╔══════════════════════════════════════════════════════════════════════╗')
  log('║  GATE GREEN — the built server got a real policy decision back.      ║')
  log('╚══════════════════════════════════════════════════════════════════════╝')
  log('')
}

main().catch((err) => {
  abort(`The gate crashed: ${err?.message ?? err}`, 'A crash is a failure, not a skip.')
})
