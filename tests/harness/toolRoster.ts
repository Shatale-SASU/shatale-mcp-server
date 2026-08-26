import type { ToolDefinition } from '../../src/types.js'
import { createGuestTools } from '../../src/tools/guest.js'
import { createCommonTools } from '../../src/tools/common.js'
import { createCatalogTools } from '../../src/tools/catalog.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'

/**
 * The tool roster, derived from what the modules PRODUCE rather than from what the sources look
 * like — no file layout, no quoting, no regex.
 *
 * ⚠️ IT LIVES HERE BECAUSE TWO GUARDS NEED IT, AND A SECOND COPY IS HOW THE FIRST GOES STALE. That
 * is the defect both of those guards exist to catch, and writing it twice would reintroduce it in
 * the one place nobody would look.
 *
 * Every factory, with every flag on: no single MODE registers all of them — guest is 7, sandbox 15,
 * live-with-money 14 — and both callers ask about the whole surface. The client is never used; only
 * declarations are read, and nothing here makes a request.
 */
export function rosterFromRuntime(): string[] {
  const client = {} as never
  const ctx = {
    isGuest: false,
    isSandbox: true,
    isLive: false,
    moneyEnabled: true,
    getToolNames: () => [] as string[],
  }
  const modules = [
    createGuestTools(ctx),
    createCommonTools(client, ctx),
    createCatalogTools(client),
    createOnboardingTools(client, { enabled: true }),
    createPurchaseTools(client, { isSandbox: true }),
    createCredentialTools(client, { emailsEnabled: true }),
    createCheckoutTools(client),
    createSandboxTools(client),
  ]
  const names = modules.flatMap((m) => (m.tools as ToolDefinition[]).map((t) => t.name))
  return [...new Set(names)].sort()
}
