import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MockUpstream } from '../harness/mockUpstream.js'
import { ShataleClient } from '../../src/client.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'
import type { ToolModule } from '../../src/types.js'

/**
 * /!\ SECURITY.md CLAIMED THESE INPUTS WERE VALIDATED BEFORE ANY API CALL. FOR IDs THEY WERE NOT.
 *
 * "Sensitive tool inputs (purchases, onboarding, credentials, sandbox) are validated (zod) before
 * any API call" was true of the five handlers that take a BODY and of NONE of the handlers that
 * take an ID. Those did `String(args.purchase_id)` and interpolated the result straight into a path.
 * `String(undefined)` is the four-character string "undefined". `String(args.x ?? '')` is empty.
 *
 * Measured by calling each tool with `{}` and recording what reached the upstream:
 *
 *     POST   /v1/sandbox/users/undefined/onboarding
 *     POST   /v1/sandbox/purchases//approve        <- an EMPTY path segment, on a WRITE route
 *     GET    /v1/purchases/undefined
 *     GET    /v1/credentials/undefined
 *     DELETE /v1/purchases/undefined
 *
 * /!\ THE HARM IS NOT THAT A 404 IS UGLY.
 *
 *   1. The empty segment collapses `/v1/sandbox/purchases/{id}/approve` into a DIFFERENT ROUTE.
 *      What that resolves to is the backend router's business, and guessing is exactly what a
 *      boundary exists to avoid. A malformed write must not become a well-formed request for
 *      something else.
 *   2. The model receives a backend error for a mistake made HERE, one hop from the cause. A caller
 *      that omitted an argument is told "purchase not found", reasonably concludes the purchase does
 *      not exist, and then retries, invents an id, or tells the person something untrue.
 *
 * /!\ AND THE ASSERTION IS "THE UPSTREAM SAW NOTHING", not "the tool returned an error". Those are
 * different claims and only one of them is the point. A handler that sends the request and then
 * reports the failure would satisfy an error-shaped assertion perfectly while the malformed write
 * had already left the process.
 */

let upstream: MockUpstream
let modules: Record<string, ToolModule>

beforeAll(async () => {
  upstream = await MockUpstream.start()
  const client = new ShataleClient(upstream.url, 'sk_sandbox_test')
  modules = {
    purchase: createPurchaseTools(client, { isSandbox: false }),
    reveal: createRevealTools(client),
    credentials: createCredentialTools(client, { emailsEnabled: true }),
    onboarding: createOnboardingTools(client, { enabled: true }),
    catalog: createCatalogTools(client),
    sandbox: createSandboxTools(client),
  }
})

afterAll(async () => {
  await upstream.close()
})

function handlerFor(name: string) {
  for (const mod of Object.values(modules)) {
    const h = mod.handlers[name]
    if (h) return h
  }
  throw new Error(
    `no handler named ${name} — the tool was renamed or its module stopped registering it, and this ` +
      `guard is now watching nothing. Point it at the new name rather than deleting the case.`,
  )
}

/** Every tool whose id becomes a URL PATH SEGMENT, and the argument it must refuse to do without. */
const idTools: Array<{ tool: string; missing: string }> = [
  { tool: 'get_purchase_status', missing: 'purchase_id' },
  // ⚠️ ADDED WITH THE TOOL (SHAT-2802). This list is hand-written, so a new id-taking tool is
  // absent from it by default and the suite stays green — the absence is indistinguishable from
  // coverage, which is the failure this file's own header describes.
  { tool: 'await_purchase_approval', missing: 'purchase_id' },
  { tool: 'cancel_purchase', missing: 'purchase_id' },
  { tool: 'get_credential_status', missing: 'credential_request_id' },
  { tool: 'get_credential_emails', missing: 'credential_request_id' },
  { tool: 'get_onboarding_status', missing: 'session_id' },
  { tool: 'get_merchant_details', missing: 'merchant_id' },
  // ⚠️ ADDED WITH THE TOOL (SHAT-3023), and the comment above says why it has to be: reveal_card
  // shipped with a bare `.min(1)` and sent GET /v1/purchases/%20%20%20/card-credentials. This file
  // was already asserting that no id-taking tool does that, and it was TRUE only of the tools
  // somebody remembered to list.
  { tool: 'reveal_card', missing: 'purchase_id' },
  { tool: 'sandbox_approve_purchase', missing: 'purchase_id or request_id' },
  { tool: 'sandbox_complete_onboarding', missing: 'user_id' },
]

