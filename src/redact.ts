/**
 * Defense-in-depth PCI guard. The backend's purchase response embeds the raw pool-card PAN + CVV
 * under `payment.card` when a card is issued (apps/api purchases.go purchaseToJSON). That raw card
 * MUST NOT flow into the LLM reasoning context / MCP-host logs / chat history — it belongs only in
 * the out-of-band checkout executor via the dedicated reveal path.
 *
 * /!\ THIS FILE EXISTS BECAUSE THE INVARIANT WAS A PROPERTY OF FOUR CALL SITES, NOT OF THE SYSTEM.
 *
 * The redactor's own comment claimed the global form — "this walks the whole result and enforces one
 * invariant everywhere: NO TOOL RESULT CARRIES A NUMBER+CVV PAIR" — and that was true of what the
 * FUNCTION does and false of what the SERVER does. Measured before this change: it was applied at
 * exactly four places (three in purchase.ts, one in sandbox.ts). Every other tool returned the
 * upstream body unfiltered, and a tool added tomorrow got no redaction from anywhere.
 *
 * That is the same shape three other defects this week had: an invariant written into a method,
 * with every path that does not call the method left unguarded — the delegation-status sync a raw
 * UPDATE walked around, the id validation five handlers had and eight did not, the wire fixtures
 * that covered five tools out of seventeen.
 *
 * So the scrub now runs in ShataleClient.request, on every response, before any tool sees it. It is
 * a property of the CLIENT: there is one door, a new tool cannot miss it by not knowing it exists,
 * and its absence would be visible in one place rather than by auditing every handler.
 *
 * Nothing legitimate is lost. No tool needs a PAN in its result — `card_number` is an INPUT to
 * sandbox_simulate_authorization, not an output, and the checkout tools return identities. last4 is
 * derived before the deletion so an agent can still tell two cards apart.
 */

// Strip PAN and CVV from anything a tool is about to hand back.
//
// This used to reach exactly one shape — `payment.card` — while guest.ts told readers a raw PAN is
// "NEVER returned". Review's call was to widen the redactor rather than narrow the copy, and that is
// the right side to move: the copy is the promise a reader acts on, and narrowing a PCI claim to
// match the code optimises the wrong half. A caller who believes the promise and finds a PAN has
// been misled by us; a caller who believes it and finds nothing has lost nothing.
//
// Today's backend emits only the static 4242 test card, so nothing here is a live leak — which is
// precisely why it is cheap to make the guarantee true before it needs to be.
//
// The walk is depth-limited and cycle-safe: a redactor that hangs on a self-referential response
// would take the tool down with it.
export function redactPurchaseCard(result: unknown): unknown {
  return scrub(result, 0, new WeakSet())
}

const CARD_NOTE =
  'Raw PAN/CVV are withheld from the agent context (PCI). Retrieve the card out-of-band ' +
  'via the checkout executor, not from this response. For the checkout form\'s identity fields, ' +
  'use get_checkout_cardholder (cardholder/billing) and get_checkout_customer (buyer).'

// A node is card-ish if it carries a PAN-shaped field. Keyed on the field, not on the
// parent's name, because the parent is what kept changing — `card`, `issued_card`,
// a bare array element — while the sensitive field itself never did.
function isCardish(o: Record<string, unknown>): boolean {
  return typeof o.number === 'string' || typeof o.card_number === 'string' || 'cvv' in o || 'cvc' in o
}

function scrub(node: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 12 || !node || typeof node !== 'object') return node
  if (seen.has(node as object)) return node
  seen.add(node as object)

  if (Array.isArray(node)) return node.map((v) => scrub(v, depth + 1, seen))

  const o = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) out[k] = scrub(o[k], depth + 1, seen)

  if (isCardish(o)) {
    const pan = typeof o.number === 'string' ? o.number : typeof o.card_number === 'string' ? o.card_number : undefined
    if (pan) {
      // last4 is derived before the delete — an agent still needs to tell two cards
      // apart, and taking that away would push it to ask for the PAN some other way.
      out.last4 = pan.slice(-4)
      delete out.number
      delete out.card_number
    }
    delete out.cvv
    delete out.cvc
    out._note = CARD_NOTE
  }
  return out
}
