# Internal change log — shatale-mcp-server

Not shipped: `docs/` is outside the npm `files` list. The repository is public, so write entries as
you would for a public reader — no card-lifecycle mechanics, limits, issuer internals or credentials.
History before 2.1.2 is in git history (the former CHANGELOG.md).

## [Unreleased]
- `reveal_card` takes an optional `page_currency`: the currency the open checkout page charges in, as
  the page states it. Shatale compares it with the currency the purchase was priced in and refuses the
  reveal when they differ. Omit it and the tool behaves exactly as before (SHAT-8390).
- That refusal now reaches the agent by name — `currency_mismatch_purchase_canceled` or
  `currency_mismatch_hold_stands` — with guidance that says not to retry, instead of the generic 409
  envelope that suggested one. A sentence written for the person travels beside it as `person_message`
  when the API sends one. The shared error-code contract gains both codes (SHAT-8390).
- `page_currency` is refused unless it is a three-letter currency code. A symbol such as `$`, a word,
  or a value with stray characters is not a code, and passing one on would have been read as a
  mismatch — which cancels the purchase. Nothing is sent; omit the field instead of guessing
  (SHAT-8390).
- Test: the card text in `explain_shatale` and SECURITY.md must equal the approved text as a whole (whitelist); the earlier word-pattern refusal is replaced, so an added sentence in any words fails (SHAT-8370).

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
