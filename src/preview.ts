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
import { projectRanges, wrapWidthLayout, type WrappedLayoutLine } from './width.js'

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
 * The wrap layout of one message, cached per message object and width.
 *
 * The layout depends on `message.text` and the width and on nothing else —
 * in particular NOT on the query's hit ranges, which are rebuilt on every
 * keystroke. Without this cache the reader re-wrapped the entire conversation
 * each time the user typed (the memo's `rangesByMessage` dependency changes
 * identity every query), which measured 66-76 ms for a 500-message session.
 *
 * The key is the message OBJECT, which is what makes the cache safe: the
 * scanner hands out frozen message objects and keeps them for the life of the
 * index, so a text can never change under a live key, and the entry is
 * collected exactly when the message is. The width rides in a per-message map
 * because a terminal resize must invalidate the layout — the count of widths
 * ever seen is one in practice (two during a resize), and a non-positive
 * width is never stored at all (see messageLayout).
 */
const layoutCache = new WeakMap<IndexedMessage, Map<number, WrappedLayoutLine[]>>()

/** The wrap layout of one message at one width, computed once. */
export function messageLayout(message: IndexedMessage, wrapWidthCols: number): WrappedLayoutLine[] {
  // A non-positive width is not a layout: `wrapWidthLayout` short-circuits to
  // an empty list, and caching that per message would fill the map with
  // entries no resize ever revisits (and hide the invalid column budget). The
  // caller's own arithmetic owns that case.
  if (wrapWidthCols <= 0) return wrapWidthLayout(message.text, wrapWidthCols)
  let byWidth = layoutCache.get(message)
  if (byWidth === undefined) {
    byWidth = new Map()
    layoutCache.set(message, byWidth)
  }
  const cached = byWidth.get(wrapWidthCols)
  if (cached !== undefined) return cached
  const built = wrapWidthLayout(message.text, wrapWidthCols)
  byWidth.set(wrapWidthCols, built)
  return built
}

/** Whether a layout for `message` at `wrapWidthCols` is already in the cache —
 *  the structural half of "this width was laid out once": the returned list
 *  cannot show it, because a cached empty list and a freshly computed one are
 *  equal. Diagnostics surface: nothing in the plugin calls it, but it rides
 *  the shipped `dist/` into the npm artifact with the rest of the module, so
 *  a rename or removal is a breaking change for any consumer that reached for
 *  it (the same note the search module's probes carry). */
export function layoutIsCachedForTest(message: IndexedMessage, wrapWidthCols: number): boolean {
  return layoutCache.get(message)?.has(wrapWidthCols) === true
}

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
 *
 * The wrapping itself comes from {@link messageLayout}, so a keystroke that
 * only moves the hits re-slices ranges against the cached layout instead of
 * re-wrapping the conversation — the phase-4 fix for the split layout's
 * per-keystroke re-layout. The returned lines are new objects either way (they
 * carry per-query hits); only the expensive part is shared.
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
    const hitRanges = rangesByMessage.get(messageIndex) ?? []
    const layout = messageLayout(message, wrapWidthCols)
    for (const [bodyIndex, line] of layout.entries()) {
      lines.push({
        kind: 'body',
        messageIndex,
        role: message.role,
        bodyIndex,
        text: line.text,
        ranges: projectRanges(hitRanges, line),
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
 * The first body line of `messageIndex` that carries a hit range — the line
 * the keyword is actually painted on, i.e. where that hit lives on screen.
 * Undefined when the message's hits are not in its indexed body (a title hit,
 * an anchor of -1, a hit range that fell outside this wrap): the message is a
 * hit, but no line of it shows why.
 *
 * The scan stops at the next message's header, so a body line of the message
 * BELOW can never answer for the message above (an out-of-range anchor clamps
 * onto the last header, exactly as {@link messageHeaderLine} does).
 */
export function messageHitLine(
  lines: readonly PreviewLine[],
  messageIndex: number,
): number | undefined {
  const headerLine = Math.max(0, messageHeaderLine(lines, messageIndex))
  for (let at = headerLine; at < lines.length; at++) {
    const line = lines[at]
    if (line === undefined) break
    if (line.kind === 'header' && line.messageIndex > messageIndex) break
    if (line.kind === 'body' && line.ranges.length > 0) return at
  }
  return undefined
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
  const hitLine = messageHitLine(lines, messageIndex)
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
 * Where the backward step searches up from: the parked hit's own header, the
 * window top when the parked message is not a hit at all, or — in one state —
 * the parked hit's own keyword line.
 *
 * Bounding at the header is what keeps a repeat `N` moving: after a
 * hit-aware landing the parked hit itself fills the screen while its header
 * sits above the window top, so naming that header would land on the line
 * already shown. That reasoning fails once the reader scrolls DOWN past the
 * keyword while still parked inside the same message: the hit is then above
 * the window like any other (the header is further up still), and `N` — which
 * is the only step pointing at it, since `n` skips it by its own rule (its
 * header sits above the window's end) — would walk straight past it, leaving
 * the nearest hit above the window unreachable without manual scrolling. Its
 * keyword line is the bound in that state: the range up to it holds no other
 * message (only the parked message's own header), so the parked hit becomes
 * the first candidate and the caller's landing scrolls the keyword back into
 * view — after which the keyword is on screen again and the header rule
 * resumes, so the key still never dead-ends.
 */
function backwardBound(
  parkedHit: number,
  parkedHitBodyLine: number | undefined,
  windowStart: number,
): number {
  if (parkedHit < 0) return windowStart
  if (parkedHitBodyLine !== undefined && parkedHitBodyLine >= 0 && parkedHitBodyLine < windowStart) {
    return parkedHitBodyLine
  }
  return parkedHit
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
 * "Above the window's top" is NOT the same as "off screen" in the backward
 * direction: a hit-aware landing opens the window BELOW its own hit's header
 * (see hitLanding), so the hit the reader is parked on also has its header
 * up there. `currentMessage` — the message index owning the window's top
 * line (messageAtLine) — is what tells the two apart: the backward step
 * searches above the parked hit's own header, because naming that hit would
 * only land the window on the very line it already shows and `N` would read
 * as a dead key.
 *
 * A parked message whose keyword the reader has since scrolled PAST is the
 * one exception (see backwardBound): bounding at its header would hide the
 * nearest hit above the window from both steps, so the hit's own body line
 * takes over as the bound and `N` steps onto it.
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
  /** The message owning the window's top line, or undefined when the reader
   *  holds no lines at all (and therefore no hits to walk). */
  currentMessage: number | undefined,
  /** The parked message's own first hit body line ({@link messageHitLine}) —
   *  undefined when it has none (its hit is not in its indexed body, a title
   *  hit, no lines at all). Only the backward direction reads it. */
  parkedHitBodyLine?: number,
): number | undefined {
  // The parked hit's own header — the backward bound. Every other parked
  // message (a non-hit one, or none) keeps the window top it always used.
  const parkedHit = currentMessage === undefined ? -1 : (hitStartLines[currentMessage] ?? -1)
  const backwardFrom = backwardBound(parkedHit, parkedHitBodyLine, windowStart)
  let first: number | undefined
  let last: number | undefined
  let below: number | undefined
  let above: number | undefined
  for (const line of hitStartLines) {
    if (line < 0) continue
    if (first === undefined || line < first) first = line
    if (last === undefined || line > last) last = line
    if (line >= windowEnd && (below === undefined || line < below)) below = line
    if (line < backwardFrom && (above === undefined || line > above)) above = line
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
