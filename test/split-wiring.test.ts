/**
 * The split layout's scene-level wiring, driven through the real host
 * renderer at 120 columns (the shared harness; see preview-wiring.test.ts
 * for the frame-capture discipline). Covers the split matrix: default
 * rendering with the reader anchored to the selection, the deduplicated
 * selection→reader anchoring (manual scrolls survive unrelated repaints),
 * the Alt+P focus handoff with the full reader vocabulary, the area-local
 * wheel, the list's pointer wiring from reader focus (wheel/hover/click,
 * REVIEW R-056), the pane's right-click copy (0.10+ hosts only), and the
 * width / config fallbacks. The classic form is pinned by every existing
 * scene, preview and menu test mounting at the default 80 columns — zero of
 * their assertions changed, which is the no-regression proof.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import type { ScannedSession } from '../src/core/scan.js'
import { hasTerminalImageHooks, splitLayout } from '../src/find-types.js'
import { setLangOverride } from '../src/i18n.js'
import { mount, sessionWithMessages, waitFor, waitForMatch } from './harness.js'

setLangOverride('en')
afterAll(() => setLangOverride(undefined))

describe('splitLayout geometry', () => {
  it('stays classic below the width gate', () => {
    expect(splitLayout(99)).toEqual({ split: false, listWidth: 99, paneWidth: 0 })
  })

  it('caps the pane at 56 columns and gives the list the rest', () => {
    expect(splitLayout(100)).toEqual({ split: true, listWidth: 58, paneWidth: 42 })
    expect(splitLayout(134)).toEqual({ split: true, listWidth: 78, paneWidth: 56 })
    expect(splitLayout(200)).toEqual({ split: true, listWidth: 144, paneWidth: 56 })
  })
})

/** Ten messages, hits on message #2 and #9 (indexes 1 and 8): the
 *  conversation spans 20 reader lines and overflows the 9-row split
 *  viewport at 120x20, so the anchored window position is observable. */
const splitSession = (): ScannedSession =>
  sessionWithMessages([
    'alpha',
    'needle one',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'needle two',
    'hotel',
  ])

// Geometry at 120x20: listWidth 70 / paneWidth 50; the content row spans
// terminal rows 5-17, the pane's border/title/meta take rows 5-7 and its
// scroll region is rows 8-16 (body localRow 0 = terminal row 8).
const wide = { columns: 120, rows: 20 }
/** One SGR wheel report; button 64 = wheel up, 65 = wheel down. */
const wheelAt = (col: number, row: number, button: number): string => `\u001b[<${button};${col};${row}M`

// Pointer-event delivery differences ride the 0.10 kit generation probe,
// as the list menu does (menu-wiring.test.ts): on the 0.9.3 baseline the
// kit's Box swallows onWheel into its style bag (its own wheel surfaces
// bypass Box with raw ink-box elements), so wheel routing to plugin
// handlers only exists on 0.10+ — the context-menu dispatch is likewise
// 0.10-only. Both skip on 0.9.3 and run on the 0.10.x verify:hosts leg.
const generation10 = hasTerminalImageHooks(hostUi)

