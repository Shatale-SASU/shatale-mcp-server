# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

> Entries for 0.5.0, 0.5.1 and 0.5.2 were added in 1.0.0. They are reconstructed from the git
> history between the tags and from the GitHub release bodies.

## [Unreleased]

## [1.0.3] — 2026-08-27

### Added

- `sandbox_create_user` — a publisher can now create one of ITS OWN sandbox users, with the
  delegation that lets it buy, in a single call (`POST /v1/sandbox/users`, idempotent on all of
  it). This closes the one gap that made the sandbox flow undemonstrable end to end:
  `request_purchase` needs a `publisher_user_id` with an ACTIVE delegation, and nothing in the tool
  surface produced one — the demo could simulate an authorization but could not reach a purchase.
  Sandbox mode goes 16 → 17 tools; the union over all modes goes 20 → 21.
  `agent_id` is REQUIRED, and required HERE rather than upstream. It is not a formality: a sandbox
  user linked WITHOUT a delegation is found by the purchase and refused with
  `delegation_unavailable` — a sentence about delegations, two tools and one hop away from the
  argument that was actually missing. The agent itself is created by a PERSON in the publisher
  console; no API key issues one, deliberately, so the tool asks to be GIVEN the id and says so
  rather than letting a model invent one. (SHAT-2698)

### Changed

- The MCP PROMPTS no longer sell a product this server does not have. They told the model, in the
  imperative, to "Create a shopping agent with a monthly budget of 1000 EUR. Block gambling,
  alcohol, and tobacco categories." Nothing here creates an agent, stores a policy or blocks a
  category. The cost of that lands on the model, which is the worst place for it: handed an
  instruction it cannot carry out, it improvises — inventing an agent id, or reporting a limit it
  never set — and the person watching sees a setup that does not exist. The same wording had
  already been removed from `smithery.yaml` and the README; the surface an MCP client actually
  reads kept it, and the `shatale://guides/quickstart` resource carried it too.
  Prompts are now mode-filtered the way tools have always been — a guest with seven tools was
  being offered a prompt whose instructions need the sandbox simulator — and `agent_id` on that
  prompt became required rather than optional, since optional was an invitation to make one up.
  (SHAT-2604. This shipped as PR #32, which was merged into a branch that had itself just been
  merged and closed: "merged" was a true statement about the action and a false one about the
  result, nothing caught it, and 1.0.2 therefore still shipped the prompts it had fixed.)

### Fixed

- A note attached to a SUCCESS no longer carries the caught exception's own text. When
  `/v1/mcc-codes` cannot be reached, `list_mcc_codes` serves the package's built-in ISO 18245 list
  and says so — and it used to say so by interpolating the exception's message into `_note`, on a
  result with `isError` unset. Measured against the published 1.0.2 with `SHATALE_API_URL` pointed
  at a URL containing credentials, the password reached the agent's context inside a result flagged
  as success. Everything in `src/errors.ts` exists to keep raw caught detail away from the agent;
  this path walked past that guard purely by not being an error. The note now states the fact — the
  lookup failed, this is the packaged list, a code added server-side will not appear — and none of
  the exception. The fallback itself is unchanged: a stale-but-correct MCC list beats a failed call.
- The second raw echo, `API error: ${err.message}` in the `list_mcc_codes` handler, is gone too. It
  had been read as unreachable, since `listMCCCodes` swallows its own failures; it is not.
  `encodeURIComponent` runs before that try block, so a query containing an unpaired surrogate
  throws past the fallback and reached the echo — measured: `API error: URI malformed`. A query that
  cannot be put on a URL is now refused by name, and anything else goes through `errorResult` like
  every other tool. The refusal deliberately does not point at `SHATALE_API_URL`: our own encode
  call threw before a byte was sent, so nothing about the deployment is implicated.
