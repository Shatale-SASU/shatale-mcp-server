/**
 * SHAT-2678 follow-up — what the server SAYS about cards must match what it DOES.
 *
 * ⚠️ THIS IS THE DIRECTION NO GUARD CATCHES, WHICH IS WHY IT NEEDS ONE. Every check in this repo
 * is built to catch a promise that claims MORE than the code delivers. A promise that claims more
 * PROTECTION than the code delivers reddens nowhere: the tests pass, the redactor works exactly as
 * designed, and only the sentence is wrong.
 *
 * Measured before this test existed: `explain_shatale` told the agent "Raw card credentials
 * (PAN/CVV) are NEVER returned into this reasoning context, even in LIVE mode" while
 * `sandbox_approve_purchase` — advertised in the same session, in the same mode — returned a full
 * number and cvv. The disclosure is DELIBERATE (SHAT-2610, and the owner's decision recorded in
 * SECURITY.md): the card we mint for a purchase is handed to the agent because the agent has to pay
 * with it, and the person's own card is never returned on any path. The code was right. The copy
 * was left behind when the redactor was narrowed.
 *
 * And a false promise of safety is worse than the disclosure it hides, because it is ACTED ON: an
 * agent told that nothing sensitive can arrive will quote the result into a summary and a log.
 *
 * So the assertions below are DERIVED FROM THE CODE — the allowlist itself — rather than restating
 * the sentence in a second place. Two texts maintained separately is how this happened.
 */

import { describe, test, expect } from 'vitest'
import { OUR_CARD_PATHS, redactPurchaseCard } from '../../src/redact.js'
import { createGuestTools } from '../../src/tools/guest.js'

const CARD_BODY = { purchase_id: 'pur_1', card: { number: '4242424242424242', cvv: '123' } }

async function explainText(): Promise<string> {
  const mod = createGuestTools({
    isGuest: false,
    isSandbox: false,
    isLive: true,
    moneyEnabled: true,
    getToolNames: () => ['request_purchase'],
  } as never)
  const res = (await mod.handlers.explain_shatale({})) as { content: Array<{ text: string }> }
  return res.content[0].text
}

