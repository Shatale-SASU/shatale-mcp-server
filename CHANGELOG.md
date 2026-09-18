# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

> Entries for 0.5.0, 0.5.1 and 0.5.2 were added in 1.0.0. They are reconstructed from the git
> history between the tags and from the GitHub release bodies.

## [Unreleased]

### Added

- **A streamable-HTTP transport beside stdio** (SHAT-3520). The server spoke only stdio, so a client
  that cannot spawn a child process — a web application — could not reach it through the public
  contract at all. stdio remains the default and is unchanged: the transport is ADDED, and it is
  chosen by an explicit `SHATALE_MCP_TRANSPORT`, never inferred from the environment. A value we do
  not recognise is refused rather than folded into the default, because falling back starts stdio
  for somebody who asked for HTTP and leaves them debugging a network they can reach.

  The server build moved into a factory. It was a module-level singleton whose handlers were
  registered as import side effects — sound while stdio is a 1:1 pipe to one client, and wrong the
  moment a second client can arrive: they would have shared one object and crossed each other's
  replies. Both transports now hand back the SAME roster rather than two lists that happen to agree
  today, and a test asks BOTH RUNNING TRANSPORTS and compares the sets — a tool present on one path
  and absent on the other is a divergence that would never announce itself.

  HTTP requires the publisher key as a bearer token, compared in constant time and never echoed.
  `missing_key` and `key_not_accepted` stay separate answers on purpose. Without a key to check
  against, HTTP refuses to start rather than listening on a network that authenticates nothing; it
  binds loopback unless told otherwise. Sessions are stateless — a server and a transport per
  request — so two callers cannot observe each other.

  The stdio hardening stays on the stdio path: it writes a parse-error frame to the process stdout
  and closes the session, which is right for a pipe and wrong twice on HTTP, where that stdout is
  nobody's channel and one malformed frame would tear down a session shared with others.

## [1.0.4] — 2026-09-18

> 🔴 **THIS VERSION WAS PREPARED ON 2026-08-28 AND NOT PUBLISHED FOR THREE WEEKS, AND THE COST IS
> MEASURED (SHAT-3506).** The entry below was written the night the divergence was found; the tag was
> never cut. In the meantime `main` gathered twenty more commits, and the one thing 1.0.4 exists to
> ship — a deterministic `idempotency_key` on every write — stayed unpublished while the API started
> requiring it.
>
> **What that did:** the Concierge pins `shatale-mcp-server@1.0.3`, the API put `IdempotentBody` in
> front of `POST /v1/sandbox/users` (SHAT-2721), and provisioning has answered
> `400 idempotency_key is required in the request body` ever since. `sandbox_create_user` is the ONLY
> way a new Concierge user reaches the enrolment funnel, so the funnel has been dead since the end of
> August. The e2e spec that walks it has failed in every run it actually executed since 2026-09-06.
>
> ⚠️ **The fix was three hours late to the release, and that is worse than absent.** Commit `2a71805`
> landed at 23:34 on 2026-08-27; `v1.0.3` was tagged at 20:28 the same evening. Anyone reading
> `src/client.ts` — and two people did, including the author of this note — sees a client that sends
> the key. The tree was right and the registry was three hours behind it.
>
> The sections below therefore cover **everything on `main` at the time of this release**, not only
> what was written on 28.08. The date is the publication date, because a heading that names an older
> day describes content it has never seen — which is the defect the original note underneath was
> written about, one version down.

### Fixed — the reason this release is urgent

- **The Concierge enrolment funnel opens again** (SHAT-3506). `createSandboxUser` and
  `sandboxCompleteOnboarding` send deterministic idempotency keys, which the API has required since
  SHAT-2721. No code changed for this: it has been on `main` since 2026-08-27 and this is the first
  release that carries it.


> ⚠️ **1.0.3 was published without the three commits below, and the version was never raised.** The
> package on npm and the tree on `main` carried ONE NUMBER over DIFFERENT CONTENT, so anyone
> installing `shatale-mcp-server@1.0.3` got the older behaviour with no way to notice — the number
> matched. Measured by RUNNING the published tarball, not by reading it: it announced
> `demo(sandbox) mode, 17 tools`, where `main` announces 19.
>
> This release exists to make the number mean something again.

