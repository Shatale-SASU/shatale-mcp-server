# Changelog

All notable changes to `shatale-mcp-server` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

> **On the three entries below `[1.0.0]`.** `0.5.0`, `0.5.1` and `0.5.2` were published to npm
> and had no entries here for weeks; the last documented release was `[0.4.0]` while three
> versions were installable. They are reconstructed from the git history between the tags and
> from the GitHub release bodies. Two of them carry a note about how the artifact was produced
> rather than about what it does. Those notes are here because this file ships **inside the npm
> tarball**: the person who most needs to know that a published artifact did not come from the
> place it claims to is the person who installed it, and this file is the copy they already have.

## [1.0.0] — unreleased

**This release changes no code.** `dist/` in the 1.0.0 tarball is byte-identical to the `dist/`
in the published 0.5.2 (verified by SHA-256 over the sorted file digests of both tarballs). The
entire diff is the release machinery, the documentation, and this file. If you are on 0.5.2, the
server you are running does not change when you upgrade.

What the version number is for is the tool contract. See "Tool contract" below.

### Added
- **Publishing without a tag is now unwritable** (#24) — the version/tag check moved out of the
  publish job (where it was a conditional step, and was `skipped` on every `workflow_dispatch`
  run in this repository's history) into a `needs:` precondition job. The only input that can
  authorise a publish IS the tag to publish, and the code that gets packed is checked out **from
  the tag**, not from a branch. The `dry_run` boolean is gone, and its absence is the fix: it was
  read as a string in two steps with two different spellings of the same intent, so "publish" was
  the default branch of the second. That is how 0.5.0 was published from `refs/heads/main` with
  the tag check sitting skipped one step above.
- **The README's tool matrix is generated from the running server** (#25, SHAT-2527) — the matrix
  lives in a generated region: the gate boots the built server over stdio in all six reachable
  mode combinations, renders the region from what the server actually returned from `tools/list`,
  and byte-compares. Outside the region a bare tool count and an unannotated example prompt are
  refused. A tool named in the README that the server does not advertise is now a CI failure
  rather than a false statement with a live reader. 15 negative controls assert the gate can
  actually fail, and that it cannot trip on its own text.

### Fixed
- The pre-publish gate's success banner claimed more than the gate had measured (#23).

### Tool contract
- 20 tools are defined. What a given session sees depends on the key and the flags:
  guest **7**, sandbox **15**, sandbox + flags **18**, live without money-GO **7**,
  live + money-GO **14**, live + money-GO + flags **17**. The per-tool matrix is in the README
  and is generated from the server, not written by hand.
- Three of the 20 have no backend that can serve them and are OFF unless explicitly enabled:
  `register_user_profile` and `get_onboarding_status` (SHAT-1662 — the register→status loop
  cannot close on any deployed backend) and `get_credential_emails` (its backend is unshipped).

## [0.5.2] — 2026-08-26

Nine fixes, five of which were found while checking something else.

### Changed — **breaking, and it had already happened before this release**
- `list_mcc_codes` now reads the server (`GET /v1/mcc-codes`) instead of a list compiled into
  the client. `_source: "built-in"` is **gone** from the response, and `code` is now a **string**
  (`"4511"`), preserving leading zeros, where 0.5.1 returned a **number** (`4511`).
  **This took effect at the backend deploy on 2026-08-26, not at this release.** For anyone
  running 0.5.1 it had already happened, and was announced nowhere. If you compare MCC codes,
  compare strings.

### Fixed
- **The 30s request timeout covered the headers and not the body.** `finally` cleared the abort
  timer as soon as the try block returned a promise, so an upstream that sent `200` and then
  stalled mid-body was never aborted — measured still hanging at 45 seconds. For a stdio server
  that is an agent that never answers again: no log, no error, no timeout.
- **The install command the server handed out 404s.** The `shatale://guides/quickstart` resource
  and `smithery.yaml` both told the reader to `npx` a **scoped** package name that has never
  existed on the registry. The published package is `shatale-mcp-server`, unscoped. Every
  Smithery install ran a name that 404s. (The dead name is deliberately not spelled here: a
  repository guard refuses it outside prose, because a copyable install line in a file that
  ships to users is the defect itself, not a description of it.)
- **IDs reached the API unvalidated.** A missing argument was sent upstream as the literal
  `"undefined"` and an empty one collapsed the path — including
  `POST /v1/sandbox/purchases//approve`, an empty segment on a write route. Every id that becomes
  a URL path segment is now validated here, naming the argument at fault.
- **A live key would go to any subdomain, over any scheme.** `*.shatale.com` passed the allowlist
  and received `Authorization: Bearer`, and `http://` was accepted because nothing checked the
  scheme. In live mode the host must now be `api.shatale.com` unless
  `SHATALE_ALLOW_NONSTANDARD_LIVE_HOST=true` says otherwise; plaintext is refused for any
  non-loopback host.
- **The PCI card scrub was a property of four call sites, not of the server.** It now runs inside
  the client, on every response, so a tool added later cannot miss it.
- **`sandbox_simulate_authorization` returned a router-level 404 on production** until the route
  was mounted on 2026-08-26. It now returns a decision with an `authorization_id`. Note what a
  decision means today: an agent with no sandbox delegation is declined at the first gate
  (`no active delegation for this agent`), before policy, ledger or fraud run — and **omitting
  `card_number` substitutes the force-approve test card `4242…`**, which overrides that decline
  to `approved` with a `[SANDBOX OVERRIDE]` prefix in the explanation. Send `4111111111111111`
  for the real decision. Tracked as SHAT-2566.
- Errors now carry the server-side `request_id` so a failure can be traced (the backend always
  sent it; the client discarded it).
- `sk_`-prefixed live-key detection accepted a prefix the server never issues (SHAT-2557).
- The credential idempotency key was computed on an hour grid, so two calls either side of the
  boundary produced two live credentials (SHAT-1686).
- Three key-gated tests still expected the tool surface from before three tools were unadvertised
  (18/17 tools, `register_user_profile` callable). They were green-by-skip in PR CI, which runs
  keyless, and would have failed the next nightly — the same skipped-but-green trap the release
  gate exists to close.

### Added
- **Pre-publish release gate** (SHAT-2165) — `npm run gate` drives the built `dist/index.js`
  over stdio against a real deployment with a real sandbox key and asserts a positive policy
  **decision** (`approved`/`declined` + `is_sandbox` + explanation), which is reachable only if
  the request body decoded AND the agent exists. Asserting "no error" would not do: the backend
  returns HTTP 400 for *agent not found* exactly as for a *decode reject*, and the MCP discards
  upstream bodies — so a naive gate would have gone green on the broken 0.5.0 build. Includes a
  build-freshness check, runtime agent discovery (no agent → loud failure, never a skip) and a
  negative control. Wired into `publish.yml` between test and publish, with no skip path.
  See [docs/release-gate.md](docs/release-gate.md).
- **Wire-body fixtures** (SHAT-2165) — `tests/e2e/wire-fixtures.test.ts` captures the exact
  outbound bodies of six tool calls into `tests/fixtures/wire/outbound-requests.json`, so a
  renamed or re-typed field is a reviewable diff instead of a green mock. Runs in `test:public`.
  The Go-side replay test is specified in `tests/fixtures/wire/README.md` but is **not written** —
  it belongs in the `shatale` repo.
- The gating test suite no longer depends on a hand-written list of filenames.
- Documentation corrected against the code, including a security policy that listed `0.2.x` as
  the supported version while the published package was `0.5.2`.

### Notes
- Both legs of the pre-publish gate ran green against the released commit — staging
  (`api-staging.shatale.com`) and production (`api.shatale.com`), each naming its target. The
  staging leg ran for the first time in the project's history; before this, an unset variable
  meant every run labelled "staging" silently certified production.

## [0.5.1] — 2026-08-16

### ⚠️ How this version was published
**There is no `v0.5.1` tag in this repository, and there never was.** 0.5.1 was published from a
maintainer's machine (npm 11.12.1 / Node 22.23.0, user `solskiysb`) 41 seconds after the commit
it was built from, from the branch `feat/shat-2165-publish-gate`. That commit
(`302dc16b54cf1547f1ec7b703f32130d68537286`) is **not an ancestor of `main`** — the code you have
if you installed 0.5.1 is not reachable from this repository's default branch, and the changes in
it re-landed later under different commits. Unlike every other release in this series, the
tarball carries **no npm provenance attestation**, so there is no cryptographic statement of what
source it was built from beyond the `gitHead` field above, which the publisher supplies.

This entry exists because 0.5.1 is installed on people's machines and this file is shipped to
them. It is not hidden, and it is not being quietly folded into 0.5.2. The mechanism that makes
this unrepeatable landed in 1.0.0 (#24): a tag that exists, and whose `package.json` matches it,
is now the only route to the registry.

### Fixed
- **The sandbox policy tool never worked** — 0.2.1's failure, reproduced: `mcc` went onto the
  wire as a JSON number where the Go backend expects a string, so the request never decoded.
  129 green tests did not catch it, because the mock upstream is on this side of the contract.
- **Two tools were advertised whose flow could not complete.** `register_user_profile` returned
  a `claim_set_id` that was never persisted, while its description promised a `session_id`, so
  the `get_onboarding_status` call after it 404s forever. Both are now withheld unless
  `SHATALE_ONBOARDING_ENABLED=true`, and the **handler** is removed along with the listing —
  a merely-unlisted tool stays callable by name.
- The PCI card scrub was widened.

### Changed
- **The package now ships `dist/` plus `README.md`, `LICENSE`, `SECURITY.md` and `CHANGELOG.md`,
  and nothing else** (`files` in `package.json`). Before this, the published tarball contained
  the working repository. File count fell from **104 to 56**.

## [0.5.0] — 2026-08-07

Two-mode operation (demo / live) with a fail-closed money gate.

### ⚠️ What npm serves as 0.5.0 is not the code at the `v0.5.0` tag
The published tarball was built one commit **ahead** of its own tag: npm records
`gitHead: bd9a1e2…`, while `v0.5.0` points at `7e57bf5…`. This is measurable in the artifact
itself — 0.5.0 shipped `.github/` (see below), and the `publish.yml` inside the tarball says
`node-version: 22` where the same file at the tag says `node-version: 20`.

The cause: the run that published it was a `workflow_dispatch` with `dry_run=false`, which
reached the registry through the default branch of a string comparison, from `refs/heads/main`,
with the tag check `skipped` one step above (npm provenance records
`event_name=workflow_dispatch`). No source content that ships at runtime differs — `dist/` is
built from the same source either way — but "the tag is what was published" is not a true
statement about this version, and the release process has been changed so that it is one going
forward (#24, in 1.0.0).

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
