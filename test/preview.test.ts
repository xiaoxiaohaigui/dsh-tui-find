import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import {
  buildPreviewLines,
  hitOrdinal,
  jumpHit,
  messageAtLine,
  messageHeaderLine,
  previewWindow,
  stepMessage,
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

describe('jumpHit', () => {
  // Messages 0..5; hits at 1 (header line 3) and 4 (header line 9).
  const table = [-1, 3, -1, -1, 9, -1]

  it('walks forward to the next hit, skipping non-hit messages', () => {
    expect(jumpHit(table, 0, 1)).toBe(3)
    expect(jumpHit(table, 1, 1)).toBe(9)
    expect(jumpHit(table, 3, 1)).toBe(9)
  })

  it('walks backward to the previous hit', () => {
    expect(jumpHit(table, 4, -1)).toBe(3)
    expect(jumpHit(table, 5, -1)).toBe(9)
    expect(jumpHit(table, 2, -1)).toBe(3)
  })

  it('wraps around at both ends', () => {
    expect(jumpHit(table, 4, 1)).toBe(3)
    expect(jumpHit(table, 1, -1)).toBe(9)
    expect(jumpHit(table, 99, 1)).toBe(3)
    expect(jumpHit(table, -1, -1)).toBe(9)
    expect(jumpHit([], 0, 1)).toBeUndefined()
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
    expect(jumpHit(table, 1, 1)).toBe(8)
    expect(jumpHit(table, 4, -1)).toBe(2)
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

describe('previewWindow', () => {
  it('weighs every preview line one terminal row', () => {
    expect(previewWindow(100, 50, 10, 0)).toEqual({ start: 41, end: 51 })
  })

  it('follows the cursor at the window edges', () => {
    expect(previewWindow(100, 60, 10, 41)).toEqual({ start: 51, end: 61 })
    expect(previewWindow(100, 5, 10, 41)).toEqual({ start: 5, end: 15 })
    expect(previewWindow(100, 99, 10, 0)).toEqual({ start: 90, end: 100 })
  })

  it('answers empty line lists', () => {
    expect(previewWindow(0, 0, 10, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('stepMessage', () => {
  const lines = buildPreviewLines([message('one\ntwo'), message('three'), message('four\nfive')], new Set(), 20)

  it('moves one message at a time regardless of wrapped body lines', () => {
    expect(stepMessage(lines, 0, 1)).toBe(3)
    expect(stepMessage(lines, 1, 1)).toBe(3)
    expect(stepMessage(lines, 3, 1)).toBe(5)
    expect(stepMessage(lines, 4, -1)).toBe(0)
  })

  it('clamps at the conversation ends', () => {
    expect(stepMessage(lines, 0, -1)).toBe(0)
    expect(stepMessage(lines, 5, 1)).toBe(7)
  })
})
