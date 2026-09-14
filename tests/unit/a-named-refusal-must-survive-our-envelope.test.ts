import { describe, it, expect, afterEach, vi } from 'vitest'
import { extractForwardedCode, forwardedRefusal, mapHttpError, ShataleApiError } from '../../src/errors.js'
import { ShataleClient } from '../../src/client.js'

// SHAT-3362. Наш клиент отображает ЛЮБОЙ 404 в собственный конверт «проверь id в пути» и
// выбрасывает тело непрочитанным. Это намеренно: деталь чужой ошибки не должна доходить до агента.
//
// 🔴 НО У API ЕСТЬ ОТКАЗЫ, НАПИСАННЫЕ ПО ИМЕНИ ИМЕННО ПОТОМУ, ЧТО ОБЩИЙ ОТВЕТ ВРЕДЕН. Песочная
// покупка не раскрывает PAN — и голое «не найдено» читается как сломанная интеграция и отправляет
// песочного интегратора повторять на ЖИВОМ ключе (SHAT-2373). Наш конверт уничтожал это
// предупреждение и советовал смотреть ровно туда, где всё было верно.
//
// Развязка — ЗАКРЫТЫЙ СЛОВАРЬ КОДОВ, а не расширение белого списка до свободного текста: код есть
// значение из согласованного списка, а не чужое предложение. Эти проверки утверждают ОБЕ половины
// договора — что согласованный код проходит, и что НЕСОГЛАСОВАННЫЙ не проходит.
describe('именованный отказ переживает наш конверт', () => {
  it('согласованный код доносится дословно, а не как «проверь id»', () => {
    const code = extractForwardedCode({ code: 'sandbox_no_pan', error: 'a sandbox purchase does not reveal a PAN' })
    expect(code).toBe('sandbox_no_pan')
    const named = forwardedRefusal(code!, 'req-1')
    expect(named).toBeDefined()
    expect(named!.code).toBe('sandbox_no_pan')
    expect(named!.suggested_fix).toMatch(/last4/)
    // ГЛАВНОЕ УТВЕРЖДЕНИЕ: предупреждение про живой ключ доходит. Ради него отказ и писался.
    expect(named!.suggested_fix).toMatch(/live key/i)
    expect(named!.request_id).toBe('req-1')
  })

  it('НЕСОГЛАСОВАННЫЙ код не проходит — иначе список перестал бы быть закрытым', () => {
    // Это вторая половина, и без неё первая ничего не стоит: если пропускается любой код, сервер
    // (или тот, кто им притворился) получает канал в сообщение агента.
    expect(extractForwardedCode({ code: 'not_found' })).toBeUndefined()
    expect(extractForwardedCode({ code: 'внезапно_новый_код' })).toBeUndefined()
    expect(forwardedRefusal('not_found')).toBeUndefined()
  })

  it('чужое тело не может подсунуть объект или роман вместо кода', () => {
    expect(extractForwardedCode({ code: { evil: true } })).toBeUndefined()
    expect(extractForwardedCode({ code: ['sandbox_no_pan'] })).toBeUndefined()
    expect(extractForwardedCode(null)).toBeUndefined()
    expect(extractForwardedCode('sandbox_no_pan')).toBeUndefined()
    // Прототипная ловушка: hasOwnProperty, а не `in`, иначе 'toString' прошёл бы как код.
    expect(extractForwardedCode({ code: 'toString' })).toBeUndefined()
    expect(extractForwardedCode({ code: 'constructor' })).toBeUndefined()
  })

  it('КОНТРОЛЬ: без согласованного кода 404 по-прежнему получает наш конверт', () => {
    // Без этого контроля предыдущие проверки не различали бы «починка работает» и «мы сломали
    // разбор всех остальных ошибок».
    const e = mapHttpError(404, 'GET', '/v1/purchases/x/card-credentials', undefined, { addressing: 'caller-id' })
    expect(e.code).toBe('not_found')
    expect(e.suggested_fix).toMatch(/id/i)
  })
})

// 🔴 И ОТДЕЛЬНО — ПРОВЕРКА ТОГО, ЧТО КЛИЕНТ СЛОВАРЁМ ПОЛЬЗУЕТСЯ.
//
// Без неё прибор доказывал бы, что словарь РАБОТАЕТ, и молчал бы о том, что его НИКТО НЕ ЗОВЁТ.
// Это измерено, а не предположено: мутант `if (false)` на ветке пересылки в client.ts ПЕРЕЖИЛ
// первые четыре проверки — все зелёные. Функция не есть её вызов, и разница видна только на
// настоящем пути запроса.
describe('клиент действительно зовёт словарь, а не только имеет его', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 404, headers: { 'content-type': 'application/json' } })))

  it('404 с согласованным кодом приезжает как ИМЕНОВАННЫЙ отказ', async () => {
    respond({ code: 'sandbox_no_pan', error: 'a sandbox purchase does not reveal a PAN', request_id: 'req-9' })
    const c = new ShataleClient('https://api.example.test', 'sk_sandbox_test')
    await expect(c.getCardCredentials('pur_x')).rejects.toMatchObject({
      code: 'sandbox_no_pan',
      request_id: 'req-9',
    })
    try {
      await c.getCardCredentials('pur_x')
    } catch (e) {
      expect(e).toBeInstanceOf(ShataleApiError)
      expect((e as ShataleApiError).suggested_fix).toMatch(/live key/i)
      expect((e as ShataleApiError).suggested_fix).not.toMatch(/Verify the id/i)
    }
  })

  it('КОНТРОЛЬ: 404 БЕЗ согласованного кода по-прежнему получает наш конверт', async () => {
    // Иначе предыдущая проверка не различала бы «пересылка работает» и «мы сломали все 404».
    respond({ code: 'not_found', error: 'nope' })
    const c = new ShataleClient('https://api.example.test', 'sk_sandbox_test')
    try {
      await c.getCardCredentials('pur_x')
      throw new Error('ожидался отказ')
    } catch (e) {
      expect((e as ShataleApiError).code).toBe('not_found')
    }
  })
})
