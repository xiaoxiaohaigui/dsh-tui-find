import { afterAll, describe, expect, it, vi } from 'vitest'

// The fold badge's hover highlight is a STYLE, and chalk strips escapes
// off-TTY, so the styling case below needs coloured output. `vi.hoisted` runs
// before this file's imports, i.e. before chalk resolves FORCE_COLOR at module
// load; every other assertion reads ANSI-stripped frames, so the extra
// escapes change nothing for them — and a state that MUST leave no highlight
// (badge not hovered) is asserted on their absence.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1'
})

import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { glyphStyle, hasBackground, mount, sessionWithMessages, waitFor, waitForMatch } from './harness.js'
import type { Harness } from './harness.js'

setLangOverride('en')
// One language for the whole file (every frame assertion below is en), and
// restored once after ALL describes — a per-describe afterAll would reset the
// override for every later describe in this file.
afterAll(() => setLangOverride(undefined))

/** The last frame, once a full repaint has actually landed on it: each round
 *  triggers a resize (the only thing that forces a full repaint) and then
 *  polls `latest()` until every pattern matches, re-triggering if the frame a
 *  dense render stream is still writing gets captured mid-flight.
 *
 *  Two known flake classes meet here (REVIEW R-058/R-046 and R-088): a diff
 *  frame that suppresses or mangles content, and a capture taken while the
 *  frame is still being written — a screen dump showed `First session` torn
 *  to `First sesion` under a full parallel run. A full repaint after the
 *  render queue drains fixes both, so each round resizes first and polls
 *  between rounds; the caller keeps its own `expect` so a deadline miss still
 *  surfaces as a normal assertion diff, never a helper error. */
async function paintedFrame(
  harness: Harness,
  patterns: readonly RegExp[],
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = harness.latest()
  for (;;) {
    harness.toggleWidth()
    const roundDeadline = Math.min(Date.now() + 200, deadline)
    do {
      await waitFor(20)
      frame = harness.latest()
    } while (!patterns.every(pattern => pattern.test(frame)) && Date.now() < roundDeadline)
    if (patterns.every(pattern => pattern.test(frame)) || Date.now() >= deadline) return frame
  }
}

/** The SGR run in front of EVERY occurrence of `glyph` in a raw frame, in
 *  frame order. `glyphStyle` reads the last one only, which cannot tell "the
 *  badge the pointer is on" from "the badge that inherited its cell" — the
 *  exact confusion behind REVIEW R-068, where the leftover fill landed on a
 *  different card than the one under the pointer. Empty string where an
 *  occurrence carries no run of its own (an unstyled badge). */
