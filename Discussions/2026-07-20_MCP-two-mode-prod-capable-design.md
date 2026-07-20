# MCP «привести в порядок»: два честных режима demo/live + prod-capable без PCI-взрыва

**Дата:** 2026-07-20 · **Автор:** Albus (архитектура, с Fable) · **Ревью:** консилиум (B+D консенсус) + Fable · **Бэкенд-исполнение:** Odin
**Статус:** design → нужен Odin по бэкенд-частям + money-GO Сергея на любой live-прогон

## Проблема (почему это не просто тест)

`shatale-mcp-server` — **продукт**, а не тест-харнесс. Его ценность: агент делает РЕАЛЬНЫЕ покупки.
Сейчас у него де-факто три режима (guest / sandbox / «production»), из которых **«production» структурно недостижим**:
бэкенд выдаёт боевые ключи с префиксом `sk_live_`, а MCP (`src/index.ts:28`) на `sk_live_`/`sh_live_` делает `process.exit(1)`.
То есть normal-режим существует в названии, но не работает → мы протестировали бы кусок money-flow, а не весь процесс.

Цель Сергея: **demo-режим = sandbox, normal-режим = prod, и normal должен реально работать.**

## Жёсткое ограничение (PCI, найдено Fable, подтверждено по коду)

`purchaseToJSON` (`apps/api/api/v1/purchases.go:178`) при выпущенной карте встраивает в ответ create_purchase
`payment.card.number` (полный PAN) + `cvv`. MCP `src/tools/purchase.ts:~156` возвращает это `jsonResult(result)` **без маскировки**
→ сырой PAN+CVV попадает в **контекст LLM, логи MCP-хоста, историю чата пользователя** = расширение PCI CDE на неконтролируемые машины.

Карта single-use + merchant-locked + amount-limit (blast radius ограничен), но сырой PAN в reasoning-контексте недопустим as-is.

**Вывод:** normal-режим MCP может ходить в прод — но НЕ имеет права протаскивать сырой PAN через рассуждающий контекст агента.
Значит «привести в порядок» = не просто снять guard, а перестроить путь карты.

## Target state

### 1. Честные два режима (убрать мёртвый «production»)

| Режим | Ключ | Тулзы | API |
|---|---|---|---|
| `guest` | нет | симуляция (7) | нет вызовов |
| `demo` (=sandbox) | `sk_sandbox_`/`sk_test_` | +onboarding +purchase +credentials +sandbox | api.shatale.com (sandbox-scope) |
| `live` (=normal/prod) | `sk_live_` + **явный интент** | +onboarding +purchase +credentials | api.shatale.com (live) |

- Удалить недостижимый `production` режим (`index.ts:42-43,293`) и вводящее в заблуждение описание «switch to a live key» в `purchase.ts:141`.
- `sk_live_` **разрешить**, но только при явном интенте оператора: `SHATALE_MODE=live` (или флаг `--live`). Голый `sk_live_` без интента → по-прежнему fail-fast (защита от fat-finger в demo-контексте). Это заменяет тупой `process.exit` на осознанный гейт.
- Публичная npm-сборка по умолчанию НЕ имеет live-интента → внешние пользователи остаются на demo. Live-интент — это конфиг НАШЕГО деплоя/раннера, не форк пакета (консенсус: не плодить артефакты, но и не прятать capability за скрытым env в публичном пакете — интент явный и логируется).

### 2. Путь карты в live (разрешение PCI) — ГЛАВНОЕ, бэкенд-часть Odin

**create_purchase НЕ должен возвращать сырой PAN.** Ответ payment_ready = карта-хэндл + констрейнты + last4, без `number`/`cvv`.
Сырой PAN — только через **отдельный deliberate reveal** (`GET /v1/purchases/{id}/card-credentials`, #321: no-store, аудит по last4).

MCP-сторона:
- `request_purchase` тул возвращает статус + last4 + констрейнты (merchant_locked/amount/single_use/expires) — БЕЗ PAN.
- Отдельный `reveal_card` тул: вывод помечен sensitive, НЕ логируется ни на одном sink, и (цель) отдаётся checkout-executor'у, а не в reasoning-транскрипт. Для supervised-донора это уже так (Playwright fill в памяти).

Бэкенд-аск Odin:
- **B-1:** `purchaseToJSON` не встраивает `number`/`cvv`; отдаёт `card_ref`/`last4`/констрейнты. Сырой PAN живёт только за reveal-эндпоинтом. (Иначе любой клиент create_purchase получает PAN, что и ломает PCI-границу.)

### 3. Разные гейты: онбординг (без денег) vs покупка (деньги)

- **onboarding-GO** (`SHATALE_ONBOARDING_GO`): открывает register/onboarding-тулзы. Денег не двигает, PAN не трогает.
- **money-GO** (код Сергея): открывает purchase/reveal money-путь. Проверка — при регистрации money-тулзов, не в хендлере.
- Онбординг-страница (`app.shatale.com/onboarding/<id>`) уже боевая и достижима даже sandbox-ключом (register не SandboxOnly — это **SHAT-1683**, чинить).

### 4. Фиксы-баги (тикеты заведены 2026-07-20)

- **SHAT-1682** — идемпотентность: `client.ts:27` генерит `randomUUID()` на каждый вызов → ретрай = двойная покупка. Стабильный ключ на логическую покупку.
- **SHAT-1683** — `/v1/onboarding/register` не SandboxOnly → публичный спам/фишинг верификационными письмами. Rate-limit + scope.
- **SHAT-1684** — нет серверного гейта sandbox-ключей на `/v1/purchases` (только клиентский guard SHAT-1488, обходится curl). LiveOnly на money-эндпоинтах.
- **SHAT-1685** — `credentials.ts` не шлёт `idempotency_key` (бэкенд требует) → всегда 400.
- **NEW (B-1 выше)** — purchaseToJSON не должен встраивать сырой PAN. Завести отдельным тикетом на бэкенд.

## Что можно сделать СЕЙЧАС (не дожидаясь бэкенда), для прогона €2.50

Fable + консилиум: боевую **регистрацию** MCP уже может показать на sandbox-ключе (страница боевая).
Боевые **деньги** до фикса B-1 безопаснее гнать прямым `/v1` клиентом донора (`shatale-donor-agent/src/shatale.ts` — идемпотентность уже стабильная, PAN в памяти харнесса, не в LLM).
Т.е. прогон €2.50 не блокируется редизайном MCP; редизайн MCP — это продуктовая доводка normal-режима, параллельный трек.

## Открытый вопрос к Odin (бэкенд-владелец ключей/auth/ответов)

1. B-1: согласен убрать сырой PAN из purchaseToJSON, оставив его только за reveal-эндпоинтом? Есть ли клиенты, завязанные на `payment.card.number` в ответе create?
2. Live-money-эндпоинты: делаем инверсный SandboxOnly (LiveOnly → sandbox-ключ = 403 на /v1/purchases)? — SHAT-1684.
3. Онбординг-scope: отдельный scope/rate-limit на register вместо «публичный, но не должны дёргать»? — SHAT-1683.
