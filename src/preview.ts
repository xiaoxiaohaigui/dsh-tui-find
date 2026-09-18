/**
 * Pure layout and navigation arithmetic for the preview pane's scrollable
 * full-conversation reader (scene.tsx's `mode === 'preview'` branch).
 *
 * The reader lays out EVERY indexed message — one header line per message
 * (role, seq, time, hit flag) plus the body wrapped to the pane's column
 * budget — and scrolls that flat line list behind an OFFSET (the top line of
 * the viewport), not a cursor: a read-only reader has nothing to select, so
 * arrows and the wheel move the window itself (see scrollWindow). Long
 * bodies are not cut here: indexing already bounds each message
 * (`maxMessageChars`), and the window is the safety net.
 *
 * Nothing here imports React or i18n: every function is a data-in / data-out
 * step so the layout and the hit-jump order are unit-testable without
 * rendering the scene.
 *
 * @module dsh-tui-find/preview
 */
import type { IndexedMessage } from './core/events.js'
import { wrapWidthRanges } from './width.js'

/** One physical line of the built preview. A message renders as its header
 *  line followed by its wrapped body lines; `messageIndex` attributes every
 *  line to its owning message so the scene can highlight, copy and jump by
 *  message while the scroll window walks raw lines. */
export type PreviewLine =
  | {
      readonly kind: 'header'
      /** Owning message's index in the previewed messages array. */
      readonly messageIndex: number
      /** Drives the ROLE_MARK glyph/colour in the scene. */
      readonly role: IndexedMessage['role']
      /** Envelope seq; undefined when the log carried none. */
      readonly seq: number | undefined
      /** Envelope epoch-ms; undefined when absent. */
      readonly at: number | undefined
      /** Whether the owning message is one of the query's hits. */
      readonly isHit: boolean
    }
  | {
      readonly kind: 'body'
      readonly messageIndex: number
      /** Kept on body lines so the scene can dim assistant bodies without
       *  reaching for the messages array (headers may be scrolled away). */
      readonly role: IndexedMessage['role']
      /** 0-based index within the owning message's body: the scene indents
       *  continuation lines deeper than the first (its own vocabulary). */
      readonly bodyIndex: number
      readonly text: string
      /** The owning message's hit ranges that land on THIS line, rebased
       *  into the line's own UTF-16 coordinates by the wrap primitive;
       *  empty when the message carries no hits (or the line none). */
      readonly ranges: readonly (readonly [number, number])[]
    }

/** Hit ranges keyed by message index — the ORIGINAL-text UTF-16 offsets,
 *  sorted and disjoint, exactly what the search kernel attaches to a hit. */
export type RangesByMessage = ReadonlyMap<number, readonly (readonly [number, number])[]>

/** The shared empty table: callers without hits pass nothing at all. */
const NO_RANGES: RangesByMessage = new Map()

/**
 * Lay a whole conversation out as flat preview lines: one header per
 * message (marked as a hit when its index is in `hitIndices`), then the
 * message text wrapped to `wrapWidthCols` display columns (newlines
 * honoured; an empty body yields one empty body line, the natural blank
 * separator). Body lines carry content and attribution only — indent and
 * chrome are the scene's decisions.
 *
 * `rangesByMessage` (optional, empty by default) feeds the reader's hit
 * highlighting: each body line receives its slice of the owning message's
 * ranges, already rebased onto the line, so the scene can paint the
 * keyword without re-deriving offsets across the reflow.
 */
export function buildPreviewLines(
  messages: readonly IndexedMessage[],
  hitIndices: ReadonlySet<number>,
  wrapWidthCols: number,
  rangesByMessage: RangesByMessage = NO_RANGES,
): PreviewLine[] {
  const lines: PreviewLine[] = []
  for (const [messageIndex, message] of messages.entries()) {
    lines.push({
      kind: 'header',
      messageIndex,
      role: message.role,
      seq: message.seq,
      at: message.at,
      isHit: hitIndices.has(messageIndex),
    })
    const wrapped = wrapWidthRanges(message.text, wrapWidthCols, rangesByMessage.get(messageIndex) ?? [])
    for (const [bodyIndex, line] of wrapped.entries()) {
      lines.push({
        kind: 'body',
        messageIndex,
        role: message.role,
        bodyIndex,
        text: line.text,
        ranges: line.ranges,
      })
    }
  }
  return lines
}

/**
 * The message a line belongs to (a body line answers its own message).
 * Out-of-range lines clamp into the list; an empty list has no message.
 */
export function messageAtLine(
  lines: readonly PreviewLine[],
  line: number,
): number | undefined {
  if (lines.length === 0) return undefined
  const clamped = Math.min(Math.max(0, line), lines.length - 1)
  const at = lines[clamped]
  return at === undefined ? undefined : at.messageIndex
}

/**
 * The preview line number of the header of the first message at or after
 * `messageIndex` — where a freshly opened preview anchors. An anchor at or
 * below the head lands on line 0; one at or beyond the tail lands on the
 * last header.
 */
export function messageHeaderLine(
  lines: readonly PreviewLine[],
  messageIndex: number,
): number {
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]
    if (line !== undefined && line.kind === 'header' && line.messageIndex >= messageIndex) return at
  }
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]
    if (line !== undefined && line.kind === 'header') return at
  }
  return 0
}

