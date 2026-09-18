import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import {
  buildPreviewLines,
  currentHitMessage,
  hitLanding,
  hitOrdinal,
  jumpHitLine,
  messageAtLine,
  messageHeaderLine,
  scrollWindow,
} from '../src/preview.js'

const message = (
  text: string,
  role: IndexedMessage['role'] = 'user',
  seq: number | undefined = undefined,
): IndexedMessage => ({
  seq,
  role,
  text,
  at: 1_700_000_000_000,
})

const bodyLines = (lines: ReturnType<typeof buildPreviewLines>): string[] =>
  lines.flatMap(line => (line.kind === 'body' ? [line.text] : []))

describe('buildPreviewLines', () => {
  it('emits one header per message carrying role, seq, time and hit flag', () => {
    const lines = buildPreviewLines(
      [message('hi', 'user', 3), message('yo', 'assistant')],
      new Set<number>(),
      20,
    )
    expect(lines[0]).toEqual({
      kind: 'header',
      messageIndex: 0,
      role: 'user',
      seq: 3,
      at: 1_700_000_000_000,
      isHit: false,
    })
    expect(lines[2]).toEqual({
      kind: 'header',
      messageIndex: 1,
      role: 'assistant',
      seq: undefined,
      at: 1_700_000_000_000,
      isHit: false,
    })
  })

  it('marks exactly the hit messages', () => {
    const lines = buildPreviewLines(
      [message('a'), message('b'), message('c')],
      new Set([1]),
      20,
    )
    const hits = lines.flatMap(line => (line.kind === 'header' && line.isHit ? [line.messageIndex] : []))
    expect(hits).toEqual([1])
  })

  it('wraps bodies at the column budget and attributes lines to their message', () => {
    const lines = buildPreviewLines([message('hello world foo')], new Set<number>(), 6)
    expect(bodyLines(lines)).toEqual(['hello', 'world', 'foo'])
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.map(line => line.bodyIndex)).toEqual([0, 1, 2])
    expect(bodies.every(line => line.messageIndex === 0 && line.role === 'user')).toBe(true)
  })

  it('wraps CJK text on the wide-character budget', () => {
    expect(bodyLines(buildPreviewLines([message('一二三四五')], new Set<number>(), 4))).toEqual([
      '一二',
      '三四',
      '五',
    ])
  })

  it('keeps newlines as separate body lines', () => {
    expect(bodyLines(buildPreviewLines([message('a\nb\nc')], new Set<number>(), 20))).toEqual(['a', 'b', 'c'])
  })

  it('yields one empty body line for an empty message (the blank separator)', () => {
    const lines = buildPreviewLines([message('')], new Set<number>(), 20)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toEqual({
      kind: 'body',
      messageIndex: 0,
      role: 'user',
      bodyIndex: 0,
      text: '',
      ranges: [],
    })
  })

  it('emits headers only when the wrap budget is not positive', () => {
    const lines = buildPreviewLines([message('a'), message('b')], new Set<number>(), 0)
    expect(lines.every(line => line.kind === 'header')).toBe(true)
  })

  it('attributes body lines across messages of different lengths', () => {
    const lines = buildPreviewLines(
      [message('one two three'), message('x'), message('dd ee ff gg')],
      new Set<number>(),
      8,
    )
    const owners = lines.flatMap(line => (line.kind === 'body' ? [line.messageIndex] : []))
    // msg0 wraps to 2 lines, msg1 to 1, msg2 to 2.
    expect(owners).toEqual([0, 0, 1, 2, 2])
  })

  it('attaches rebased hit ranges to the wrapped body lines they land on', () => {
    // 'one two three' at width 8 wraps to ['one two', 'three']; the range
    // [5, 10) straddles the break, so each line carries its own segment.
    const lines = buildPreviewLines([message('one two three')], new Set<number>(), 8, new Map([[0, [[5, 10]]]]))
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.map(line => line.text)).toEqual(['one two', 'three'])
    expect(bodies.map(line => line.ranges)).toEqual([[[5, 7]], [[0, 2]]])
    expect(bodies[0]!.text.slice(5, 7)).toBe('wo')
    expect(bodies[1]!.text.slice(0, 2)).toBe('th')
  })

  it('keeps ranges to their own message', () => {
    const lines = buildPreviewLines(
      [message('alpha beta'), message('gamma delta')],
      new Set<number>(),
      20,
      new Map([[1, [[0, 5]]]]),
    )
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.map(line => line.ranges)).toEqual([[], [[0, 5]]])
    expect(bodies[1]!.text.slice(0, 5)).toBe('gamma')
  })

  it('defaults to no ranges when the map is omitted', () => {
    const lines = buildPreviewLines([message('hello world')], new Set<number>(), 20)
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.every(line => line.ranges.length === 0)).toBe(true)
  })

  it('drops ranges that fall outside the wrapped text', () => {
    const lines = buildPreviewLines([message('plain')], new Set<number>(), 20, new Map([[0, [[50, 60]]]]))
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.map(line => line.ranges)).toEqual([[]])
  })

  it('splits a hit across the newline the wrap honours', () => {
    const lines = buildPreviewLines([message('ab\ncd')], new Set<number>(), 20, new Map([[0, [[1, 4]]]]))
    const bodies = lines.flatMap(line => (line.kind === 'body' ? [line] : []))
    expect(bodies.map(line => line.text)).toEqual(['ab', 'cd'])
    expect(bodies.map(line => line.ranges)).toEqual([[[1, 2]], [[0, 1]]])
  })
})

