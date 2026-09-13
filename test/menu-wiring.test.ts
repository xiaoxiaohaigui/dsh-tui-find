/**
 * The context menu's scene-level wiring, driven through the real host
 * renderer with injected SGR mouse sequences (REVIEW R-053): a right-press
 * opens the menu on the row under the pointer and selects that row, hover
 * moves the highlight (the real-machine defect-② class the pure-model tests
 * cannot catch), the keyboard vocabulary (↑↓/Enter/Esc) drives it while it
 * stands, the backdrop closes it without passing the event through to the
 * row beneath, and a direct item click activates. The 0.9 generation gate —
 * no context-menu dispatch, no attached handlers — is asserted separately
 * so both host generations pin their own contract.
 *
 * Layout coordinates (80×12, query 'needle', one session, one hit row):
 * the list window spans rows 4-8 with the card at 4-5 and the hit row at
 * row 6; a menu opened there clamps to a panel at columns 11-35, rows 6-10,
 * so its three items sit on terminal rows 8/9/10 (1-indexed).
 *
 * Diff frames skip cells identical to the previous frame — interior
 * characters included — so content assertions use whitespace-tolerant (or
 * gap-tolerant) regexes, and state changes are confirmed on resize-forced
 * full repaints where the panel region genuinely repaints.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { hasTerminalImageHooks } from '../src/find-types.js'
import { setLangOverride } from '../src/i18n.js'
import { mount, sessionWithMessages, waitFor } from './harness.js'

setLangOverride('en')
afterAll(() => setLangOverride(undefined))

// The same structural generation probe the scene gates its handler
// attachment on: 0.9 hosts dispatch no context-menu events, so the
// host-dispatch cases run only where they can (the 0.10 leg of the
// host matrix), and 0.9 pins its own inertness in the gate test below.
const menuCapable = hasTerminalImageHooks(hostUi)

const menuHarness = (notify?: (text: string, tone: 'info' | 'error') => void) =>
  mount(sessionWithMessages(['intro', 'needle one', 'tail']), {
    query: 'needle',
    fullscreen: true,
    notify,
  })

describe.skipIf(!menuCapable)('context menu scene wiring', () => {
  it('opens the menu on a right-press and selects the row under the pointer', async () => {
    const harness = await menuHarness()
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      const frame = harness.latest()
      expect(frame).toMatch(/Copy\s*message\s*text/)
      expect(frame).toMatch(/Copy\s*session\s*log\s*path/)
      expect(frame).toMatch(/Resume\s*this\s*session/)
      // The selection marker moved onto the hit row (the card's reverts).
      // Asserted on a resize-forced full repaint: a plain diff frame paints
      // the marker's content change but skips the row's style-only cells.
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*#2/)
      // While the menu stands, its own vocabulary owns the keyboard —
      // typing must never leak into the query behind it (a leaked 'x'
      // would show in the search card on a full repaint).
      harness.send('x')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/⌕\s*needlex/)
      expect(harness.latest()).toMatch(/⌕\s*needle/)
    } finally {
      harness.dispose()
    }
  })

  it('moves the highlight to the hovered item so Enter activates it', async () => {
    const notify = vi.fn()
    const harness = await menuHarness(notify)
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      // Hover the second item (copy log path): the highlight must follow
      // the pointer — without the row's onMouseEnter wiring Enter would
      // still activate the first item and copy the message instead.
      harness.movePointer(15, 9)
      await waitFor()
      harness.send('\r')
      await waitFor()
      expect(notify).toHaveBeenCalledTimes(1)
      const [text, tone] = notify.mock.calls[0] ?? []
      expect(text).toBe('Session log path copied')
      expect(tone).toBe('info')
      // Activation closes the menu.
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Copy\s*message\s*text/)
    } finally {
      harness.dispose()
    }
  })

  it('drives the menu from the keyboard: arrows move and clamp, Enter activates, Esc closes only the menu', async () => {
    const notify = vi.fn()
    const harness = await menuHarness(notify)
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      // Esc dismisses the menu and nothing else: the query survives and
      // the scene stays open.
      harness.send('\u001b')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Copy\s*session\s*log\s*path/)
      expect(harness.latest()).toMatch(/⌕\s*needle/)
      expect(harness.closed()).toBe(0)

      // Reopen: ↑ clamps at the first item, Enter activates it (copy the
      // hit row's message).
      harness.rightClickAt(12, 7)
      await waitFor()
      harness.send('\u001b[A')
      await waitFor()
      harness.send('\r')
      await waitFor()
      const [text, tone] = notify.mock.calls[0] ?? []
      expect(text).toMatch(/^Copied \d+ chars to clipboard$/)
      expect(tone).toBe('info')

      // Reopen: ↓↓ reaches the last item, Enter resumes through the
      // confirm pane (the action re-locates the row by session id).
      harness.rightClickAt(12, 7)
      await waitFor()
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\r')
      await waitFor()
      expect(harness.latest()).toMatch(/Resum[^?\r]{0,20}session\?/)
      expect(harness.latest()).toMatch(/Targ[^:\r]{0,20}:/)
      // Esc backs out of the confirm pane; the menu is long gone.
      harness.send('\u001b')
      await waitFor()
      expect(harness.latest()).toMatch(/needle\s*one/)
      expect(harness.latest()).not.toMatch(/Resum[^?\r]{0,20}session\?/)
    } finally {
      harness.dispose()
    }
  })

  it('closes on a backdrop click without passing it through to the row beneath', async () => {
    const harness = await menuHarness()
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      expect(harness.all()).toMatch(/Copy\s*session\s*log\s*path/)
      // Left-click the backdrop over the hit row (the panel sits at
      // columns 11-35): the menu closes and the click must NOT fall
      // through to the row's own open path (which would show the resume
      // confirm pane).
      harness.clickAt(51, 7)
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Copy\s*session\s*log\s*path/)
      expect(harness.latest()).not.toMatch(/Resume this session\?/)

      // The row still answers a fresh right-click — the earlier click was
      // consumed by the backdrop, not dead.
      harness.rightClickAt(51, 7)
      await waitFor()
      expect(harness.latest()).toMatch(/Copy\s*session\s*log\s*path/)

      // A right-click on the backdrop (well clear of the reopened panel
      // at columns 50-74) closes again; if the event passed through, the
      // row would re-open a menu right there and the labels would stay.
      harness.rightClickAt(5, 7)
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Copy\s*session\s*log\s*path/)
    } finally {
      harness.dispose()
    }
  })

  it('activates an item on click and closes the menu', async () => {
    const notify = vi.fn()
    const harness = await menuHarness(notify)
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      harness.clickAt(15, 8)
      await waitFor()
      const [text, tone] = notify.mock.calls[0] ?? []
      expect(text).toMatch(/^Copied \d+ chars to clipboard$/)
      expect(tone).toBe('info')
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Copy\s*message\s*text/)
    } finally {
      harness.dispose()
    }
  })
})

describe('context menu generation gate', () => {
  it('answers a right-click only where the host generation dispatches context menus', async () => {
    const harness = await menuHarness()
    try {
      harness.rightClickAt(12, 7)
      await waitFor()
      if (menuCapable) {
        // 0.10 kit: handlers attached, host dispatches the context menu.
        expect(harness.all()).toMatch(/Copy\s*session\s*log\s*path/)
      } else {
        // 0.9 kit: no dispatch and no attached handlers — the right-click
        // is inert and the scene keeps answering its own keys (the
        // appended 'x' shows in the search card on a full repaint).
        expect(harness.all()).not.toMatch(/Copy\s*session\s*log\s*path/)
        harness.send('x')
        await waitFor()
        harness.resize(81, 12)
        await waitFor()
        expect(harness.latest()).toMatch(/⌕\s*needlex/)
      }
    } finally {
      harness.dispose()
    }
  })
})
