/**
 * The sidebar panel → scene handoff: a seeded mount (scene.tsx's `SceneSeed`)
 * lands the selection on the row the panel handed over, and keeps it there
 * until the streaming sweep delivers that row. The panel's own tests pin what
 * it SENDS (panel-model.test.ts); this pins what the scene does with it.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { FindScene, type SceneSeed } from '../src/scene.js'
import { mount, sessionWithMessages, waitFor, waitForMatch, type HarnessSceneProps } from './harness.js'

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
    try {
      // Move onto the last hit row (the card, then #1, then #2). The moves
      // repaint only the changed cells, so the frame is forced whole before
      // it is read (the harness's own toggleWidth idiom).
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitFor()
      harness.toggleWidth()
      await waitForMatch(() => harness.latest(), /❯\s*#2\s*AI:\s*beta/)
      expect(harness.latest()).toMatch(/❯\s*#2\s*AI:\s*beta/)

      // A scope change is a list-shape edit: the highlight returns to the top
      // row — which only happens if the abandoned handoff was dropped.
      harness.send('\t')
      await waitFor()
      harness.toggleWidth()
      await waitForMatch(() => harness.latest(), /❯\s*Handoff/)
      expect(harness.latest()).toMatch(/❯\s*Handoff/)
    } finally {
      harness.dispose()
    }
  })
})
