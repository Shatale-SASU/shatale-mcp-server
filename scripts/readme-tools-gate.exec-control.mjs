#!/usr/bin/env node
//
// Negative control for the --exec pass of readme-tools-gate.mjs.
//
// --exec asserts that a tool the README invites is not merely LISTED but ANSWERS. Against
// the real server that pass is green, and green proves nothing: the real server backs
// tools/list and tools/call with the same map, so it cannot list a tool it will not run.
// So the control supplies a server that CAN: it advertises the full roster and implements
// no handler at all. The gate must go red under --exec and name the tool, and — this is
// the part that makes the control informative — must stay GREEN without --exec, showing
// that the two passes measure different things.
//
// Run: node scripts/readme-tools-gate.exec-control.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE = path.join(HERE, 'readme-tools-gate.mjs')
const REAL_ENTRY = path.join(REPO, 'dist/index.js')

// The roster is learned from the REAL build once, up front (below), and handed to the stub
// as data — so the stub answers instantly and the control cannot fail for being slow.
// Keyed by the same env signature the gate uses to select a mode.
const sig = (e) => [
  (e.SHATALE_API_KEY ?? '').slice(0, 11),
  e.SHATALE_MODE ?? '',
  e.SHATALE_MONEY_GO ? 'go' : '',
  e.SHATALE_ONBOARDING_ENABLED ?? '',
  e.SHATALE_CREDENTIAL_EMAILS_ENABLED ?? '',
].join('|')

// ⚠️ THE ENV TABLE IS NO LONGER A COPY — SHAT-2527. It used to mirror the gate's, with a comment
// arguing the duplication was "self-detecting" because a drift would make the roster lookup miss.
// It did detect it: removing SHATALE_CREDENTIAL_EMAILS_ENABLED from the gate's modes left this copy
// behind, the signatures stopped matching, every mode resolved to an EMPTY roster, and the failure
// surfaced as something else entirely — "README names get_onboarding_status but no server advertises
// it". A self-detecting copy still costs the next person the walk from that message back to here.
//
// Both callers now read the same MODES, and the money-GO pair comes with them, so there is nothing
// left to drift.
import { MODES, GO_CODE, GO_SHA } from './lib/serverRoster.mjs'
const MODE_ENVS = MODES.map(([, , env]) => env)

const { spawn } = await import('node:child_process')
function realList(extraEnv) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [REAL_ENTRY], { env: { PATH: process.env.PATH, HOME: process.env.HOME, SHATALE_API_URL: 'http://127.0.0.1:9', ...extraEnv }, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    const s = (o) => c.stdin.write(JSON.stringify(o) + '\n')
    s({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exec-control', version: '0' } } })
    s({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    s({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    setTimeout(() => {
      c.stdin.end(); c.kill()
      const f = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      res(f.find((x) => x.id === 2)?.result?.tools ?? [])
    }, 1200)
  })
}

const ROSTER = {}
for (const env of MODE_ENVS) {
  // sig() must see exactly what the stub will see: the gate's BASE_ENV plus the mode env.
  ROSTER[sig({ SHATALE_API_URL: 'http://127.0.0.1:9', ...env })] = await realList(env)
}

// A server that lists whatever the real one lists, and runs nothing.
const STUB = `
const ROSTER = ${JSON.stringify(ROSTER)}
const sig = ${sig.toString()}
const tools = ROSTER[sig(process.env)] ?? []
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    let result
    if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
    else if (msg.method === 'tools/list') result = { tools }            // advertises everything
    else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'Unknown tool: ' + msg.params.name }], isError: true }  // runs nothing
    else result = {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
`

const dir = mkdtempSync(path.join(tmpdir(), 'readme-gate-exec-'))
const stubPath = path.join(dir, 'stub-server.mjs')
writeFileSync(stubPath, STUB)
const readmePath = path.join(dir, 'README.md')
copyFileSync(path.join(REPO, 'README.md'), readmePath)
copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'))

function run(extra) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [GATE, '--readme', readmePath, '--entry', stubPath, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') } }
}

// The stub's roster equals the real one, so the matrix already matches. Regenerate anyway
// so the control cannot pass or fail for a reason other than the one being tested.
run(['--fix'])

const without = run([])
const with_ = run(['--exec'])

let bad = 0
if (without.code !== 0) {
  bad++
  console.log('FAIL  the stub should satisfy the static pass (it advertises the same roster), but the gate went red:')
  console.log(without.out.split('\n').slice(0, 10).map((l) => '      | ' + l).join('\n'))
} else {
  console.log('ok    static pass is GREEN against a server that lists everything and runs nothing')
}

const named = /Unknown tool/i.test(with_.out) && /is listed but answers/.test(with_.out)
if (with_.code === 0 || !named) {
  bad++
  console.log(`FAIL  --exec should have gone red and named the unrunnable tool; got exit ${with_.code}`)
  console.log(with_.out.split('\n').slice(0, 10).map((l) => '      | ' + l).join('\n'))
} else {
  const first = with_.out.split('\n').find((l) => l.includes('is listed but answers'))
  console.log('ok    --exec went RED and named it:' + first.replace(/^\s*✗\s*/, ' '))
}

if (bad) { console.log('\nthe --exec pass does not discriminate as claimed.'); process.exit(1) }
console.log('\n--exec discriminates: listing a tool is not the same measurement as running it.')
