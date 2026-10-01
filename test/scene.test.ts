import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectionMarker, wheelRows } from '../src/find-types.js'
import { composeHeaderRight } from '../src/find-chrome.js'
import { setLangOverride } from '../src/i18n.js'
import { useSessionSweep } from '../src/find-sweep.js'
import type { ScanProgress, ScannedSession } from '../src/core/scan.js'
import type { StatusNote } from '../src/find-types.js'
import { mount, sessionWithMessages, waitFor, type HarnessSceneProps } from './harness.js'

setLangOverride('en')
// One language for the whole file (every frame assertion below is en), and
// restored once after ALL describes — a per-describe afterAll would reset
// the override for every later describe in this file.
afterAll(() => setLangOverride(undefined))

describe('wheelRows', () => {
  it('moves by the notch size the host reports, not one row', () => {
    // The host sends ±3 per notch on its own screens; a /find surface must
    // scroll at the same speed instead of collapsing the delta to one row.
    expect(wheelRows(3)).toBe(3)
    expect(wheelRows(-3)).toBe(-3)
    expect(wheelRows(1)).toBe(1)
    expect(wheelRows(-1)).toBe(-1)
    // Oversized and fractional deltas normalize to a whole-row step of at
    // least one; a zero-height delta is still nothing.
    expect(wheelRows(5)).toBe(5)
    expect(wheelRows(0.4)).toBe(1)
    expect(wheelRows(-0.4)).toBe(-1)
    expect(wheelRows(0)).toBe(0)
    expect(wheelRows(Number.NaN)).toBe(0)
    expect(wheelRows(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('ignores horizontal-only wheel events', () => {
    expect(wheelRows(0, 1)).toBe(0)
    expect(wheelRows(0, -1)).toBe(0)
    // A diagonal event still scrolls vertically (deltaY wins).
    expect(wheelRows(-3, 3)).toBe(-3)
  })
})

describe('selectionMarker', () => {
  it('keeps title and message arrows in the same column', () => {
    expect(selectionMarker(true)).toBe('❯ ')
    expect(selectionMarker(false)).toBe('  ')
    expect(selectionMarker(true, 'message')).toBe('❯   ')
    expect(selectionMarker(false, 'message')).toBe('    ')
  })
})

describe('composeHeaderRight (REVIEW R-115)', () => {
  const settled = { recentMode: true, sessionCount: 1, hitSessions: 0, hitTotal: 0 }

  it('appends the withheld-sub-agent count to the live sweep row', () => {
    // The sweep counts withheld logs as resolved, so the row that says how far
    // the sweep got must also say how many rows it will not deliver.
    expect(
      composeHeaderRight({
        ...settled,
        progress: { resolved: 3, total: 3, decodedBytes: 0, resumed: 0, hiddenSubagents: 2 },
        settledHiddenSubagents: 0,
      }),
    ).toBe('Scanning 3/3… · 2 sub-agent sessions hidden')
  })

  it('keeps the count after the sweep lands, when progress is gone', () => {
    // The settled header reads the scene's own state: `progress` is cleared
    // the moment the sweep lands, and the note must not vanish with it.
    expect(composeHeaderRight({ ...settled, progress: undefined, settledHiddenSubagents: 2 })).toBe(
      '1 sessions · 2 sub-agent sessions hidden',
    )
    // A landed sweep's count wins nowhere the live one exists, and vice versa.
    expect(
      composeHeaderRight({
        ...settled,
        progress: { resolved: 3, total: 3, decodedBytes: 0, resumed: 0, hiddenSubagents: 0 },
        settledHiddenSubagents: 2,
      }),
    ).toBe('Scanning 3/3…')
  })

  it('stays silent when nothing was withheld or the switch is on', () => {
    expect(composeHeaderRight({ ...settled, progress: undefined, settledHiddenSubagents: 0 })).toBe('1 sessions')
    expect(
      composeHeaderRight({
        recentMode: false,
        sessionCount: 0,
        hitSessions: 4,
        hitTotal: 9,
        progress: undefined,
        settledHiddenSubagents: 0,
      }),
    ).toBe('4 sessions · 9 hits')
  })

  it('carries the counts and the note together in results mode', () => {
    expect(
      composeHeaderRight({
        recentMode: false,
        sessionCount: 0,
        hitSessions: 4,
        hitTotal: 9,
        progress: undefined,
        settledHiddenSubagents: 1,
      }),
    ).toBe('4 sessions · 9 hits · 1 sub-agent sessions hidden')
  })
})

describe('list-mode key dispatch', () => {
  it('types into the query, deletes whole code points, and lets Ctrl+C pass through', async () => {
    const harness = await mount(sessionWithMessages(['needle body']), { query: '' })
    try {
      harness.send('ab')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*ab/)
      harness.send('\u007f')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*a/)
      // An emoji is one code point over two UTF-16 units: backspace must
      // remove it whole, leaving no lone surrogate behind.
      harness.send('🙂')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/a🙂/)
      harness.send('\u007f')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*a/)
      expect(harness.latest()).not.toMatch(/🙂/)
      // The host delivers Ctrl+C as input 'c' + key.ctrl — hijacking it
      // would break the scene's interrupt path, so it must never type.
      harness.send('\u0003')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*a/)
      expect(harness.closed()).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('toggles scope with Tab and cycles the time window with Alt+T', async () => {
    const harness = await mount(sessionWithMessages(['needle body']), { query: '' })
    try {
      harness.send('\t')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Scope\s*switched\s*to\s*"This\s*repo"/)
      harness.send('\u001bt')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Time\s*range:\s*Last\s*7\s*days/)
      harness.send('\u001bt')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Time\s*range:\s*Last\s*30\s*days/)
      harness.send('\u001bt')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Time\s*range:\s*All\s*time/)
    } finally {
      harness.dispose()
    }
  })

  it('toggles regex with Alt+R and reports an invalid pattern while typing', async () => {
    const harness = await mount(sessionWithMessages(['needle body']), { query: '' })
    try {
      harness.send('\u001br')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Regex\s*matching:\s*on/)
      harness.send('needle[')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/No\s*matching\s*sessions/)
      expect(harness.latest()).toMatch(/Invalid\s*regular\s*expression/)
    } finally {
      harness.dispose()
    }
  })

  it('moves the selection with arrows and pages with PgUp/PgDn, window following', async () => {
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
    const sessions: ScannedSession[] = titles.map((title, index) => ({
      ...sessionWithMessages([`body ${index}`]),
      id: `nav-session-${index}`,
      title,
      modifiedAt: Date.now() - index * 60_000,
    }))
    const harness = await mount(sessions[0]!, {
      query: '',
      scanner: { scan: async () => sessions },
    })
    try {
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      // listHeight is rows-7 = 5 physical lines: four downs land on Delta
      // and the fitted window has scrolled Alpha off the top.
      expect(harness.latest()).toContain('Delta')
      expect(harness.latest()).not.toContain('Alpha')
      harness.send('\u001b[6~')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      // The page jump is rows-7 = 5 rows: from Alpha to Foxtrot.
      expect(harness.latest()).toContain('Foxtrot')
      expect(harness.latest()).not.toContain('Alpha')
      harness.send('\u001b[5~')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toContain('Alpha')
      expect(harness.latest()).not.toContain('Foxtrot')
    } finally {
      harness.dispose()
    }
  })

  it('enters the resume confirm with Enter, backs out with Esc, and reports the host answer', async () => {
    const harness = await mount(sessionWithMessages(['body']), { query: '' })
    try {
      harness.send('\r')
      await waitFor()
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Resume\s*this\s*session\?/)
      expect(harness.latest()).toMatch(/Preview\s*wiring/)
      harness.send('\u001b')
      await waitFor()
      harness.resize(80, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)
      harness.send('\r')
      await waitFor()
      // Plain Enter in confirm commits: the harness channel answers
      // 'cancelled', the scene reports it and returns to the list.
      harness.send('\r')
      await waitFor(300)
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Resume\s*cancelled/)
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)
    } finally {
      harness.dispose()
    }
  })

  it('names the holding process when another TUI terminal occupies the session', async () => {
    // 0.11.0 widened the resume failure union with the occupancy case (it
    // carries a pid, no error string). Without a branch for it the scene fell
    // through to the generic line and printed `Resume failed: undefined`.
    const notify = vi.fn()
    const harness = await mount(sessionWithMessages(['body']), {
      query: '',
      resumeTo: async () => ({ ok: false, reason: 'occupied', pid: 4242 }),
      notify,
    })
    try {
      harness.send('\r')
      await waitFor()
      harness.send('\r')
      await waitFor(300)
      harness.resize(81, 12)
      await waitFor()
      expect(harness.latest()).toMatch(/Resume\s*failed:\s*another\s*TUI\s*terminal/)
      expect(harness.latest()).not.toMatch(/undefined/)
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('holds this session (pid 4242)'), 'error')
    } finally {
      harness.dispose()
    }
  })

  it('reports the host success on a landed resume and closes the scene', async () => {
    // The happy path of the confirm flow. The scene closes itself on a landed
    // resume (the resumed session takes the terminal over), so the transcript
    // is not the assertion surface: the toast is, because it outlives the
    // closing scene — and the close count is what proves the handoff happened
    // rather than the confirm quietly staying up.
    const notify = vi.fn()
    const harness = await mount(sessionWithMessages(['body']), {
      query: '',
      resumeTo: async () => ({ ok: true }),
      notify,
    })
    try {
      harness.send('\r')
      await waitFor()
      harness.send('\r')
      await waitFor(300)
      // One close, from the resume itself: the earlier Esc-backed confirm and
      // the cancelled result both stay on the list.
      expect(harness.closed()).toBe(1)
      expect(notify).toHaveBeenCalledWith('Session resumed', 'info')
    } finally {
      harness.dispose()
    }
  })
})

