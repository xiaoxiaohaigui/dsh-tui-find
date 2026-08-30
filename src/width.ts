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