describe('an id that is missing or empty never leaves the process (SHAT-2526)', () => {
  // /!\ POSITIVE CONTROL, FIRST AND ON THE MECHANISM THAT MATTERS. Every case below asserts that the
  // upstream recorded NOTHING — which is also what a broken harness, a server that never started, or
  // a client pointed elsewhere would produce. This proves the recorder records.
  it('the upstream records a request that IS well formed', async () => {
    const before = upstream.requests.length
    await handlerFor('get_purchase_status')({ purchase_id: 'pur_real_1' })
    expect(
      upstream.requests.length,
      'a well-formed call recorded nothing. The mock upstream is not seeing traffic, so "the upstream ' +
        'saw nothing" below would be true no matter what the handlers did.',
    ).toBe(before + 1)
    expect(upstream.lastRequest('GET', '/v1/purchases/')?.path).toBe('/v1/purchases/pur_real_1')
  })

  for (const { tool, missing } of idTools) {
    for (const [label, args] of [
      ['no arguments at all', {}],
      ['an empty string', { purchase_id: '', request_id: '', credential_request_id: '', session_id: '', merchant_id: '', user_id: '' }],
      ['whitespace only', { purchase_id: '   ', request_id: '   ', credential_request_id: '   ', session_id: '   ', merchant_id: '   ', user_id: '   ' }],
    ] as const) {
      it(`${tool} with ${label} sends nothing and says why`, async () => {
        const before = upstream.requests.length
        const result = await handlerFor(tool)(args as Record<string, unknown>)

        const sent = upstream.requests.slice(before)
        expect(
          sent.map((r) => `${r.method} ${r.path}`),
          `${tool} reached the upstream without a usable ${missing}. The id is interpolated into a ` +
            `URL PATH, so a missing one becomes the literal "undefined" and an empty one collapses ` +
            `the path — on sandbox_approve_purchase that is an empty segment on a WRITE route, which ` +
            `is a malformed write turning into a well-formed request for something else. Validate ` +
            `before the call: src/validate.ts requireId / requireFirstId.`,
        ).toEqual([])

        // /!\ AND IT MUST SAY SO AS AN ERROR. Refusing silently and returning a normal-looking result
        // would be worse than the bug: the model would read "no data" as an answer about the record
        // rather than about its own arguments.
        expect(result.isError, `${tool} refused but did not mark the result as an error`).toBe(true)
        const text = JSON.stringify(result.content)
        expect(
          text,
          `${tool}'s refusal does not name the missing argument. The caller has to learn that the ` +
            `mistake is in ITS arguments and not in the record it asked about — that confusion is ` +
            `exactly what sending "undefined" upstream produced, one hop later and in someone ` +
            `else's words.`,
        ).toContain(missing.split(' or ')[0])
      })
    }
  }
})

