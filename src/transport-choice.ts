/**
 * SHAT-3520 — which transport to start, kept in its OWN module with no heavy imports.
 *
 * 🔴 IT LIVES APART FROM THE HTTP TRANSPORT BECAUSE EVERY STDIO START PAYS FOR WHAT THIS FILE
 * IMPORTS. When the choice sat beside the endpoint, `index.ts` pulled the SDK's streamable-HTTP
 * transport, `node:http` and `node:crypto` into every launch — including the launches that never
 * speak HTTP, which is every Claude Desktop and Cursor session in existence.
 *
 * Measured, not assumed: cold `node dist/index.js` in sandbox mode went 0.16-0.25s to 0.24-0.43s.
 * It surfaced as the roster gate going red — that harness gives a spawned server 1200ms to print
 * its banner, and six servers per file under parallel workers had been sitting comfortably inside
 * that budget until the margin was spent.
 */

export type TransportChoice = 'stdio' | 'http'

export class UnknownTransportError extends Error {
  constructor(public readonly given: string) {
    super(
      `SHATALE_MCP_TRANSPORT=${JSON.stringify(given)} is not a transport this server speaks. ` +
        `Use "stdio" (the default) or "http".`,
    )
    this.name = 'UnknownTransportError'
  }
}

/**
 * Which transport to start, from an EXPLICIT declaration.
 *
 * ⚠️ IT DOES NOT ASK WHAT KIND OF ENVIRONMENT THIS IS, and acceptance ① says so in as many words.
 * "No TTY on stdin, so this must be a server" and "PORT is set, so this must be hosted" are both
 * guesses that are right until a CI runner, a container or a supervisor makes them wrong — and when
 * they are wrong the server comes up speaking a protocol nobody on the other end is speaking, which
 * looks like a hang rather than a misconfiguration.
 *
 * ⚠️ AN UNSET VARIABLE MEANS STDIO, AND THAT IS A DECLARED DEFAULT RATHER THAN A GUESS: it is the
 * transport every existing installation already uses, so the absence of a choice keeps them working
 * unchanged. A value we do not recognise is REFUSED rather than folded into that default — falling
 * back would start stdio for somebody who asked for "HTTP", "Http " or "htpp" and leave them
 * debugging a network they can reach.
 */
export function resolveTransport(raw: string | undefined): TransportChoice {
  if (raw === undefined || raw.trim() === '') return 'stdio'
  const given = raw.trim()
  if (given === 'stdio') return 'stdio'
  if (given === 'http') return 'http'
  throw new UnknownTransportError(given)
}

