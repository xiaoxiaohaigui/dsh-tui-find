/**
 * CJK-aware terminal display-width arithmetic for the find scene's hand-laid
 * rows. The host kit exports only Box/Text/hooks to plugin scenes — its
 * `stringWidth` and `sessions/format` helpers are internal — so the scene
 * reimplements the three layout primitives the session browser's rows rely
 * on (truncate / tail-window / spread), with the same contracts:
 *
 * - a row is measured in DISPLAY COLUMNS (a wide CJK character costs two),
 *   never in UTF-16 units — `.length` overstates CJK text and overflows;
 * - an overlong row is cut with an ellipsis instead of wrapping, because a
 *   wrapped row shifts every region below it down a line.
 *
 * The preview reader additionally wraps whole message bodies:
 * {@link wrapWidthRanges} is the one core behind {@link wrapWidth} and hands
 * back each physical line together with the hit ranges that land on it, so
 * highlights measured on the ORIGINAL text survive the reflow.
 *
 * @module dsh-tui-find/width
 */

/** Code-point ranges rendered two columns wide (East Asian Wide/Fullwidth,
 *  plus the emoji planes a session title realistically carries). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

/** Display width of one code point: 2 for wide ranges, 1 otherwise. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  for (const [low, high] of WIDE_RANGES) {
    if (code >= low && code <= high) return 2
  }
  return 1
}

/** Display width of a string in terminal columns. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * Truncate to a display width, CJK-aware: the text when it fits, otherwise a
 * cut ending in `…` (ellipsis included in the budget).
 */
export function truncateWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const w = charWidth(char)
    if (width + w > maxWidth - 1) break
    width += w
    out += char
  }
  return `${out}…`
}

/**
 * Keep the END of a string within a display width, CJK-aware (`…` prefix
 * included in the budget) — what a single-line, caret-at-end editor shows.
 */
export function tailWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  const characters = [...text]
  let width = 0
  let out = ''
  for (let at = characters.length - 1; at >= 0; at--) {
    const character = characters[at]!
    const w = charWidth(character)
    if (width + w > maxWidth - 1) break
    width += w
    out = character + out
  }
  return `…${out}`
}

/** One wrapped physical line: the line text plus the highlight ranges that
 *  land on it, rebased into the line's own UTF-16 coordinates. */
export interface WrappedLine {
  readonly text: string
  readonly ranges: [number, number][]
}

/**
 * Intersect `ranges` (original-text UTF-16 offsets, sorted and disjoint) with
 * a line's original-text window `[from, to)` and rebase the survivors onto
 * the line's own coordinates. A range straddling the window is cut at both
 * edges; one with no overlap is dropped; an empty window carries nothing.
 */
function windowRanges(
  ranges: readonly (readonly [number, number])[],
  from: number | undefined,
  to: number,
): [number, number][] {
  if (from === undefined || to <= from) return []
  const out: [number, number][] = []
  for (const [start, end] of ranges) {
    const low = Math.max(start, from)
    const high = Math.min(end, to)
    if (high > low) out.push([low - from, high - from])
  }
  return out
}

/**
 * The core behind {@link wrapWidth}: the same greedy CJK-aware wrap, with
 * every output line ALSO carrying the slice of `ranges` — original-text
 * UTF-16 offsets, sorted and disjoint, as the search kernel produces them —
 * that lands on that line. The text output is byte-identical to `wrapWidth`
 * (that function is this one with the ranges discarded), so the two can
 * never drift.
 *
 * The mapping is plain subtraction because every output line's characters
 * are one CONTIGUOUS slice of the input: the only hole a break ever opens
 * is the single boundary space it drops, and that hole sits BETWEEN two
 * lines. Each line therefore spans `[from, to)` in original-text offsets,
 * and a range crossing the dropped space — or the newline between
 * paragraphs — simply arrives as one segment on each line it touches.
 */
export function wrapWidthRanges(
  text: string,
  width: number,
  ranges: readonly (readonly [number, number])[],
): WrappedLine[] {
  if (width <= 0) return []
  const lines: WrappedLine[] = []
  // UTF-16 offset of the current paragraph inside `text`; the separating
  // '\n' belongs to neither paragraph.
  let paragraphStart = 0
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    // Original-text window [lineFrom, lineTo) of the line being built:
    // `lineFrom` is its first character's offset (undefined while the line
    // is empty), `lineTo` its end; `cursor` is the offset of the character
    // about to be appended.
    let lineFrom: number | undefined = undefined
    let lineTo = paragraphStart
    let cursor = paragraphStart
    for (const char of paragraph) {
      const charW = charWidth(char)
      if (used + charW > width) {
        // Prefer a word boundary, but only when it does not throw away most
        // of the line — a single long token must still make progress.
        const breakAt = line.lastIndexOf(' ')
        if (breakAt > width / 2) {
          const headFrom: number = lineFrom ?? cursor
          const headTo: number = headFrom + breakAt
          lines.push({ text: line.slice(0, breakAt), ranges: windowRanges(ranges, headFrom, headTo) })
          const tailFrom: number = headTo + 1 // the boundary space is dropped
          line = line.slice(breakAt + 1)
          used = displayWidth(line)
          lineFrom = line.length === 0 ? undefined : tailFrom
          lineTo = tailFrom + line.length
        } else {
          lines.push({ text: line, ranges: windowRanges(ranges, lineFrom, lineTo) })
          line = ''
          used = 0
          lineFrom = undefined
          lineTo = cursor
        }
      }
      line += char
      used += charW
      if (lineFrom === undefined) lineFrom = cursor
      lineTo = cursor + char.length
      cursor += char.length
    }
    lines.push({ text: line, ranges: windowRanges(ranges, lineFrom, lineTo) })
    paragraphStart += paragraph.length + 1
  }
  return lines
}

