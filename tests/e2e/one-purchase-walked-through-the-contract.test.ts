/**
 * SHAT-3023, the acceptance clause the slice is not done without: the path walked FROM BEGINNING TO
 * END THROUGH THE PUBLIC CONTRACT — "not through unit tests and not through a private call. The
 * project has twice paid for the opposite: a feature tested everywhere except the front door."
 *
 * 🔴 WHAT WAS MISSING WAS THE JOIN, NOT THE TOOLS. Every tool in this chain already had a keyed test
 * of its own: request_purchase alone, sandbox_approve_purchase against a non-existent id,
 * get_purchase_status against a non-existent id. Four tests, four different subjects, and not one of
 * them asked whether the id that comes OUT of the first reaches the LAST. A suite of independent
 * single-tool tests is green on a chain that does not connect — which is the shape SHAT-3023 was
 * filed about one level down (the reveal path existed and had no caller).
 *
 * So what is asserted here is the id travelling: the same purchase id in the approval's PATH, in the
 * status read, and in the reveal. The tool results matter less than the outbound requests, and the
 * mock upstream records those exactly.
 *
 * ⚠️ AND THE REVEAL IS ASSERTED AFTER THE REDACTION LAYER, which is the part no unit test of the tool
 * can reach. Every response passes `redactPurchaseCard` once inside ShataleClient.request, and it
 * decides by PROVENANCE — the path — not by the shape of the body. So a sentinel that arrives intact
 * proves the client method used the allowlisted path; the same sentinel arriving scrubbed is exactly
 * what a broken path looks like. #69 pinned that at the URL; this pins it at the response, at the end
 * of a chain.
 */
import { readFileSync } from 'node:fs'
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { McpTestClient } from '../harness/mcpClient'
import { MockUpstream } from '../harness/mockUpstream'

const TEST_KEY = process.env.SHATALE_TEST_KEY

// ⚠️ SHAT-3340 — THE OPT-IN IS NOW SET WHERE THE RUN IS WATCHED, AND DELIBERATELY NOT WHERE IT IS NOT.
//
// What the blocker was BELIEVED to be, and why that belief is retracted: "across two ci-sandbox
// dispatches the Actions key saw ZERO agents while a working key saw TWO on the same host — one
// secret name, two sandbox accounts". The secret was replaced on that reading (its timestamp moved
// 2026-05-11 → 2026-09-14).
//
// 🔴 BOTH DISPATCHES RAN THROUGH A READER THAT COULD NOT SEE AN AGENT UNDER ANY KEY: it parsed
// `{ agents: [...] }` and GET /v1/agents returns a BARE ARRAY (fixed below, with the three places
// that measure the shape). So the zero was a fact about the reader; the "two" came from a curl.
// ⇒ Whether the account owns an agent is UNKNOWN until the fixed reader runs. It is not claimed
// here either way, and the deferral was not lifted on that claim — it was lifted because the
// deferred WORK (the opt-in, and a run that proves execution by a number) is done.
//
// ▌ci-sandbox.yml sets SHATALE_E2E_LIVE_CHAIN=1. nightly.yml does NOT, and that is a decision
// rather than an omission: the replacement key is a PERSON'S sandbox account, so an unattended
// nightly would create purchases in an account somebody works in by hand. Enabling it there is the
// owner's call — asked, not assumed — and until it is answered nightly.yml carries the true reason
// instead of the old one.
//
// 🔴 AND A LIFTED OPT-IN IS NOT A LIFTED SKIP, WHICH IS WHY THE CHECK BELOW IS NOT THE COLOUR OF
// THE RUN. A skipped vitest suite makes the run PASS, and the default reporter prints neither
// skipped suite names nor logs from passing tests (both measured). So the acceptance is a COUNT,
// read from the run's own JSON report by scripts/live-chain-executed.mjs: how many cases of this
// suite executed. It answers 1 for "skipped", 2 for "could not measure", and 0 only with a number.
const LIVE_CHAIN_OPT_IN = process.env.SHATALE_E2E_LIVE_CHAIN === '1'

/**
 * ⚠️ NOT "skipped" — the word vitest prints is the one this repository has been bitten by twice.
 * This sentence is what a reader of the summary gets instead, so it has to carry: that the block is
 * OFF rather than passing, what turns it on, and the ticket that will make the skip stop being
 * permanent. Asserted by a test that always runs, below.
 */
