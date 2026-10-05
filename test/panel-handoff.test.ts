/**
 * The sidebar panel → scene handoff: a seeded mount (scene.tsx's `SceneSeed`)
 * lands the selection on the row the panel handed over, and keeps it there
 * until the streaming sweep delivers that row. The panel's own tests pin what
 * it SENDS (panel-model.test.ts); this pins what the scene does with it.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { FindScene, type SceneSeed } from '../src/scene.js'
import { mount, sessionWithMessages, waitForMatch, waitUntil, type HarnessSceneProps } from './harness.js'

/** The plugin's registered wrapper, reduced to the seed under test. */
function seeded(seed: SceneSeed): React.ComponentType<HarnessSceneProps> {
  const Seeded = (props: HarnessSceneProps): React.ReactElement =>
    React.createElement(FindScene, { ...props, initialSeed: () => seed })
  return Seeded
}

/** A session whose first two messages both carry the word `needle`, so the
 *  handoff has two hit rows to choose between. */
function session(): ReturnType<typeof sessionWithMessages> {
  return { ...sessionWithMessages(['alpha needle', 'beta needle', 'gamma']), title: 'Handoff' }
}

describe('scene seeded by the sidebar panel', () => {
  it('selects the handed-over hit row instead of the first row', async () => {
    const target = session()
    const harness = await mount(target, {
      component: seeded({ query: 'needle', rowId: `m:${target.id}:1` }),
      columns: 90,
    })
    try {
      // Polled, not slept on: a full repaint is what makes the selection
      // readable, and the harness's own deadline keeps a slow runner honest.
      await waitForMatch(() => harness.latest(), /❯\s*#2\s*AI:\s*beta\s*needle/)
      const frame = harness.latest()
      // The second message's hit row (sourceIndex 1) carries the selection.
      expect(frame).toMatch(/❯\s*#2\s*AI:\s*beta\s*needle/)
      expect(frame).not.toMatch(/❯\s*#1\s*You:\s*alpha/)
    } finally {
      harness.dispose()
    }
  })

  it('lands on a session card handed over as the target', async () => {
    const target = session()
    const harness = await mount(target, {
      component: seeded({ query: 'needle', rowId: `s:${target.id}` }),
      columns: 90,
    })
    try {
      await waitForMatch(() => harness.latest(), /❯\s*Handoff/)
      expect(harness.latest()).toMatch(/❯\s*Handoff/)
    } finally {
      harness.dispose()
    }
  })

  it('applies the seed query even when its row never arrives', async () => {
    const harness = await mount(session(), {
      component: seeded({ query: 'needle', rowId: 'm:no-such-session:7' }),
      columns: 90,
    })
    try {
      // The query line may have been painted in an earlier frame (ink
      // re-renders differentially), so the query assertion reads the
      // cumulative stream while the selection reads the live frame.
      await waitForMatch(() => harness.all(), /⌕\s*needle/)
      expect(harness.all()).toMatch(/⌕\s*needle/)
      // The unknown anchor falls back to the clamped selection (the card).
      await waitForMatch(() => harness.latest(), /❯\s*Handoff/)
      expect(harness.latest()).toMatch(/❯\s*Handoff/)
    } finally {
      harness.dispose()
    }
  })

  it('stops waiting for a handoff the user edited past', async () => {
    // Regression (review F4): the pending-handoff guard used to suppress the
    // query-change reset for the REST of the mount, so a seed whose row never
    // arrived left the highlight stuck wherever the clamp put it.
    const target = session()
    const harness = await mount(target, {
      component: seeded({ query: 'needle', rowId: 'm:no-such-session:7' }),
      columns: 90,
    })
    /** Move onto a row, then poll for it on frames forced WHOLE: the moves
     *  repaint only the changed cells, so a frame read without the width flip
     *  can miss the selection. The flip belongs INSIDE the poll — a fixed
     *  sleep before it races ink's key consumption and turns into a 5 s
     *  timeout instead of a frame (R-140). */
    const waitForSelection = async (pattern: RegExp): Promise<void> => {
      await waitForMatch(() => {
        harness.toggleWidth()
        return harness.latest()
      }, pattern)
      expect(harness.latest()).toMatch(pattern)
    }
    try {
      // Move onto the last hit row (the card, then #1, then #2).
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitForSelection(/❯\s*#2\s*AI:\s*beta/)

      // A scope change is a list-shape edit: the highlight returns to the top
      // row — which only happens if the abandoned handoff was dropped.
      harness.send('\t')
      await waitForSelection(/❯\s*Handoff/)
    } finally {
      harness.dispose()
    }
  })

  it('drops a handoff that never landed instead of letting it hijack a later fold', async () => {
    // R-136's fallback. Same seed as above but WITHOUT the fold: the hit row
    // is past the preview budget, so it never arrives — exactly the shape a
    // live `titleOnly` edit produces between the panel's last derivation and
    // this mount. Once the sweep is over the anchor must be dropped; otherwise
    // unfolding the card here would drag the highlight down to #7.
    const target = {
      ...sessionWithMessages(Array.from({ length: 8 }, (_unused, i) => `needle ${i}`)),
      title: 'Handoff',
    }
    const harness = await mount(target, {
      component: seeded({ query: 'needle', rowId: `m:${target.id}:6` }),
      columns: 90,
    })
    try {
      // The anchor cannot land: the folded card offers the preview budget only
      // (its `▸ (+5)` badge says so).
      await waitForMatch(() => harness.latest(), /❯\s*Handoff/)
      expect(harness.latest()).toMatch(/❯\s*Handoff/)
      expect(harness.latest()).toMatch(/\(\+5\)/)

      // Alt+E unfolds that session. #7 now EXISTS in the list, but nothing
      // asked for it any more, so the highlight stays on the card. (The row
      // itself is below the viewport either way — the tells are the badge
      // disappearing and ❯ staying put: under the latch, the fold would scroll
      // the list down onto #7.)
      harness.send('\u001be')
      await waitUntil(() => {
        harness.toggleWidth()
        return !/\(\+5\)/.test(harness.latest())
      })
      expect(harness.latest()).not.toMatch(/\(\+5\)/)
      expect(harness.latest()).toMatch(/❯\s*Handoff/)
      expect(harness.latest()).not.toMatch(/❯\s*#7/)
    } finally {
      harness.dispose()
    }
  })

  it('lands on a hit row the panel handed over unfolded', async () => {
    // R-136: without the fold travelling with the seed, a hit past the preview
    // budget is not in the row list at all, so the anchor could never land —
    // the scene sat on the session card and the pending anchor stayed latched.
    const target = { ...sessionWithMessages(Array.from({ length: 8 }, (_unused, i) => `needle ${i}`)), title: 'Handoff' }
    const harness = await mount(target, {
      component: seeded({ query: 'needle', rowId: `m:${target.id}:6`, expanded: [target.id] }),
      columns: 90,
    })
    try {
      // #7 is the seventh message (sourceIndex 6) — the seed must both unfold
      // the session and land on it. The role label is the language-dependent
      // one (`You:` / `你:`; this file pins neither), and the frame collapses
      // padding cells, so both are matched loosely.
      await waitForMatch(() => harness.latest(), /❯\s*#7\s*\S{1,4}:\s*needle\s*6/)
      expect(harness.latest()).toMatch(/❯\s*#7\s*\S{1,4}:\s*needle\s*6/)
    } finally {
      harness.dispose()
    }
  })
})