### Added

- **Checkout tools in the sandbox.** `get_checkout_customer` and `get_checkout_cardholder` now
  register for a sandbox key, not only for `isLive && moneyGo`. The gate that hid them was ours, and
  the reason recorded for it — that the backend would refuse a sandbox key on those routes — was not
  true of the backend. The owner decided the tools should be available; the gate is removed rather
  than re-justified. Sandbox goes 17 → 19 tools; the union over all modes stays 21.

### Changed

- **Every write now carries an idempotency key, and the list of writes comes from the source.**
  `cancel_purchase`, `sandbox_approve_purchase`, `sandbox_create_user`,
  `sandbox_complete_onboarding` and `register_user_profile` send one; the last of those previously
  *forwarded* a caller-supplied key and enforced nothing. `sandbox_approve_purchase` matters most —
  it issues a card, and it appeared in neither of the two tickets' hand-written lists.
  The keys are DETERMINISTIC, derived from the operation and its target: these calls address a row
  that already exists, so a repeat means "do that again to the same thing" and must de-duplicate. A
  per-call random key does the opposite.
  `sandbox_simulate_authorization` is the one exemption, and it is recorded with the measurement
  that earns it rather than as an assertion.

### Fixed

- **The publish workflow refuses a tag that is not reachable from `main`.** A tag cut from a branch
  can no longer reach the registry — the failure that put 0.5.1 on npm with no tag at all. Verified
  to discriminate, not merely to exist: a tag on `main` passes, a tag on a side branch is refused,
  and a tag whose name disagrees with `package.json` is refused.

### Changed and added since 2026-08-28