const LIVE_CHAIN_DISABLED =
  'DISABLED, NOT PASSED — this block did not run. Set SHATALE_E2E_LIVE_CHAIN=1 with a ' +
  'SHATALE_TEST_KEY whose account owns an agent. Both ci-sandbox.yml and nightly.yml set it ' +
  '(SHAT-3340: the secret holds the ci-nightly publisher\'s sandbox key — an account that belongs ' +
  'to the pipeline, which is what made the unattended nightly the owner\'s to allow; agents on a ' +
  'sandbox key are created by POST /v1/sandbox/agents, measured 17.09.2026, while a LIVE key still ' +
  'cannot). Seeing this sentence in either run means the ' +
  'opt-in was removed, not that the chain is still blocked.'

const describeIfKey = TEST_KEY && LIVE_CHAIN_OPT_IN ? describe : describe.skip

// A test that always runs, because everything above is prose the moment nothing reads it — and prose
// is exactly what a deleted opt-in leaves behind looking correct. It does not assert the block is
// disabled (ci-sandbox.yml now enables it, and asserting otherwise would go red on the very change
// that fixed the ticket); it asserts that the sentence a reader is given still names the way out.
describe('the live chain says it is disabled rather than passed', () => {
  test('the reason names what enables it and the ticket that ends the deferral', () => {
    // ⚠️ WHETHER THE SENTENCE ABOVE REACHES ANYONE DEPENDS ON THE RUNNER, AND THE TWO DISAGREE —
    // measured 2026-09-14. A skipped suite's NAME is printed by `--reporter=verbose`, which
    // nightly.yml passes, and NOT by the plain `npm test` in ci-sandbox.yml or in a local run. A
    // `console.log` from a passing test is swallowed by both (written, measured, removed). So the
    // sentence alone is a notice whose visibility is an accident of the caller; the workflows print
    // it as a `::notice::` of their own, and the test below is what stops the texts drifting.
    expect(LIVE_CHAIN_DISABLED).toMatch(/SHATALE_E2E_LIVE_CHAIN/)
    expect(LIVE_CHAIN_DISABLED).toMatch(/SHAT-3340/)
    // ⚠️ THE PIN ON `shatale-api` IS GONE BECAUSE THE FACT IS GONE, and that is the point rather
    // than a loosening: the deferral registration in shatale-api is REMOVED in the same change that
    // lifts this opt-in — the deferred work is done, and a registry entry describing an undone thing
    // reddens by design. A test pinning a sentence to a repository that no longer holds anything
    // about this would be prose outliving its subject, asserted.
    //
    // What replaces it is the pin that now carries the decision: the sentence must name WHICH
    // workflow turns the chain on and which deliberately does not, because "it is off" without
    // "off where" is what sent the last reader looking in the wrong file.
    expect(LIVE_CHAIN_DISABLED, 'the sentence must say where the opt-in IS set').toMatch(
      /ci-sandbox\.yml/,
    )
    expect(LIVE_CHAIN_DISABLED, 'and where it is deliberately not set').toMatch(/nightly\.yml/)
    expect(LIVE_CHAIN_DISABLED, 'a skip that reads as a pass is the whole failure').toMatch(
      /DISABLED, NOT PASSED/,
    )
  })

  // 🔴 THE NOTICE HAS TO BE WHERE THE RUN IS READ. Both workflows that execute the live suite print
  // it themselves, and this is what stops one of the three texts from being edited alone.
  // ⚠️ TWO PLAIN CALLS RATHER THAN `test.each`, AND THE REASON IS AN INSTRUMENT IN THIS REPOSITORY.
  // tests/tool-coverage.md carries a per-file test COUNT, and the guard that checks it counts
  // `test(`/`it(` at line starts — `test.each` is invisible to it. So an each-table of two would
  // have made the document under-report by one while the guard called it correct: a number that no
  // longer means what its column header says.
  const workflowNotice = (wf: string): string =>
    readFileSync(new URL(`../../.github/workflows/${wf}`, import.meta.url), 'utf8')

  test('nightly.yml prints the notice itself', () => {
    const body = workflowNotice('nightly.yml')
    expect(body, 'the workflow does not say the live chain is off').toMatch(/DISABLED, NOT PASSED/)
    expect(body).toMatch(/SHAT-3340/)
    expect(body).toMatch(/SHATALE_E2E_LIVE_CHAIN/)
  })

  // ⚠️ ci-sandbox.yml NOW ENABLES THE CHAIN, AND THE NOTICE STAYS THERE AS A FALLBACK. Its step is
  // conditional on the env variable, so it prints only if somebody removes the opt-in — which is
  // exactly the day a green run would otherwise mean nothing. Asserting the text is still present
  // is asserting that removing the flag cannot pass silently.
  //
  // 🔴 AND THE COLOUR IS NOT THE ACCEPTANCE. The same file must run the chain and then MEASURE that
  // it ran: a skipped suite makes the run green, so the count comes from the JSON report through
  // scripts/live-chain-executed.mjs. A workflow that enables the opt-in and does not check the
  // number is back to believing a colour.
  test('ci-sandbox.yml prints the notice itself', () => {
    const body = workflowNotice('ci-sandbox.yml')
    expect(body, 'the fallback notice is gone — removing the opt-in would then read as a pass').toMatch(
      /DISABLED, NOT PASSED/,
    )
    expect(body).toMatch(/SHAT-3340/)
    expect(body).toMatch(/SHATALE_E2E_LIVE_CHAIN/)
    expect(body, 'the opt-in is not actually set in the workflow that is supposed to set it').toMatch(
      /SHATALE_E2E_LIVE_CHAIN:\s*['"]?1/,
    )
    expect(body, 'the run is green whether or not the chain ran unless the count is read').toMatch(
      /live-chain-executed\.mjs/,
    )
  })
})

const text = (result: any): string => {
  expect(result.content?.[0]?.type).toBe('text')
  return result.content[0].text as string
}

describe('SHAT-3023: one purchase, walked through the contract (mock upstream)', () => {
  let mock: MockUpstream
  let client: McpTestClient

  beforeAll(async () => {
    mock = await MockUpstream.start()
    client = new McpTestClient(
      { SHATALE_API_KEY: 'sk_sandbox_mock', SHATALE_API_URL: mock.url },
      'purchase-chain',
    )
    await client.initialize()
  })

  afterAll(async () => {
    client.close()
    await mock.close()
  })

  test('the id from request_purchase reaches approve, status and reveal', async () => {
    // ⚠️ THE FIRST LINK, ADDED AFTER THE LIVE RUN REFUSED THE CHAIN WITHOUT IT. request_purchase
    // needs a publisher_user_id that HAS AN ACTIVE DELEGATION, and sandbox_create_user is the only
    // thing in the contract that makes one — its own description says so: "This is the first step".
    // The mock answers 200 to anything, so the mock chain could never have told me: only the live
    // dispatch could, and it did, with HTTP 400 on step one.

    const provisioned = await client.callTool('sandbox_create_user', {
      user_id: 'usr_chain_1',
      agent_id: 'agt_chain_1',
    })
    expect(provisioned.isError).toBeFalsy()

    const created = await client.callTool('request_purchase', {
      publisher_user_id: 'usr_chain_1',
      agent_id: 'agt_chain_1',
      merchant: 'amazon.com',
      amount: 49.99,
      currency: 'EUR',
      description: 'SHAT-3023 chain',
    })
    expect(created.isError).toBeFalsy()

    // The id is taken FROM THE TOOL'S ANSWER, not written here. A test that hard-codes the id it
    // expects proves the mock, not the chain: the next step would be given the right id by the test
    // even if the tool had answered with a different one.
    const purchaseId = JSON.parse(text(created)).purchase_id as string
    expect(purchaseId, 'request_purchase answered without a purchase_id').toBeTruthy()

    const approved = await client.callTool('sandbox_approve_purchase', { purchase_id: purchaseId })
    expect(approved.isError).toBeFalsy()

    const status = await client.callTool('get_purchase_status', { purchase_id: purchaseId })
    expect(status.isError).toBeFalsy()

    const revealed = await client.callTool('reveal_card', { purchase_id: purchaseId })
    expect(revealed.isError, `reveal_card refused: ${text(revealed)}`).toBeFalsy()

    // ── the joins, which are the subject ──────────────────────────────────────────────────────────
    const provision = mock.lastRequest('POST', '/v1/sandbox/users')
    expect(provision, 'no sandbox user was provisioned — the chain skipped its own first link')
      .toBeDefined()

    const approve = mock.lastRequest('POST', '/v1/sandbox/purchases/')
    expect(approve, 'no approval request reached the upstream').toBeDefined()
    expect(approve!.path, 'the approval was sent for a different purchase than the one created')
      .toBe(`/v1/sandbox/purchases/${purchaseId}/approve`)

    const read = mock.lastRequest('GET', `/v1/purchases/${purchaseId}`)
    expect(read, 'no status read reached the upstream for that purchase').toBeDefined()

    const reveal = mock.lastRequest('GET', `/v1/purchases/${purchaseId}/card-credentials`)
    expect(reveal, 'the reveal did not ask the allowlisted card-credentials path for that purchase')
      .toBeDefined()

    // ── and the card survived the redaction layer, because the path is allowlisted ────────────────
    const card = JSON.parse(text(revealed))
    expect(card.card_number, 'the card field came back scrubbed — the client method is off the allowlisted path')
      .toBe('MOCK-CARD-NUMBER-NOT-A-PAN')
    expect(card.cvv).toBe('MOCK-CVV')
  })

  // ⚠️ THE CONTROL FOR THE ASSERTION ABOVE, AND WITHOUT IT "the sentinel arrived" PROVES NOTHING
  // ABOUT THE ALLOWLIST: it would also hold if redaction did nothing at all, anywhere. So the same
  // sentinel is sent down a path that is NOT on the allowlist, through a tool that reads it, and it
  // must come back scrubbed.
  test('the same card shape is scrubbed when it arrives from a path that is not allowlisted', async () => {
    const checkout = await client.callTool('get_checkout_cardholder', { purchase_id: 'pur_mock_1' })
    expect(checkout.isError).toBeFalsy()
    // The checkout-identity route answers identity, never a card — so the assertion here is about
    // the LAYER, not about that route's payload: nothing card-shaped may pass from a path off the
    // allowlist. If this ever starts carrying card fields, the guard next door
    // (no-tool-result-carries-a-card.test.ts) is the one that fails, and it should.
    expect(text(checkout)).not.toContain('MOCK-CARD-NUMBER-NOT-A-PAN')
  })
})

// ── the same chain against the LIVE sandbox ──────────────────────────────────────────────────────
//
// 🔴 IT RAN, AND IT REFUSED THE CHAIN — which is the whole reason a dispatch was asked for. Run
// 34825051118 (ci-sandbox, 2026-09-14): 44 files passed, this one failed, and it failed on STEP ONE
// with `request_purchase` → HTTP 400. The mock could not have told me: it answers 200 to anything.
//
// THE CAUSE WAS A MISSING FIRST LINK, NOT A BROKEN TOOL. request_purchase needs a publisher_user_id
// that HAS AN ACTIVE DELEGATION, and `sandbox_create_user` is the only thing in the contract that
// makes one — its own description says "This is the first step … nothing else here creates one".
//
// ⚠️ AND ONE PRECONDITION DOES NOT COME FROM THIS CONTRACT, THOUGH THE REASON NARROWED ON 17.09.2026.
// The agent is obtained the way the publish gate obtains it — `GET /v1/agents` with the same key, a
// READ — and that step is a PREMISE, not part of the walk; the walk itself is the five tool calls.
// What changed is WHY: this comment used to say "no API key can create an agent". Measured — POST
// /v1/sandbox/agents answers 201 for a SANDBOX key (SandboxOnly, so a live key cannot), and that is
// how the ci-nightly account got its agent. No MCP TOOL creates one, which is the part that still
// holds and the part this walk depends on.
//
// ⚠️ A MISSING AGENT IS A LOUD FAILURE, NEVER A SKIP, and that is the neighbouring gate's rule for
// the same premise: "an unverified premise is how a test ends up asserting nothing". The remedy is
// named in the message — set `SHATALE_GATE_AGENT_ID` (the variable publish.yml already uses) or seed
// one agent in the console — so the red says what to do rather than only that something is wrong.
//
// ⚠️ AND A SKIP IS NOT A PASS. Without a key the whole block is `describe.skip`, and the summary
// prints skipped and passed on the same line. This repository has been bitten twice by
// green-by-skip in sandbox-tools.test.ts.
//
// ⚠️ THE LIVE REVEAL HAS TWO LEGITIMATE ENDINGS. Whether the sandbox issues a card for an approved
// purchase is not answerable from this tree: reveal_card returns the card when the purchase is
// payment_ready and holds one, and refuses with the NAMED code `card_credentials_unavailable` when
// it does not. Both are the door working; any other failure, or a refusal with no name, is not.
const API_BASE = process.env.SHATALE_API_URL ?? 'https://api.shatale.com'

/** The premise, read the way publish-gate.mjs reads it. Read-only: GET /v1/agents. */
async function resolveSandboxAgentId(): Promise<string> {
  const pinned = process.env.SHATALE_GATE_AGENT_ID
  const headers = { Authorization: `Bearer ${TEST_KEY}`, Accept: 'application/json' }
  if (pinned) {
    const probe = await fetch(`${API_BASE}/v1/agents/${encodeURIComponent(pinned)}`, { headers })
    if (!probe.ok) {
      throw new Error(
        `SHATALE_GATE_AGENT_ID=${pinned} does not resolve on ${API_BASE} (HTTP ${probe.status}). ` +
          'A chain pointed at a non-existent agent can only produce the 400 it cannot distinguish ' +
          'from a real refusal. ⚠️ And an id that exists on ANOTHER account resolves to 404 here ' +
          'exactly like an id that exists nowhere: the pin must name an agent of the account this ' +
          'key belongs to.',
      )
    }
    return pinned
  }
  const res = await fetch(`${API_BASE}/v1/agents`, { headers })
  if (!res.ok) {
    throw new Error(
      `GET /v1/agents answered HTTP ${res.status} on ${API_BASE}, so the chain has no agent to walk ` +
        'with. Set SHATALE_GATE_AGENT_ID (publish.yml already uses that variable), or create one: on ' +
        'a SANDBOX key POST /v1/sandbox/agents does it (measured 17.09.2026), on a live key it is by ' +
        'hand in the publisher console. Either way it cannot be fixed inside this test.',
    )
  }
  // 🔴 THIS PARSE WAS THE DEFECT, AND ITS MESSAGE ACCUSED THE ACCOUNT FOR IT. It read
  // `body.agents?.find(…)` — an object with an `agents` field — and GET /v1/agents returns a BARE
  // JSON ARRAY. Measured in three independent places rather than guessed:
  //
  //   · apps/api/api/v1/agents.go: ListAgents ends in `writeJSON(w, 200, agents)` where `agents` is
  //     a slice, and writeJSON's listsAreNeverNull only turns a nil slice into an empty one — it
  //     adds no envelope;
  //   · scripts/publish-gate.mjs, THE OTHER READER OF THE SAME ENDPOINT IN THIS REPOSITORY, parses
  //     `Array.isArray(res.json) ? res.json : []`;
  //   · the elements embed `Agent`, so `id` is a top-level field of each.
  //
  // So `body.agents` was ALWAYS undefined and the throw below said "THIS KEY HAS ZERO AGENTS" — a
  // claim about the PARSER, printed as a claim about somebody's sandbox account. The comment above
  // even said this reads "the way publish-gate.mjs reads it"; it did not.
  //
  // ⚠️ BOTH SHAPES ARE ACCEPTED NOW, AND THAT IS ONLY SAFE BECAUSE THE THIRD OUTCOME EXISTS. A
  // tolerant parse with two outcomes rebuilds the same defect: an unreadable answer would fall into
  // "zero agents" again. So an unrecognised shape is its own refusal, and it says it is about the
  // reader.
  const raw = (await res.json()) as unknown
  const list = Array.isArray(raw)
    ? (raw as Array<{ id?: string; status?: string }>)
    : Array.isArray((raw as { agents?: unknown })?.agents)
      ? (raw as { agents: Array<{ id?: string; status?: string }> }).agents
      : null
  if (list === null) {
    throw new Error(
      `GET /v1/agents on ${API_BASE} answered 200 with a shape this test cannot read: neither a ` +
        'JSON array nor { agents: [...] }. ⚠️ THIS IS A STATEMENT ABOUT THE READER, NOT ABOUT THE ' +
        'ACCOUNT — do not conclude the key has no agents from it. First 200 characters of the body: ' +
        JSON.stringify(raw).slice(0, 200),
    )
  }
  // Active first, like publish-gate.mjs, because a suspended agent fails later with a worse
  // message; any agent is still better than none.
  const usable =
    list.find((a) => typeof a.id === 'string' && a.id.length > 0 && a.status === 'active') ??
    list.find((a) => typeof a.id === 'string' && a.id.length > 0)
  const id = usable?.id
  if (!id) {
    // 🔴 THE MESSAGE NAMES THE DISCRIMINATOR, BECAUSE THE CHANNEL DOES NOT CARRY ONE.
    //
    // ⚠️ AND THE MEASUREMENT THAT USED TO STAND HERE IS RETRACTED, NOT EDITED FOR TONE. It read:
    // "across two ci-sandbox dispatches this key sees ZERO agents while a working key sees TWO on
    // the SAME host, so they are two different sandbox accounts under one name". Both dispatches
    // ran through the reader below, which parsed `{ agents: [...] }` against an endpoint that
    // returns a BARE ARRAY — so it could not see an agent under ANY key. The "two" came from a
    // curl, a different instrument. One number from a broken reader and one from a working one,
    // compared as if they shared a scale.
    //
    // ⇒ The conclusion it produced — a secret rotation — was acted on. What the zero actually
    // licensed was "this reader cannot answer", and nothing about the account. Re-measure with the
    // code below before repeating it.
    //
    // The first version of this message offered two remedies — set the variable, or seed an agent —
    // and was silent about the likeliest one. A guard's message is followed LITERALLY: pinning an
    // id from the wrong account would only change the text of the red, which is what fixing a
    // symptom looks like. "Which account does the secret belong to" is the question that separates
    // "wrong key" from "empty account", and nothing in the tool surface can answer it: none of the
    // 22 tools lists a publisher's agents (measured 2026-09-10 by role, not by name).
    throw new Error(
      `GET /v1/agents returned a list of ${list.length} on ${API_BASE} with no usable agent in ` +
        'it, so THIS KEY HAS ZERO AGENTS — and this time the list was actually READ, which the ' +
        'old wording could not claim. ' +
        'Check WHICH ACCOUNT the key belongs to, not which deployment it addresses. ' +
        '⚠️ AND DO NOT INHERIT THE OLD MEASUREMENT HERE: the claim that "the Actions key sees zero ' +
        'agents while a working key sees two on the same host, so they are two accounts" was made ' +
        'THROUGH THE BROKEN READER above, which could never see an agent at all. It is retracted ' +
        'until re-measured with this code. Remedies, in the order that actually applies: ' +
        '(1) create one on the account that owns THIS key — POST /v1/sandbox/agents on a sandbox ' +
        'key (SandboxOnly; a live key must do it by hand in the publisher console); ' +
        '(2) replace the secret with a key of an account that ' +
        'already has agents; (3) only if you know the id belongs to THIS account, pin it with ' +
        'SHATALE_GATE_AGENT_ID. Pinning an id from another account changes the wording of this ' +
        'failure and nothing else.',
    )
  }
  return id
}

// 🔴 THE SUFFIX IS CONDITIONAL, AND THE UNCONDITIONAL FORM WAS A REAL DEFECT THE MOMENT THE OPT-IN
// WAS LIFTED. Measured on a real report before this change: the suite's `fullName` carried the
// whole "DISABLED, NOT PASSED — set SHATALE_E2E_LIVE_CHAIN=1 …" sentence, so a verbose reporter and
// the JSON report would both have shown an EXECUTING suite whose own name says it did not run. The
// label was written for the disabled world and read as true in the other one.
//
// ⚠️ The marker `(live sandbox)` stays in BOTH forms on purpose: scripts/live-chain-executed.mjs
// finds the suite by it, and answers "could not measure" — never "executed" — if it is renamed past
// that. A conditional name must not be conditional about the part an instrument keys on.
const LIVE_SUITE_NAME = LIVE_CHAIN_OPT_IN
  ? 'SHAT-3023: one purchase, walked through the contract (live sandbox)'
  : `SHAT-3023: one purchase, walked through the contract (live sandbox) [${LIVE_CHAIN_DISABLED}]`

describeIfKey(LIVE_SUITE_NAME, () => {
  let client: McpTestClient
  let agentId: string

  beforeAll(async () => {
    // ⚠️ THE OTHER DIRECTION OF THE SAME LIE. The workflow's notice is conditional on the ENV
    // VARIABLE and this suite is gated in CODE, so if the gate ever loses the opt-in, the chain runs
    // while the run summary says it is disabled — and this file's other tests would all still pass.
    // A running block asserting it was invited is the one control that catches that, and it can only
    // ever be reached when the block is running.
    expect(
      LIVE_CHAIN_OPT_IN,
      'this suite ran without SHATALE_E2E_LIVE_CHAIN=1, while both workflows print that it is ' +
        'DISABLED (SHAT-3340). One of the two is wrong, and the notice is the one a reader believes.',
    ).toBe(true)
    agentId = await resolveSandboxAgentId()
    client = new McpTestClient({ SHATALE_API_KEY: TEST_KEY! }, 'purchase-chain-live')
    await client.initialize()
  })

  afterAll(() => client.close())

  test('provision → request → approve → status → reveal, on the same purchase', async () => {
    const userId = `shat3023-${Date.now()}`

    // The first link, through the contract: the delegation request_purchase needs.
    const provisioned = await client.callTool('sandbox_create_user', {
      user_id: userId,
      agent_id: agentId,
    })
    expect(provisioned.isError, `sandbox_create_user failed: ${text(provisioned)}`).toBeFalsy()

    const created = await client.callTool('request_purchase', {
      publisher_user_id: userId,
      agent_id: agentId,
      merchant: 'amazon.com',
      amount: 12.34,
      currency: 'EUR',
      description: 'SHAT-3023 chain (live sandbox)',
    })
    expect(created.isError, `request_purchase failed: ${text(created)}`).toBeFalsy()

    const purchaseId = (JSON.parse(text(created)) as { purchase_id?: string }).purchase_id
    expect(purchaseId, `no purchase_id in ${text(created)}`).toBeTruthy()

    // The approval beat is only meaningful when the purchase is actually waiting for one; a purchase
    // that came back payment_ready needs no approval, and asking for one is not a failure either.
    const approved = await client.callTool('sandbox_approve_purchase', { purchase_id: purchaseId! })
    expect(approved.content?.[0]?.text, 'the approval answered nothing at all').toBeDefined()

    const status = await client.callTool('get_purchase_status', { purchase_id: purchaseId! })
    expect(status.isError, `get_purchase_status failed: ${text(status)}`).toBeFalsy()
    expect(text(status), 'the status read answered about a different purchase').toContain(purchaseId!)

    const revealed = await client.callTool('reveal_card', { purchase_id: purchaseId! })
    const answer = text(revealed)
    const cardArrived = answer.includes('card_number') || answer.includes('"number"')
    const namedRefusal = answer.includes('card_credentials_unavailable')
    // 🔴 THE THIRD OUTCOME, AND IT IS THE ONE A SANDBOX RUN ACTUALLY TAKES (SHAT-3340/3362 tail B).
    // A sandbox purchase does not reveal a PAN, on purpose, and the API says so BY NAME —
    // `sandbox_no_pan`, forwarded through our envelope (src/errors.ts, SHAT-2373) precisely so a
    // sandbox integrator does not read a bare "not found" as a broken integration and retry on a
    // LIVE key. This test listed two outcomes and called that refusal a failure, so the live chain
    // could not be green in the only environment it runs in — the assertion was narrower than the
    // contract it was checking.
    const sandboxRefusesOnPurpose = answer.includes('sandbox_no_pan')
    expect(
      cardArrived || namedRefusal || sandboxRefusesOnPurpose,
      `reveal_card ended in none of its three legitimate outcomes (card, ` +
        `card_credentials_unavailable, sandbox_no_pan): ${answer}`,
    ).toBe(true)
  })
})
