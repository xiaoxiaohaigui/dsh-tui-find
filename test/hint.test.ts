/**
 * The reader hint line's composition. Two contracts (REVIEW R-070): the keys
 * a cursor-less reader cannot do without — how to scroll, and how to leave —
 * are MANDATORY at every width, and the row is exactly ONE physical line
 * whatever the terminal does, because the preview's chrome budget counts it
 * as one row (a wrapped hint used to steal a row from the scroll region).
 * The remaining segments drop rightmost-first, and truncation is the last
 * resort below even the mandatory pair.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { composeReaderHint } from '../src/find-chrome.js'
import { setLangOverride } from '../src/i18n.js'
import { displayWidth } from '../src/width.js'

/** What the terminal paints: HintLine consumes the `**` markers. */
const painted = (text: string): string => text.split('**').join('')

afterEach(() => setLangOverride(undefined))

describe('reader hint composition', () => {
  it('renders every segment when the row is wide enough', () => {
    setLangOverride('zh')
    expect(painted(composeReaderHint(120, false))).toBe(
      '↑↓ 滚动 · n/N 命中 · Enter 恢复 · Alt+C 复制当前命中 · Esc 返回列表',
    )
    expect(painted(composeReaderHint(120, true))).toBe(
      '← 返回列表 · ↑↓ 滚动 · n/N 命中 · Enter 恢复 · Alt+C 复制当前命中',
    )
  })

  it('drops the lowest-priority segments first and never the mandatory pair', () => {
    setLangOverride('zh')
    // The full classic line paints 67 columns: copy (18) goes first...
    expect(painted(composeReaderHint(60, false))).toBe('↑↓ 滚动 · n/N 命中 · Enter 恢复 · Esc 返回列表')
    // ...then resume (10), then hits (8) — scroll and the way out stay.
    expect(painted(composeReaderHint(40, false))).toBe('↑↓ 滚动 · n/N 命中 · Esc 返回列表')
    expect(painted(composeReaderHint(24, false))).toBe('↑↓ 滚动 · Esc 返回列表')
    // Split swaps the way out for ← and keeps both guarantees at the head.
    expect(painted(composeReaderHint(22, true))).toBe('← 返回列表 · ↑↓ 滚动')
  })

  it('truncates as the backstop when even the mandatory pair cannot fit', () => {
    setLangOverride('zh')
    const line = composeReaderHint(14, false)
    // 14 columns leave a 12-column budget: the cut keeps the marker off the
    // rendered row (a `**` pair cut in half would print its markers).
    expect(painted(line)).toBe('↑↓ 滚动 · E…')
    expect(line).not.toContain('**')
  })

  it('stays exactly one line at every width, in both layouts and languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLangOverride(lang)
      for (const splitActive of [false, true]) {
        for (let columns = 1; columns <= 140; columns++) {
          const line = painted(composeReaderHint(columns, splitActive))
          expect(line).not.toMatch(/\n/)
          expect(displayWidth(line)).toBeLessThanOrEqual(Math.max(1, columns - 2))
        }
      }
    }
  })
})