> ⚠️ **A NEW PUBLIC TOOL SHIPS UNDER A PATCH NUMBER, AND THAT IS A RELEASE DECISION RATHER THAN AN
> OVERSIGHT TO CORRECT HERE.** `await_purchase_approval` (#64) is new MCP surface, and the sandbox
> roster has gone 19 → 21 since the note above was written — `reveal_card` (SHAT-3023) and
> `await_purchase_approval`. Under semver an added tool is a MINOR bump, so 1.0.3 → 1.0.4 understates
> what a consumer receives.
>
> It is recorded and not decided: `package.json` already says 1.0.4, the publish gate matches the tag
> against it, and `main-must-not-drift-past-its-published-version.mjs` is satisfied by 1.0.4. Raising
> it to 1.1.0 is one line in two places and is the releaser's call.
>
> The counts above are quoted from the README's per-mode roster, which is generated from the RUNNING
> server (`<!-- count:sandbox -->`). A count derived by grepping `src/tools` gives 23 and is wrong —
> it counts names across modes. The number belongs to the instrument that maintains it.

### Changed

- **The nightly run executes the live purchase chain, and a sandbox refusal is no longer counted as
  a failure** (SHAT-3340 / SHAT-3023). `reveal_card` has THREE legitimate outcomes, not two: a
  sandbox purchase does not reveal a PAN and the API says so by name (`sandbox_no_pan`, forwarded
  through our envelope since SHAT-2373 precisely so a sandbox integrator does not read it as a broken
  integration). The walk called that refusal a failure, so the chain could not be green in the only
  environment it runs in. `nightly.yml` now sets `SHATALE_E2E_LIVE_CHAIN=1`, asks vitest for a JSON
  report and runs `scripts/live-chain-executed.mjs` — a skipped suite makes a run PASS, so the count
  is the acceptance rather than the colour. The secret now holds the sandbox key of the `ci-nightly`
  publisher, an account that belongs to the pipeline rather than to a person, which is what made the
  unattended run the owner's to allow.
- **The tool description no longer claims that no API key can create an agent** — it said so, and it
  was false; the first correction ("only a sandbox key can") was false too. Measured on the API tree:
  `POST /v1/agents` creates one for a LIVE key (`agents:write`, behind the middleware that refuses a
  sandbox key) and `POST /v1/sandbox/agents` for a sandbox one. What is true, and all this contract
  depends on, is that **no tool here creates an agent** — so an agent id is a precondition an
  assistant cannot manufacture. The generated README matrix carries the corrected sentence.

- **`request_temporary_credentials` no longer tells the model the credentials are short-lived**
  (SHAT-3443, backend SHAT-3428). **Behaviour change for the agent**, not a comment: a tool
  description is read before the tool is chosen and acted on after.
  The backend cancelled the term on saved credentials — the user/agent/merchant pairing lives until
  the person revokes it, the column that held an expiry is NULL for every row minted since, and the
  API no longer accepts `ttl_seconds`. The description still said "temporary, short-lived", and an
  agent that believes it re-requests credentials on every attempt, which is exactly what the durable
  pairing exists to avoid. It now says they live until revoked and that the same pairing is reused.
  ⚠️ **The tool NAME is unchanged** and keeps the word "temporary": a name is public MCP surface, and
  renaming it breaks every prompt that calls it by name, for a word. A test asserts the name is still
  there, so a future rename is a deliberate act rather than tidying.
  Also corrected: `DERIVED_KEY_WINDOW_MS` documented itself as MIRRORING `credentials/service.go:
  defaultTTL = 1 hour` while warning in the same paragraph that the coupling was one-directional —
  "nothing here notices if the backend changes it". That constant has been deleted. The window stays
  at one hour for a reason of its own (how long this process holds a derived key in memory), now
  stated. **No behaviour change** in the key cache.
  ⚠️ And the same stale word stood in TWO SIBLING descriptions and one field hint — `get_credential_status`
  ("the status of a *temporary* credential request"), `get_credential_emails` ("a *temporary*
  credential's relay address") and the `purpose` hint. Found by grepping the subject rather than by
  remembering what had been edited: fixing one of three is how a claim survives its own repair.

- **The PCI redactor's justification described a response that no longer exists** (SHAT-3346).
  Internal: comments and test fixtures only, **no behaviour change** — the scrub itself is untouched.
  The opening paragraph of `src/redact.ts` stated, naming `apps/api purchases.go purchaseToJSON`,
  that the backend's purchase response "embeds the raw pool-card PAN + CVV under `payment.card`".
  Measured on apps/api at 2026-09-15: that block is `last4`, plus `card_ref` when the issued card
  row exists. The raw card came off this response in SHAT B-1 and lives only on the reveal endpoint;
  `merchant_locked` was removed by SHAT-2710.
  The claim also contradicted this file's own allowlist: that reveal path is in `OUR_CARD_PATHS` and
  is passed through deliberately (SHAT-2610), so the named subject carried no PAN while the response
  that does carry one is not scrubbed at all.
  **There was no leak** — the scrub had nothing to cut on that path. What was wrong was knowledge: a
  false statement about another system's contract, written as a fact with an address, inside the
  component that guards a card surface. The test fixture modelled the same invention and was green
  throughout, because it checked the redactor against its own input. The fixtures are now split into
  the contract shape and a shape labelled a hypothesis, and apps/api pins that contract where it is
  produced.

- **A named refusal from the API now survives our envelope** (SHAT-3362). Every 404 was mapped into
  the client's own `not_found` with "Verify the id in the path", and the upstream body was discarded
  unread. That is deliberate — upstream error DETAIL must never reach a calling agent — but it also
  destroyed refusals the API writes BY NAME precisely because a generic answer is harmful: a sandbox
  purchase does not reveal a PAN, and a bare "not found" reads as a broken integration and sends a
  sandbox integrator to retry **on a live key**, which is the exact move that refusal exists to
  prevent.
  The fix is NOT a wider whitelist: free upstream text is still never forwarded, because widening it
  re-opens the leak `publicErrorMessage` closes. It is a **closed vocabulary** — a `code` is not
  content, it is a value from a list both sides agreed on in advance, and forwarding it reads none of
  the server's own prose. A code outside the list is dropped together with the whole body, as before.
  First entry: `sandbox_no_pan`.
  ⚠️ The first version of the test proved the vocabulary worked and said nothing about the client
  USING it — a mutant disabling the forwarding branch survived four green assertions. A function is
  not its call. Two assertions now drive the real request path with a stubbed `fetch`, and the
  control asserts a 404 WITHOUT an agreed code still receives the client's own envelope.

- **`sandbox_complete_onboarding`** now says WHICH id it wants: the one you chose in
  `sandbox_create_user`. It said "The test user ID", and that ambiguity was the whole of SHAT-2530 —
  the API resolved the parameter as Shatale's internal user id, which no tool, endpoint or response
  ever hands out, so the call could not be made correctly and answered 404. A 404 reads as "your user
  does not exist", not as "you cannot express which user you mean", which is why it went unnoticed.

  The parameter description also names the failure against an older API, so the text is true whichever
  version a caller is pointed at rather than true only after the server change lands.

### Added

- **`reveal_card`** — reveal the card credentials (number, expiry, CVV) of the Shatale card issued for
  a given purchase, so an agent can complete a merchant checkout that has no out-of-band path
  (SHAT-3023). Only the card **we** issued for that purchase is ever returned; a customer's own
  instrument is not available here and is stripped from every other response.

  ⚠️ **The redaction boundary is unchanged, and the tool holds none of it.** The PCI scrub runs once,
  inside `ShataleClient.request`, and decides by the PATH the client used — the allowlist in
  `src/redact.ts` has listed `/v1/purchases/{id}/card-credentials` since SHAT-2610, with the comment
  "for when the client learns to call it". This release is the client learning; nothing was widened to
  admit it. A tool wired to a neighbouring URL would return a redacted body, which is the failure this
  design intends.

  It does **not** return `three_ds_password`: one static 3DS password is shared by every card in the
  pool, and the endpoint stopped returning it under SHAT-2323. Every SUCCESSFUL reveal is recorded
  server-side in the credential access log — the agent cannot suppress the record by how it calls.
  A refused reveal discloses nothing and is therefore not in that log; it is recorded separately
  server-side (SHAT-3288), because a log of disclosures that also held refusals would stop
  answering the one question it exists for: who holds this secret.

  Registered wherever the checkout tools are — sandbox, and live behind the same explicit money-GO that
  already gates purchases and credentials.

- **`await_purchase_approval`** — wait for the person to answer a purchase that needs their
  approval, instead of polling. Returns `approved`, `declined`, `expired`, or `still_waiting`,
  which means nobody has answered yet and the tool may be called again (SHAT-2802).

  It reads the decision and never changes the purchase, and `get_purchase_status` keeps working
  alongside it — the wait is an addition, not a replacement.

  ⚠️ **How long it waits is the host's decision, not ours.** A progress notification resets the
  client's request timeout only when the client asked for progress AND enabled
  `resetTimeoutOnProgress`; without a token the SDK's 60s default stands, so the tool finishes
  inside it and hands the decision back. Either way it RETURNS `still_waiting` rather than failing:
  promising a long wait on a host that never agreed to one is a promise made at somebody else's
  expense.

  The 30s bound `SECURITY.md` states on every API call is unchanged — the wait the agent sees is
  several bounded calls underneath, paced by this tool rather than by the server.

### Changed

- **internal, no behaviour change:** the mock upstream answers
  `GET /v1/purchases/{id}/card-credentials` (SHAT-3023), so the purchase chain — request, approve,
  status, reveal — can be walked in CI with no live key. The values are sentinels and carry no
  digits: a PAN-shaped literal in a fixture is a PAN-shaped literal in the repository, and the
  scanners that exist for that reason cannot tell a fixture from a leak. Ordered before the generic
  `/v1/purchases/` read, which would otherwise swallow the path and answer with a purchase-shaped
  body — making a reveal that returned no card look successful.

- **internal, no behaviour change:** the onboarding gate's recorded REASON was corrected
  (SHAT-2622). `register_user_profile` and `get_onboarding_status` stay OFF and the switch is
  untouched; what changed is why. The comment named a backend defect — "RegisterUserProfile mints
  sessionID = ulid.New() and never persists it" — which has since been fixed, so a reader who
  checked the stated cause would find it gone, conclude the flip condition was met, and turn on an
  identity path whose four later steps answer 404 for the only id they are ever given. A stale
  reason under a right conclusion is more dangerous than no reason: it tells the next person exactly
  which wrong thing to verify. The live blocker (the register step and the later steps read
  different tables) is named instead, with the ticket that owns it, and the flip condition is
  restated so it can be measured.

- **internal, no behaviour change:** the filesystem sweep's skip list moved to
  `tests/harness/repoWalk.ts` and is explained there (SHAT-2713). A sweep that descends into
  `.claude/` reads a git worktree — a copy of this repository inside itself — and counts every
  forbidden string in its own source as a hit; three absence checks went red on a clean `main` that
  way. The exclusion used to live in the one test that was bitten, where the next author of a sweep
  would never see it.

### Changed

- **The startup banner names the API it will talk to** (SHAT-2711). It read
  `... (demo(sandbox) mode, 19 tools)` for production and, byte for byte, the same line for a dead
  `http://127.0.0.1:9` — so the log could not answer the one question asked of it. It now carries
  `api=<origin>`, and marks the unset case `(default)`, because an unset variable is how a process
  ends up talking to production without anyone deciding that it should.

### Fixed

- **An empty `SHATALE_API_URL` is refused in the server's own words** (SHAT-2711). `??` falls back on
  `undefined` only, so an empty string reached `new URL('')` and threw at MODULE SCOPE — before any
  handler existed. The parent saw a raw Node stack from a child dying during the MCP handshake, which
  arrives as a timeout rather than an error. A value that is not a URL is refused too, by its LENGTH
  rather than by echoing it: a URL can carry credentials in its userinfo.

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
  by hand. Three of the four fractions were wrong, not two: `Contract (Zod): 6/20` and
  `Security edge cases: 1/20` against a table holding 11 and 4 ticks over 21 tools — wrong in the
  NUMERATOR and the denominator both — and `Input validation: 3/21`, whose denominator was right and
  whose numerator was one short of the column's 4. All three sat three lines under a
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
- `demo/demo-script.md` still opened with the sentence SHAT-2604 was opened to remove — "Create a
  shopping agent with a €1000 monthly budget. Block gambling and alcohol." — and it was the last
  live copy in the repository. The entry above records that wording being taken out of the prompts,
  the README and `smithery.yaml`; the demo script was not on that list, so the one surface a
  newcomer is most likely to paste verbatim kept it. Its "expected MCP calls" were wrong in the
  same direction: `register_user_profile` is not among the 17 tools the banner three lines above
  advertises (it needs `SHATALE_ONBOARDING_ENABLED=true`, which makes the roster 19), and the step
  promised to show "Agent ID, Card ID, Policy config" — none of which any tool produces. The flow
  now starts where the tools actually start, at `sandbox_create_user`, and the `explain_shatale`
  step no longer claims to return a per-rule breakdown of an earlier decline: that comes back in
  `sandbox_simulate_authorization`'s own response.
- The `exercise-the-policy-engine` prompt was grammatically broken by its own fix. The clause about
  who creates an agent had been spliced into the middle of the instruction, stranding "one call
  each": "...nothing here can create one for them, one call each, and read the rule explanation...".
  The fact was right and the sentence was rubble — and this is a PROMPT, read verbatim by a model as
  an instruction, so it is not a cosmetic defect. The clause now sits at the end.
- `package-lock.json` rejoins `package.json`, and a test now keeps them together. It was left at
  1.0.1 by the 1.0.2 release, which touched only the changelog and the manifest; nothing in the
  suite or in CI compared the two, so the drift was invisible until an `npm ci` or a publish read
  it. Both copies of the version in the lockfile are asserted, because the second is eight lines
  down and looks like a dependency, which is the one a hand-edit misses.
- The per-file test counts in `tool-coverage.md` are gated too, against the files on disk. They were
  the last number in that document with no watcher, and they had drifted furthest — which is what a
  hand-maintained table does under a banner warning that hand-maintained tables drift.

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
