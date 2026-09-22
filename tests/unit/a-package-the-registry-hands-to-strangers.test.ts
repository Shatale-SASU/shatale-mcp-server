/**
 * SHAT-3592 — a description npm hands to strangers may not promise a service we do not run.
 *
 * `sandbox_complete_onboarding` said: "Mark a sandbox test user as fully onboarded (KYC passed,
 * WALLET FUNDED)." There is no wallet, and the call funds nothing. Measured against the endpoint it
 * reaches, POST /v1/sandbox/users/{id}/onboarding: one UPDATE, profile_status='complete',
 * kyc_level='basic', threeds_onboarded=TRUE. Nothing about money moves. The API file carries the
 * word "onboard" 22 times and wallet/fund/balance zero times — the file was read, not empty.
 *
 * 🔴 IT IS THE MACHINE-READABLE SURFACE, WHICH IS WHAT MAKES IT WORSE THAN A PAGE. An agent reads
 * the description before it calls, and plans against a balance that does not exist. And the same
 * sentence rides to npm inside the package, where anyone evaluating us before integrating reads it
 * without ever opening our site.
 *
 * ⚠️ THE SAME SENTENCE LIVED IN TWO PLACES — src/tools/sandbox.ts and README.md — word for word.
 * So this was not documentation drifting from code: both were wrong together, and a guard over only
 * one of them would have passed.
 *
 * ⚠️ AND WHAT THIS FILE DELIBERATELY DOES NOT CHECK, said rather than glossed: that each README
 * description matches its source description character for character. Measured while writing this:
 * a regex extractor resolves 10 of the 23 and mis-reads 3 more (comments between `name` and
 * `description`, escaped apostrophes, concatenated literals). A rule that needs a TypeScript parser
 * to be right is a rule that will be wrong quietly. The dictionary below is checked on the REAL
 * descriptions instead — the modules are imported and asked — which is the half that can be run.
 */

import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createCatalogTools } from '../../src/tools/catalog.js'
import { createCheckoutTools } from '../../src/tools/checkout.js'
import { createCommonTools } from '../../src/tools/common.js'
import { createCredentialTools } from '../../src/tools/credentials.js'
import { createGuestTools } from '../../src/tools/guest.js'
import { createOnboardingTools } from '../../src/tools/onboarding.js'
import { createPurchaseTools } from '../../src/tools/purchase.js'
import { createRevealTools } from '../../src/tools/reveal.js'
import { createSandboxTools } from '../../src/tools/sandbox.js'
import type { ShataleClient } from '../../src/client.js'

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(join(here, '..', '..', 'README.md'), 'utf8')

/** Words that assert stored value. Each is a service we do not provide. */
const CLAIMS_A_BALANCE: { re: RegExp; why: string }[] = [
  { re: /\bwallet\b/i, why: 'a wallet is an account holding value; we hold none' },
  { re: /\bbalance\b/i, why: 'a balance is value on deposit that can run down' },
  { re: /\bstored value\b/i, why: 'the regulated term for exactly what we do not do' },
  { re: /\btop[- ]?up\b/i, why: 'topping up implies a balance to top up' },
  { re: /\bfunded\b/i, why: 'a claim that money was moved' },
]

function allTools(): { name: string; description: string }[] {
  const c = {} as ShataleClient
  const mods = [
    createCatalogTools(c),
    createCheckoutTools(c),
    createCommonTools(c),
    createCredentialTools(c),
    createGuestTools(c),
    createOnboardingTools(c),
    createPurchaseTools(c, { isSandbox: true }),
    createRevealTools(c),
    createSandboxTools(c),
  ]
  return mods.flatMap((m) => m.tools.map((t) => ({ name: t.name, description: t.description })))
}