- ...and the detail it stopped sending to the agent now goes to the OPERATOR instead of nowhere.
  Dropping `err` from the catch closed the leak and destroyed the only copy of the reason in the
  same stroke, while the note went on saying "the server-side log has the detail". For the usual
  causes of that branch — DNS failure, connection refused, timeout — NO SERVER WAS REACHED, so no
  server-side log exists to have it; and because the fallback answers as a success, nothing
  downstream reports a problem either. A deployment where `/v1/mcc-codes` is simply absent looked
  healthy from every direction at once. The reason is now written to stderr, which under stdio MCP
  goes to the host's own log and never into the model's context — the same channel `src/index.ts`
  already uses to refuse a start and say why — and the note names that place instead of promising
  one that does not exist. Both halves are pinned: present on stderr, absent from the result.
  The line carries the CAUSE CHAIN, not just the message, because the first version of this fix
  reproduced the defect it was fixing: Node's fetch reports every network failure as the same two
  words, `fetch failed`, and hides the real event in `err.cause`. Measured end to end against a
  dead loopback port, the promised "reason" was literally `Reason: fetch failed` — identical for
  DNS, refusal and timeout, which are the exact three cases the note cites. It now reads
  `fetch failed ← connect ECONNREFUSED 127.0.0.1:62436`, and a test pins that it cannot collapse
  back to the generic wrapper.
- A permanent test that `sandbox_create_user` refuses a missing, empty, whitespace-only or
  non-string `agent_id` BEFORE the write. The behaviour shipped correct in this release; nothing
  was watching it. The route creates a user, a link, a profile and a delegation in one POST, so a
  create that reaches the backend without an agent leaves a user who exists, looks onboarded and
  cannot buy — the assertion is therefore "the upstream saw nothing", not "the tool returned an
  error". Every case supplies a VALID `user_id`, because the handler checks that first and a call
  with `{}` would be answered by the user_id branch and prove nothing about agent_id.
- The coverage summary in `tests/tool-coverage.md` is now derived and enforced rather than asserted
  by hand. It read `Contract (Zod): 6/20` and `Security edge cases: 1/20` against a table holding 11
  and 4 ticks over 21 tools — wrong in the NUMERATOR and the denominator both, three lines under a
  `Tools defined in code: 21` that was correct, and green the whole time because the only gate on
  the file counted rows. `tool-coverage-matches-the-roster.test.ts` now counts each column and
  compares both halves of every fraction against the live roster. This is the document's own
  original defect recurring: it exists because it once reported "17/17 (100%)" against 20 tools.
- Counts that outran the code, swept rather than fixed one at a time. `mock-contract.test.ts`
  carried a comment reading "16" directly above `toHaveLength(17)`; `src/index.ts` said the union
  over every mode "is 20" when it is 21; `demo/demo-script.md` printed a startup banner claiming 15
  tools; and two roster floors sat at `>= 20` against a real 21 — one under the population, which is
  precisely the drift the comment attached to one of them condemns. The per-file test counts in
  `tool-coverage.md` were three rows wrong in the same way (`guest-mode` recorded as 9 against 16,
  `security` 16 against 18, `mock-contract` 8 against 14) with three e2e files missing entirely;
  they are now the output of a run rather than a recollection.
- Two key-gated roster assertions that had been stale for two releases and could not fail in CI.
  `contract.test.ts` and `sandbox-tools.test.ts` both asserted 15 tools in sandbox mode, and
  `sandbox-tools.test.ts` additionally asserted `not.toContain('get_credential_emails')` — the exact
  opposite of the truth since SHAT-2527. Both files are `describe.skip` without `SHATALE_TEST_KEY`,
  and a skip and a pass are the same line in the summary, so the keyless CI that gates PRs was green
  across both moves (15 → 16 when a suppression expired, 16 → 17 when a tool was added). This is the
  skipped-but-green trap of SHAT-2611/2685, in files whose own comments warn about it. Measured, not
  reasoned: the roster is fixed by the key's PREFIX and the env flags before any request is made, so
  a sandbox-shaped key with no network reproduces the failure — `expected [ …(17) ] to have a length
  of 15`.
- `package-lock.json` rejoins `package.json`. It was left at 1.0.1 by the 1.0.2 release, which
  touched only the changelog and the manifest; nothing in the suite or in CI compares the two, so
  the drift was invisible until an `npm ci` or a publish read it.

## [1.0.2] — 2026-08-27

Five fixes that all share one shape: a text that outran, or misread, the code it describes.
1.0.1 shipped with each of them, which is why they are grouped here rather than held back.

### Changed

- A tool DESCRIPTION is a promise too, and two of them outran the code. `request_purchase`
  advertised that Shatale "executes the payment"; no branch of the backend does — the call answers
  with a status, and even `payment_ready` means only that a card was issued. And every 401 AND every
  403 told the reader to set a sandbox key: destructive under a live key, since the server refuses
  to start on `SHATALE_MODE=live` with a non-live key, and simply wrong for a 403, which is a key
  that WAS accepted. 403 is now its own code with its own advice. (SHAT-2683)
