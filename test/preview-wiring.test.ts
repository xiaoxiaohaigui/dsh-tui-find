import { afterAll, describe, expect, it, vi } from 'vitest'
import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { mount, sessionWithMessages, waitFor, waitForMatch } from './harness.js'

setLangOverride('en')
// One language for the whole file (every frame assertion below is en), and
// restored once after ALL describes — a per-describe afterAll would reset
// the override for every later describe in this file.
afterAll(() => setLangOverride(undefined))

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

  it('walks hits with n/N, wrapping at both ends', async () => {
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'middle', 'needle two is longer']))
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.send('n')
      await waitFor()
      expect(harness.all()).toContain('Hit1/2')
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*15\s*chars/)
      harness.send('n')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*25\s*chars/)
      harness.send('N')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*15\s*chars/)
      harness.send('N')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      // N wraps from the first hit back to the last hit.
      expect(harness.latest()).toMatch(/Copied\s*25\s*chars/)
    } finally {
      harness.dispose()
    }
  })

  it('uses rows minus preview chrome for PgDn and copies the cursor message', async () => {
    const harness = await mount(
      sessionWithMessages(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh']),
      { query: '', rows: 10 },
    )
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.all()).toContain('Copied7chars')

      // rows=10 and four fixed preview chrome lines leave a six-line page.
      // Every message is two lines (header + body), so PgDn lands on message 3.
      harness.send('\u001b[6~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest().trim()).toMatch(/9$/)

      harness.send('\u001b[5~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest().trim()).toMatch(/7$/)
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

  it('shows the collapsed remaining count only on the final visible hit', async () => {
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four', 'needle five']))
    try {
      const frame = harness.latest()
      const count = (frame.match(/\(\+2\)/g) ?? []).length
      expect(count).toBe(1)
      expect(frame).toMatch(/needlethree.*\(\+2\)/)
      expect(frame).not.toMatch(/needleone.*\(\+2\)/)
      expect(frame).not.toMatch(/needletwo.*\(\+2\)/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the collapsed remaining count visible while its row is selected', async () => {
    const harness = await mount(sessionWithMessages(['needle one', 'needle two', 'needle three', 'needle four', 'needle five']))
    try {
      // The (+2) tail rides the final visible hit row; selecting that row
      // must not hide it — the collapsed card has no other place reporting
      // its remaining hits. The resize forces a full repaint so the SELECTED
      // row's screen content is asserted, not just the incremental diff
      // (unchanged tail cells never appear in a diff frame).
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/needle\s*three.*\(\+2\)/)
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
      // stay — asserted on the final full-repaint frame, i.e. the replaced
      // list state itself rather than the pre-replacement frames all()
      // would also accept.
      await waitForMatch(() => harness.all(), /First\s*session/)
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/First\s*session/)
      expect(harness.latest()).toMatch(/Second\s*session/)
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