describe('messageAtLine', () => {
  // msg0: header@0 + body@1; msg1: header@2 + body@3 ('yy') + body@4 ('zz').
  const lines = buildPreviewLines([message('x'), message('yy\nzz', 'assistant')], new Set<number>(), 10)

  it('maps a line onto its owning message', () => {
    expect(messageAtLine(lines, 0)).toBe(0)
    expect(messageAtLine(lines, 1)).toBe(0)
    expect(messageAtLine(lines, 2)).toBe(1)
    expect(messageAtLine(lines, 3)).toBe(1)
    expect(messageAtLine(lines, 4)).toBe(1)
  })

  it('clamps out-of-range lines and answers empty lists', () => {
    expect(messageAtLine(lines, -5)).toBe(0)
    expect(messageAtLine(lines, 99)).toBe(1)
    expect(messageAtLine([], 0)).toBeUndefined()
  })
})

describe('messageHeaderLine', () => {
  const lines = buildPreviewLines([message('x'), message('y'), message('z')], new Set<number>(), 10)
  // One body per message: headers at 0, 2, 4.
  const headerAt = [0, 2, 4]

  it('parks on the header of the anchored message', () => {
    expect(messageHeaderLine(lines, 0)).toBe(headerAt[0])
    expect(messageHeaderLine(lines, 1)).toBe(headerAt[1])
    expect(messageHeaderLine(lines, 2)).toBe(headerAt[2])
  })

  it('falls back to the nearest header outside the range', () => {
    expect(messageHeaderLine(lines, -3)).toBe(0)
    expect(messageHeaderLine(lines, 99)).toBe(4)
    expect(messageHeaderLine([], 0)).toBe(0)
  })
})