function glyphRuns(frame: string, glyph: string): string[] {
  const runs: string[] = []
  for (let at = frame.indexOf(glyph); at >= 0; at = frame.indexOf(glyph, at + 1)) {
    runs.push(/((?:\u001b\[[0-9;]*m)+)[^\S\r\n]*$/.exec(frame.slice(0, at))?.[1] ?? '')
  }
  return runs
}

describe('preview scene wiring', () => {
  it('owns preview typing and returns through preview, query, then close layers', async () => {
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'tail']))
    try {
      harness.send('\u001bp')
      await waitFor()

      harness.send('x')
      await waitFor()
      harness.send('\u001b')
      await waitFor()
      expect(harness.all()).not.toContain('needlex')
      expect(harness.latest()).toContain('needle')

      harness.send('\u001b')
      await waitFor()
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)

      harness.send('\u001b')
      await waitFor()
      expect(harness.closed()).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it('walks hits with n/N from the visible window, wrapping at both ends', async () => {
    // Twelve short messages at the 7-row solo viewport: the reader opens on
    // the card's first hit (#2) and each press of n/N scrolls the window to
    // the next hit. Alt+C copies the hit the navigator parked on and names
    // it in the status, so that note is the proof the target moved with it.
    const harness = await mount(
      sessionWithMessages([
        'one',
        'needle one',
        'three',
        'four',
        'five',
        'six',
        'seven',
        'eight',
        'needle two is longer',
        'ten',
        'eleven',
        'twelve',
      ]),
    )
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.send('n')
      await waitFor()
      expect(harness.all()).toMatch(/Hit\s*2\/2/)
      harness.send('\u001bc')
      await waitFor()
      // '[You]' + newline + 'needle two is longer' = 26: the status names
      // the hit it took, not just its size.
      expect(harness.latest()).toMatch(/Copied hit 2\/2 · You \(26 chars\)/)
      harness.send('N')
      await waitFor()
      expect(harness.all()).toMatch(/Hit\s*1\/2/)
      harness.send('\u001bc')
      await waitFor()
      // '[AI]' + newline + 'needle one' = 15.
      expect(harness.latest()).toMatch(/Copied hit 1\/2 · AI \(15 chars\)/)
      harness.send('N')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      // N wraps from the first hit back to the last hit.
      expect(harness.latest()).toMatch(/Copied hit 2\/2 · You \(26 chars\)/)
    } finally {
      harness.dispose()
    }
  })

  it('pages by the viewport with PgUp/PgDn, and Alt+C falls back to the top message without hits', async () => {
    const harness = await mount(
      sessionWithMessages(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh']),
      { query: '', rows: 10 },
    )
    try {
      // Each step asserts on a resize-forced FULL repaint: a status-row
      // overwrite only ever emits its changed cells in a diff frame, so
      // 'Copied 9 chars' would otherwise read back as a lone '9'.
      harness.send('\u001bp')
      await waitFor()
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      harness.resize(81, 10)
      await waitFor()
      // An empty query has no message hits, so the reader keeps the
      // top-of-viewport fallback: one row of scrolling from the head opens
      // the window on line 1 — message #2's body 'bb' — and Alt+C copies
      // THAT message: '[AI]' + newline + 2 chars = 7.
      expect(harness.latest()).toMatch(/Copied\s*7\s*chars/)

      // rows=10 and five fixed preview chrome lines leave a five-line page,
      // and every message here is two lines (header + body): PgDn moves the
      // window from line 1 to line 6, i.e. onto message #4's header — the
      // copy follows the window to that message: '[AI]' + 1 + 4 = 9.
      harness.send('\u001b[6~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      harness.resize(80, 10)
      await waitFor()
      const paged = harness.latest()
      expect(paged).toMatch(/Copied\s*9\s*chars/)
      // The window really moved: it opens on #4 and the earlier messages are
      // gone from the viewport (which holds #4..#6 of the eight).
      expect(paged).toMatch(/AI\s*#4/)
      expect(paged).toMatch(/AI\s*#6/)
      expect(paged).not.toMatch(/You\s*#1\b/)

      // PgUp returns the window to line 1, and the copy follows it there.
      harness.send('\u001b[5~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      harness.resize(81, 10)
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*7\s*chars/)
    } finally {
      harness.dispose()
    }
  })

  it('expands all message hits from the selected session card', async () => {
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four']))
    try {
      // The card initially shows three child hit rows; Alt+E on the card must
      // expand the fourth without first moving the selection to a child row.
      expect(harness.latest()).not.toContain('needle four')
      harness.send('\u001be')
      await waitFor()
      // Move into the newly appended row so it enters the fitted viewport.
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitFor()
      expect(harness.all()).toContain('four')
    } finally {
      harness.dispose()
    }
  })

  it('folds and unfolds from the badge without taking the row\'s resume path', async () => {
    // The reported gap: a card with more than three hits offers Alt+E on the
    // keyboard and nothing for the mouse. The count now rides a chevron badge
    // on the final visible hit row, right-aligned on the list surface;
    // clicking it must fold THAT card and must not fall through to the row's
    // own click, which opens the resume confirmation (the host dispatches to
    // the deepest node and honours the bubble-stop). Geometry at 80x20:
    // header row 1, search card 2-4, card title/meta 5-6, hit rows 7-9 — the
    // badge spans the last seven columns of row 9 (measured by probing every
    // column: 75-80 fold, 74 and left resume).
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four']), {
      columns: 80,
      rows: 20,
      layout: 'classic',
      fullscreen: true,
    })
    try {
      harness.resize(81, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/▸\s*\(\+1\)/)
      harness.clickAt(77, 9)
      await waitFor()
      harness.resize(80, 20)
      await waitFor()
      const opened = harness.latest()
      // The fold ran: the fourth hit row exists and the badge flipped to the
      // way back.
      expect(opened).toContain('four')
      expect(opened).toMatch(/▴\s*less/)
      // ...and the row's own action never ran — a click that reached it would
      // have replaced the whole screen with the resume confirm.
      expect(opened).not.toMatch(/Resum[^?\r]{0,20}session\?/)

      // The same badge folds it back: the expanded card spends one more row
      // (the fourth hit), so the badge moved down with it — the mouse path
      // stays symmetric, or expanding by mouse would be a one-way door.
      harness.clickAt(77, 10)
      await waitFor()
      harness.resize(81, 20)
      await waitFor()
      const closed = harness.latest()
      expect(closed).toMatch(/▸\s*\(\+1\)/)
      expect(closed).not.toContain('four')
      expect(closed).not.toMatch(/Resum[^?\r]{0,20}session\?/)
    } finally {
      harness.dispose()
    }
  }, 20_000)

  it('advertises the badge as clickable on hover and restores it on leave', async () => {
    // A passive `(+N)` taught nothing; the badge is a control. Its hover
    // highlight is the host's own clickable-affordance treatment (the
    // `userMessageBackgroundHover` fill ClickableDivider and the todo fold
    // use). Asserted on the raw stream: this is a STYLE, and `latest()`
    // strips exactly the escape that carries it — and asserted as
    // "carries a background at all", not as one colour, because the palette
    // depth follows the host generation. No resize between hovering and
    // reading: the host drops its hover set on a resize (the geometry it was
    // computed against is gone), which would read as a leave.
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four']), {
      columns: 80,
      rows: 20,
      layout: 'classic',
      fullscreen: true,
    })
    try {
      harness.resize(81, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/▸\s*\(\+1\)/)
      // The selected row's own tint rides the row box, not the badge: the
      // badge's own run carries no fill until the pointer reaches it.
      expect(hasBackground(glyphStyle(harness.rawLatest(), '▸'))).toBe(false)

      harness.movePointer(77, 9)
      await waitFor(200)
      expect(hasBackground(glyphStyle(harness.rawLatest(), '▸'))).toBe(true)

      // Leaving for another cell of the SAME row (the row stays hovered and
      // selected, so only the badge's own state changes) drops the fill. The
      // resize then forces a full repaint, which is what makes the assertion
      // about the leave handler rather than about the host's own hover
      // bookkeeping.
      harness.movePointer(20, 9)
      await waitFor(150)
      harness.resize(80, 20)
      await waitFor()
      expect(hasBackground(glyphStyle(harness.rawLatest(), '▸'))).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the badge hover off a neighbouring card when a keyboard fold rewrites the rows', async () => {
    // The reported leftover (REVIEW R-068): the hover tint was keyed by ROW
    // INDEX, and folding rewrites which row sits at which index — so the
    // index the hovered badge occupied came to name the NEXT card's badge
    // and painted a tint onto a control the pointer was nowhere near. The
    // host could not correct it either: its hover bookkeeping only fires
    // `onMouseLeave` on nodes that are still mounted, and a keyboard fold
    // (Alt+E) sends no pointer event at all.
    //
    // Geometry at 81x30 classic, exactly the review's probe: A holds 7 hits
    // and B 4. Expanded, A's badge rides flat row 7 (terminal row 13) — the
    // pointer hovers THERE. Folding A drops its badge back to flat row 3,
    // which moves B's badge onto flat row 7: the collision. The tint is
    // asserted in the FOLD FRAME, not after a repaint — a repaint makes the
    // stale value vanish (the host's own hover reset reaches the recycled
    // node), so a resize between the fold and the read would hide the bug.
    const alpha: ScannedSession = {
      ...sessionWithMessages(['needle alpha one', 'needle alpha two', 'needle alpha three', 'needle alpha four', 'needle alpha five', 'needle alpha six', 'needle alpha seven']),
      id: 'alpha-session',
      title: 'Alpha',
    }
    const bravo: ScannedSession = {
      ...sessionWithMessages(['needle bravo one', 'needle bravo two', 'needle bravo three', 'needle bravo four']),
      id: 'bravo-session',
      title: 'Bravo',
    }
    const harness = await mount(alpha, {
      columns: 80,
      rows: 20,
      layout: 'classic',
      fullscreen: true,
      scanner: { scan: async () => [alpha, bravo] },
    })
    try {
      harness.resize(81, 30)
      await waitFor(200)
      harness.resize(81, 30)
      await waitFor(200)
      // Folded to start with: both cards show three hits and a badge.
      expect(harness.latest()).toMatch(/▸\s*\(\+4\)/)
      expect(harness.latest()).toMatch(/▸\s*\(\+1\)/)
      // Expand A (the selection sits on its card, flat row 0) so its badge
      // moves onto flat row 7 — the row B's badge will land on after the
      // fold. Then hover it: the pointer is provably on a badge, so the tint
      // assertions below are about the hover staying put, not about hover
      // never having worked.
      harness.send('\u001be')
      await waitFor(200)
      harness.resize(81, 30)
      await waitFor(200)
      expect(harness.latest()).toMatch(/▴\s*less/)
      harness.movePointer(77, 13)
      await waitFor(250)
      const hovering = harness.rawLatest()
      // The tint is on the badge under the pointer and on no other: A's
      // expanded badge (`▴`) carries the fill, and B's `▸` badge does not. So
      // a hover that never worked, or that bled onto the neighbouring card
      // from the start, fails here rather than passing the fold below.
      expect(hasBackground(glyphStyle(hovering, '▴'))).toBe(true)
      for (const run of glyphRuns(hovering, '▸')) expect(hasBackground(run)).toBe(false)

      // Alt+E folds A. The pointer has not moved a cell: A's expanded badge
      // (and the whole row it sat on) is gone, and B's badge now occupies
      // that cell. No badge in the fold frame may carry a fill — the tint
      // belongs to the control that was hovered, and it must die with it
      // rather than be inherited by whatever control takes the cell. This is
      // the assertion the index-keyed state failed (it painted B's badge),
      // and it is deliberately read from the FOLD FRAME with no repaint in
      // between: the next repaint corrects the tint anyway (the host resets
      // its hover bookkeeping), which is why the defect only ever showed as
      // a transient — and why a resize before the read would hide it.
      //
      // The fix has two halves and this case covers both: the tint lives on
      // the badge itself (so it dies with it), and the rows carry stable
      // React keys (so React UNMOUNTS the folded-away badge instead of
      // recycling that same component onto the next card's badge, hover
      // state and all). Rotating either half alone back leaves this case red.
      harness.send('\u001be')
      await waitFor(250)
      expect(harness.latest()).toMatch(/▸\s*\(\+4\)/)
      const runs = glyphRuns(harness.rawLatest(), '▸')
      expect(runs).toHaveLength(2)
      for (const run of runs) expect(hasBackground(run)).toBe(false)
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('shows the fold badge only on the final visible hit', async () => {
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four', 'needle five']))
    try {
      // A resize forces a full repaint: the mount frame is a diff, and a
      // partly-painted card would fail the row-shape assertions below for a
      // reason that has nothing to do with the badge.
      harness.resize(81, 12)
      await waitFor()
      const frame = harness.latest()
      const count = (frame.match(/\(\+2\)/g) ?? []).length
      expect(count).toBe(1)
      expect(frame).toMatch(/needle\s*three.*▸\s*\(\+2\)/)
      expect(frame).not.toMatch(/needle\s*one.*\(\+2\)/)
      expect(frame).not.toMatch(/needle\s*two.*\(\+2\)/)
    } finally {
      harness.dispose()
    }
  })

  it('leaves the fold control off a card that has nothing to fold', async () => {
    // Exactly three hits: every hit is already visible, so there is no fold
    // state to reach and no control to click. A badge here would offer a
    // click that does nothing.
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three']))
    try {
      const frame = harness.latest()
      expect(frame).toContain('needle three')
      expect(frame).not.toMatch(/\(\+0\)/)
      expect(frame).not.toMatch(/[▸▴]/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the collapsed fold badge visible while its row is selected', async () => {
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four', 'needle five']))
    try {
      // The badge rides the final visible hit row; selecting that row must
      // not hide it — the collapsed card has no other place reporting its
      // remaining hits, nor any other stretch of the row that folds. The
      // resize forces a full repaint so the SELECTED row's screen content is
      // asserted, not just the incremental diff (unchanged tail cells never
      // appear in a diff frame).
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/needle\s*three.*▸\s*\(\+2\)/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps a narrow preview header on one physical row', async () => {
    const base = sessionWithMessages(['body'])
    const session: ScannedSession = {
      ...base,
      messages: base.messages.map(message => ({ ...message, seq: Number.MAX_SAFE_INTEGER })),
    }
    const harness = await mount(session, { query: '', columns: 20, rows: 12 })
    try {
      harness.send('\u001bp')
      await waitFor()
      // The marker consumes two columns; the remaining header is truncated
      // with an ellipsis instead of wrapping into the one-weight scroll list.
      // (\s* not \s+: the diff-based repaint skips cells that already held a
      // space in the previous frame, so the stripped stream can drop the one
      // between the role label and the seq without the row being wrapped.)
      expect(harness.all()).toMatch(/You\s*#9007199254…/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the reader hint on one row and the scroll region whole when the terminal is narrow', async () => {
    // The hint is width- and language-dependent (the full line paints 70
    // columns in en, 67 in zh), so a narrow pane drops its lowest-priority
    // segments instead of letting the row wrap — a wrapped hint used to eat
    // one of the reader's rows (REVIEW R-070). rows=12 leaves a seven-line
    // window, and the fourth message's header is its last line.
    for (const [lang, columns] of [['en', 40], ['zh', 66]] as const) {
      setLangOverride(lang)
      const harness = await mount(sessionWithMessages(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff']), {
        query: '',
        columns,
        rows: 12,
      })
      try {
        harness.send('\u001bp')
        await waitFor()
        const frame = harness.all()
        // Scroll and the way out share ONE physical row...
        expect(frame).toMatch(/↑↓\s*(?:scroll|滚动)[^\n]*(?:Esc\s*back to list|Esc\s*返回列表)/)
        // ...and the window still shows its whole seven lines.
        expect(frame).toMatch(/✦\s*AI\s*#4/)
      } finally {
        harness.dispose()
      }
    }
    setLangOverride('en')
  })

  it('opens a deep hit scrolled into view instead of on the message head', async () => {
    // A hit far into a long message cannot sit in the 7-row solo viewport
    // below its own header; anchoring on the header would open the reader
    // with the keyword off screen, which is the reader's whole job. The
    // window must land on the hit's own line.
    const text = `${'pad '.repeat(120)}deepneedle marker tail`
    const harness = await mount(sessionWithMessages(['intro', text, 'tail']), { rows: 12 })
    try {
      await waitForMatch(() => harness.all(), /deepneedle/)
      // ↓ onto the hit row, then Alt+P: the classic anchor path.
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001bp')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      const frame = harness.latest()
      expect(frame).toMatch(/deepneedle/)
      // The message header scrolled off the top: the header-anchored landing
      // shows it instead of the keyword.
      expect(frame).not.toMatch(/✦\s*AI\s*#2\s*◆/)
      // `n` walks the hits through the same landing.
      harness.send('n')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/deepneedle/)
      expect(harness.latest()).not.toMatch(/✦\s*AI\s*#2\s*◆/)
    } finally {
      harness.dispose()
    }
  })
})

describe('help panel wiring', () => {
  it('opens with Alt+H, swallows typing, and returns through Alt+H and Esc', async () => {
    const harness = await mount(sessionWithMessages(['intro']))
    try {
      harness.send('\u001bh')
      await waitFor()
      // The panel body paints (sections, rows, footer). Frame-level capture
      // quirks exist around the host renderer's cell diff (row 1 and the
      // close frame), so the assertions below stay on cumulative-stream and
      // mode-level evidence rather than exact final frames.
      expect(harness.all()).toMatch(/Toggle\s*regex/)
      // Typing on the help screen must never leak into the query.
      harness.send('x')
      await waitFor()
      expect(harness.all()).not.toContain('needlex')
      // Alt+H closes the panel; Esc then clears the query — proof the scene
      // is really back in list mode answering its own keys again.
      harness.send('\u001bh')
      await waitFor()
      harness.send('\u001b')
      await waitFor()
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)
    } finally {
      harness.dispose()
    }
  })
})

describe('resume confirm wiring', () => {
  it('swallows an arrow that follows Enter in the same stdin block', async () => {
    // Enter opens the resume confirm; a later key of the same chunk must
    // read the mode Enter already chose (the modeRef mirror write) and hit
    // the confirm branch's swallow, not the list branch behind the pane
    // (REVIEW R-055; same merged-block class as the R-054 menu case). The
    // ESC-prefixed arrow parses fully within the chunk, so the two keys
    // provably share one batch — the Esc variant lives in the sibling case.
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'tail']))
    try {
      // The sweep streams sessions in: wait until the card row exists, or
      // Enter lands on an empty list and beginResume legitimately no-ops.
      await waitForMatch(() => harness.all(), /Preview\s*wiring/)
      harness.send('\r\u001b[B')
      await waitFor()
      // The confirm pane did open — guards against a vacuous pass where
      // Enter never reached beginResume at all.
      expect(harness.all()).toMatch(/Resum[^?\r]{0,20}session\?/)
      harness.send('\u001b')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*Preview\s*wiring/)
      expect(harness.latest()).not.toMatch(/❯\s*#2\s*AI/)
    } finally {
      harness.dispose()
    }
  })

  it('backs out of the confirm when Esc follows Enter in the same stdin block', async () => {
    // The review's R-055 scenario: the chunk's Esc must read the mode Enter
    // already chose (the modeRef mirror write) and take the confirm branch's
    // back-out — a render-synced mirror still reads 'list' and takes the
    // list-mode Esc, which clears the query and strands the confirm pane.
    // Shape notes (probed against the host tokenizer): a lone trailing ESC
    // is held out of the batch entirely, and CR absorbs a following
    // printable into one mangled token that is neither Return nor text — so
    // a plain '\r\u001b' or '\rx' cannot express this bug. The second ESC
    // forces the first out as a real Escape key and the '[B' suffix
    // completes that second sequence: all three keys land in one batch.
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'tail']))
    try {
      // The sweep streams sessions in: wait until the card row exists, or
      // Enter lands on an empty list and beginResume legitimately no-ops.
      await waitForMatch(() => harness.all(), /Preview\s*wiring/)
      harness.send('\r\u001b\u001b[B')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      // Esc backed out of the confirm — the batched confirm→list transition
      // settles on the list root and the pane never paints...
      expect(harness.latest()).not.toMatch(/Resum[^?\r]{0,20}session\?/)
      // ...the query survived, and the chunk's ↓ legitimately moved the
      // selection onto the hit row in the restored list focus.
      expect(harness.latest()).toMatch(/⌕\s*needle/)
      expect(harness.latest()).toMatch(/❯\s*#2\s*AI/)
    } finally {
      harness.dispose()
    }
  })
})

describe('search filter and scan streaming wiring', () => {
  it('narrows matches to session titles with Alt+N and back', async () => {
    const base = sessionWithMessages(['needle one', 'needle two'])
    const titled: ScannedSession = { ...base, title: 'Needle session title' }
    const harness = await mount(titled)
    try {
      harness.send('\u001bn')
      await waitFor()
      // A resize forces a full repaint so the frame (not the cumulative
      // stream) can be asserted for both presence and absence; the stripped
      // frame glues words when diff cells skip unchanged spaces, so content
      // assertions stay on whitespace-tolerant regexes.
      harness.resize(81, 12)
      await waitFor()
      const frame = harness.latest()
      expect(frame).toMatch(/Title-only\s*search:\s*on/)
      expect(frame).toMatch(/Needle\s*session\s*title/)
      expect(frame).not.toMatch(/#1/)
      harness.send('\u001bn')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/#1/)
    } finally {
      harness.dispose()
    }
  })

  it('streams scan results in before the sweep completes', async () => {
    const first: ScannedSession = { ...sessionWithMessages(['needle first']), id: 'first-session', title: 'First session' }
    const second: ScannedSession = { ...sessionWithMessages(['needle second']), id: 'second-session', title: 'Second session' }
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const firstGate = gate()
    const secondGate = gate()
    const scanner = {
      scan: async (scanOptions: { onSession?: (session: ScannedSession) => void }) => {
        scanOptions.onSession?.(first)
        await firstGate.promise
        scanOptions.onSession?.(second)
        await secondGate.promise
        return [first, second]
      },
    }
    const harness = await mount(first, { scanner })
    try {
      // The first resolved session is on screen while the sweep is still
      // gated; the second does not exist for the scene yet. Header counts
      // stay out of the assertions on purpose: the host renderer's row-1
      // diff quirk keeps the header out of captured frames after the first.
      // Presence rides a resize-forced full-repaint frame (diff frames can
      // suppress the streamed rows); absence rides the cumulative stream.
      await waitFor(200)
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/First\s*session/)
      expect(harness.all()).not.toMatch(/Second\s*session/)
      // The doubled flush gap (PARTIAL_FLUSH_MS in find-types.ts, doubling
      // per flush up to PARTIAL_FLUSH_MAX_MS) can lag the arrival's render
      // behind the gate by a frame, and a parallel run or a cold working
      // tree (the host-matrix copies) slows the write-out further. No fixed
      // sleep covers that — a wide one slows every passing run and still
      // loses under load — so poll the cumulative stream against a deadline;
      // the expects after the waits turn a deadline miss into a normal diff
      // failure instead of a load-dependent flake.
      firstGate.resolve()
      await waitForMatch(() => harness.all(), /Second\s*session/)
      // The streamed row rides a diff frame, and a torn diff capture can
      // drop interior cells from the cumulative stream ('Second session' →
      // 'Second sesion' flaked once in the 09-13 review round; the
      // split-wiring header records the same quirk for first frames). The
      // presence assertion rides a resize-forced full repaint, which
      // rewrites every cell and cannot carry a tear. No fixed wait covers
      // the poll itself, so a deadline miss still resolves here and the
      // frame assertion below turns it into a normal diff failure.
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Second\s*session/)
      secondGate.resolve()
      // The completed sweep replaces the accumulation; the streamed rows
      // stay — asserted on a full-repaint frame, i.e. the replaced list state
      // itself rather than the pre-replacement frames all() would also
      // accept. This is the one presence check with BOTH rows required, and
      // it is where the frame used to come out torn under load (REVIEW R-088:
      // the screen dump read `First sesion`), so it rides the polling
      // full-repaint helper instead of a single resize + fixed wait.
      await waitForMatch(() => harness.all(), /First\s*session/)
      const frame = await paintedFrame(harness, [/First\s*session/, /Second\s*session/])
      expect(frame).toMatch(/First\s*session/)
      expect(frame).toMatch(/Second\s*session/)
    } finally {
      harness.dispose()
    }
    // 20s vitest budget: the two sequential 5s waitForMatch deadlines plus
    // mount/repaint overhead must fit inside it, or vitest preempts the
    // diagnostic expects on a loaded machine and reports a bare timeout.
  }, 20_000)

  it('shows the reading notice while a query sweep has resolved nothing yet', async () => {
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const onlyGate = gate()
    const scanner = {
      scan: async (scanOptions: { onProgress?: (progress: unknown) => void }) => {
        // The real scanner reports progress before the first session lands;
        // mirror that so the scene's sweep-in-flight state is reached.
        scanOptions.onProgress?.({ resolved: 0, total: 1, decodedBytes: 0, resumed: 0 })
        await onlyGate.promise
        return []
      },
    }
    const harness = await mount(sessionWithMessages(['needle body']), { scanner, query: 'needle' })
    try {
      // Results mode with zero resolved sessions must show the reading
      // notice, not a premature "no matching sessions". Both states are
      // asserted on resize-forced full-repaint frames: diff frames mangle
      // overwrites of this row (cells skip unchanged spans), and the
      // pre-effect first frame flashes the empty state into all().
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Reading\s*sessions/)
      expect(harness.latest()).not.toMatch(/No\s*matching/)
      onlyGate.resolve()
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/No\s*matching/)
      expect(harness.latest()).not.toMatch(/Reading\s*sessions/)
    } finally {
      harness.dispose()
    }
  })

  it('mirrors copy feedback onto the host toast channel', async () => {
    const notify = vi.fn()
    const harness = await mount(sessionWithMessages(['needle body']), { notify })
    try {
      // ↓ moves onto the hit row (cards have no message to copy), then
      // Alt+C copies it. The footer note stays the in-scene channel and the
      // notifier rides along (0.9.x hosts without the toast service simply
      // pass no spy — the footer stands alone).
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      // The cumulative stream, not the latest diff frame: a status-row
      // overwrite can be suppressed by the renderer's diff frames.
      expect(harness.all()).toMatch(/Copied\s*\d+\s*chars/)
      expect(notify).toHaveBeenCalledTimes(1)
      const [text, tone] = notify.mock.calls[0] ?? []
      expect(text).toMatch(/^Copied \d+ chars to clipboard$/)
      expect(tone).toBe('info')
    } finally {
      harness.dispose()
    }
  })
})
