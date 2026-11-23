# Internal change log — shatale-mcp-server

Not shipped: `docs/` is outside the npm `files` list. The repository is public, so write entries as
you would for a public reader — no card-lifecycle mechanics, limits, issuer internals or credentials.
History before 2.1.2 is in git history (the former CHANGELOG.md).

## [Unreleased]

## [2.1.5] — 2026-11-23
- **Behaviour change.** `reveal_card` now requires `publisher_user_id`. A call without it is refused
  before any request is sent, with an argument error that names the field; a call that passes it is
  served exactly as before. Callers that omitted the field must now pass it. The stderr and `_meta`
  deprecation notice for the old call is gone (SHAT-8736).
- Packaging check: the pack-contents gate reads the shape of `npm pack --json` as npm 12 writes it, and
  npm is pinned to 12.2.3 where the gate runs. The tarball contents are unchanged (SHAT-8133).

## [2.1.4] — 2026-11-22
- `reveal_card` takes an optional `page_currency`: the currency the open checkout page charges in, as
  the page states it. Shatale compares it with the currency the purchase was priced in and refuses the
  reveal when they differ. Omit it and the tool behaves exactly as before (SHAT-8390).
- Eight tools now carry the MCP annotation `readOnlyHint: true`: `explain_shatale`,
  `simulate_purchase_flow`, `generate_policy_template`, `list_capabilities`, `list_mcc_codes`,
  `search_merchants`, `get_merchant_details`, `sandbox_simulate_authorization`. A client may call these
  without asking first. No tool that changes state or answers with card, personal or sign-in data
  carries it; a test pins the exact list (SHAT-8729).
- That refusal now reaches the agent by name — `currency_mismatch_purchase_canceled` or
  `currency_mismatch_hold_stands` — with guidance that says not to retry, instead of the generic 409
  envelope that suggested one. A sentence written for the person travels beside it as `person_message`
  when the API sends one. The shared error-code contract gains both codes (SHAT-8390).
- The third refusal of the same check, `page_currency_not_convertible` (the page's currency could not
  be turned into a safe limit; the card was not issued and the purchase was cancelled), now reaches the
  agent by name with its `person_message`, instead of the generic 409 envelope. The shared contract
  already listed the code; it now lists it as forwarded too (SHAT-8390).
- `page_currency` is refused unless it is a three-letter currency code. A symbol such as `$`, a word,
  or a value with stray characters is not a code, and passing one on would have been read as a
  mismatch — which cancels the purchase. Nothing is sent; omit the field instead of guessing
  (SHAT-8390).
- Packaging: the tarball holds exactly the compiled `.js` and `.d.ts` that `src/` builds, plus
  LICENSE, README.md, SECURITY.md, server.json and package.json. `npm run build` empties `dist/` first;
  `files` no longer takes the whole of `dist/` (test files and dot-paths are excluded); source maps,
  which pointed at sources the package never carried, are no longer shipped; and `prepack` refuses a
  tarball that differs from what `src/` builds (`npm run gate:pack`) (SHAT-8133).
- Test: the card text in `explain_shatale` and SECURITY.md must equal the approved text as a whole (whitelist); the earlier word-pattern refusal is replaced, so an added sentence in any words fails (SHAT-8370).
- Every tool now carries a short public summary as its MCP `title` (for example `search_merchants`:
  "Searches the merchant catalog."), for listings people read. The `description` written for the
  model is unchanged. A test pins each tool's approved text (SHAT-8734).

## [2.1.3] — 2026-11-16
- Card handling text in `explain_shatale` and SECURITY.md now states the card's guarantee to the person
  (never charged more than the approved purchase amount) and no longer describes card lifetimes
  (SHAT-8370).
- The published package carries no source comments (`removeComments`), checked by a test over `dist/`.
  Comments that described card internals were rewritten in the source (SHAT-8313, SHAT-8333).
- `request_purchase`: the API's 409 `unresolved_payment_on_a_failed_purchase` reaches the agent by
  name with its own guidance (do not retry, tell the person to contact support) instead of the generic
  409 envelope that suggested a retry. The shared error-code contract gains the code (SHAT-8325).

## [2.1.2] — 2026-11-10
- Card handling text in `explain_shatale`, README and SECURITY.md corrected: the person's own card is
  never returned; the card Shatale issues for a purchase is returned in full on the reveal path.
  Earlier wording that card numbers are never returned was wrong and is removed.
- CHANGELOG.md removed from the package; this internal log replaces it (SHAT-8315).
