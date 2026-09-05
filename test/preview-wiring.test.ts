import { afterAll, describe, expect, it } from 'vitest'
import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { mount, sessionWithMessages, waitFor } from './harness.js'

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
      // The doubled flush gap (PARTIAL_FLUSH_MS) can lag the arrival's
      // render behind the gate by a frame, and a parallel test run slows
      // the write-out further — wait long enough for the flush frame to
      // land before asserting on the cumulative stream.
      firstGate.resolve()
      await waitFor(300)
      expect(harness.all()).toMatch(/Second\s*session/)
      secondGate.resolve()
      await waitFor(300)
      // The completed sweep replaces the accumulation; the streamed rows stay.
      expect(harness.all()).toMatch(/First\s*session/)
      expect(harness.all()).toMatch(/Second\s*session/)
    } finally {
      harness.dispose()
    }
  })

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
})
