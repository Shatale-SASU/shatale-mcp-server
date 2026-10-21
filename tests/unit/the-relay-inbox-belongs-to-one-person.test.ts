import { describe, test, expect, vi } from 'vitest'
import { ShataleClient } from '../../src/client.js'
import { createCredentialTools } from '../../src/tools/credentials.js'

// SHAT-6689 — THE RELAY INBOX BELONGS TO ONE PERSON, AND THE READ MUST NAME THEM.
//
// Before this change `get_credential_emails` took only the credential id, so a publisher's API key
// read the verification mail of ANY person of that publisher: codes and confirmation links addressed
// to somebody else. The API gained `?publisher_user_id=` (credentials.go ListEmails, read by
// personScopeOfRequest); this server now sends it, and the flag
// CREDENTIAL_EMAILS_REQUIRE_PERSON_SCOPE can be turned on without blinding the agent.
//
// 🔴 EVERY ASSERTION HERE IS ABOUT THE WIRE, NOT ABOUT A HELPER. A test that called requirePersonId
// directly would stay green if the handler stopped calling it — measured on #111 that same morning:
// a mutant swapping the reader left 399 of 399 tests passing. What is spent is the URL.
describe('get_credential_emails names the person', () => {
  const client = () => new ShataleClient('https://api.example.test', 'sk_sandbox_abc')

  test('the person id reaches the API as sent — untrimmed, once', async () => {
    const seen: string[] = []
    const fn = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ emails: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fn)
    try {
      await createCredentialTools(client()).handlers.get_credential_emails({
        credential_request_id: 'cred_6689',
        publisher_user_id: '  u1  ',
      } as Record<string, unknown>)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen.length, 'the tool made no request at all').toBeGreaterThan(0)
    const url = seen.join('\n')
    expect(url).toContain('/v1/credentials/cred_6689/emails')
    // Spaces survive: the API decides what blank means, and trimming here would answer that
    // question differently from a caller talking to the API directly.
    expect(url).toContain(encodeURIComponent('  u1  '))
    // Sent ONCE: the API refuses the parameter repeated with different values (400).
    expect(url.match(/publisher_user_id=/g) ?? []).toHaveLength(1)
  })

  test('a missing person id is refused HERE — no request leaves the process', async () => {
    const fn = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fn)
    let out: unknown
    try {
      out = await createCredentialTools(client()).handlers.get_credential_emails({
        credential_request_id: 'cred_6689',
      } as Record<string, unknown>)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fn, 'a nameless read must not reach the API').not.toHaveBeenCalled()
    expect(JSON.stringify(out)).toContain('publisher_user_id')
  })

  test('a blank person id is refused too — blank means absent to the API', async () => {
    const fn = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fn)
    try {
      await createCredentialTools(client()).handlers.get_credential_emails({
        credential_request_id: 'cred_6689',
        publisher_user_id: '   ',
      } as Record<string, unknown>)
    } finally {
      vi.unstubAllGlobals()
    }
    // '   ' is blank to the API, so sending it would be a read naming nobody — refused before the
    // round trip rather than after it.
    expect(fn, 'a blank name must not reach the API either').not.toHaveBeenCalled()
  })

  test('the tool DECLARES the field required — a schema that omits it invites the old call', async () => {
    const mod = createCredentialTools(client())
    const tool = mod.tools.find((t) => t.name === 'get_credential_emails')
    expect(tool, 'get_credential_emails is not listed').toBeDefined()
    const schema = tool!.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toContain('publisher_user_id')
    expect(schema.required).toContain('publisher_user_id')
  })
})