/**
 * Wrap to a display width, CJK-aware. Greedy, breaking on a space when one
 * is available in the line just filled and mid-character when it is not —
 * correct for CJK, where there are no spaces to break on. Newlines in the
 * input are honoured. (The host browser's own `wrapWidth` contract.)
 */
export function wrapWidth(text: string, width: number): string[] {
  return wrapWidthRanges(text, width, []).map(line => line.text)
}

/**
 * Scroll-window arithmetic for the flattened list, fitted in PHYSICAL
 * terminal lines. Rows spend different line counts (a session card is its
 * title + metadata pair; a hit row is one line), so a window sliced by row
 * COUNT renders up to twice the viewport in a card-heavy list and the
 * selection walks off the bottom without the window ever moving — the
 * on-device "arrow keys don't scroll the page" bug. `previous` is the
 * caller's current window start: moving up snaps the selection to the top
 * of the window, moving down keeps it inside by advancing the start just
 * far enough for the selected row's own lines to fit.
 *
 * @param weights - Physical line count of each row.
 * @param selected - Flat index of the selected row (clamped here).
 * @param height - Viewport budget in terminal lines.
 * @param previous - Previous window start (hysteresis; avoids jumping).
 * @returns The visible flat-index range `[start, end)`; `end` stops at the
 *   physical budget so the list never overflows the viewport.
 */
export function fitScrollWindow(
  weights: readonly number[],
  selected: number,
  height: number,
  previous: number,
): { start: number; end: number } {
  const count = weights.length
  if (count === 0 || height <= 0) return { start: 0, end: 0 }
  const prefix = new Array<number>(count + 1)
  prefix[0] = 0
  for (let index = 0; index < count; index++) prefix[index + 1] = prefix[index]! + weights[index]!
  const span = (from: number, to: number): number => prefix[to]! - prefix[from]!

  const sel = Math.min(Math.max(0, selected), count - 1)
  let start = Math.min(Math.max(0, previous), sel)
  while (start < sel && span(start, sel + 1) > height) start++

  let end = start
  while (end < count && span(start, end + 1) <= height) end++
  // Degenerate guard: a single row taller than the window still renders.
  if (end <= sel) end = sel + 1
  return { start, end }
}

/** A one-line hit preview: the flattened text plus highlight ranges
 *  expressed over that text's own UTF-16 coordinates. */
export interface HitLine {
  readonly text: string
  readonly ranges: readonly (readonly [number, number])[]
}

interface FlatCps {
  readonly chars: string[]
  readonly widths: readonly number[]
  /** Flat code-point index → origin code-point index in the source text. */
  readonly origins: readonly number[]
}

/** Whitespace as a single flat column: any run of blanks (spaces, tabs,
 *  and the newlines a message body carries) collapses to one space — a hit
 *  row must be exactly one terminal line, and multi-line markdown bodies
 *  would otherwise paint whole paragraphs into the list. */
function flattenCodePoints(text: string): FlatCps {
  const chars: string[] = []
  const widths: number[] = []
  const origins: number[] = []
  const codePoints = [...text]
  let inBlank = false
  for (let index = 0; index < codePoints.length; index++) {
    const char = codePoints[index]!
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (!inBlank) {
        chars.push(' ')
        widths.push(1)
        origins.push(index)
        inBlank = true
      }
      continue
    }
    inBlank = false
    chars.push(char)
    widths.push(charWidth(char))
    origins.push(index)
  }
  return { chars, widths, origins }
}

/**
 * One search-hit row's text, ready to paint: the message is flattened to a
 * single line (whitespace runs — newlines included — become one space), and
 * when the line still exceeds `maxWidth` the window is cut AROUND THE FIRST
 * HIGHLIGHT with `…` marking each cut side, so the keyword the user searched
 * for is always on screen even when it sits deep inside a long message (a
 * head-cut alone hides it whenever the match is past the budget).
 *
 * The returned ranges are rebased into the returned string's own UTF-16
 * coordinates, ready for a highlight renderer.
 */
