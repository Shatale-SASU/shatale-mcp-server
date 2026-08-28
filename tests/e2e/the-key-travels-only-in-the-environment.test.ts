/**
 * SHAT-2712. A STANDING REQUIREMENT, NOT A DEFECT: the API key reaches this server only through the
 * environment, and it must stay that way.
 *
 * Today's behaviour is correct and measured — `dist/` contains no `process.argv` at all, and the key
 * is read once, from `process.env.SHATALE_API_KEY`. The reason to pin it is that the change which
 * would break it is a helpful one: someone adds `--api-key` for debugging, or a launcher builds a
 * command string, and nothing anywhere goes red.
 *
 * ⚠️ WHAT IT COSTS, IN ONE COMPARISON MEASURED ON A LIVE PROCESS:
 *
 *     -r--r--r--  /proc/<pid>/cmdline    readable by EVERY user on the box
 *     -r--------  /proc/<pid>/environ    owner and root only
 *
 * An argument is not a private channel. It is in `ps` for anyone on the machine, in shell history,
 * in process listings a crash reporter attaches, and — with `shell: true` — in a string the shell
 * itself parses. A key that travels there has been disclosed before it is ever used.
 *
 * ⚠️ AND BOTH CHECKS BELOW CARRY A POSITIVE CONTROL, because both are absence claims. "No argv in
 * the build" is satisfied by a scan that read nothing, and "the argument was ignored" is satisfied
 * by a server that ignores everything, including the environment.
 */
import { describe, test, expect } from 'vitest'
import { spawn } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { requireBuiltServer } from '../harness/mcpClient.js'

const DIST = resolve(import.meta.dirname, '../../dist')
const ENTRY = join(DIST, 'index.js')
requireBuiltServer(ENTRY)

function builtFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      out.push(...builtFiles(p))
    } else if (name.endsWith('.js')) {
      out.push(p)
    }
  }
  return out
}

/** Starts the built server and returns its startup banner (written to stderr). */
function startAndReadBanner(args: string[], env: Record<string, string | undefined>): Promise<string> {
  return new Promise((done) => {
    const child = spawn('node', [ENTRY, ...args], {
      env: { ...process.env, SHATALE_API_KEY: undefined, SHATALE_MODE: undefined, ...env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (b) => {
      stderr += String(b)
      if (stderr.includes('server started') || stderr.includes('Fatal')) {
        child.kill()
      }
    })
    child.on('close', () => done(stderr))
    setTimeout(() => {
      child.kill()
      done(stderr)
    }, 10_000)
  })
}

// A key-shaped string that is not a real key. It must never be read, so it must never work — and it
// must never be echoed back either.
const ARGV_KEY = 'sk_sandbox_argv_must_not_be_read_0000'

describe('the API key travels only in the environment (SHAT-2712)', () => {
  test('the shipped build never reads process.argv', () => {
    const files = builtFiles(DIST)
    expect(files.length).toBeGreaterThan(0)

    // POSITIVE CONTROL FIRST. Zero occurrences of `process.argv` is exactly what a scan that read
    // the wrong directory reports, so the scan must first find something it is certain to contain.
    const readsTheEnvKey = files.filter((f) => readFileSync(f, 'utf8').includes('process.env.SHATALE_API_KEY'))
    expect(
      readsTheEnvKey.length,
      'the scan found no file reading process.env.SHATALE_API_KEY — it is not reading the build, ' +
        'so its zero below would mean nothing',
    ).toBeGreaterThan(0)

    const readsArgv = files.filter((f) => readFileSync(f, 'utf8').includes('process.argv'))
    expect(
      readsArgv.map((f) => f.replace(DIST, 'dist')),
      'the build reads process.argv. Whatever it takes from there, an argument is world-readable in ' +
        '/proc/<pid>/cmdline and in `ps`; the key must arrive through the environment only',
    ).toEqual([])
  })

  test('a key offered as a command-line argument is not used, and not echoed', async () => {
    const banner = await startAndReadBanner([`--api-key=${ARGV_KEY}`, '--api-key', ARGV_KEY], {})

    expect(
      banner,
      `the server started in a keyed mode with the key supplied ONLY as an argument. Banner: ${banner}`,
    ).toContain('guest mode')
    expect(banner).not.toContain('demo(sandbox)')

    // A secret handed to us wrongly must not be repeated back into logs, where it outlives the
    // process that refused it.
    expect(banner, 'the argument value was echoed to stderr').not.toContain(ARGV_KEY)
  })

  // THE CONTROL FOR THE TEST ABOVE. "Guest mode" also happens when the server ignores everything,
  // including a correct environment — which would make the previous assertion pass while the server
  // was simply broken.
  test('control: the same key in the environment DOES key the server', async () => {
    const banner = await startAndReadBanner([], { SHATALE_API_KEY: ARGV_KEY })

    expect(
      banner,
      'a sandbox key in the environment did not produce sandbox mode, so the previous test proves ' +
        'nothing: it cannot tell "the argument was ignored" from "everything is ignored"',
    ).toContain('demo(sandbox)')
    expect(banner).not.toContain('guest mode')
  })
})