describe('SHAT-3592 · the package tells strangers only what we do', () => {
  const tools = allTools()

  test('CONTROL · the modules and the README were really read', () => {
    // Floors on this guard's own work. A reader that loaded nothing reports a clean package in the
    // same words as a real pass — the shape this repository has been closing all day.
    expect(tools.length).toBeGreaterThanOrEqual(20)
    expect(tools.map((t) => t.name)).toContain('sandbox_complete_onboarding')
    for (const t of tools) {
      expect(t.description.length, `${t.name} has no description to judge`).toBeGreaterThan(20)
    }
    expect(readme.replace(/\s+/g, '').length).toBeGreaterThan(10000)
    expect(readme).toMatch(/sandbox_complete_onboarding/)
  })

  test('CONTROL · EVERY dictionary entry catches what it is for, and none is carried by a neighbour', () => {
    // 🔴 A MUTANT SURVIVED THE FIRST VERSION OF THIS CONTROL. It asked whether SOME entry matched
    // "KYC passed, wallet funded" — and deleting the `wallet` entry left it green, because `funded`
    // still matched the same sample. An entry could be removed and nothing would say so.
    // ⇒ Each entry is now exercised on a phrase only IT catches.
    const sample: Record<string, string> = {
      wallet: 'top of the wallet page',
      balance: 'the balance shown is stale',  // only the balance entry matches this sentence
      'stored value': 'we hold stored value for you',
      'top-up': 'top up the account',
      funded: 'the account was funded overnight',
    }
    expect(Object.keys(sample).length).toBe(CLAIMS_A_BALANCE.length)
    for (const d of CLAIMS_A_BALANCE) {
      const key = Object.keys(sample).find((k) => d.re.test(sample[k]))
      expect(key, `no sample in this control exercises ${d.re} — the entry is unchecked`).toBeDefined()
    }
    for (const [key, phrase] of Object.entries(sample)) {
      const matching = CLAIMS_A_BALANCE.filter((d) => d.re.test(phrase))
      expect(matching.length, `"${phrase}" is caught by ${matching.length} entries; it must ` +
        `exercise exactly one, or deleting that one would be covered by its neighbour`).toBe(1)
    }

    const hits = (s: string) => CLAIMS_A_BALANCE.some((d) => d.re.test(s))
    expect(hits('KYC passed, wallet funded')).toBe(true)
    // and the vocabulary we DO use must pass, or the rule would forbid the truth
    expect(hits('profile complete, KYC at basic level, 3-D Secure enrolled')).toBe(false)
    expect(hits('spending policy, delegation, per-purchase limit')).toBe(false)
    expect(hits('the funding source declined')).toBe(false)
  })

  test('no tool description promises a wallet, a balance or funding', () => {
    const bad: string[] = []
    for (const t of tools) {
      for (const { re, why } of CLAIMS_A_BALANCE) {
        if (re.test(t.description)) {
          bad.push(`${t.name}: ${why}\n      ${t.description.slice(0, 110)}`)
          break
        }
      }
    }
    expect(
      bad,
      'an agent reads these BEFORE it calls, and plans against what they promise. There is no ' +
        'wallet and no balance: a Shatale card is signed for one purchase at a time against the ' +
        "user's own funding. Say what the call does — for sandbox_complete_onboarding that is " +
        'profile complete, KYC basic, 3-D Secure enrolled (SHAT-3592).',
    ).toEqual([])
  })

  test('and neither does the README npm hands to anyone who looks at the package', () => {
    const bad: string[] = []
    readme.split('\n').forEach((line, i) => {
      for (const { re, why } of CLAIMS_A_BALANCE) {
        if (re.test(line)) {
          bad.push(`README.md:${i + 1}  ${why}\n      ${line.trim().slice(0, 110)}`)
          break
        }
      }
    })
    expect(
      bad,
      'this text travels to npm inside the package and is read by people deciding whether to ' +
        'integrate, without them ever opening our site. It may not describe a payment service we ' +
        'do not provide (SHAT-3592).',
    ).toEqual([])
  })

  test('nor the BUILT files, which are what npm actually ships', () => {
    // 🔴 THE HALF I GOT WRONG FIRST, AND IT IS THE HALF THAT MATTERS. Correcting the source left
    // "wallet funded" in dist/tools/sandbox.js — inside the comment I had written to explain its
    // removal. tsconfig keeps comments, so the file ships, and anyone grepping the package still
    // found the words. A denial carries the noun; the publisher cabinet taught that this morning
    // and this file repeated it by lunchtime.
    //
    // ⇒ The subject is what is PUBLISHED, not what is written. The harness guarantees a fresh
    // build before these suites run, so dist/ here is the tree that goes into the tarball.
    const dist = join(here, '..', '..', 'dist')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(js|d\.ts)$/.test(e.name)) files.push(p)
      }
    }
    walk(dist)
    // floor on this guard's own reading, before any verdict
    expect(files.length, 'the build produced nothing to read').toBeGreaterThan(10)
    // ⚠️ ONE PHRASE IS ALLOWED, AND IT IS ALLOWED BY MEASUREMENT RATHER THAN BY TASTE. The prompt
    // template documents `balance_check`, which is a REAL skill: migration 037_skills.sql creates
    // it and internal/skills/service.go:408 evaluates it, denying when the CARD's available
    // balance at the issuer is under a configured threshold. That balance is the card's, not value
    // we hold — the distinction this dictionary exists to protect. Exempting the FILE would have
    // been coarse enough to let a new false claim through, so the exact lines are named: change
    // one and this guard asks again.
    const measuredAndTrue = [
      'Ensures a minimum balance reserve is maintained before approving',
      'Minimum balance reserve',
    ]
    const bad: string[] = []
    for (const f of files) {
      const body = readFileSync(f, 'utf8')
      expect(body.length, `${f} is empty`).toBeGreaterThan(0)
      for (const line of body.split('\n')) {
        if (measuredAndTrue.some((ok) => line.includes(ok))) continue
        const hit = CLAIMS_A_BALANCE.find((d) => d.re.test(line))
        if (hit) {
          bad.push(`${f.slice(f.indexOf('dist'))}: ${hit.why}\n      ${line.trim().slice(0, 100)}`)
          break
        }
      }
    }
    expect(
      bad,
      'these files go into the tarball. Describing the old claim is fine; REPRODUCING it puts the ' +
        'words back into the package, where the next person greps and finds them (SHAT-3592).',
    ).toEqual([])
  })

  test('CONTROL · the one exempted phrase is still in the package, or the exemption is stale', () => {
    // An exemption covering nothing reads like a decision and hides the next case of its shape.
    const idx = readFileSync(join(here, '..', '..', 'dist', 'index.js'), 'utf8')
    expect(idx).toMatch(/balance_check/)
    expect(idx).toMatch(/minimum balance reserve/i)
  })

  test('the corrected sentence says what the endpoint actually does', () => {
    // Not merely "the old words are gone": a description emptied of the false claim and left vague
    // would pass the rules above while telling an agent nothing it can act on.
    const t = tools.find((x) => x.name === 'sandbox_complete_onboarding')!
    expect(t.description).toMatch(/profile complete/i)
    expect(t.description).toMatch(/KYC/)
    expect(t.description).toMatch(/3-D Secure/i)
    expect(readme).toMatch(/sandbox_complete_onboarding.*profile complete.*3-D Secure/i)
  })
})
