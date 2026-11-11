# Internal change log — shatale-mcp-server

Not shipped: `docs/` is outside the npm `files` list. The repository is public, so write entries as
you would for a public reader — no card-lifecycle mechanics, limits, issuer internals or credentials.
History before 2.1.2 is in git history (the former CHANGELOG.md).

## [Unreleased]
- The published package carries no source comments (`removeComments`), checked by a test over `dist/`.
  Comments that described card internals were rewritten in the source (SHAT-8313, SHAT-8333).

## [2.1.2] — 2026-11-10
- Card handling text in `explain_shatale`, README and SECURITY.md corrected: the person's own card is
  never returned; the card Shatale issues for a purchase is returned in full on the reveal path.
  Earlier wording that card numbers are never returned was wrong and is removed.
- CHANGELOG.md removed from the package; this internal log replaces it (SHAT-8315).
