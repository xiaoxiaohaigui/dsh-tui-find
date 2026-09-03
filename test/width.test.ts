/**
 * Width-arithmetic tests for the scene's hand-laid rows: CJK characters cost
 * two columns, cuts keep their ellipsis inside the budget, and a spread row
 * never exceeds the columns it is given — the invariant the host browser's
 * own spreadRow regression pins.
 */
import { describe, expect, it } from 'vitest'
import {
  displayWidth,
  fitScrollWindow,
  hitLine,
  spreadRow,
  tailWidth,
  truncateWidth,
  wrapWidth,
  wrapWidthRanges,
} from '../src/width.js'

describe('displayWidth', () => {
  it('counts CJK characters as two columns', () => {
    expect(displayWidth('auth')).toBe(4)
    expect(displayWidth('登录')).toBe(4)
    expect(displayWidth('a登b')).toBe(4)
    expect(displayWidth('')).toBe(0)
  })

  it('counts emoji as wide', () => {
    expect(displayWidth('✦')).toBeGreaterThanOrEqual(1)
    expect(displayWidth('🔍x')).toBe(3)
  })
})

describe('truncateWidth', () => {
  it('returns the text when it fits', () => {
    expect(truncateWidth('登录失败', 8)).toBe('登录失败')
    expect(truncateWidth('登录失败', 9)).toBe('登录失败')
  })

  it('cuts with an ellipsis inside the budget', () => {
    const cut = truncateWidth('登录失败重试', 7)
    expect(displayWidth(cut)).toBeLessThanOrEqual(7)
    expect(cut.endsWith('…')).toBe(true)
    const ascii = truncateWidth('abcdefgh', 5)
    expect(displayWidth(ascii)).toBeLessThanOrEqual(5)
    expect(ascii).toBe('abcd…')
  })

  it('returns empty for a non-positive budget', () => {
    expect(truncateWidth('anything', 0)).toBe('')
    expect(truncateWidth('anything', -1)).toBe('')
  })
})

describe('tailWidth', () => {
  it('keeps the END of the text with a leading ellipsis', () => {
    const kept = tailWidth('abcdefgh', 5)
    expect(kept).toBe('…efgh')
    const cjk = tailWidth('登录失败重试', 7)
    expect(displayWidth(cjk)).toBeLessThanOrEqual(7)
    expect(cjk.startsWith('…')).toBe(true)
    expect(cjk.endsWith('重试')).toBe(true)
  })
})

describe('spreadRow', () => {
  it('pushes the two ends apart and never exceeds the columns', () => {
    const row = spreadRow(' 查找历史会话', '252 个会话', 40)
    expect(displayWidth(row.left) + row.gap + displayWidth(row.right)).toBeLessThanOrEqual(40)
    expect(row.gap).toBeGreaterThanOrEqual(1)
  })

  it('truncates the right side first, then the left', () => {
    const row = spreadRow('left-side-title', 'r'.repeat(60), 20)
    expect(displayWidth(row.left) + row.gap + displayWidth(row.right)).toBeLessThanOrEqual(20)
  })

  it('degrades to empty segments on a zero-width row', () => {
    expect(spreadRow('a', 'b', 0)).toEqual({ left: '', gap: 0, right: '' })
  })
})

describe('fitScrollWindow', () => {
  const weightsOf = (cards: number, hits: number): number[] => {
    // One card (2 lines) followed by `hits` one-line hit rows, repeated.
    const weights: number[] = []
    for (let group = 0; group < cards; group++) {
      weights.push(2, ...Array<number>(hits).fill(1))
    }
    return weights
  }

  it('keeps the window still while the selection fits', () => {
    const weights = weightsOf(5, 3)
    // A 10-line viewport holds card+3 hits (5 lines) plus card+2 more rows.
    expect(fitScrollWindow(weights, 0, 10, 0)).toEqual({ start: 0, end: 8 })
    // Selection moves within the first card's group: window unchanged.
    expect(fitScrollWindow(weights, 2, 10, 0)).toEqual({ start: 0, end: 8 })
  })

  it('advances just far enough when the selection outgrows the budget (down)', () => {
    // 21 one-line rows, 10-line viewport: at selection 10 the row-count
    // windows would still fit, but the window must hold the selection.
    const weights = Array<number>(21).fill(1)
    const view = fitScrollWindow(weights, 10, 10, 0)
    expect(view.start).toBeLessThanOrEqual(10)
    expect(view.end).toBeGreaterThan(10)
    expect(view.end - view.start).toBeLessThanOrEqual(10)
  })

  it('accounts for two-line cards: the selection cannot walk off the bottom', () => {
    // 10 cards only (2 lines each), 10-line viewport shows 5 cards. The old
    // row-count window rendered 10 rows = 20 lines; the fitted window holds
    // the selection on screen at every position.
    const weights = Array<number>(10).fill(2)
    for (const selected of [0, 4, 5, 6, 9]) {
      const view = fitScrollWindow(weights, selected, 10, 0)
      expect(view.start).toBeLessThanOrEqual(selected)
      expect(view.end).toBeGreaterThan(selected)
      expect(view.end - view.start).toBeLessThanOrEqual(5)
    }
  })

  it('snaps the selection to the top when moving up past the window', () => {
    const weights = Array<number>(30).fill(1)
    expect(fitScrollWindow(weights, 3, 10, 20)).toEqual({ start: 3, end: 13 })
  })

  it('clamps to the list and survives empty input', () => {
    expect(fitScrollWindow([], 0, 10, 0)).toEqual({ start: 0, end: 0 })
    expect(fitScrollWindow([2, 2], 99, 10, 0).end).toBeLessThanOrEqual(2)
    expect(fitScrollWindow([2], 0, 0).end).toBe(0)
  })
})

