import { afterAll, describe, expect, it } from 'vitest'
import { selectionMarker, wheelStep } from '../src/find-types.js'
import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { mount, sessionWithMessages, waitFor } from './harness.js'

setLangOverride('en')
// One language for the whole file (every frame assertion below is en), and
// restored once after ALL describes — a per-describe afterAll would reset
// the override for every later describe in this file.
afterAll(() => setLangOverride(undefined))

describe('wheelStep', () => {
  it('moves one row for vertical wheel events', () => {
    expect(wheelStep(1)).toBe(1)
    expect(wheelStep(-1)).toBe(-1)
  })

  it('ignores horizontal-only wheel events', () => {
    expect(wheelStep(0, 1)).toBe(0)
    expect(wheelStep(0, -1)).toBe(0)
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
})

describe('preview scrolling', () => {
  it('re-anchors the preview on Alt+P and walks messages with arrows, window following', async () => {
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
      // Five arrows walk from message 1 to message 6; with a five-line
      // viewport the fitted window has scrolled the head off the top.
      expect(harness.latest()).toContain('#6')
      expect(harness.latest()).not.toContain('#1')
      harness.send('\u001b')
      await waitFor()
      harness.send('\u001bp')
      await waitFor()
      harness.resize(81, 10)
      await waitFor()
      // Every Alt+P re-anchors: cursor and window reset to the head.
      expect(harness.latest()).toContain('#1')
      expect(harness.latest()).not.toContain('#6')
    } finally {
      harness.dispose()
    }
  })
})
