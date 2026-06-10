# Councils 2026-06-09 — PR #80 merge + SHAT-1465 funnel metrics

Two Bridge councils (6 models + Claude, 4 rounds, role rotation, include_anthropic).
Mistral optional here (not legally-significant documents). Full logs in `~/.bridge/logs/`.

---

## Council 1 — PR #80 (shatale-api SHAT-1447): remove orphaned packages/mcp-server + fix docs

**Verdict: unanimous GO — merge today.** Convened because designated reviewer Odin was unresponsive.

Key points:
- Deleted tree confirmed orphaned (no workspace/imports/CI/turbo/nx); PR MERGEABLE/CLEAN, checks pass → risk **very low** (not "zero" — possible human/doc refs).
- Canonical source = standalone `Shatale-SASU/shatale-mcp-server` (npm `shatale-mcp-server` v0.3.0, 19 tools).
- Install-command fix (`@shatale/mcp-server` 404 → `shatale-mcp-server`) is real user-facing breakage; do not hold.
- **Salvage, not port:** deleted `errors.ts`/`validation.ts`/`config.ts` may hold reusable patterns for SHAT-1463 — record permalinks before branch deletion, do NOT import dead code, no `research/` folder.
- Pre-merge: repo grep for stale package name / path / non-19 counts; PR comment documenting council approval substituting for blocked reviewer.

**Executed:** grep done → found publisher Tools Reference tab badly divergent (non-existent `preview_purchase`, false `sk_live_*`-works claim, guest set 4 vs real 7) → rewrote to canonical GUEST(7)/SANDBOX(+12)=19 (commit f56642c). SHAT-1463 salvage permalinks pinned to main @ 841ad3a posted. PR #80 squash-merged; SHAT-1447 → Done. Branch kept until 1463 lands. Non-blocking follow-up: `scripts/concierge-cli-demo` references now-deleted paths.

---

## Council 2 — SHAT-1465: guest→sandbox→first-purchase funnel metrics

**Verdict: server-derived metrics + minimal MCP attribution headers. NO client telemetry.**

Core tension: the MCP server is a public OSS npm package running inside the user's IDE; guest mode's zero-network behavior is a documented trust promise. Any silent egress = breaks the promise / "spyware" perception.

Decision:
1. **Do NOT instrument the client with telemetry.** No `/telemetry` endpoint, no beacons, no opt-in flow in v1.
2. **Guest mode stays zero-network** — and guest-only events (`guest_sim_run`, `policy_template_generated`) are **intentionally not measured remotely** in v1.
3. **Sandbox mode:** add static attribution headers on the *already-authenticated* API calls only:
   - `User-Agent: shatale-mcp-server/<version>`
   - `X-Shatale-Client: shatale-mcp-server`
   - `X-Shatale-Client-Version: <version>`
   Classified as **request attribution**, not telemetry (no new transport/endpoint/payload). No OS/hostname/username/IDE/path/install-id/fingerprint.
4. **Backend derives** deduped funnel events from authenticated activity: `mcp_sandbox_key_added` (first sh_test_ request carrying MCP headers), `sandbox_key_first_seen`, `first_real_purchase_request`, `first_card_issued`. Attribute downstream live events to MCP only if account previously had `mcp_sandbox_key_added`.
5. **Stored fields:** event_name, account/org id, timestamp, source, client_name, client_version, key_type, environment. **Never:** key values, prompts, policy contents, merchant/customer/card data, PAN, local username/hostname/path, persistent install id.
6. **Consent:** no new opt-in/opt-out in v1 (no new transport). **Disclosure required before release:** README privacy section stating guest = zero network, sandbox requests carry client/version headers, backend uses authenticated service events for aggregate analytics, no PII/card/merchant/machine identifiers collected.
7. **Dashboard wording:** "MCP sandbox activation" / "Sandbox-to-live conversion" — NOT "guest→sandbox conversion"; add note "guest mode intentionally untracked".

**v1 scope to implement now:**
- MCP repo: add the 3 headers on authenticated calls only; regression test proving guest mode = 0 outbound calls; README privacy section; keep sh_live_ blocked.
- Backend: capture headers in middleware; implement deduped funnel events.