describe('wrapWidthRanges', () => {
  // A varied corpus: ascii with spaces, CJK, an emoji (surrogate pair),
  // newlines, and a single long token with no break opportunities.
  const corpus = [
    'hello world foo',
    'one two three four five',
    '一二三四五六七八',
    '在服务器上\n部署了机器人',
    `前缀${'🔍'.repeat(3)}后缀很长的一段文字没有空格`,
    'aaaaaaaaaa',
    'x',
    '',
  ]

  it('wraps byte-identically to wrapWidth, with or without ranges', () => {
    for (const text of corpus) {
      for (const width of [0, 1, 2, 3, 4, 5, 6, 8, 13, 40]) {
        expect(wrapWidthRanges(text, width, []).map(line => line.text)).toEqual(wrapWidth(text, width))
        expect(wrapWidthRanges(text, width, [[0, Math.max(0, text.length)]]).map(line => line.text)).toEqual(
          wrapWidth(text, width),
        )
      }
    }
  })

  it('keeps a contained range on its own line, unrebased', () => {
    const lines = wrapWidthRanges('hello world foo', 20, [[6, 11]])
    expect(lines).toEqual([{ text: 'hello world foo', ranges: [[6, 11]] }])
    expect(lines[0]!.text.slice(6, 11)).toBe('world')
  })

  it('splits a range across a line boundary at the break', () => {
    // 'one two three' at width 8 wraps to ['one two', 'three'] with the
    // boundary space (original offset 7) dropped between the two lines.
    const lines = wrapWidthRanges('one two three', 8, [[5, 10]])
    expect(lines.map(line => line.text)).toEqual(['one two', 'three'])
    expect(lines[0]!.ranges).toEqual([[5, 7]])
    expect(lines[1]!.ranges).toEqual([[0, 2]])
    expect(lines[0]!.text.slice(5, 7)).toBe('wo')
    expect(lines[1]!.text.slice(0, 2)).toBe('th')
  })

  it('excludes the dropped boundary space from both segments', () => {
    // 'one twoo' at width 5 → ['one', 'twoo']; a range spanning the dropped
    // space at offset 3 reaches both lines but covers neither's full width.
    const lines = wrapWidthRanges('one twoo', 5, [[2, 6]])
    expect(lines.map(line => line.text)).toEqual(['one', 'twoo'])
    expect(lines[0]!.ranges).toEqual([[2, 3]])
    expect(lines[1]!.ranges).toEqual([[0, 2]])
    expect(lines[0]!.text.slice(2, 3)).toBe('e')
    expect(lines[1]!.text.slice(0, 2)).toBe('tw')
  })

  it('maps ranges across CJK wide-character lines', () => {
    const lines = wrapWidthRanges('一二三四五六', 4, [[1, 5]])
    expect(lines.map(line => line.text)).toEqual(['一二', '三四', '五六'])
    expect(lines[0]!.ranges).toEqual([[1, 2]])
    expect(lines[1]!.ranges).toEqual([[0, 2]])
    expect(lines[2]!.ranges).toEqual([[0, 1]])
    expect(lines[0]!.text.slice(1, 2)).toBe('二')
    expect(lines[1]!.text.slice(0, 2)).toBe('三四')
    expect(lines[2]!.text.slice(0, 1)).toBe('五')
  })

  it('keeps disjoint ranges on their own lines and drops the misses', () => {
    const lines = wrapWidthRanges('一二三四五六', 4, [
      [0, 2],
      [4, 5],
      [100, 200],
    ])
    expect(lines.map(line => line.text)).toEqual(['一二', '三四', '五六'])
    expect(lines[0]!.ranges).toEqual([[0, 2]])
    expect(lines[1]!.ranges).toEqual([])
    expect(lines[2]!.ranges).toEqual([[0, 1]])
  })

  it('splits a range across the newline between paragraphs', () => {
    const lines = wrapWidthRanges('ab\ncd', 10, [[1, 4]])
    expect(lines.map(line => line.text)).toEqual(['ab', 'cd'])
    expect(lines[0]!.ranges).toEqual([[1, 2]])
    expect(lines[1]!.ranges).toEqual([[0, 1]])
  })

  it('keeps surrogate-pair boundaries intact across a break', () => {
    const lines = wrapWidthRanges('🔍x🔍', 3, [
      [0, 2],
      [3, 5],
    ])
    expect(lines.map(line => line.text)).toEqual(['🔍x', '🔍'])
    expect(lines[0]!.ranges).toEqual([[0, 2]])
    expect(lines[1]!.ranges).toEqual([[0, 2]])
  })

  it('answers empty for empty text and non-positive budgets', () => {
    expect(wrapWidthRanges('', 10, [[0, 1]])).toEqual([{ text: '', ranges: [] }])
    expect(wrapWidthRanges('abc', 0, [[0, 3]])).toEqual([])
    expect(wrapWidthRanges('abc', -1, [])).toEqual([])
  })
})