describe('hitLanding', () => {
  /** A message whose hit sits far below its header: the pad wraps to many
   *  body lines before the keyword's line. */
  const longMessage = (hitAtEndOfPad: string): string =>
    `pad ${'pad '.repeat(120)}${hitAtEndOfPad} tail`
  const hitRanges = (text: string, needle: string): readonly (readonly [number, number])[] => {
    const at = text.indexOf(needle)
    return at === -1 ? [] : [[at, at + needle.length]]
  }
  const build = (viewportCols = 20): { lines: ReturnType<typeof buildPreviewLines>; hitLine: number; headerLine: number } => {
    const text = longMessage('NEEDLEHIT')
    const lines = buildPreviewLines(
      [message('intro'), message(text, 'assistant'), message('tail')],
      new Set([1]),
      viewportCols,
      new Map([[1, hitRanges(text, 'NEEDLEHIT')]]),
    )
    const hitLine = lines.findIndex(line => line.kind === 'body' && line.ranges.length > 0)
    return { lines, hitLine, headerLine: messageHeaderLine(lines, 1) }
  }

  it('keeps the header when the hit already fits inside the viewport', () => {
    const lines = buildPreviewLines(
      [message('intro'), message('needle here', 'assistant')],
      new Set([1]),
      20,
      new Map([[1, [[0, 6]] as readonly [number, number][]]]),
    )
    const viewport = 20
    const landing = hitLanding(lines, 1, viewport)
    // The landing stays header-anchored — the window opens on the header,
    // the anchored shape every other reader assertion depends on — because
    // the hit's own line is inside the viewport below it.
    const headerLine = messageHeaderLine(lines, 1)
    expect(landing).toBe(headerLine)
    const hitLine = lines.findIndex(line => line.kind === 'body' && line.ranges.length > 0)
    expect(hitLine).toBeGreaterThanOrEqual(landing)
    expect(hitLine).toBeLessThan(landing + viewport)
    expect(messageAtLine(lines, landing)).toBe(1)
  })

  it('opens above a hit the header-anchored window cannot reach', () => {
    const viewport = 9
    const { lines, hitLine, headerLine } = build()
    // Guards the fixture: the hit really is unreachable from the header.
    expect(hitLine - headerLine + 1).toBeGreaterThan(viewport)
    const landing = hitLanding(lines, 1, viewport)
    // The keyword's line is inside [landing, landing + viewport) with
    // leading context above it, and the message head is scrolled away.
    expect(landing).toBeLessThan(hitLine)
    expect(landing).toBeGreaterThanOrEqual(headerLine)
    expect(hitLine - landing).toBeLessThan(viewport)
  })

  it('never opens above the message head, whatever the viewport', () => {
    const { lines, hitLine, headerLine } = build()
    for (const viewport of [1, 2, 3, 5, 9, 40]) {
      const landing = hitLanding(lines, 1, viewport)
      expect(landing).toBeGreaterThanOrEqual(headerLine)
      if (viewport >= hitLine - headerLine + 1) {
        // Reachable from the header: the whole message head stays in view.
        expect(landing).toBe(headerLine)
      } else {
        expect(hitLine - landing).toBeLessThan(viewport)
        expect(hitLine).toBeGreaterThanOrEqual(landing)
      }
    }
  })

  it('falls back to the header for a message without an in-body hit', () => {
    const lines = buildPreviewLines([message('plain text')], new Set<number>(), 20)
    expect(hitLanding(lines, 0, 9)).toBe(0)
    // Out-of-range anchors clamp like messageHeaderLine, and an empty list
    // still answers a usable line.
    expect(hitLanding(lines, 99, 9)).toBe(0)
    expect(hitLanding([], 0, 9)).toBe(0)
  })
})

describe('jumpHitLine', () => {
  // Messages 0..5; hits at 1 (header line 3) and 4 (header line 9).
  const table = [-1, 3, -1, -1, 9, -1]

  it('takes the first hit below the window on n, skipping the visible ones', () => {
    // At the top with a 4-row window (lines 0..3): line 3 is on screen, so
    // the next press lands on the far hit rather than re-showing it.
    expect(jumpHitLine(table, 0, 4, 1)).toBe(9)
    // A one-row window that stops just above line 3 targets it.
    expect(jumpHitLine(table, 0, 3, 1)).toBe(3)
    // From below the last hit, n wraps to the first.
    expect(jumpHitLine(table, 9, 12, 1)).toBe(3)
  })

  it('takes the last hit above the window on N, likewise wrapping', () => {
    expect(jumpHitLine(table, 9, 12, -1)).toBe(3)
    expect(jumpHitLine(table, 4, 9, -1)).toBe(3)
    // From the top, N wraps to the last hit.
    expect(jumpHitLine(table, 0, 3, -1)).toBe(9)
  })

  it('never re-targets a hit that is already on screen', () => {
    // The window (lines 3..11) holds both hits: each direction wraps, so a
    // press always moves even in a conversation that fits entirely.
    expect(jumpHitLine(table, 3, 12, 1)).toBe(3)
    expect(jumpHitLine(table, 3, 12, -1)).toBe(9)
  })

  it('answers empty tables and empty windows', () => {
    expect(jumpHitLine([], 0, 5, 1)).toBeUndefined()
    expect(jumpHitLine([-1, -1], 0, 5, -1)).toBeUndefined()
    // A degenerate window still resolves: both hits sit below line 0.
    expect(jumpHitLine(table, 0, 0, 1)).toBe(3)
    expect(jumpHitLine(table, 0, 0, -1)).toBe(9)
  })

  it('serves a table derived from built lines the way the scene does', () => {
    const messages = [message('a'), message('needle'), message('b'), message('c'), message('needle')]
    const lines = buildPreviewLines(messages, new Set([1, 4]), 20)
    const table = new Array<number>(messages.length).fill(-1)
    lines.forEach((line, at) => {
      if (line.kind === 'header' && line.isHit) table[line.messageIndex] = at
    })
    // msg1's header sits at line 2 (after msg0's header+body), msg4's at 8.
    expect(table).toEqual([-1, 2, -1, -1, 8])
    // The end is EXCLUSIVE: a window [0, 3) shows line 2, so n skips it.
    expect(jumpHitLine(table, 0, 3, 1)).toBe(8)
    expect(jumpHitLine(table, 0, 2, 1)).toBe(2)
    expect(jumpHitLine(table, 8, 10, -1)).toBe(2)
  })
})