- An error whose cause is unknown no longer names one. `errorResult(err, fallback)` reached its
  fallback exactly when the caught error was NOT an API error — when the server had not answered —
  and each of the fourteen tools had written that fallback as a diagnosis. Measured against the
  published package with the API unreachable, `request_purchase` came back advising the caller to
  "Confirm the merchant, amount, and user details are valid, then retry." Nothing had rejected any
  of them. The second argument is now a CODE, not a diagnosis, and there is one shared text saying
  that no reply came back. Advice about inputs stays where the server rejected them (`mapHttpError`),
  which a test asserts, so this cannot be satisfied by removing all advice. A refusal the client
  itself decides now goes through `refusal()`, where the cause is known and the advice is earned.
- A 404 no longer exonerates a bad id. The old rule guessed from the shape of the path whether a
  request could carry a caller-supplied id, and it was wrong in BOTH directions: it told two POSTs
  with an id mid-path that "nothing in your request is wrong", and it told three requests that carry
  no id at all to go check their id. The fact now travels WITH the request — every one of the fifteen
  call sites declares `caller-id`, `fixed`, or `unknown` — and the reply is a table over that
  declaration, so a fourth kind of knowledge will not compile until someone writes its sentence.
  `unknown` is the default and says plainly that the two cannot be told apart from here. (SHAT-2678)
- The card promise was wider than the code, and a promise wider than the code is the dangerous
  direction: it licenses the reader to quote and to log. `explain_shatale` said raw PAN/CVV are
  NEVER returned into the reasoning context, "even in LIVE mode", while `sandbox_approve_purchase`
  returns them in full — deliberately, because the card is one WE issued and an agent cannot fill a
  checkout form with a mask. The person's own card is never returned, on any path, in any mode. What
  separates the two is an allowlist of API paths, not a property read off the response body. The
  boundaries are stated with it: the card is not merchant-locked, and it spends until it expires, is
  locked, or is quarantined. (SHAT-2610)

### Fixed

- An e2e assertion outlived its subject. `sandbox-tools.test.ts` still asserted that
  `request_purchase` answers `sandbox_key_purchase_blocked` — a refusal removed in 1.0.1. Nothing
  caught it: the suite is key-gated, and without a key it SKIPS, which in the summary line is
  indistinguishable from passing. The damage is not the failure it would have caused on the first
  keyed run. It is that anyone checking whether the removed refusal is really gone would have found
  a green-looking assertion that it is not. (SHAT-2611, and the class itself is SHAT-2685)

## [1.0.1] — 2026-08-27

Everything below shipped in this release; 1.0.0 carried none of it. The entries sat under
`[Unreleased]` until now, which was true by commit order and false for the person reading the
changelog — and the changelog is what gets read.

### Changed

- `request_purchase` is no longer refused under a sandbox key. The refusal cited a property of the
  backend — "`/v1/purchases` is NOT sandbox-gated, so a `sk_sandbox_*` key can reach a live,
  side-effectful path" — and SHAT-2373 changed exactly that property while this client went on
  citing it. The endpoint now serves sandbox keys deliberately: the environment is stamped from the
  key, never from the request body, and the money-movers resolve to sandbox implementations. A
  sandbox key using the same public contract an outsider uses is the product; a privileged
  `/v1/sandbox/purchases` bypass is what the ticket forbids. (SHAT-2611)
- The two sentences the server SAYS about it were corrected with the code. `explain_shatale` and
  `list_capabilities` told a sandbox caller that `request_purchase` was "disabled"/"BLOCKED"; an
  agent that reads that does not call the tool, so the refusal survived its own removal in prose.
  Both are now pinned by a test. (SHAT-2611)
- The refusal's suggested fix pointed at real money: it told the caller to escape the sandbox by
  switching to a live key together with the two production money switches, as the way out of a
  sandbox that was safe by construction. That advice is gone and is asserted absent. (SHAT-2611)

## [1.0.0] — 2026-08-27

No code change **relative to 0.5.2**: `dist/` in the 1.0.0 tarball is byte-identical to `dist/` in
the published 0.5.2, so upgrading from 0.5.2 changes the documentation and the packaging, not the
server. That is a statement about this release, not about the repository — changes made after it
are under `[Unreleased]` above.

