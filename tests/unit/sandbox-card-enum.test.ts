import { describe, it, expect } from 'vitest'
import { createSandboxTools, SANDBOX_TEST_CARDS } from '../../src/tools/sandbox.js'

// SHAT-2161. The tool DESCRIPTION said "exactly one of three" while the validator said
// z.string().min(12).max(19) — so any 12-19 digit string was accepted, including a real
// card number somebody pastes into a tool call.
//
// The API refuses it (SHAT-1557), and that is not the point. By the standard SHAT-1557
// was closed on — PCI scope is what a process CAN receive, not what it does afterwards —
// the client half was still open: the digits pass through the tool call, this process's
// memory and the wire before anybody says no.
//
// What makes it worse than an ordinary validation gap is where the sloppiness sat. The
// description was already correct. Somebody tightened the words and left the validator,
// so the only thing between a real PAN and this process was a sentence a human reads.
//
// These tests drive the REAL handler with a client that records whether it was called,
// because the claim being made is not "the schema rejects it" but "the digits never
// reach the wire". A test against a copy of the schema could not tell those apart.

/** A client that refuses to be called, and remembers if it was. */
function recordingClient() {
  const calls: unknown[] = []
  return {
    calls,
    client: {
      sandboxSimulateAuthorization: async (args: unknown) => {
        calls.push(args)
        return { decision: 'approved' }
      },
    } as never,
  }
}

function validCall(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'agt_1',
    amount: 1000,
    currency: 'EUR',
    // A number, which is what this schema takes on main. Passing the string form was
    // my own fixture error, and it failed for that reason rather than the card.
    mcc: 5734,
    merchant_name: 'Test Merchant',
    card_number: SANDBOX_TEST_CARDS[0],
    ...overrides,
  }
}

describe('the sandbox card is an enum, not a length range', () => {
  it('names exactly the three cards and nothing else', () => {
    // The enum IS the control. A fourth value makes the description untrue; an empty
    // list makes the schema accept nothing and the tool dead. Both are worth failing on.
    expect([...SANDBOX_TEST_CARDS]).toEqual([
      '4242424242424242',
      '4000000000000002',
      '4111111111111111',
    ])
  })

  it('never sends a realistic PAN that the old range accepted', async () => {
    const { client, calls } = recordingClient()
    const mod = createSandboxTools(client)

    // Sixteen digits, and it satisfied min(12).max(19). Deliberately a test-card-shaped
    // number rather than anything real — a real PAN must never appear in a fixture,
    // which is the same rule the production refusal has to hold.
    const res = await mod.handlers.sandbox_simulate_authorization(
      validCall({ card_number: '4111111111111112' }),
    )

    // The assertion that matters is the SECOND one. An error result proves the schema
    // objected; zero calls proves the digits never left this process.
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('never sends a 19-digit string, the old upper bound', async () => {
    const { client, calls } = recordingClient()
    const mod = createSandboxTools(client)
    const res = await mod.handlers.sandbox_simulate_authorization(
      validCall({ card_number: '4111111111111111111' }),
    )
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('still sends each of the three', async () => {
    for (const card of SANDBOX_TEST_CARDS) {
      const { client, calls } = recordingClient()
      const mod = createSandboxTools(client)
      const res = await mod.handlers.sandbox_simulate_authorization(validCall({ card_number: card }))

      // Per-card, not in aggregate: an enum with one working member and two typos would
      // pass a "some card works" assertion.
      expect(res.isError, `${card} must be accepted`).toBeFalsy()
      expect(calls, `${card} must reach the client`).toHaveLength(1)
    }
  })

  it('advertises the enum in the JSON schema the host validates against', () => {
    // This is the half that stops the digits being typed AT ALL. Zod refuses after the
    // call arrives; the JSON schema is what the model and host see first, and it is
    // where the old version said only type: 'string'.
    const { client } = recordingClient()
    const authorize = createSandboxTools(client).tools.find(
      (t) => t.name === 'sandbox_simulate_authorization',
    )
    expect(authorize, 'the authorization tool must exist, or this test measures nothing').toBeDefined()

    const prop = (authorize!.inputSchema.properties as Record<string, any>).card_number
    expect(prop.enum).toEqual([...SANDBOX_TEST_CARDS])

    // The description must keep explaining what each card DOES, because a host that
    // ignores enum still shows the description to the model.
    //
    // Deliberately not asserting the full numbers appear: this description abbreviates
    // them (4242…, 4000…0002, 4111…) so that no complete card number sits in the tool
    // surface at all. That is the better choice and my first version of this test would
    // have pushed it the wrong way.
    // Matched on the WORDS, not on a phrasing. The description is worded differently on
    // main ("4242… → force approve") and on the open publish-gate branch ("4242…
    // forces approve, … lets the real policy decide"), and my first version asserted
    // main's exact phrasing — so it failed on the other branch for a reason that had
    // nothing to do with card safety. A guard that breaks on a reworded sentence gets
    // deleted rather than fixed.
    for (const meaning of ['approve', 'decline', 'policy']) {
      expect(prop.description.toLowerCase()).toContain(meaning)
    }
  })
})

// The rejection must not print what it rejected.
//
// Found in review, after the enum was already written: zod 3.24's default enum error is
// "Invalid enum value. Expected '4242…' | …, received '4929123456789012'", and the
// handler interpolates i.message into the tool result. So the first version of this fix
// did not remove the leak, it MOVED it — a pasted card stopped going to the API and
// started going into the model's context, the conversation transcript, and anything that
// logs tool results. By this ticket's own standard (PCI scope is what a process CAN
// receive) the transcript is the worse of the two: more durable, and harder to find later.
//
// It also printed all three test cards in full, undoing the deliberate choice in the
// tool description to abbreviate them.
describe('the rejection does not echo what it rejected', () => {
  const pasted = '4929123456789012' // card-shaped, not a real card, never a fixture value

  it('keeps the rejected number out of the tool result', async () => {
    const { client, calls } = recordingClient()
    const res = await createSandboxTools(client).handlers.sandbox_simulate_authorization(
      validCall({ card_number: pasted }),
    )

    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
    // The assertion this test exists for.
    expect(JSON.stringify(res.content)).not.toContain(pasted)
  })

  it('still says something a caller can act on', async () => {
    const { client } = recordingClient()
    const res = await createSandboxTools(client).handlers.sandbox_simulate_authorization(
      validCall({ card_number: pasted }),
    )
    const text = JSON.stringify(res.content).toLowerCase()
    // Names the field and what to do. "Invalid input" alone would satisfy the no-echo
    // assertion above while telling the caller nothing.
    expect(text).toContain('card_number')
    expect(text).toContain('sandbox test card')
  })

  it('prints no long digit run at all, whatever the validator said', async () => {
    // The belt on top of the braces. A field added later whose validator quotes its input
    // — a regex, a literal, a refine — would reintroduce the leak silently, and nothing
    // about the field name would make anyone think of PCI.
    const { client } = recordingClient()
    const res = await createSandboxTools(client).handlers.sandbox_simulate_authorization(
      validCall({ card_number: pasted }),
    )
    expect(JSON.stringify(res.content)).not.toMatch(/\d[\d\s-]{10,}\d/)
  })
})