describe('preview scrolling', () => {
  it('re-anchors the preview on Alt+P and scrolls the window line by line', async () => {
    const harness = await mount(
      sessionWithMessages(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']),
      { query: '', rows: 10 },
    )
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.resize(81, 10)
      await waitFor()
      expect(harness.latest()).toContain('#1')
      for (let index = 0; index < 5; index++) {
        harness.send('\u001b[B')
        await waitFor()
      }
      harness.resize(80, 10)
      await waitFor()
      // Five rows of scrolling from the head: every message is two lines
      // (header + body) in a five-line viewport, so the window now opens on
      // message 3's BODY line and runs through message 5. Arrows move the
      // window ITSELF — no cursor, no per-message stepping — which is why a
      // half-scrolled message (its header gone, its text on top) is a normal
      // frame rather than something the reader would snap away from.
      const scrolled = harness.latest()
      expect(scrolled).toContain('three')
      expect(scrolled).not.toMatch(/You\s*#1\b/)
      expect(scrolled).not.toMatch(/\bone\b/)
      expect(scrolled).toMatch(/AI\s*#4/)
      expect(scrolled).toMatch(/You\s*#5/)
      // ...and ↑ walks back up the same way, to the very top.
      for (let index = 0; index < 5; index++) {
        harness.send('\u001b[A')
        await waitFor()
      }
      harness.resize(81, 10)
      await waitFor()
      const back = harness.latest()
      expect(back).toMatch(/You\s*#1\b/)
      expect(back).not.toContain('three')
      harness.send('\u001b')
      await waitFor()
      harness.send('\u001bp')
      await waitFor()
      harness.resize(80, 10)
      await waitFor()
      // Every Alt+P re-anchors: the window resets to the head.
      expect(harness.latest()).toContain('#1')
    } finally {
      harness.dispose()
    }
  })
})

describe('copy guard (REVIEW R-101)', () => {
  it('copies a message whose timestamp is finite but outside the Date range', async () => {
    // 1e18 is finite, so the scanner's own finiteness screen passes it — and
    // `new Date(1e18).toISOString()` throws a RangeError. That throw used to
    // escape the key handler before its try: no copy, no feedback, and the
    // keys batched behind it in the same chunk were lost.
    const base = sessionWithMessages(['needle body'])
    const session = {
      ...base,
      title: undefined,
      messages: base.messages.map(message => ({ ...message, at: 1e18 })),
    }
    const harness = await mount(session, { query: 'needle' })
    const writes = vi.spyOn(process.stdout, 'write')
    try {
      harness.send('\u001b[B') // card row → the hit row
      await waitFor()
      harness.send('\u001bc')
      await waitFor(200)
      // The body simply carries no timestamp instead of throwing.
      expect(lastClipboard(writes.mock.calls.map(call => call[0]))).toBe('[You]\nneedle body')
      harness.toggleWidth()
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*17\s*chars/)
    } finally {
      writes.mockRestore()
      harness.dispose()
    }
  })
})

/** Force fresh frames until `pattern` shows up in the last painted one, or
 *  the deadline lapses (the repaint is the only way to read the CURRENT
 *  paint; the cumulative stream keeps stale frames too). */
async function painted(harness: { latest(): string; toggleWidth(): void }, pattern: RegExp, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = harness.latest()
    if (pattern.test(frame)) return frame
    if (Date.now() >= deadline) return frame
    harness.toggleWidth()
    await waitFor(50)
  }
}

/** The clipboard text the scene last handed the terminal (OSC 52 payload). */
function lastClipboard(writes: readonly unknown[]): string {
  const payloads = writes
    .map(chunk => String(chunk))
    .filter(text => text.includes(']52;c;'))
  const match = /\]52;c;([A-Za-z0-9+/=]+)/.exec(payloads[payloads.length - 1] ?? '')
  return match === null ? '' : Buffer.from(match[1]!, 'base64').toString('utf8')
}

describe('cursor identity (REVIEW R-102/R-103)', () => {
  it('acts on the row a same-chunk movement key selected', async () => {
    // ↓ + Alt+C arrive as ONE stdin chunk: React batches both handlers, so
    // the copy used to read the render closure's pre-move index. On a card
    // that was a silent no-op; one row further it copied the WRONG message
    // while the frame showed the moved cursor.
    const session = { ...sessionWithMessages(['needle first', 'needle second long']), title: undefined }
    const harness = await mount(session, { query: 'needle' })
    const writes = vi.spyOn(process.stdout, 'write')
    try {
      // Row 0 is the session card, rows 1/2 the two hit rows: the two ↓
      // land on the SECOND message and the Alt+C of the same chunk must
      // copy that one.
      harness.send('\u001b[B\u001b[B\u001bc')
      await waitFor(200)
      harness.toggleWidth()
      await waitFor()
      expect(lastClipboard(writes.mock.calls.map(call => call[0]))).toBe('[AI]\nneedle second long')
      // The status note is the second half of the proof: the pre-move row
      // would have reported its own (shorter) body.
      expect(harness.latest()).toMatch(/Copied\s*23\s*chars/)
    } finally {
      writes.mockRestore()
      harness.dispose()
    }
  })

  it('keeps the selected session when a sweep flush reorders the list', async () => {
    // The progressive sweep sorts every flush; a later arrival can be MORE
    // recent than what is already on screen and lands above it. The index
    // used to stay put and silently re-point the cursor at another session.
    const alpha: ScannedSession = {
      ...sessionWithMessages(['needle alpha body']),
      id: 'alpha-session',
      path: 'alpha.jsonl',
      title: 'needle Alpha',
      modifiedAt: 1_000,
    }
    const beta: ScannedSession = {
      ...sessionWithMessages(['needle beta body']),
      id: 'beta-session',
      path: 'beta.jsonl',
      title: 'needle Beta',
      modifiedAt: 2_000,
    }
    let deliver: ((session: ScannedSession) => void) | undefined
    let finish: ((sessions: readonly ScannedSession[]) => void) | undefined
    const harness = await mount(alpha, {
      query: 'needle',
      scanner: {
        scan(options: { onSession?: (session: ScannedSession) => void }) {
          deliver = options.onSession
          return new Promise<readonly ScannedSession[]>(resolve => {
            finish = resolve
          })
        },
      },
    })
    try {
      deliver?.(alpha)
      expect(await painted(harness, /❯\s*needle\s*Alpha/)).toMatch(/❯\s*needle\s*Alpha/)
      expect(harness.latest()).not.toMatch(/needle\s*Beta/)
      // Past the first flush's gap (100 ms, doubling), the more recent
      // arrival flushes in above Alpha.
      await waitFor(150)
      deliver?.(beta)
      const frame = await painted(harness, /needle\s*Beta/)
      expect(frame).toMatch(/needle\s*Beta/)
      expect(frame).toMatch(/❯\s*needle\s*Alpha/)
      expect(frame).not.toMatch(/❯\s*needle\s*Beta/)
      finish?.([beta, alpha])
    } finally {
      harness.dispose()
    }
  })
})

/** Every state the sweep probe rendered with, in render order. */
const probeStates: Array<{ progress: string; hidden: number; sessions: number }> = []

/**
 * A scene-shaped probe around `useSessionSweep` alone: it renders one static
 * text row and records the hook's own outputs. The sweep contracts that the
 * header depends on are observable here and nowhere else — see the R-115
 * wiring test for why the header row itself cannot be read back.
 */
function SweepProbe(props: HarnessSceneProps): unknown {
  const R = props.React
  const { useState } = R
  const [sessions, setSessions] = useState<readonly ScannedSession[]>([])
  const [progress, setProgress] = useState<ScanProgress | undefined>(undefined)
  const [status, setStatus] = useState<StatusNote | undefined>(undefined)
  const [hidden, setHidden] = useState(0)
  useSessionSweep(R, {
    scanner: props.scanner,
    config: props.config,
    setSessions,
    setProgress,
    setStatus,
    setHiddenSubagents: setHidden,
  })
  probeStates.push({
    progress:
      progress === undefined ? 'none' : `${progress.resolved}/${progress.total}/${progress.hiddenSubagents}`,
    hidden,
    sessions: sessions.length,
  })
  return R.createElement(props.ui.Text, null, `sweep probe: ${sessions.length}`)
}

describe('sweep options (sub-agent posture)', () => {
  it('asks the scanner for sub-agent runs only when the config says so', async () => {
    // The filter itself lives in the scanner (its own suite pins the
    // behavior); this pins the wiring — the scene must forward the resolved
    // config, whose default keeps delegated runs out of the list and the
    // search index.
    const seen: Array<boolean | undefined> = []
    const scanner = {
      scan(options: { includeSubagents?: boolean }): Promise<readonly ScannedSession[]> {
        seen.push(options.includeSubagents)
        return Promise.resolve([])
      },
    }

    const off = await mount(sessionWithMessages(['needle body']), { query: 'needle', scanner })
    try {
      expect(seen).toEqual([false])
    } finally {
      off.dispose()
    }

    seen.length = 0
    const on = await mount(sessionWithMessages(['needle body']), {
      query: 'needle',
      scanner,
      showSubagentSessions: true,
    })
    try {
      expect(seen).toEqual([true])
    } finally {
      on.dispose()
    }
  })

  it('hands the settled withheld count to the scene after the sweep clears progress', async () => {
    // R-115's wiring half. The scene's header cannot be asserted on directly:
    // the host renderer repaints only the rows its damage pass marks, and the
    // header row is never among them after the first paint (probed here
    // 2026-09-30 — a header change from "0 sessions" to "Scanning 3/3…" never
    // reaches the stream). So the contract is pinned one level down, on the
    // sweep hook the header reads: while the sweep runs the count rides the
    // live `progress` tick, and once the sweep lands — progress cleared, which
    // a warm sweep can do inside a single render — the count must still be
    // handed over, or the settled header silently drops the note.
    probeStates.length = 0
    const alpha = sessionWithMessages(['needle body'])
    let finish: ((sessions: readonly ScannedSession[]) => void) | undefined
    const harness = await mount(alpha, {
      query: '',
      component: SweepProbe as never,
      scanner: {
        scan(options: { onProgress?: (progress: ScanProgress) => void }) {
          options.onProgress?.({ resolved: 3, total: 3, decodedBytes: 0, resumed: 0, hiddenSubagents: 2 })
          return new Promise<readonly ScannedSession[]>(resolve => {
            finish = resolve
          })
        },
      },
    })
    try {
      await waitFor(150)
      // Mid-sweep: the scene still holds 0 of its own, the tick carries the 2.
      expect(probeStates.some(state => state.progress === '3/3/2' && state.hidden === 0)).toBe(true)
      finish?.([alpha])
      await waitFor(200)
      expect(probeStates.at(-1)).toEqual({ progress: 'none', hidden: 2, sessions: 1 })
    } finally {
      harness.dispose()
    }
  })
})