describe('split rendering and anchoring', () => {
  it('renders the reader beside the list and anchors it to the first hit', async () => {
    const harness = await mount(splitSession(), wide)
    try {
      // Full repaint first: first-frame captures can drop interior cells
      // ('10 msgs' → '10 mgs' class of capture quirk, seen on both host
      // legs); the resize keeps every text assertion on complete cells.
      harness.resize(121, 20)
      await waitFor()
      const frame = harness.latest()
      // Left column: the selected card and its hit rows.
      expect(frame).toMatch(/❯\s*Preview\s*wiring/)
      expect(frame).toMatch(/#2\s*AI:\s*needle\s*one/)
      // Right column: the reader head, anchored to the card's FIRST message
      // hit (message #2) — the conversation head (#1) sits above the window
      // and must not show.
      expect(frame).toMatch(/Read-only\s*preview\s*·\s*Preview\s*wiring/)
      expect(frame).toMatch(/10\s*msgs/)
      expect(frame).toMatch(/✦\s*AI\s*#2\s*◆/)
      expect(frame).not.toMatch(/You\s*#1\b/)
    } finally {
      harness.dispose()
    }
  })

  it('re-anchors when the selection target changes and holds when it does not', async () => {
    const harness = await mount(splitSession(), wide)
    try {
      // ↓ onto the first hit row: the same target the card already anchored
      // — the reader must not move (deduplicated).
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/✦\s*AI\s*#2\s*◆/)
      // ↓ onto the second hit row (message #9): the target changes and the
      // window jumps to that message's header.
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*❯\s*You\s*#9\s*◆/)
      expect(harness.latest()).not.toMatch(/✦\s*AI\s*#2/)
      // Esc clears the query: recent mode lists the card alone and the
      // reader anchors to the conversation head.
      harness.send('\u001b')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*❯\s*You\s*#1\b/)
      expect(harness.latest()).not.toMatch(/You\s*#9\b/)
    } finally {
      harness.dispose()
    }
  })
})

describe('split focus handoff', () => {
  it('hands the keyboard to the reader on Alt+P and back on Esc, with the reader vocabulary', async () => {
    const harness = await mount(splitSession(), wide)
    try {
      harness.send('\u001bp') // focus the reader
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      // The hint line switches to the reader vocabulary.
      expect(harness.latest()).toMatch(/back\s*to\s*list/)
      // The reader holds the keyboard: typing is swallowed...
      harness.send('x')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).not.toMatch(/⌕\s*needlex/)
      // ...PgDn pages by the split viewport (9 rows: the cursor lands on
      // message #6)...
      harness.send('\u001b[6~')
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*✦\s*AI\s*#6/)
      // ...arrows step by message (three ↓ merged in one chunk: #6 → #9);
      // the forced repaint doubles as the unrelated-repaint dedup check —
      // the manually moved cursor was NOT yanked back to the selection
      // anchor...
      harness.send('\u001b[B\u001b[B\u001b[B')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*❯\s*You\s*#9/)
      expect(harness.latest()).not.toMatch(/✦\s*AI\s*#2/)
      // ...n walks the hits (wrapping to the first), Alt+C copies the
      // cursor's message ('[AI]\nneedle one' = 15 chars).
      harness.send('n')
      await waitFor()
      await waitForMatch(() => harness.all(), /Hit\s*1\/2/)
      harness.send('\u001bc')
      await waitFor()
      expect(harness.all()).toMatch(/Copied\s*15\s*chars/)
      // Esc hands focus back; the reader pane STAYS VISIBLE and the list
      // hint vocabulary returns...
      harness.send('\u001b')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
      expect(harness.latest()).toMatch(/Alt\+P\s*preview/)
      // ...and typing filters again; zero results dismiss the reader with
      // the selection.
      harness.send('x')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*needlex/)
      expect(harness.latest()).not.toMatch(/Read-only\s*preview/)
      // Backspace restores the query, the selection and the reader.
      harness.send('\u007f')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps Alt+P inert on an empty list, matching the classic no-op', async () => {
    const harness = await mount(splitSession(), wide)
    try {
      // The sweep streams sessions in: wait until the card row exists so
      // the 'x' empties a REAL results list (and, later, Esc restores one).
      await waitForMatch(() => harness.all(), /Preview\s*wiring/)
      // 'x' empties the results and dismisses the reader with the selection.
      harness.send('x')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Read-only\s*preview/)
      // Nothing is selected, so the chord must not flip into the reader
      // focus (the classic branch no-ops the same way, REVIEW R-057): the
      // hint line keeps the list vocabulary...
      harness.send('\u001bp')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).not.toMatch(/back\s*to\s*list/)
      // ...and Esc is therefore the list-mode Esc: it clears the query and
      // the reader returns with the recent list — instead of backing out of
      // a focus handoff that never happened, which would keep the empty
      // query and the reader dismissed.
      harness.send('\u001b')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
    } finally {
      harness.dispose()
    }
  })
})

describe.skipIf(!generation10)('split wheel locality', () => {
  it('routes the wheel to the hovered pane without moving the other', async () => {
    const harness = await mount(splitSession(), { ...wide, fullscreen: true })
    try {
      // Wheel down over the LIST (col 30): the selection moves off the card
      // onto the first hit row...
      harness.send(wheelAt(30, 6, 65))
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*#2\s*AI/)
      expect(harness.latest()).not.toMatch(/❯\s*Preview\s*wiring/)
      // ...and the reader did not move: same anchor target, no re-anchor.
      expect(harness.latest()).toMatch(/✦\s*AI\s*#2\s*◆/)
      // Twenty wheel notches over the READER (col 90) while the list holds
      // focus: the reader scrolls to its tail, the selection stays put.
      harness.send(wheelAt(90, 10, 65).repeat(20))
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/You\s*#9\s*◆/)
      expect(harness.latest()).toMatch(/❯\s*#2\s*AI/)
      // One notch back over the list onto the second hit row: the selection
      // target changes, and the reader re-anchors to it.
      harness.send(wheelAt(30, 7, 65))
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*❯\s*You\s*#9\s*◆/)
    } finally {
      harness.dispose()
    }
  }, 20_000)
})

describe.skipIf(!generation10)('split pane context menu', () => {
  it('copies the message under the pointer from the pane', async () => {
    const notify = vi.fn()
    const harness = await mount(splitSession(), { ...wide, fullscreen: true, notify })
    try {
      // Right-press inside the pane's scroll region: terminal row 9 = body
      // localRow 1 = window line 3 = message #2's body row — its message
      // ('[AI]\nneedle one' = 15 chars) is what the item copies.
      harness.rightClickAt(90, 9)
      await waitFor()
      expect(harness.latest()).toMatch(/Copy\s*message\s*text/)
      harness.clickAt(95, 10)
      await waitFor()
      const [text, tone] = notify.mock.calls[0] ?? []
      expect(text).toBe('Copied 15 chars to clipboard')
      expect(tone).toBe('info')
    } finally {
      harness.dispose()
    }
  })
})

describe.skipIf(!generation10)('split pointer into the list from reader focus', () => {
  it('answers wheel, hover and click on the list while the reader holds the keyboard', async () => {
    const harness = await mount(splitSession(), { ...wide, fullscreen: true })
    try {
      // The sweep streams sessions in: wait until the card row exists, so
      // the Alt+P handoff has a selection to hand over.
      await waitForMatch(() => harness.all(), /Preview\s*wiring/)
      harness.send('\u001bp') // reader focus
      await waitFor()
      // The wheel already answered the list from reader focus (the
      // area-local wheel): one notch over the list column steps the
      // selection off the card onto the first hit row...
      harness.send(wheelAt(30, 7, 65))
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*#2\s*AI/)
      expect(harness.latest()).not.toMatch(/❯\s*Preview\s*wiring/)
      // ...hover follows the pointer onto the second hit row (the list
      // rows span the list column, so row 8 = the #9 hit row) — the reader
      // re-anchors to the new target, and the marker leaves #2 (REVIEW
      // R-056: hover/click used to be mode-gated off while the wheel was
      // already live)...
      harness.movePointer(30, 8)
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/You\s*#9\s*◆/)
      expect(harness.latest()).not.toMatch(/❯\s*#2\s*AI/)
      // ...and a click takes the row's open path into the resume confirm.
      harness.clickAt(30, 8)
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Resum[^?\r]{0,20}session\?/)
      // Esc backs out of the confirm; the split root with the reader
      // returns and the scene never closed.
      harness.send('\u001b')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
      expect(harness.closed()).toBe(0)
    } finally {
      harness.dispose()
    }
  })
})

describe('split width gate and classic layout config', () => {
  it('falls back to the classic rendering below 100 columns', async () => {
    const harness = await mount(splitSession(), { columns: 80, rows: 20 })
    try {
      expect(harness.latest()).not.toMatch(/Read-only\s*preview/)
      // Alt+P still opens the classic FULL-SCREEN preview: it carries the
      // log-path row the split pane never shows. (The solo title sits on
      // screen row 1 — the host's row-1 diff quirk keeps it out of captured
      // frames entirely, so the path row is the solo-shape evidence.)
      harness.send('\u001bp')
      await waitFor()
      harness.resize(81, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/wiring-session\.jsonl/)
      // Classic Alt+P anchors a card to the conversation head.
      expect(harness.latest()).toMatch(/You\s*#1/)
    } finally {
      harness.dispose()
    }
  })

  it('crosses the width gate on resize in both directions', async () => {
    const harness = await mount(splitSession(), wide)
    try {
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
      harness.resize(90, 20)
      await waitFor()
      expect(harness.latest()).not.toMatch(/Read-only\s*preview/)
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Read-only\s*preview/)
    } finally {
      harness.dispose()
    }
  })

  it('never splits when the layout config says classic', async () => {
    const harness = await mount(splitSession(), { ...wide, layout: 'classic' })
    try {
      expect(harness.latest()).not.toMatch(/Read-only\s*preview/)
      harness.send('\u001bp')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/wiring-session\.jsonl/)
      expect(harness.latest()).toMatch(/You\s*#1/)
    } finally {
      harness.dispose()
    }
  })
})