### Added
- Publishing requires a tag whose `package.json` matches it, and the published code is checked
  out from that tag (#24).
- The README's tool matrix is generated from the running server and byte-compared in CI, so the
  documented tool surface cannot drift from the advertised one (#25, SHAT-2527).

### Fixed
- The pre-publish gate's success banner claimed more than the gate had measured (#23).

### Tool contract
- 20 tools are defined. What a session sees depends on the key and the flags:
  guest **7**, sandbox **15**, sandbox + flags **18**, live without money-GO **7**,
  live + money-GO **14**, live + money-GO + flags **17**. The per-tool matrix is in the README.
- Three of the 20 have no deployed backend and are OFF unless explicitly enabled:
  `register_user_profile` and `get_onboarding_status` (SHAT-1662) and `get_credential_emails`.

## [0.5.2] — 2026-08-26

### Changed — breaking
- `list_mcc_codes` now reads the server (`GET /v1/mcc-codes`) instead of a list compiled into the
  client. `_source: "built-in"` is **gone** from the response, and `code` is now a **string**
  (`"4511"`), preserving leading zeros, where 0.5.1 returned a **number** (`4511`).
  This took effect at the backend deploy on 2026-08-26, not at this release, so it also applies
  to 0.5.1. **If you compare MCC codes, compare strings.**

### Fixed
- The 30s request timeout covered the response headers but not the body, so an upstream that
  answered `200` and then stalled mid-body was never aborted.
- The `shatale://guides/quickstart` resource and `smithery.yaml` told the reader to `npx` a
  **scoped** package name that does not exist on the registry. The published package is
  `shatale-mcp-server`, unscoped.
- IDs reached the API unvalidated: a missing argument was sent upstream as the literal
  `"undefined"` and an empty one collapsed the path. Every id that becomes a URL path segment is
  now validated, and the error names the argument at fault.
- A live key could be sent to any `*.shatale.com` subdomain and over plain `http`. In live mode
  the host must now be `api.shatale.com` unless `SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true`, and
  plaintext is refused for any non-loopback host.
- Card redaction moved from four individual tool results into `ShataleClient`, so it applies to
  every response rather than to an enumerated list of call sites.
- `sandbox_simulate_authorization` returned a router-level 404 on production until the route was
  mounted on 2026-08-26. It now returns a decision with an `authorization_id`. Two things to know
  about that decision: an agent with no sandbox delegation is declined at the first gate, before
  policy runs; and **omitting `card_number` substitutes the force-approve test card `4242…`**,
  which overrides that decline to `approved` with a `[SANDBOX OVERRIDE]` prefix. Send
  `4111111111111111` for the real decision (SHAT-2566).
- Errors now carry the server-side `request_id` (the backend always sent it; the client dropped
  it).
- Live-key detection accepted an `sk_` prefix the server never issues (SHAT-2557).
- The credential idempotency key was computed on an hour grid, so two calls either side of the
  boundary produced two live credentials (SHAT-1686).

### Added
- **Pre-publish release gate** (SHAT-2165) — `npm run gate` drives the built server over stdio
  against a real deployment with a real sandbox key and requires a positive policy **decision**,
  which is reachable only if the request body decoded and the agent exists. It has no skip path:
  a missing key, an unreachable API or an empty agent list all fail.
  See [docs/release-gate.md](docs/release-gate.md).
- **Wire-body fixtures** (SHAT-2165) — the exact outbound bodies of six tool calls are captured
  into `tests/fixtures/wire/outbound-requests.json`, so a renamed or re-typed field is a
  reviewable diff rather than a passing mock.
- Documentation corrected against the code, including a security policy that listed `0.2.x` as
  the supported version while the published package was `0.5.2`.

## [0.5.1] — 2026-08-16

### Fixed
- `sandbox_simulate_authorization` sent `mcc` onto the wire as a JSON number where the backend
  expects a string, so the request never decoded and the tool could not work.
- `register_user_profile` and `get_onboarding_status` were advertised while the flow between them
  could not complete: the first returned an id the backend does not persist, so the second 404s
  for it. Both are now withheld unless `SHATALE_ONBOARDING_ENABLED=true`, and the handler is
  removed along with the listing — an unlisted tool otherwise stays callable by name.
- Card redaction was widened to more of the results that can carry one.

### Changed
- The package now ships `dist/` plus `README.md`, `LICENSE`, `SECURITY.md` and `CHANGELOG.md`,
  and nothing else (`files` in `package.json`). File count fell from **104 to 56**.

## [0.5.0] — 2026-08-07

Two-mode operation (demo / live) with a fail-closed money gate.

> **Note on the published artifact.** The 0.5.0 tarball on npm was not built from the code at the
> `v0.5.0` tag. If you are comparing the tag against the package, they differ. `dist/` is built
> from the same sources either way. From 1.0.0 the published code is checked out from the tag
> (#24).

### Added
- **Two modes, demo and live**, with a fail-closed SHA-256 money gate: the purchase and
  credential tools are registered only when `sha256(SHATALE_MONEY_GO) === SHATALE_MONEY_GO_SHA256`.
  Default OFF. A live key without `SHATALE_MODE=live` refuses to start, and `SHATALE_MODE=live`
  without a live key also refuses. A live key with the mode and no money-GO runs onboarding-only.
- **Checkout-identity tools** — `get_checkout_cardholder` (the legal cardholder / billing
  identity) and `get_checkout_customer` (the buyer), both returning an identity only: card
  number, expiry and CVV are not returned here.
- `get_credential_emails`, gated behind `SHATALE_CREDENTIAL_EMAILS_ENABLED` until its backend
  ships.

### Changed
- Server-side `RejectSandbox` plus PAN redaction on the tool results that can carry a card.

### Notes
- Reviewed by Odin (the SHA-256 gate was authored there) and Fable.

## [0.4.0] — 2026-06-10

Realign the sandbox tool surface to the routes the backend actually deploys, and
strengthen the guest/no-key demo. This is a **breaking change** to the public tool surface.

### Added
- `sandbox_simulate_authorization` (SHAT-1488) — runs the policy engine on a simulated
  authorization via `POST /v1/sandbox/authorizations`. Side-effect-free (no ledger, no
  money, no card issued). Returns approve/decline plus an explanation. Test cards: `4242…`
  forces approve, `4000…0002` forces decline, neutral cards let the real policy decide.
- Mode-aware `explain_shatale` (SHAT-1460) — reports live mode, the tools available in this
  session, the recommended first prompt, and a sandbox-unlock CTA. (Historical note: this entry
  originally said "GUEST / SANDBOX / blocked PRODUCTION". "Blocked PRODUCTION" stopped existing in
  0.4, when live keys became gated rather than rejected, and the server now reports FOUR modes:
  guest, demo(sandbox), live(onboarding-only), live+money-GO. Annotated rather than rewritten — a
  changelog entry records what shipped then, and correcting it silently would lose that.)
- `generate_policy_template` now returns a `validation` block (SHAT-1462) — `risk_level`,
  `warnings`, `recommended_controls`; never returns a silently unsafe policy.
- Structured error envelope across tools (SHAT-1463) and gated client attribution headers
  on authenticated sandbox calls only (SHAT-1465) — `User-Agent`, `X-Shatale-Client`,
  `X-Shatale-Client-Version`; guest mode stays fully offline with no headers.

### Changed
- `sandbox_approve_request` → **renamed** `sandbox_approve_purchase`, now pointing at the
  deployed `POST /v1/sandbox/purchases/{purchaseId}/approve`.
- `request_purchase` is **blocked when a sandbox key is set**. `POST /v1/purchases` is not
  sandbox-gated on the backend and would create real ledger/outbox state. The tool now
  returns a structured `sandbox_key_purchase_blocked` error and never reaches the network.
  Use `sandbox_simulate_authorization` to exercise the policy engine instead.
- `simulate_purchase_flow` (SHAT-1461) emits a deterministic guest verdict with non-happy
  paths (blocked category, over guest cap, over budget, approval-required) and a trace.
- README leads with the 60-second no-key demo and "run the same flow in sandbox" (SHAT-1464).
- Sandbox tool count: **5 → 3**. Total tools in sandbox mode: **19 → 17**.
- All user-facing key examples now use `sk_sandbox_*` (sandbox) / `sk_live_*` (rejected).

### Removed
- `sandbox_create_test_user`, `sandbox_decline_request`, `sandbox_reset` — these called
  routes the backend does not deploy and could not succeed against a real sandbox.

### Notes
- Guest mode makes no network calls (3 simulation tools + catalog).
- No backend changes; this release only realigns the MCP client to the deployed contract.