/**
 * The line a fresh anchor opens the reader ON — the top line of its window.
 * When the anchored message's hit fits in the viewport below its own header,
 * the reader keeps the header-anchored shape (window starting at the header)
 * and the keyword is simply on screen; otherwise — the everyday case in a
 * long message, where the hit sits far below the header — the window opens
 * above the hit's own body line with a little leading context, because a
 * reader that never shows the keyword the query matched is useless.
 *
 * A message whose hits are not in its indexed body (a title hit, an anchor
 * of -1, a hit range that fell outside this wrap) keeps the header landing.
 * Pure arithmetic over the built lines; the caller applies it.
 */
export function hitLanding(
  lines: readonly PreviewLine[],
  messageIndex: number,
  viewportHeight: number,
): number {
  const headerLine = messageHeaderLine(lines, messageIndex)
  const viewport = Math.max(1, Math.floor(viewportHeight))
  let hitLine: number | undefined
  for (let at = Math.max(0, headerLine); at < lines.length; at++) {
    const line = lines[at]
    if (line === undefined) break
    if (line.kind === 'header' && line.messageIndex > messageIndex) break
    if (line.kind === 'body' && line.ranges.length > 0) {
      hitLine = at
      break
    }
  }
  // Reachable from the header: the anchored frame already shows the keyword
  // (and the message's own head), so nothing about it should move.
  if (hitLine === undefined || hitLine - headerLine + 1 <= viewport) return headerLine
  // Unreachable: open above the hit with about a third of the viewport as
  // leading context, never scrolled above the message's own header.
  const lead = Math.max(0, Math.min(Math.floor(viewport / 3), hitLine - headerLine))
  return Math.max(headerLine, hitLine - lead)
}

/**
 * The reader's visible window for a scroll offset: the offset is the top
 * line, clamped into [0, lineCount - height] so the window never runs off
 * either end, and the end stops at the content. All preview lines weigh one
 * terminal row, so the arithmetic is exact.
 */
export function scrollWindow(
  lineCount: number,
  offset: number,
  height: number,
): { start: number; end: number } {
  const count = Math.max(0, lineCount)
  const viewport = Math.max(1, Math.floor(height))
  const maxStart = Math.max(0, count - viewport)
  const start = Math.min(Math.max(0, Math.floor(offset)), maxStart)
  return { start, end: Math.min(count, start + viewport) }
}

/**
 * The hit `n`/`N` moves to, as the hit message's header line. The reader has
 * no cursor, so its position is the visible window: `n` (direction 1) takes
 * the first hit at or below the window's end and `N` (direction -1) the last
 * one above its top, each wrapping to the opposite end of the hit list —
 * the n/N vocabulary is a navigator, not a bounded search. Because the
 * window is what the user sees, a hit that is already on screen is never the
 * answer (except by wrapping), so a repeat press always moves.
 *
 * `hitStartLines` is indexed BY MESSAGE index: entry m holds the header line
 * of message m when m is a hit, or the -1 sentinel when it is not (the scene
 * derives the table from the built lines' hit headers).
 */
export function jumpHitLine(
  hitStartLines: readonly number[],
  windowStart: number,
  windowEnd: number,
  direction: 1 | -1,
): number | undefined {
  let first: number | undefined
  let last: number | undefined
  let below: number | undefined
  let above: number | undefined
  for (const line of hitStartLines) {
    if (line < 0) continue
    if (first === undefined || line < first) first = line
    if (last === undefined || line > last) last = line
    if (line >= windowEnd && (below === undefined || line < below)) below = line
    if (line < windowStart && (above === undefined || line > above)) above = line
  }
  if (first === undefined || last === undefined) return undefined
  return direction > 0 ? (below ?? first) : (above ?? last)
}

/**
 * The hit message the reader is parked on, for the copy chord: the hit
 * whose header line is the last one at or above the window's top — the hit
 * an n/N landing or a scroll left at the reader's position. When the window
 * sits above every hit (scrolled back to the conversation head), the answer
 * is the first hit, the one `n` would jump to, so the chord never goes dead
 * while the session HAS hits. Undefined when it has none at all (a recent
 * card, a title-only match): the caller keeps its own fallback.
 */
export function currentHitMessage(
  hitStartLines: readonly number[],
  windowStart: number,
): number | undefined {
  let current: number | undefined
  let currentLine = -1
  let first: number | undefined
  let firstLine = Number.POSITIVE_INFINITY
  for (let at = 0; at < hitStartLines.length; at++) {
    const line = hitStartLines[at] ?? -1
    if (line < 0) continue
    if (line <= windowStart && line > currentLine) {
      current = at
      currentLine = line
    }
    if (line < firstLine) {
      first = at
      firstLine = line
    }
  }
  return current ?? first
}

/**
 * The 1-based position of `messageIndex` among the hit messages (hits at or
 * before it) and the hit total — the "hit i/total" status pair. When the
 * message is not itself a hit, `index` counts the hits before it.
 */
export function hitOrdinal(
  hitStartLines: readonly number[],
  messageIndex: number,
): { index: number; total: number } {
  let index = 0
  let total = 0
  for (let at = 0; at < hitStartLines.length; at++) {
    if ((hitStartLines[at] ?? -1) < 0) continue
    total += 1
    if (at <= messageIndex) index += 1
  }
  return { index, total }
}
