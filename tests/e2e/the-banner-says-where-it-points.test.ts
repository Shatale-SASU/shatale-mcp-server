/**
 * SHAT-2711. The startup banner could not answer the one question an operator asks of it: where is
 * this thing pointed?
 *
 * SHATALE_API_URL is optional and defaults to the real API, so a launcher that forgot it did not
 * fail — it pointed at money and said nothing. Measured before the fix: the banner was BYTE-IDENTICAL
 * for a run against api.shatale.com and a run against a dead http://127.0.0.1:9.
 *
 *     Shatale MCP server started (demo(sandbox) mode, 19 tools)      ← production
 *     Shatale MCP server started (demo(sandbox) mode, 19 tools)      ← a hole
 *
 * ⚠️ AND EMPTY IS NOT UNSET. `??` falls back on undefined only, so an empty string reached
 * `new URL('')`, which throws AT MODULE SCOPE — before any handler exists. The parent got a raw Node
 * stack from a child dying during the MCP handshake, which arrives as a TIMEOUT rather than as a
 * message. A config writing `SHATALE_API_URL: process.env.X ?? ""` produces exactly that, and one
 * did (SHAT-2703).
 *
 * The three cases the acceptance names — unset, empty, explicit — are each driven here against the
 * BUILT server, because all three are startup behaviour and none of them is visible from a unit
 * reading of the module.
 */
import { describe, test, expect } from 'vitest'
import { spawn } from 'child_process'
import { resolve } from 'path'
import { requireBuiltServer } from '../harness/mcpClient.js'

const ENTRY = resolve(import.meta.dirname, '../../dist/index.js')
requireBuiltServer(ENTRY)

function start(env: Record<string, string | undefined>): Promise<{ stderr: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn('node', [ENTRY], {
      env: {
        ...process.env,
        SHATALE_API_KEY: 'sk_sandbox_banner_probe_0000',
        SHATALE_API_URL: undefined,
        SHATALE_MODE: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (b) => {
      stderr += String(b)
      if (stderr.includes('server started')) child.kill()
    })
    child.on('close', (code) => done({ stderr, code }))
    setTimeout(() => {
      child.kill()
      done({ stderr, code: null })
    }, 12_000)
  })
}

describe('the startup banner says where the server points (SHAT-2711)', () => {
  test('unset names the default, and marks it as the one nobody chose', async () => {
    const { stderr } = await start({})
    expect(stderr).toContain('api=https://api.shatale.com')
    expect(
      stderr,
      'an unset variable is how a process ends up talking to production without anyone deciding ' +
        'that it should; the banner has to say that this was the default, not a choice',
    ).toContain('(default)')
  })

  test('an explicit URL is named, and is not marked as a default', async () => {
    const { stderr } = await start({ SHATALE_API_URL: 'http://127.0.0.1:9' })
    expect(stderr).toContain('api=http://127.0.0.1:9')
    expect(stderr).not.toContain('(default)')
  })

  // ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Each test above passes on a banner
  // that names a host and never changes it. The property is that two DIFFERENT destinations produce
  // two DIFFERENT lines — that is what "the log tells you where it points" means.
  test('two different destinations produce two different banners', async () => {
    const prod = (await start({})).stderr
    const local = (await start({ SHATALE_API_URL: 'http://127.0.0.1:9' })).stderr

    const line = (s: string) => (s.split('\n').find((l) => l.includes('server started')) ?? '').trim()
    expect(line(prod)).not.toBe('')
    expect(line(local)).not.toBe('')
    expect(
      line(local),
      'the two runs printed the same line, so the startup log cannot tell production from a dead ' +
        'endpoint — the defect this test exists for',
    ).not.toBe(line(prod))
  })

  test('an empty value is refused by the server, in its own words', async () => {
    const { stderr, code } = await start({ SHATALE_API_URL: '' })

    expect(code, 'an empty API URL must stop the process').not.toBe(0)
    expect(stderr).toContain('SHATALE_API_URL')
    expect(stderr.toLowerCase()).toContain('empty')

    // The control that distinguishes a refusal from the crash it replaced: no raw Node internals.
    expect(
      stderr,
      'the process still died inside node:internal — that is the module-scope throw this refusal ' +
        'was written to replace, and the parent reads it as a handshake timeout, not as an error',
    ).not.toContain('node:internal')
    expect(stderr).not.toContain('ERR_INVALID_URL')
  })
})
