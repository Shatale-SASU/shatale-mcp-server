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

// SHAT-8370, second hand (Buklya) on #131/#132: a blacklist of window words lost twice — a paraphrase passed
// (P1-P5) and an innocent neighbouring sentence went red (I1-I3). The open class cannot be held by patterns, so
// the card text is a WHITELIST: the paragraph that carries the approved sentences must EQUAL the approved
// paragraph as a whole (whitespace-normalised). Any added sentence — before, after, inside, in any words — goes red.
//
// What "the paragraph" is, deterministically:
//   explain_shatale: the block of text between blank lines that contains the first approved sentence;
//   SECURITY.md:     the list item (a line starting with "- ") that contains it, up to the next list item or blank line.
// If the first approved sentence cannot be found, extraction THROWS (positive control) — it never returns "".
const FIRST = 'Each card is issued against one approved purchase amount, and for that purchase the person is never charged more than that amount.'
const SECOND = 'Card lifetimes and internal card handling are not disclosed.'
const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()

const APPROVED_GUEST_PARAGRAPH = norm(
  `THE CARD SHATALE ISSUES for a purchase IS returned in full. We mint it for that purchase, the
cardholder is Shatale SASU, and it is handed to you precisely so you can pay with it — a masked
number cannot be typed into a checkout form. ${FIRST} ${SECOND} Treat them as live payment credentials: use them for the checkout, do not
repeat them into logs or a summary.`,
)
const APPROVED_SECURITY_ITEM = norm(`- ${FIRST} ${SECOND}`)

function guestParagraph(text: string): string {
  const hit = text.split(/\n\s*\n/).filter((b) => norm(b).includes(FIRST))
  if (hit.length !== 1) throw new Error(`explain_shatale: expected exactly one paragraph with the approved first sentence, found ${hit.length}`)
  return norm(hit[0])
}

function securityItem(text: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes(FIRST.slice(0, 40)))
  if (at < 0) throw new Error('SECURITY.md: the approved first sentence is not there')
  let start = at
  while (start > 0 && !/^\s*- /.test(lines[start])) start--
  if (!/^\s*- /.test(lines[start])) throw new Error('SECURITY.md: the card text is not a list item')
  let end = at + 1
  while (end < lines.length && lines[end].trim() !== '' && !/^\s*- /.test(lines[end])) end++
  return norm(lines.slice(start, end).join('\n'))
}

// Sentences may be wrapped across lines in the source; match them whatever the wrapping.
const loose = (sentence: string): RegExp => new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
const put = (doc: string, anchor: string, f: (m: string) => string): string => doc.replace(loose(anchor), f)

async function securityText(): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  return readFileSync(fileURLToPath(new URL('../../SECURITY.md', import.meta.url)), 'utf8')
}

// Buklya's pairs. P* are paraphrases that must be refused; I* are innocent sentences that must stay allowed.
const P_GUEST = [
  'The details can be charged elsewhere until we close the card.', // P1
  'Leaked details can be spent anywhere for a while after checkout.', // P2
  'The card survives the checkout and can pay a second shop.', // P5
]
const P_SECURITY = [
  'The card is not closed right after payment, so the details keep working for a time.', // P3
  'The card number works across merchants until it is retired.', // P4
]
const I_SECURITY = [
  'The shipping address is released only while the purchase is active.', // I1
  'The relay password is valid until the person revokes it.', // I2
  'In live mode the API key is live.', // I3
]

describe('the card text equals the approved text as a whole, in both public texts (SHAT-8370)', () => {
  test('positive controls: extraction finds the paragraph, and the approved paragraph is the one in the tree', async () => {
    expect(() => guestParagraph('nothing here')).toThrow()
    expect(() => securityItem('nothing here')).toThrow()
    expect(() => securityItem(`${FIRST} not a list item`)).toThrow()
    expect(guestParagraph(await explainText())).toBe(APPROVED_GUEST_PARAGRAPH)
    expect(securityItem(await securityText())).toBe(APPROVED_SECURITY_ITEM)
  })

  test('explain_shatale: the card paragraph equals the approved paragraph', async () => {
    expect(guestParagraph(await explainText()), 'the card paragraph in explain_shatale differs from the approved text').toBe(APPROVED_GUEST_PARAGRAPH)
  })

  test('SECURITY.md: the card bullet equals the approved bullet', async () => {
    expect(securityItem(await securityText()), 'the card bullet in SECURITY.md differs from the approved text').toBe(APPROVED_SECURITY_ITEM)
  })

  // P1-P5, each inserted in all three positions of BOTH texts: after the second sentence, between the two, before the first.
  test.each([...P_GUEST, ...P_SECURITY])('refused as a paraphrase, anywhere in the paragraph: %s', async (p) => {
    const g = await explainText()
    const s = await securityText()
    for (const [name, doc, extract, want] of [
      ['explain_shatale', g, guestParagraph, APPROVED_GUEST_PARAGRAPH],
      ['SECURITY.md', s, securityItem, APPROVED_SECURITY_ITEM],
    ] as const) {
      for (const mutated of [put(doc, SECOND, (m) => `${m} ${p}`), put(doc, SECOND, (m) => `${p} ${m}`), put(doc, FIRST, (m) => `${p} ${m}`)]) {
        expect(mutated, 'the mutation must have changed the text').not.toBe(doc)
        expect(extract(mutated), `${name}: an added sentence must redden the whole-paragraph check`).not.toBe(want)
      }
    }
  })

  // I1-I3: innocent sentences about other things, placed as their own item/paragraph AFTER the card text — they are
  // not part of the card paragraph, so the whole-paragraph check stays green. (The blacklist reddened all three.)
  test.each(I_SECURITY)('stays allowed outside the card paragraph: %s', async (i) => {
    const s = await securityText()
    const after = put(s, SECOND, (m) => `${m}\n  - ${i}`)
    expect(after).not.toBe(s)
    expect(securityItem(after)).toBe(APPROVED_SECURITY_ITEM)
    const g = await explainText()
    expect(guestParagraph(g.replace(/(\n\s*\n)(THE PERSON'S OWN CARD)/, `$1${i}$1$2`))).toBe(APPROVED_GUEST_PARAGRAPH)
    // and the same sentence INSIDE the card paragraph is refused: the check is about the place, not the words.
    expect(securityItem(put(s, SECOND, (m) => `${m} ${i}`))).not.toBe(APPROVED_SECURITY_ITEM)
  })
})
