/**
 * SHAT-5075. The one property of the deleted flag test that did not depend on the flag.
 *
 * That file (a-flag-that-rises-nowhere-would-also-pass) pinned SHATALE_ONBOARDING_ENABLED and the
 * pair it raised, and both are gone. Its last test was never about the flag: no sandbox_* tool is
 * ever offered to a live key. It is kept, asked of the RUNNING SERVER, with its positive control.
 */

import { describe, test, expect } from 'vitest'
import { rosterByMode } from '../harness/toolRoster.js'

describe('what a live key is offered, measured per mode', () => {
  test('no sandbox_* tool is ever offered to a live key', async () => {
    for (const mode of ['live', 'live+money']) {
      const tools = await rosterByMode(mode)
      expect(tools.filter((t) => t.startsWith('sandbox_')), `mode ${mode}`).toEqual([])
    }
    // Positive control on the search itself: sandbox_* tools exist, so an empty result above is a
    // gate holding rather than a prefix nothing ever matches.
    expect((await rosterByMode('sandbox')).filter((t) => t.startsWith('sandbox_')).length).toBeGreaterThan(0)
  })

  test('the removed onboarding pair is offered in no mode at all', async () => {
    for (const mode of ['guest', 'sandbox', 'live', 'live+money']) {
      const tools = await rosterByMode(mode)
      expect(tools, `mode ${mode}`).not.toContain('register_user_profile')
      expect(tools, `mode ${mode}`).not.toContain('get_onboarding_status')
    }
    // Positive control, same instrument: a tool that is there is found.
    expect(await rosterByMode('sandbox')).toContain('request_purchase')
  })
})
