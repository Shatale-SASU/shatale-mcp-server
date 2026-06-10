# Council — MCP как рабочий инструмент паблишера + sales-демо в guest-mode до регистрации

**Дата:** 2026-06-09
**Состав:** Publisher DX Advocate (gpt-5.5), PLG Growth Strategist (deepseek-v4), Skeptical Publisher CTO (deepseek-r1), «Mistral» Integration Architect (gemini-3.5) + Claude
**Полный лог:** `~/.bridge/logs/2026-06-09_17-33-44_council.jsonl`
**Замечание:** роль «Mistral» попала на gemini-провайдера — реальный Mistral в авто-ротацию не подставился. Правило «Mistral в Shatale-консилиумы» технически не выполнено этим прогоном.

## Продуктовый принцип (консенсус)
- **First wow:** 30–60 сек, без API-ключа.
- **Real proof:** 5–10 мин, sandbox-ключ.
- **Переход:** тот же промпт, та же концепция, добавлен один `SHATALE_API_KEY`. Без изменений кода.
- **Production execution в MCP остаётся заблокированным** (это trust-сигнал, не баг).

```
60 сек:  "Я понял, что делает Shatale."
5 мин:   "Я прогнал тот же flow с sandbox-ключом."
10 мин:  "Это реально вставляется в мой агентский/платёжный workflow."
```

## Позиционирование режимов
- **GUEST** = self-serve интерактивное демо платёжного жизненного цикла. Должен показывать: discovery мерчантов/категорий, policy-evaluation, состояния approval/decline/requires-approval, превью выпуска карты, timeline покупки, sandbox-эквивалент tools, signup CTA. НЕ притворяться реальным платежом.
- **SANDBOX** = настоящий dev-режим интеграции: onboarding, purchase request, approval, выпуск credentials, status, traceability, auditability, idempotency.
- **PRODUCTION** = заблокирован by design; ошибка должна объяснять ПОЧЕМУ (локальный IDE/agent — не граница для live-платёжных кредов) и вести на backend-интеграцию.

## P0 — поведение tools (не плодить новые)
**`explain_shatale`** делаем точкой входа/оркестратором: выводит текущий режим (GUEST/SANDBOX/blocked PRODUCTION), доступные возможности, рекомендованный первый промпт, список tools по режиму, sandbox-unlock CTA, production safety note.
Рекомендованный первый промпт:
> Use Shatale to simulate an AI agent buying a $25 developer tool subscription with a $100 monthly budget. Show the policy check, approval decision, virtual card step, and final timeline.

**`simulate_purchase_flow`** — низкое трение (merchant/amount/currency/description). Guest-output должен включать: `mode`, `summary.result` (approved|declined|requires_approval), `policy_evaluation` (matched_rules, remaining_budget), `trace` (trace_id + steps), `sandbox_equivalent_tools`, компактный `next_step` CTA. Поддержать НЕ-happy пути: blocked category, amount over limit, approval required, unknown merchant. `idempotency_key`: опционален в guest (авто-генерится, виден как `demo_auto_...`), обязателен в sandbox.

**`generate_policy_template`** — не генерировать молча небезопасные политики: возвращать policy JSON + `validation` (risk_level, warnings, recommended_controls: approval_required_above, max_transaction_amount, blocked_categories). Жёсткий cap бюджета — НЕ для policy-template (только для simulate), но с warnings.

## P0 — security / trust
JSON Schema на каждый tool; currency enum; positive-amount; guest-cap (`<= $1000` эквивалент) + rate-limit (~5 RPM guest); структурированные ошибки (`{code, message, suggested_fix}`); trace_id в guest и sandbox; `idempotency_key` обязателен в sandbox purchase; `audit_log_id`/`audit_log_url` в sandbox-ответах; live-key hard block с PCI-объяснением.

## P1 — README / онбординг
Первый экран README: **«## 60-second demo, no API key required»** → `npx shatale-mcp-server` → IDE-сетап (Claude Code/Desktop/Cursor/Windsurf) → рекомендованный промпт → секция **«## Run the same flow in sandbox»** с `--env SHATALE_API_KEY=sh_test_xxx` и ключевой строкой «No code changes required. Add a sandbox key and re-run the same prompt.» → signup CTA `admin.shatale.com/register?ref=mcp`.
Tool-descriptions переписать под ясность для агента (плохо: «Simulates a purchase»; хорошо: «Simulates the Shatale agent payment lifecycle in guest mode: … No real API call or payment is made. Use this before registering for a sandbox key.»).

## P1 — конверсия guest→sandbox
В каждом guest-ответе компактный `next_step` CTA (label / register-url / «Free sandbox key, no card required. Add SHATALE_API_KEY and re-run the same prompt»). **CTA не больше самого результата.** Не лить «real Visa/Mastercard» формулировки — безопаснее «Run the same flow against Shatale Sandbox APIs».

## P1 — метрики воронки
`mcp_started_guest`, `tool_explain_called`, `tool_simulate_purchase_completed`, `signup_link_returned`, `sandbox_key_detected`, `sandbox_purchase_requested`, `sandbox_purchase_completed`.

## Несогласия / дополнения скептика (CTO)
- Sandbox должен РЕАЛЬНО enforce-ить policy в рантайме (отклонять превышение бюджета/категории), а не только симулировать — иначе «happy path ≠ trust».
- `audit_log_url` недостаточно — нужны экспортируемые логи (CSV/JSON, sandbox-only) для комплаенса.
- Guest CTA не должен раздувать ответ: один `demo_unlock_url` (или opt-in `?include_cta=true`) вместо тяжёлого `_meta`.

## Итог
- **v0.3.0: новых tools не добавлять**, если не критично. Усиливать `explain_shatale` / `simulate_purchase_flow` / `generate_policy_template`, аудируемость sandbox-ответов, README вокруг «60-sec demo → same flow in sandbox».
- TODO команде: реальный Mistral-review-pass (README, tool-descriptions, guest/sandbox-ответы, поведение в 4 IDE) — отдельно, т.к. в прогоне Mistral не участвовал.