/**
 * /!\ THE SAME REFUSAL, ON AN ID THAT IS NOT A PATH SEGMENT — AND THAT IS WHY IT NEEDED ITS OWN
 * TEST RATHER THAN A ROW IN THE TABLE ABOVE.
 *
 * `sandbox_create_user` (SHAT-2698) takes TWO ids and puts both in the BODY:
 * `POST /v1/sandbox/users {user_id, agent_id, onboarded, currency}`. So none of the path-collapse
 * reasoning applies — nothing becomes the literal "undefined" in a URL, and no route turns into a
 * different route. It reaches the upstream as a perfectly well-formed request.
 *
 * /!\ WHICH MAKES THE CONSEQUENCE WORSE HERE, NOT BETTER, BECAUSE THIS ROUTE WRITES. The call
 * provisions a user, a publisher link, a profile AND an active delegation in one shot. `agent_id`
 * is what the delegation is FOR. A create that reaches the backend without it does not fail
 * cleanly and leave nothing behind — it is the one shape that produces a user who exists, looks
 * onboarded, and cannot buy: `request_purchase` finds them and answers `delegation_unavailable`,
 * a sentence about delegations that reads like a server problem two tools and one hop away from
 * the argument that was actually missing. The handler's own comment says exactly this; until now
 * nothing held it to it.
 *
 * /!\ AND THE ORDER OF THE CHECKS IS LOAD-BEARING, SO EVERY CASE BELOW SUPPLIES A VALID user_id.
 * The handler validates `user_id` first and returns on its failure, so calling with `{}` would be
 * answered by the user_id branch and would prove nothing at all about agent_id — it would pass
 * just as well if the agent_id check were deleted outright. This was measured with a throwaway
 * probe during review and then thrown away with it; a defect a temporary test found is a defect
 * nothing is watching.
 */
describe('sandbox_create_user refuses a missing agent_id before the write (SHAT-2698)', () => {
  it('positive control: with BOTH ids the create does reach the upstream', async () => {
    // Without this, "the upstream saw nothing" below is also what a tool that stopped existing,
    // or a recorder that stopped recording, would produce.
    const before = upstream.requests.length
    await handlerFor('sandbox_create_user')({ user_id: 'usr_ctl_1', agent_id: 'agt_ctl_1' })

    const sent = upstream.requests.slice(before)
    expect(
      sent.map((r) => `${r.method} ${r.path}`),
      'a complete sandbox_create_user call recorded nothing upstream, so the absence assertions ' +
        'below are green for free.',
    ).toEqual(['POST /v1/sandbox/users'])
    // And the id really does travel in the body — which is the premise of this whole block.
    expect((sent[0].body as Record<string, unknown>).agent_id).toBe('agt_ctl_1')
  })

  for (const [label, agentArg] of [
    ['absent', {}],
    ['an empty string', { agent_id: '' }],
    ['whitespace only', { agent_id: '   ' }],
    ['not a string', { agent_id: 12345 }],
  ] as const) {
    it(`with agent_id ${label}: nothing is written, and the refusal names agent_id`, async () => {
      const before = upstream.requests.length
      const result = await handlerFor('sandbox_create_user')({
        user_id: 'usr_probe_1',
        ...(agentArg as Record<string, unknown>),
      })

      expect(
        upstream.requests.slice(before).map((r) => `${r.method} ${r.path}`),
        'a user was provisioned without the delegation that lets it buy. This is a WRITE: the row ' +
          'survives the failed call, and the next thing the agent does (request_purchase) answers ' +
          'delegation_unavailable — a server-shaped sentence for a missing argument. Validate ' +
          'before the call: src/validate.ts requireId.',
      ).toEqual([])

      expect(result.isError, 'the refusal was not marked as an error').toBe(true)

      const text = JSON.stringify(result.content)
      expect(
        text,
        'the refusal does not name agent_id, so a caller who supplied user_id correctly cannot ' +
          'tell which of the two ids it got wrong.',
      ).toContain('agent_id')
      // /!\ AND IT MUST NOT BE ANSWERED BY THE user_id BRANCH. If that check ever moved after this
      // one, or this one were dropped, a valid user_id plus no agent_id would sail through — and a
      // test asserting only "isError" would still be green.
      expect(
        text,
        'the refusal blames user_id, which was supplied and is valid — the wrong branch answered.',
      ).not.toContain('user_id')
    })
  }
})