describe('the card promise is not wider than the code', () => {
  // The premise, executed. If this ever fails the copy below must change WITH it — which is the
  // whole point of deriving from the list instead of describing it twice.
  test('the allowlist really does let a card through, and only there', () => {
    expect(OUR_CARD_PATHS.length).toBeGreaterThan(0)

    for (const re of OUR_CARD_PATHS) {
      const path = re.source.replace(/\\\//g, '/').replace(/\[\^\/\]\+/g, 'x').replace(/[\^$]/g, '')
      const out = redactPurchaseCard(structuredClone(CARD_BODY), path) as typeof CARD_BODY
      expect(out.card.number, `${path} should return our card intact`).toBe('4242424242424242')
    }

    const scrubbed = redactPurchaseCard(structuredClone(CARD_BODY), '/v1/purchases/pur_1') as {
      card: Record<string, unknown>
    }
    expect(scrubbed.card.number, 'a path off the list must not reveal a card').toBeUndefined()
    expect(scrubbed.card.last4).toBe('4242')
  })

  // ⚠️ THE PREDICATE IS SCOPED, AND THE FIRST VERSION WAS NOT — IT REDDENED ON THE TRUE SENTENCE.
  // "The person's own card is never returned" contains "never" and "returned" and is exactly what
  // the copy is REQUIRED to say. What must not appear is an UNSCOPED never-claim: one that speaks
  // about card credentials in general, the way the measured text did. So every never-sentence has
  // to name whose card it is about.
  test('every "never returned" claim names WHOSE card, because one of the two IS returned', async () => {
    const text = await explainText()
    const sentences = text.split(/(?<=[.!?])\s+|\n/).filter((s) => /\bnever\b/i.test(s) && /return/i.test(s))

    // A control on the search itself: if no sentence matches, this test is asserting nothing and
    // the copy has quietly lost the promise it is supposed to make.
    expect(sentences.length, 'the copy makes no never-returned claim at all — see the next test').toBeGreaterThan(0)

    for (const sentence of sentences) {
      expect(
        /person'?s|customer'?s|their own|funding instrument/i.test(sentence),
        `an unscoped promise that cards are never returned, while the allowlist reveals ours:\n${sentence}`,
      ).toBe(true)
    }
  })

  test('and it states BOTH halves — ours is returned, the person\'s never is', async () => {
    const text = await explainText()
    // Under-claiming is invisible to every other check, so the copy is required to say the
    // uncomfortable half out loud, not merely to avoid the false one.
    expect(text, 'the copy must say our issued card IS returned').toMatch(/we issue[^.]{0,60}returned|card (shatale )?issues[^.]{0,60}returned/i)
    expect(text, "the copy must say the person's own card never is").toMatch(/person'?s own card is never returned/i)
    // SHAT-8370: the card's property is stated, its window is not. The copy names the one guarantee that
    // holds on every path — the person is never charged more than the approved amount — and says that card
    // lifetimes are not disclosed. It must not describe when or where the returned details can still be
    // spent: that told a reader of a public repository (and the model itself) how to misuse a leaked card.
    expect(text, 'the copy must state the property').toContain('Each card is issued against one approved purchase amount, and for that purchase the person is never charged more than that amount.')
    expect(text, 'the copy must say lifetimes are not disclosed').toContain('Card lifetimes and internal card handling are not disclosed.')
    expect(text, 'the copy must not describe the window').not.toMatch(/until we deactivate|stays live after|any merchant until/i)
  })
})

// SHAT-8370, second hand (Buklya) on #131: the exact old sentence was refused, a PARAPHRASE was not — «The details
// remain usable at other shops until the card is switched off.» passed, and SECURITY.md was not read at all. The
// refusal is by CLASS now, over BOTH public texts: anything that says how long, until when, or where else the
// returned card details can still be spent. The property is stated (above); its window is not.
const WINDOW_CLASS = new RegExp(
  [
    String.raw`until\b[^.]{0,40}\b(deactivat|switch(ed)? off|turn(ed)? off|disabl|expir|lock|quarantin|cancel)`,
    String.raw`\b(remain|remains|stay|stays|is|are|keeps?)\s+(still\s+)?(usable|live|valid|active|spendable)\b`,
    String.raw`\b(at|in|with)\s+(other|another|any|different)\s+(shop|store|merchant|retailer|seller)s?\b`,
    String.raw`\b(after|past|beyond)\s+the\s+(checkout|purchase)\b[^.]{0,40}\b(spend|use|usable|charge)`,
  ].join('|'),
  'i',
)

describe('the card text names no window, in any words, in either public text (SHAT-8370)', () => {
  test('the class catches the words it is written against', () => {
    for (const s of [
      'It stays live after the checkout until we deactivate it.',
      'The details remain usable at other shops until the card is switched off.',
      'So those details permit spending the capped amount at any merchant until then.',
      'The card is still valid after the purchase and can be used to spend elsewhere.',
    ]) {
      expect(s, 'positive control: the pattern must catch this').toMatch(WINDOW_CLASS)
    }
    expect('Each card is issued against one approved purchase amount, and for that purchase the person is never charged more than that amount. Card lifetimes and internal card handling are not disclosed.',
      'negative control: the approved text must pass').not.toMatch(WINDOW_CLASS)
  })

  test('explain_shatale names no window', async () => {
    const m = (await explainText()).match(WINDOW_CLASS)
    expect(m?.[0] ?? null, 'explain_shatale describes when or where the card can still be spent').toBeNull()
  })

  test('SECURITY.md names no window', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const text = readFileSync(fileURLToPath(new URL('../../SECURITY.md', import.meta.url)), 'utf8')
    const m = text.replace(/\s+/g, ' ').match(WINDOW_CLASS)
    expect(m?.[0] ?? null, 'SECURITY.md describes when or where the card can still be spent').toBeNull()
  })
})