describe('hitLine', () => {
  it('flattens newlines so a hit row is exactly one line', () => {
    const line = hitLine('结论：\r\n\n机器人不回话\t原因如下', [], 80)
    expect(line.text).toBe('结论： 机器人不回话 原因如下')
    expect(line.text.includes('\n')).toBe(false)
  })

  it('returns the whole (flattened) text with mapped ranges when it fits', () => {
    // Ranges are UTF-16 offsets into the ORIGINAL text; the newline collapse
    // shifts them — the mapped range must still cover 部署.
    const text = '在服务器上\n部署了机器人'
    const line = hitLine(text, [[6, 8]], 80)
    expect(line.text).toBe('在服务器上 部署了机器人')
    expect(line.ranges).toEqual([[6, 8]])
    expect(line.text.slice(6, 8)).toBe('部署')
  })

  it('windows a deep match around the keyword instead of head-cutting it', () => {
    const text = `${'前'.repeat(60)}部署${'后'.repeat(60)}`
    const line = hitLine(text, [[60, 62]], 20)
    expect(displayWidth(line.text)).toBeLessThanOrEqual(20)
    expect(line.text.includes('部署')).toBe(true)
    expect(line.text.startsWith('…')).toBe(true)
    expect(line.text.endsWith('…')).toBe(true)
    // The mapped range covers exactly the keyword inside the window.
    const [start, end] = line.ranges[0]!
    expect(line.text.slice(start, end)).toBe('部署')
  })

  it('keeps CJK budgets honest when windowing', () => {
    const text = `${'长'.repeat(40)}部署${'尾'.repeat(40)}`
    const line = hitLine(text, [[40, 42]], 21)
    expect(displayWidth(line.text)).toBeLessThanOrEqual(21)
    expect(line.text.includes('部署')).toBe(true)
  })

  it('shows the head of a match wider than the whole budget', () => {
    const text = `${'x'.repeat(10)}${'很'.repeat(30)}`
    const line = hitLine(text, [[10, 40]], 8)
    expect(displayWidth(line.text)).toBeLessThanOrEqual(8)
    expect(line.text.startsWith('…')).toBe(true)
    expect(line.text.slice(1, 3)).toBe('很很')
  })

  it('maps multiple ranges, dropping those outside the window', () => {
    const text = `${'a'.repeat(50)}部署${'b'.repeat(50)}部署${'c'.repeat(50)}`
    const line = hitLine(text, [[50, 52], [102, 104]], 12)
    expect(line.ranges.length).toBe(1)
    const [start, end] = line.ranges[0]!
    expect(line.text.slice(start, end)).toBe('部署')
  })

  it('returns empty for empty or non-positive budgets', () => {
    expect(hitLine('anything', [], 0)).toEqual({ text: '', ranges: [] })
    expect(hitLine('', [[0, 1]], 10)).toEqual({ text: '', ranges: [] })
  })
})
