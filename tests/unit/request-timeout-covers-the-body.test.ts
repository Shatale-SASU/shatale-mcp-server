import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ShataleClient } from "../../src/client.js";

/**
 * /!\ THE 30s TIMEOUT COVERED THE HEADERS AND NOT THE BODY, AND A MISSING `await` WAS THE WHOLE BUG.
 *
 * The client read:
 *
 *     const timeout = setTimeout(() => controller.abort(), 30_000)
 *     try {
 *       const res = await fetch(url, { signal: controller.signal })
 *       ...
 *       return res.json()          // <- no await
 *     } finally {
 *       clearTimeout(timeout)      // <- runs when the try RETURNS, not when the promise settles
 *     }
 *
 * `finally` fires as soon as the try block returns a promise. So the timer was cleared the instant
 * fetch resolved its HEADERS, cancelling the abort before one byte of body had been read. An
 * upstream that answered 200 and then stalled mid-body was never aborted by anything at all.
 *
 * /!\ AND THE FAILURE IS THE WORST SHAPE A STDIO SERVER HAS. This process serves one agent over one
 * pipe. A request that never settles is not a slow tool call — it is an agent that never answers
 * again, with nothing logged, no error, and no timeout to explain it. The stall does not even have
 * to be malicious: a proxy that flushes headers and dies is enough.
 *
 * /!\ WHY IT SURVIVED SO LONG, WHICH IS THE PART WORTH KEEPING. SECURITY.md has claimed "each API
 * call is bounded by a 30s timeout" from the beginning, and the code contained a 30s timeout, so
 * every reading of either one agreed. Nothing tested it, because testing it meant waiting 30
 * seconds. A bound nobody can afford to test is a bound nobody has tested.
 *
 * That is why `timeoutMs` is now a constructor parameter: not for flexibility, but so the assertion
 * below costs 150ms instead of half a minute. The production default is unchanged.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    // closeAllConnections() BEFORE close(): these fixtures deliberately leave a socket open with an
    // unfinished body, and `close()` alone waits for it — for ever. Measured while proving the
    // mutant: without this the teardown hook itself timed out at 15s on top of the failing test, so
    // a genuine regression would cost 45 seconds and read as an infrastructure problem rather than
    // as the assertion that fired. The state a future failure leaves you in is worth designing.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** An upstream that sends 200 and a partial body, then never finishes. */
async function stallingUpstream(mode: "before-headers" | "mid-body"): Promise<string> {
  server = createServer((_req, res) => {
    if (mode === "before-headers") return; // never respond at all
    res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
    res.write('{"partial":');
    // and then nothing, for ever
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("the request timeout bounds the whole exchange", () => {
  // /!\ THE CONTROL, AND IT IS NOT DECORATIVE. This case ALREADY PASSED before the fix — the abort
  // did cover the header phase. Without it, the test below could be satisfied by a client that
  // simply fails everything, and "it timed out" would prove nothing about what changed.
  it("aborts an upstream that never sends headers (this always worked)", async () => {
    const url = await stallingUpstream("before-headers");
    const client = new ShataleClient(url, "sk_sandbox_test", 150);

    const started = Date.now();
    await expect(client.request("GET", "/v1/anything")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    // 5s cap, not vitest's 30s default: the assertion above allows 3s, so anything slower is
    // already a failure. Without it a regression here costs 30 seconds of CI to say so.
  }, 5000);

  // /!\ THE POINT. Before `return await`, this hung for ever — measured at 45 seconds with no
  // result, against the real 30s default.
  it("aborts an upstream that sends headers and then stalls mid-body", async () => {
    const url = await stallingUpstream("mid-body");
    const client = new ShataleClient(url, "sk_sandbox_test", 150);

    const started = Date.now();
    await expect(
      client.request("GET", "/v1/anything"),
      "the call did not reject. The upstream answered 200 and then stopped mid-body, so the only " +
        "thing that can end this exchange is the abort — and the abort is cancelled by `finally` " +
        "the moment the try block RETURNS a promise rather than awaiting it. `return res.json()` " +
        "returns; `return await res.json()` keeps the frame alive until the body is parsed. In a " +
        "stdio server this is not a slow tool call, it is an agent that never answers again.",
    ).rejects.toThrow();
    expect(
      Date.now() - started,
      "the call rejected, but long after the timeout — something other than the abort ended it, so " +
        "this test is not measuring the bound it claims to measure",
    ).toBeLessThan(3000);
  }, 5000);
});
