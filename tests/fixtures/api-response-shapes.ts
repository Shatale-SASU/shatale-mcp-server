/**
 * The response bodies of the two endpoints the end of a purchase reads, IN THE API'S OWN FIELD NAMES
 * (SHAT-3023).
 *
 * ⚠️ WHY THIS FILE EXISTS: THE MOCK SPOKE A DIALECT THE API NEVER SPOKE. Until this change the mock
 * upstream answered the reveal with `card_number / expiry_month / expiry_year / cardholder_name` and
 * the checkout identity with `address_line1`. The API answers `pan / exp_month / exp_year / last4` and
 * `address_line / city / postal_code`. Every tool in between passed the body through unread, so
 * nothing refused the difference — and the suite was green about a conversation that never happens.
 * Two sides naming one thing differently, with neither side refusing, is silence, not agreement.
 *
 * The consequence was not cosmetic. The PCI scrub (src/redact.ts) recognised `card_number` and
 * `number` as a PAN and did NOT recognise `pan` — the name the API actually uses. The live chain's
 * success predicate looked for `card_number` too, so a real card arriving would have been read as
 * "none of the legitimate outcomes".
 *
 * ▌SOURCE, READ RATHER THAN REMEMBERED: shatale-api origin/main 5fef347b1703a72aff33a91d365cd49e02ff3314,
 *   apps/api/api/v1/purchases.go
 *     :302  RevealCard        → writeJSON(200, map[string]string{pan, cvv, exp_month, exp_year, last4})  (:427-433)
 *     :341  the person scope  → r.URL.Query().Get("publisher_user_id")  (SHAT-4016/4051)
 *     :455  CheckoutIdentity  → billing_identity{name, address_line, city, postal_code, country}  (:485-491)
 *                               merchant_customer_identity{name, first_name, last_name, email}  (:492-497)
 *   apps/api/main.go:7635-7642 — both routes sit behind APIKeyAuth + RequireAPIKeyScope(purchases:write).
 *
 * ⚠️ DELIBERATELY NOT IMPORTED BY src/. The decoders in src/tools carry their own list of names. If the
 * test took its expectation from the code under test, renaming a field in src would move the
 * expectation with it and the test could never go red — a double that cannot fail. The two lists are
 * written twice on purpose, and this one is the one that cites the producer.
 *
 * ⚠️ THE VALUES ARE SENTINELS, NOT A CARD. No digits: a PAN-shaped literal in a fixture is a PAN-shaped
 * literal in the repository, and the scanners that exist for that cannot tell a fixture from a leak.
 * What a test needs is a value it can RECOGNISE after the redaction layer and in a log, not a real one.
 */

export const SENTINEL_PAN = 'MOCK-CARD-NUMBER-NOT-A-PAN'
export const SENTINEL_CVV = 'MOCK-CVV'

/** GET /v1/purchases/{id}/card-credentials, 200. Exactly these five keys, all strings. */
export const API_CARD_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  pan: SENTINEL_PAN,
  cvv: SENTINEL_CVV,
  exp_month: 'MOCK-MM',
  exp_year: 'MOCK-YY',
  last4: 'MOCK-LAST4',
})

/** GET /v1/purchases/{id}/checkout-identity, 200. Two objects, exactly these keys. */
export const API_CHECKOUT_IDENTITY = Object.freeze({
  billing_identity: Object.freeze({
    name: 'Shatale SASU',
    address_line: '1 Rue Fixture',
    city: 'Fixture City',
    postal_code: 'FX-000',
    country: 'FR',
  }),
  merchant_customer_identity: Object.freeze({
    name: 'Fixture User',
    first_name: 'Fixture',
    last_name: 'User',
    email: 'fixture@test.shatale.com',
  }),
})

/** A fresh, mutable copy — tests mutate one field to build a mismatch, never the frozen original. */
export function cardCredentials(): Record<string, string> {
  return { ...API_CARD_CREDENTIALS }
}

export function checkoutIdentity(): {
  billing_identity: Record<string, string>
  merchant_customer_identity: Record<string, string>
} {
  return {
    billing_identity: { ...API_CHECKOUT_IDENTITY.billing_identity },
    merchant_customer_identity: { ...API_CHECKOUT_IDENTITY.merchant_customer_identity },
  }
}
