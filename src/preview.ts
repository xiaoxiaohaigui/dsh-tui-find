/**
 * Pure layout and navigation arithmetic for the preview pane's scrollable
 * full-conversation reader (scene.tsx's `mode === 'preview'` branch).
 *
 * The reader lays out EVERY indexed message — one header line per message
 * (role, seq, time, hit flag) plus the body wrapped to the pane's column
 * budget — and scrolls that flat line list behind a cursor: the visible
 * window is fitted around the cursor line with the same `fitScrollWindow`
 * contract the session list uses, every line weighing one physical terminal
 * row. Long bodies are not cut here: indexing already bounds each message
 * (`maxMessageChars`), and the scroll window is the safety net.
 *
 * Nothing here imports React or i18n: every function is a data-in / data-out
 * step so the layout and the hit-jump order are unit-testable without
 * rendering the scene.
 *
 * @module dsh-tui-find/preview
 */
import type { IndexedMessage } from './core/events.js'
import { fitScrollWindow, wrapWidthRanges } from './width.js'

/** One physical line of the built preview. A message renders as its header
 *  line followed by its wrapped body lines; `messageIndex` attributes every
 *  line to its owning message so the scene can highlight, copy and jump by
 *  message while the cursor walks raw lines. */
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
 * The message a cursor line belongs to (a body line answers its own
 * message). Out-of-range lines clamp into the list; an empty list has no
 * message.
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
 * `messageIndex` — where a freshly opened preview parks its cursor. An
 * anchor at or below the head lands on line 0; one at or beyond the tail
 * lands on the last header.
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
 * The start line of the next (`direction` 1) or previous (`direction` -1)
 * hit message relative to `currentMessageIndex`, or undefined when no hit
 * lies that way. `hitStartLines` is indexed BY MESSAGE index: entry m holds
 * the header line of message m when m is a hit, or the -1 sentinel when it
 * is not (the scene derives the table from the built lines' hit headers).
 */
export function jumpHit(
  hitStartLines: readonly number[],
  currentMessageIndex: number,
  direction: 1 | -1,
): number | undefined {
  const count = hitStartLines.length
  if (count === 0) return undefined
  // Start one message past the cursor in the requested direction; a cursor
  // outside the message range clamps to the range edge, so "next" from the
  // head still finds the first hit and "previous" from the tail the last.
  let index = Math.min(Math.max(currentMessageIndex, -1), count - 1) + direction
  while (index >= 0 && index < count && (hitStartLines[index] ?? -1) < 0) index += direction
  if (index < 0 || index >= count) return undefined
  const start = hitStartLines[index] ?? -1
  return start >= 0 ? start : undefined
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

/** One weight per preview line: every line is exactly one terminal row. */
export function unitWeights(lineCount: number): number[] {
  return new Array<number>(Math.max(0, lineCount)).fill(1)
}

/**
 * The preview's visible window over its flat line list — `fitScrollWindow`
 * with all-ones weights (a thin wrapper so tests can exercise the exact
 * contract the scene gets).
 */
export function previewWindow(
  lineCount: number,
  cursorLine: number,
  height: number,
  previousStart: number,
): { start: number; end: number } {
  return fitScrollWindow(unitWeights(lineCount), cursorLine, height, previousStart)
}