describe('hitOrdinal', () => {
  const table = [-1, 3, -1, -1, 9, -1]

  it('counts hits at or before the message and the total', () => {
    expect(hitOrdinal(table, 0)).toEqual({ index: 0, total: 2 })
    expect(hitOrdinal(table, 1)).toEqual({ index: 1, total: 2 })
    expect(hitOrdinal(table, 4)).toEqual({ index: 2, total: 2 })
    expect(hitOrdinal(table, 5)).toEqual({ index: 2, total: 2 })
    expect(hitOrdinal([], 0)).toEqual({ index: 0, total: 0 })
  })
})

describe('currentHitMessage', () => {
  // Messages 0..5; hits at 1 (header line 3) and 4 (header line 9).
  const table = [-1, 3, -1, -1, 9, -1]

  it('answers the hit at or above the window top', () => {
    // The header exactly on the top row counts as the reader's position.
    expect(currentHitMessage(table, 3)).toBe(1)
    // Scrolled into the hit's own body keeps that hit.
    expect(currentHitMessage(table, 5)).toBe(1)
    // A window between the hits belongs to the one above it.
    expect(currentHitMessage(table, 8)).toBe(1)
    // The next hit's header takes over as soon as it reaches the top.
    expect(currentHitMessage(table, 9)).toBe(4)
    // Scrolled past every hit: the last one stays the position.
    expect(currentHitMessage(table, 12)).toBe(4)
  })

  it('falls back to the first hit when the window sits above all of them', () => {
    expect(currentHitMessage(table, 0)).toBe(1)
    expect(currentHitMessage(table, 2)).toBe(1)
  })

  it('answers undefined for a session without message hits', () => {
    expect(currentHitMessage([], 0)).toBeUndefined()
    expect(currentHitMessage([-1, -1, -1], 5)).toBeUndefined()
  })
})

describe('scrollWindow', () => {
  it('slices a viewport of the given height from the offset', () => {
    expect(scrollWindow(100, 41, 10)).toEqual({ start: 41, end: 51 })
    expect(scrollWindow(100, 0, 10)).toEqual({ start: 0, end: 10 })
  })

  it('clamps the offset so the window never runs past either end', () => {
    // Past the tail: the window parks flush with the content's end instead
    // of scrolling into blank space.
    expect(scrollWindow(100, 99, 10)).toEqual({ start: 90, end: 100 })
    expect(scrollWindow(100, 1_000, 10)).toEqual({ start: 90, end: 100 })
    expect(scrollWindow(100, -5, 10)).toEqual({ start: 0, end: 10 })
  })

  it('stops the end at a short list instead of padding it', () => {
    expect(scrollWindow(4, 0, 10)).toEqual({ start: 0, end: 4 })
    expect(scrollWindow(0, 0, 10)).toEqual({ start: 0, end: 0 })
  })

  it('answers degenerate viewports', () => {
    // A zero or negative height still renders one row (the scene's own
    // Math.max(1, …) budget rule, mirrored here).
    expect(scrollWindow(10, 3, 0)).toEqual({ start: 3, end: 4 })
    expect(scrollWindow(10, 3, -2)).toEqual({ start: 3, end: 4 })
  })
})