export function hitLine(
  text: string,
  ranges: readonly (readonly [number, number])[],
  maxWidth: number,
): HitLine {
  if (maxWidth <= 0) return { text: '', ranges: [] }
  const flat = flattenCodePoints(text)
  const count = flat.chars.length
  if (count === 0) return { text: '', ranges: [] }

  // Original code-point index → flat code-point index (`origins` is sorted).
  const flatIndexOfOrigin = (origin: number): number => {
    let low = 0
    let high = count
    while (low < high) {
      const mid = (low + high) >> 1
      if (flat.origins[mid]! < origin) low = mid + 1
      else high = mid
    }
    return low
  }
  // Original UTF-16 index → original code-point index (ranges produced by
  // matchRanges are code-point aligned, so exact boundary hits exist).
  const cpStarts: number[] = []
  let utf16 = 0
  for (const char of text) {
    cpStarts.push(utf16)
    utf16 += char.length
  }
  const cpOfUtf16 = (at: number): number => {
    let low = 0
    let high = cpStarts.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (cpStarts[mid]! < at) low = mid + 1
      else high = mid
    }
    return low
  }
  const flatRanges = ranges
    .map(([start, end]) => [flatIndexOfOrigin(cpOfUtf16(start)), flatIndexOfOrigin(cpOfUtf16(end))] as const)
    .filter(([start, end]) => end > start)

  // Flat code-point index → UTF-16 offset inside the flat string.
  const flatUtf16: number[] = []
  let flatOffset = 0
  for (let index = 0; index < count; index++) {
    flatUtf16.push(flatOffset)
    flatOffset += flat.chars[index]!.length
  }
  const toUtf16Range = ([start, end]: readonly [number, number]): [number, number] => [
    flatUtf16[start]!,
    flatUtf16[end] ?? flatOffset,
  ]

  const widths = flat.widths
  const prefix = new Array<number>(count + 1)
  prefix[0] = 0
  for (let index = 0; index < count; index++) prefix[index + 1] = prefix[index]! + widths[index]!

  if (prefix[count]! <= maxWidth) {
    return { text: flat.chars.join(''), ranges: flatRanges.map(toUtf16Range) }
  }

  // Window around the first highlight. Reserve one column per cut side up
  // front (a window of this size always fits `maxWidth`), center the match
  // with a lean toward the leading context, and walk outward by width.
  const first = flatRanges[0] ?? [0, Math.min(1, count)]
  const [matchStart, matchEnd] = first
  const matchWidth = prefix[matchEnd]! - prefix[matchStart]!
  const budget = Math.max(1, maxWidth - 2)
  let startCp = matchStart
  let used = 0
  const leftGoal = matchStart > 0 ? Math.floor(Math.max(0, budget - matchWidth) * 0.6) : 0
  while (startCp > 0 && used + widths[startCp - 1]! <= leftGoal) {
    startCp -= 1
    used += widths[startCp]!
  }
  let endCp = matchEnd
  while (endCp < count && used + (prefix[endCp + 1]! - prefix[endCp]!) <= budget - matchWidth) {
    used += widths[endCp]!
    endCp += 1
  }
  // The match itself must never be the thing that does not fit.
  if (used + matchWidth > budget) {
    startCp = matchStart
    endCp = matchStart
    used = 0
    while (endCp < matchEnd && used + widths[endCp]! <= budget) {
      used += widths[endCp]!
      endCp += 1
    }
  }

  const lead = startCp > 0 ? '…' : ''
  const tail = endCp < count ? '…' : ''
  const slice = flat.chars.slice(startCp, endCp).join('')
  const base = lead.length
  const windowed = flatRanges
    .map(([start, end]) =>
      [
        Math.max(start, startCp),
        Math.min(end, endCp),
      ] as const,
    )
    .filter(([start, end]) => end > start)
    .map(([start, end]) =>
      [
        base + flatUtf16[start]! - flatUtf16[startCp]!,
        base + (flatUtf16[end] ?? flatOffset) - flatUtf16[startCp]!,
      ] as [number, number],
    )
  return { text: `${lead}${slice}${tail}`, ranges: windowed }
}

/**
 * Lay out one row with its two ends pushed apart, never wider than
 * `columns`: the left segment yields first, the right is truncated, and at
 * least one column of separation always remains.
 */
export function spreadRow(
  left: string,
  right: string,
  columns: number,
): { left: string; gap: number; right: string } {
  if (columns <= 0) return { left: '', gap: 0, right: '' }
  const fittedLeft = truncateWidth(left, Math.max(0, columns - 1))
  const leftWidth = displayWidth(fittedLeft)
  const fittedRight = truncateWidth(right, Math.max(0, columns - leftWidth - 1))
  return {
    left: fittedLeft,
    gap: Math.max(1, columns - leftWidth - displayWidth(fittedRight)),
    right: fittedRight,
  }
}
