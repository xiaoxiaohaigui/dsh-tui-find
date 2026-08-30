/**
 * Width-arithmetic tests for the scene's hand-laid rows: CJK characters cost
 * two columns, cuts keep their ellipsis inside the budget, and a spread row
 * never exceeds the columns it is given — the invariant the host browser's
 * own spreadRow regression pins.
 */
import { describe, expect, it } from 'vitest'
import { displayWidth, spreadRow, tailWidth, truncateWidth } from '../src/width.js'

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
