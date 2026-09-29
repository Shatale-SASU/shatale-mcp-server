import { describe, it, expect, vi, afterEach } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { installStdioErrorHandling } from '../../src/stdio-hardening.js'
import * as logValue from '../../src/log-value.js'
import { cardCredentials } from '../fixtures/api-response-shapes'

// SHAT-4307 (1). A line this server writes to stderr is read by the OPERATOR, and it is read line by
// line — a host's log viewer, `grep`, a collector that ships one record per line. Three of those lines
// carried a value somebody else chose, interpolated as is:
//
//   reveal_card      — the DEPRECATED line carried `purchase_id` from the CALLER (the model);
//                      requireId only trims, so a newline inside the id survived.
//   stdio-hardening  — the protocol-error line carried the parser's message, and V8's JSON.parse
//                      message QUOTES the offending frame: a \r or U+2028 sent by the client lands in
//                      the log raw (measured: node -e 'JSON.parse("x\r\u2028…")').
//   list_mcc_codes   — the fallback line carried the flattened exception chain, whose text is written
//                      by fetch, by the API's refusal and by whatever a future cause holds.
//
// A newline in such a value does not only break the line: the text after it reads as a NEW line the
// server did not write — "served unscoped" can be followed by a forged "reveal_card ok, person
// scope checked". So every value from outside goes through one encoder (src/log-value.ts): the value
// is JSON-encoded, and the separators JSON leaves raw are escaped as well.
//
// ⚠️ JSON.stringify ALONE IS NOT ENOUGH, AND THAT IS WHY THE FIXTURE CARRIES MORE THAN \n AND \r.
// It leaves U+2028/U+2029 (line and paragraph separators — a line break for JavaScript tooling and
// many viewers), U+0085 (NEL), DEL and the C1 controls, and the bidi overrides raw. Measured before
// writing this: JSON.stringify("a\u2028b\u2029c\u0085d\u007fe\u202ef") keeps all six.

// Every character here is one that must NOT reach the log raw. Placed INSIDE the id, not at its
// ends: requireId trims, and a trimmed-away character would make the test pass for the wrong reason.
const HOSTILE = [
  '\n', // line feed
  '\r', // carriage return — overwrites the line on a terminal
  '\u0000', // NUL
  '\u0007', // BEL
  '\u001b', // ESC — the start of every terminal escape sequence
  '\u007f', // DEL
  '\u0085', // NEL — a line break for Unicode-aware readers
  '\u2028', // LINE SEPARATOR
  '\u2029', // PARAGRAPH SEPARATOR
  '\u202e', // RIGHT-TO-LEFT OVERRIDE — reorders what the reader sees
] as const

const FORGED = 'shatale-mcp-server: reveal_card ok, person scope checked'
const HOSTILE_ID = `pur_4307${HOSTILE.join('x')}\n${FORGED}`

// A line is safe when its only line break is the one the server put at the end, and nothing between
// carries a control or a separator. The class is the union of what HOSTILE names, stated once.
const RAW_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/

function assertOneSafeLine(line: string, what: string) {
  const body = line.endsWith('\n') ? line.slice(0, -1) : line
  const bad = [...body].filter((c) => RAW_UNSAFE.test(c)).map((c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  expect(bad, `${what}: raw control/separator characters reached the log line`).toEqual([])
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the encoder: what reaches the log is the value, and only one line of it', () => {
  it('is named where every writer can reuse it', () => {
    expect(typeof logValue.forLog, 'src/log-value.ts must export forLog').toBe('function')
  })

  for (const c of HOSTILE) {
    const name = `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    it(`${name} is escaped, and the value decodes back exactly`, () => {
      const v = `a${c}b`
      const out = logValue.forLog(v)
      assertOneSafeLine(out, name)
      // Not stripped: the operator must be able to see WHAT was sent. JSON.parse reads the escapes
      // this encoder adds, so the round trip is exact.
      expect(JSON.parse(out)).toBe(v)
    })
  }

  it('control: an ordinary id is printed readably, merely quoted', () => {
    expect(logValue.forLog('pur_01H8')).toBe('"pur_01H8"')
  })
})

describe('reveal_card: the DEPRECATED line carries the caller\'s id as a value, not as text', () => {
  function captureStderr(): string[] {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    return written
  }

  it('a purchase_id with newlines, controls and separators produces ONE line, and no forged one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(cardCredentials()), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    const written = captureStderr()
    await createRevealTools(new ShataleClient('https://api.example.test', 'sk_sandbox_abc')).handlers.reveal_card({
      purchase_id: HOSTILE_ID,
    })
    const deprecated = written.filter((w) => w.includes('DEPRECATED'))
    // Positive control: the line under test was written at all. Without it every assertion below
    // is about an empty list.
    expect(deprecated, 'the DEPRECATED line was not written — nothing below measures anything').toHaveLength(1)
    const line = deprecated[0]
    assertOneSafeLine(line, 'DEPRECATED line')
    expect(line.split('\n').filter((l) => l.startsWith('shatale-mcp-server: reveal_card ok')), 'a forged line').toEqual([])
    // And the operator still reads the id: its encoded form stands in the line, and decodes back.
    expect(line).toContain(logValue.forLog(HOSTILE_ID))
  })
})

describe('stdio-hardening: the protocol-error line carries the parser\'s message as a value', () => {
  it('a frame with \\r and U+2028 — quoted back by V8 in its SyntaxError — stays one line', () => {
    // The real parser, not a hand-written message: what reaches the handler is what V8 writes.
    let parseError: Error | undefined
    try {
      JSON.parse(`x\r\u2028\u001b[2K${FORGED}`)
    } catch (e) {
      parseError = e as Error
    }
    // Positive control: V8 does quote the frame, raw. If this ever stops holding, the case below is
    // measuring nothing and must be re-planted.
    expect(parseError?.message, 'V8 no longer quotes the frame in its message').toMatch(/[\r\u2028]/)

    const err: string[] = []
    const server = { onerror: undefined as undefined | ((e: Error) => void), close: () => Promise.resolve() }
    const handler = installStdioErrorHandling(server, {
      stdout: { write: () => true },
      stderr: { write: (c: string) => (err.push(c), true) },
    })
    handler(parseError as Error)
    expect(err, 'nothing was logged').toHaveLength(1)
    expect(err[0]).toContain('protocol error')
    assertOneSafeLine(err[0], 'protocol-error line')
  })
})

describe('list_mcc_codes: the fallback line carries the exception chain as a value', () => {
  it('an exception whose message holds a newline and U+2029 stays one line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`upstream said\n${FORGED}\u2029and more\r`)
      }),
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { createCommonTools } = await import('../../src/tools/common.js')
    const client = new ShataleClient('https://api.example.test', 'sk_sandbox_abc', 2_000)
    await createCommonTools(client, {
      isGuest: false,
      isSandbox: true,
      moneyEnabled: false,
      getToolNames: () => ['list_mcc_codes'],
    }).handlers.list_mcc_codes({ query: 'gambling' })
    const lines = spy.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => /mcc/i.test(l))
    expect(lines, 'the fallback line was not written — nothing below measures anything').toHaveLength(1)
    assertOneSafeLine(lines[0], 'list_mcc_codes line')
    // The reason is still there for the operator, encoded.
    expect(lines[0]).toContain('upstream said\\n')
  })
})
