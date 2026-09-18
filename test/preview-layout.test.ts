/**
 * The preview reader's per-keystroke re-layout (staged plan phase 4).
 *
 * `buildPreviewLines` used to do two jobs in one pass: wrap every message to
 * the pane width AND cut the query's hit ranges onto those lines. The ranges
 * are rebuilt on every keystroke while the wrap never changes (the message
 * text and the width are both stable), so the reader re-wrapped the whole
 * conversation each time the user typed — 66-76 ms on a 500 x 3000-character
 * session. Phase 4 split the wrap into a cached layout
 * (`wrapWidthLayout` / `messageLayout`) and a cheap range projection
 * (`projectRanges`), which is what these tests pin: the layout is reused, the
 * ranges still land exactly where they used to, and a width change still
 * re-wraps.
 *
 * Correctness of the projection itself is not re-derived here — the width
 * suite already covers the wrap primitive's windows and slices — so this
 * suite is about the CACHE's contract on top of it.
 */
import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import { buildPreviewLines, type PreviewLine } from '../src/preview.js'
import { displayWidth, wrapWidthLayout, wrapWidthRanges } from '../src/width.js'

/** The body lines of a built preview, in order. */
const bodyLines = (lines: readonly PreviewLine[]) => lines.filter(line => line.kind === 'body')

/** One assistant message carrying `text` — the shape the reader lays out. */
function message(text: string, seq = 1): IndexedMessage {
  return { seq, role: 'assistant', text, at: undefined }
}

describe('preview layout cache', () => {
  it('produces the same ranges as a fresh wrap for every hit shape', () => {
    const messages = [message('auth flow retry logic '.repeat(20)), message('张三 auth 搜索 '.repeat(30))]
    const width = 40
    const rangeSets = [
      new Map<number, readonly (readonly [number, number])[]>(),
      new Map([[0, [[0, 4], [100, 120]] as const]]),
      new Map([
        [0, [[0, 4], [100, 120]] as const],
        [1, [[2, 6], [300, 320]] as const],
      ]),
    ]
    for (const rangesByMessage of rangeSets) {
      const viaCache = buildPreviewLines(messages, new Set([0, 1]), width, rangesByMessage)
      // The reference: every message wrapped from scratch with its ranges.
      const fresh: PreviewLine[] = []
      for (const [index, entry] of messages.entries()) {
        fresh.push({
          kind: 'header',
          messageIndex: index,
          role: entry.role,
          seq: entry.seq,
          at: entry.at,
          isHit: true,
        })
        for (const [bodyIndex, line] of wrapWidthRanges(entry.text, width, rangesByMessage.get(index) ?? []).entries()) {
          fresh.push({
            kind: 'body',
            messageIndex: index,
            role: entry.role,
            bodyIndex,
            text: line.text,
            ranges: line.ranges,
          })
        }
      }
      expect(JSON.stringify(viaCache)).toBe(JSON.stringify(fresh))
    }
  })

  it('serves the layout from the cache across calls with different hits', () => {
    const entry = message('auth flow retry logic '.repeat(40))
    const width = 48
    const first = bodyLines(buildPreviewLines([entry], new Set([0]), width, new Map([[0, [[0, 4]]]])))
    const second = bodyLines(buildPreviewLines([entry], new Set(), width, new Map([[0, [[50, 60]]]])))
    expect(second).toHaveLength(first.length)
    // Same text objects, different ranges: the wrap was reused while the
    // highlight moved — exactly the keystroke shape this phase is about.
    for (let at = 0; at < first.length; at++) {
      expect(second[at]!.text).toBe(first[at]!.text)
    }
    expect(JSON.stringify(first.map(line => line.ranges))).not.toBe(
      JSON.stringify(second.map(line => line.ranges)),
    )
    expect(first[0]!.ranges).toEqual([[0, 4]])
    expect(second[0]!.ranges).toEqual([])
  })

  it('re-wraps when the width changes', () => {
    const entry = message('auth flow retry logic '.repeat(40))
    const wide = bodyLines(buildPreviewLines([entry], new Set(), 100))
    const narrow = bodyLines(buildPreviewLines([entry], new Set(), 40))
    expect(narrow.length).toBeGreaterThan(wide.length)
    // And the narrow layout is what a fresh wrap at that width produces.
    const fresh = wrapWidthLayout(entry.text, 40)
    expect(narrow.map(line => line.text)).toEqual(fresh.map(line => line.text))
  })

  it('matches the wrap primitive on every line text (the layout is the only wrapper)', () => {
    const texts = [
      'plain ascii text that wraps on spaces when it has to keep going',
      '中文文本没有空格所以必须按字符断行这样才能正确换行',
      'mixed 中英文 text with spaces and 更多中文 characters to wrap',
      'short',
      '',
      'a\n\n\nb',
      'trailing space ',
      '   leading and trailing   ',
    ]
    for (const text of texts) {
      for (const width of [1, 2, 5, 12, 40, 100]) {
        const lines = bodyLines(buildPreviewLines([message(text)], new Set(), width))
        const expected = wrapWidthLayout(text, width)
        expect(lines.map(line => line.text), `${JSON.stringify(text)} @${width}`).toEqual(
          expected.map(line => line.text),
        )
        for (const line of lines) {
          // A single wide glyph may exceed a width of 1 (the wrap cannot split
          // a code point); every wider budget is respected exactly.
          if (line.kind === 'body' && width > 1) {
            expect(displayWidth(line.text)).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })
})
