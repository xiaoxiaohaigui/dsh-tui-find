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
import { composeListHint, composeReaderHint } from '../src/find-chrome.js'
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

describe('list hint composition (the entry-key advisory)', () => {
  it('says nothing about the entry while the combo is free', () => {
    setLangOverride('zh')
    const line = painted(composeListHint(120, false))
    expect(line).toContain('Enter 恢复')
    expect(line).not.toContain('入口占用')
  })

  it('names the scene key the global entry has taken (R-160)', () => {
    setLangOverride('zh')
    // `shortcut: alt+h` cannot be explained by the help sheet — that very key
    // closes the scene — so the hint line carries it.
    expect(painted(composeListHint(120, false, { kind: 'shadowed', key: 'Alt+H' }))).toContain(
      'Alt+H 已被入口占用',
    )
    // The advisory sits second: at every width that still paints more than the
    // first segment it is the one that survives, and only the tail drops. (A
    // terminal narrow enough to cut it is narrow enough to cut every middle
    // segment — the row is a prefix fill, not a per-segment priority list.)
    for (const columns of [120, 100, 80]) {
      setLangOverride('zh')
      expect(painted(composeListHint(columns, false, { kind: 'shadowed', key: 'Alt+R' })), `${columns} columns`).toContain(
        'Alt+R 已被入口占用',
      )
    }
  })

  it('names the live combo when the host refused the configured one (10-06 real machine)', () => {
    setLangOverride('zh')
    // alt+r is the host's own Continue action: the registry refuses it, the
    // plugin keeps the previous binding, and the settings card goes on showing
    // alt+r. The hint line has to say which combo is actually live.
    const line = painted(composeListHint(120, false, { kind: 'refused', combo: 'Alt+R', effective: 'Alt+F' }))
    expect(line).toContain('Alt+R 未被宿主接受，实际入口 Alt+F')

    setLangOverride('en')
    expect(painted(composeListHint(120, false, { kind: 'refused', combo: 'Alt+R', effective: 'Alt+F' }))).toContain(
      'Alt+R refused — the entry is Alt+F',
    )
  })

  it('keeps both advisories at the common 80-column terminal, in both languages', () => {
    // The row is a prefix fill: an advisory that does not fit is dropped, not
    // truncated. The English refusal copy shipped 46 cells wide in its first
    // draft and vanished at exactly 80 columns — the width a terminal most
    // often has, and the one the scene harness renders at.
    for (const lang of ['zh', 'en'] as const) {
      setLangOverride(lang)
      expect(painted(composeListHint(80, false, { kind: 'shadowed', key: 'Alt+H' })), `${lang} shadowed`).toContain(
        lang === 'zh' ? 'Alt+H 已被入口占用' : 'Alt+H taken by the entry',
      )
      expect(
        painted(composeListHint(80, false, { kind: 'refused', combo: 'Alt+R', effective: 'Alt+F' })),
        `${lang} refused`,
      ).toContain(lang === 'zh' ? 'Alt+R 未被宿主接受，实际入口 Alt+F' : 'Alt+R refused — the entry is Alt+F')
    }
  })

  it('keeps the advisory and the keys row on exactly one line at every width', () => {
    for (const lang of ['zh', 'en'] as const) {
      setLangOverride(lang)
      for (const advisory of [
        { kind: 'shadowed', key: 'Alt+H' } as const,
        { kind: 'refused', combo: 'Alt+R', effective: 'Alt+F' } as const,
      ]) {
        for (let columns = 1; columns <= 140; columns++) {
          const line = painted(composeListHint(columns, false, advisory))
          expect(line).not.toMatch(/\n/)
          expect(displayWidth(line)).toBeLessThanOrEqual(Math.max(1, columns - 2))
        }
      }
    }
  })
})
