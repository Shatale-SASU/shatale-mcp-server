import { describe, test, expect } from 'vitest'
import { ShataleApiError, mapHttpError, errorResult, UNKNOWN_CAUSE, TIMED_OUT } from '../../src/errors.js'

describe('SHAT-1463 structured errors: mapHttpError', () => {
  test('401/403 → auth_failed', () => {
    for (const s of [401, 403]) {
      const e = mapHttpError(s, 'POST', '/v1/purchases')
      expect(e).toBeInstanceOf(ShataleApiError)
      expect(e.code).toBe('auth_failed')
      expect(e.suggested_fix).toContain('sk_sandbox_')
    }
  })

  test('404 → not_found, echoes method+path (no body)', () => {
    const e = mapHttpError(404, 'GET', '/v1/purchases/abc')
    expect(e.code).toBe('not_found')
    expect(e.message).toContain('GET /v1/purchases/abc')
  })

  test('429 → rate_limited', () => {
    expect(mapHttpError(429, 'GET', '/x').code).toBe('rate_limited')
  })

  test('5xx → upstream_error (generic, no leak)', () => {
    const e = mapHttpError(503, 'GET', '/x')
    expect(e.code).toBe('upstream_error')
    expect(e.message).toContain('503')
  })

  test('other 4xx → api_error', () => {
    expect(mapHttpError(422, 'POST', '/x').code).toBe('api_error')
  })
})

describe('SHAT-1463 structured errors: errorResult', () => {
  test('ShataleApiError passes through its structured shape, isError=true', () => {
    const res = errorResult(mapHttpError(404, 'GET', '/v1/purchases/x'), {
      code: 'fallback',
      message: 'fb',
      suggested_fix: 'fb',
    })
    expect(res.isError).toBe(true)
    const parsed = JSON.parse(res.content[0].text)
    expect(parsed.error.code).toBe('not_found')
    expect(parsed.error).toHaveProperty('message')
    expect(parsed.error).toHaveProperty('suggested_fix')
  })

  // The second argument is now a CODE, not a whole error: an unknown cause may not carry a
  // diagnosis, and the caller no longer gets to write one. The leak guarantee this
  // test was written for is unchanged and still the point.
  test('unknown error → neutral text, never leaks raw message', () => {
    const raw = new Error('pq: relation "users" does not exist at /Users/secret/path')
    const res = errorResult(raw, 'purchase_failed')
    expect(res.isError).toBe(true)
    const text = res.content[0].text
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain('relation')
    const parsed = JSON.parse(text)
    expect(parsed.error.code).toBe('purchase_failed')
    expect(parsed.error.message).toBe(UNKNOWN_CAUSE.message)
  })

  test('a timeout is the one non-answer we can name, and says so differently', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const parsed = JSON.parse(errorResult(aborted, 'purchase_failed').content[0].text)
    expect(parsed.error.message).toBe(TIMED_OUT.message)
    expect(parsed.error.message).not.toBe(UNKNOWN_CAUSE.message)
  })
})
