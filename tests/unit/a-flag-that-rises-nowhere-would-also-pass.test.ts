/**
 * SHAT-2611 follow-up — what the feature flag actually gates, asked of the RUNNING SERVER.
 *
 * The task was "check that the sandbox flag cannot be raised in live mode", with the instruction to
 * check BOTH sides: not only that it stays down where it must, but that it genuinely rises where it
 * should — because A FLAG THAT RISES NOWHERE PASSES EVERY "IT MUST NOT RISE" ASSERTION. That
 * instruction is what turned this file into a finding instead of a green tick.
 *
 * ⚠️ THERE IS NO SANDBOX FLAG. The server reads exactly one feature flag, SHATALE_ONBOARDING_ENABLED
 * (src/index.ts), and it is not about sandbox at all: SHAT-1662 keeps the register→status pair
 * unadvertised because the loop cannot close on any DEPLOYED backend until Funnel B ships. It is a
 * "not yet built" flag wearing a "test only" reputation.
 *
 * So the honest thing this file can pin is what is measured, not what the task assumed:
 *   - the flag really does raise the pair (the positive control, without which the rest is empty);
 *   - the flag raises the same pair under a LIVE key too — it is not mode-scoped in either
 *     direction, and that is recorded here so the next reader meets the measurement rather than the
 *     reputation;
 *   - the property that DOES hold as a gate: no sandbox_* tool is ever offered to a live key.
 */

import { describe, test, expect } from 'vitest'
import { rosterByMode } from '../harness/toolRoster.js'

// The pair SHAT-1662 holds back. Named, not counted: a count says "two more tools" and stays green
// when the flag starts raising two DIFFERENT ones.
const GATED_PAIR = ['get_onboarding_status', 'register_user_profile']

describe('what the onboarding flag gates, measured per mode', () => {
  test('the flag genuinely rises in sandbox — the positive control', async () => {
    const off = await rosterByMode('sandbox')
    const on = await rosterByMode('sandbox+flags')

    for (const tool of GATED_PAIR) {
      expect(off, `${tool} is supposed to be gated OFF by default`).not.toContain(tool)
      expect(on, `${tool} is supposed to appear when the flag is set`).toContain(tool)
    }
    // And it raises NOTHING ELSE: a flag that quietly brings a third tool with it is a different
    // flag than the one documented.
    expect(on.filter((t) => !off.includes(t)).sort()).toEqual(GATED_PAIR)
  })

  // ⚠️ THIS IS THE FINDING, WRITTEN AS THE ASSERTION IT ACTUALLY IS. The task expected the flag to
  // be refused under a live key. It is not: the same env var raises the same pair in live mode, and
  // SHAT-1662's own reason — the loop cannot close on a deployed backend — applies to production
  // hardest of all. Nothing here decides whether that is wrong; it stops being INVISIBLE. If the
  // gate is later scoped to sandbox, this test fails and names the decision instead of drifting.
  test('the same flag rises under a LIVE key too — it is not mode-scoped', async () => {
    const off = await rosterByMode('live+money')
    const on = await rosterByMode('live+money+flags')

    expect(on.filter((t) => !off.includes(t)).sort()).toEqual(GATED_PAIR)
  })

  test('no sandbox_* tool is ever offered to a live key — this gate does hold', async () => {
    for (const mode of ['live', 'live+money', 'live+money+flags']) {
      const tools = await rosterByMode(mode)
      expect(tools.filter((t) => t.startsWith('sandbox_')), `mode ${mode}`).toEqual([])
    }
    // Positive control on the search itself: sandbox_* tools exist, so an empty result above is a
    // gate holding rather than a prefix nothing ever matches.
    expect((await rosterByMode('sandbox')).filter((t) => t.startsWith('sandbox_')).length).toBeGreaterThan(0)
  })
})
