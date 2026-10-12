/**
 * No sandbox_* tool is ever offered to a live key — asked of the RUNNING SERVER.
 *
 * This was the last test of a file about SHATALE_ONBOARDING_ENABLED, the only feature flag the
 * server read. The flag went with the tools it gated (SHAT-4435: the API removed funnel B), and the
 * file with it; this property is independent of the flag and is kept.
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
})
