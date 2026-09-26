import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectionMarker, wheelRows } from '../src/find-types.js'
import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { mount, sessionWithMessages, waitFor } from './harness.js'

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
