/**
 * The preview reader: a scrollable full-conversation view over one session,
 * mounted in two shapes off the same model and the same row renderer — the
 * full-screen pane (classic layout, Alt+P) and the split layout's right
 * column. `usePreviewModel` owns the scroll-window/anchor state and derives
 * the line list and hit tables; it also consumes the pending anchor (or, in
 * split mode, the selection-driven anchor) and clamps the window during the
 * SCENE's own render — the render-phase adjust pattern (a component
 * adjusting its own state while rendering is legal, so the anchored frame is
 * the committed one and nothing flickers). The panes are pure display over
 * the already adjusted window.
 *
 * The reader has NO cursor: a read-only view has nothing to select, so all
 * navigation (↑↓, PgUp/PgDn, the wheel) moves the window itself and the
 * panes paint content only — no marker, no selection bar, no accent of their
 * own. That also settles the split screen's focus question structurally: the
 * list is the only surface that ever shows a selection.
 *
 * @module dsh-tui-find/find-preview
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import type { ScannedSession } from './core/scan.js'
import type { MessageHit } from './core/search.js'
import { tailWidth, truncateWidth } from './width.js'
import { buildPreviewLines, hitLanding, scrollWindow, type PreviewLine } from './preview.js'
import { HighlightedText, HintLine } from './find-chrome.js'
import {
  displayTitle,
  formatWhen,
  ROLE_MARK,
  roleMarkColor,
  wheelRows,
  type ContextBoxProps,
  type ContextMenuEventLike,
  type FlatRow,
  type StatusNote,
  type Ui,
  type WheelBoxProps,
  type WheelEventLike,
} from './find-types.js'

/** The preview reader's state and derived tables, shared by both panes and
 *  the input dispatcher. `windowStart` is the reader's whole navigation
 *  state — the flat line offset at the top of the viewport (see
 *  scrollWindow). It is re-set on re-anchor: every classic Alt+P re-anchors
 *  (the hit message's header line, or the head for cards and title hits),
 *  delivered through anchorRef and consumed by the model during the scene's
 *  render; in split mode the anchor instead follows the list selection
 *  (deduplicated — see `selectionAnchored`). The ref/setter types stay
 *  structural so the scene's own useState/useRef values flow in regardless
 *  of the host React typings' version. */
export interface PreviewModel {
  /** Top line of the viewport (already clamped). */
  windowStart: number
  /** End of the visible window — the panes slice `lines` with it. */
  windowEnd: number
  setWindowStart: (next: number | ((current: number) => number)) => void
  anchorRef: { current: number | undefined }
  session: ScannedSession | undefined
  hitStarts: number[]
  lines: PreviewLine[]
  bodyWidth: number
  stepByWheel: (event: WheelEventLike) => void
}

/** The message a split-mode anchor parks the reader on for a list row: a
 *  hit row its own message, a results card the session's FIRST message hit,
 *  a recent card (no hit bundle) the conversation head (-1). */
function anchorMessageOf(row: FlatRow): number {
  if (row.kind === 'message') return row.message.sourceIndex ?? -1
  const hits = row.hits ?? []
  for (const entry of hits) {
    if (entry.kind === 'message') return entry.sourceIndex ?? -1
  }
  return -1
}

/**
 * Identity of a session's hit set for the reader's anchor dedup: every
 * matched message with its highlight ranges. Two renders of the same query
 * produce the same signature, so unrelated repaints (toasts, progress ticks,
 * wheel scrolls) keep the manual-scroll truce; a query edit that moves a
 * match produces a new one and re-lands the reader on the hit — the everyday
 * case of typing a keyword that sits deep inside the already-selected
 * session's message, where the target message never changes but its hit does.
 */
function hitSignature(hits: readonly MessageHit[]): string {
  let signature = ''
  for (const hit of hits) {
    signature += `${hit.sourceIndex ?? -1}:`
    for (const [start, end] of hit.ranges) signature += `${start}-${end},`
    signature += ';'
  }
  return signature
}

export function usePreviewModel(
  React: TuiSceneProps['React'],
  options: {
    /** True while a reader surface is actually mounted (split: the pane is
     *  always up; classic: only the full-screen preview). Gates the session
     *  derivation, the anchoring and the window following. */
    readerActive: boolean
    /** The scene's readerActive mirror — the wheel callback must not scroll
     *  after the reader unmounted but before the re-render commits, and in
     *  split mode the wheel works over the pane regardless of which side
     *  holds the keyboard focus. */
    readerActiveRef: { current: boolean }
    /** Split mode: the LIST SELECTION drives the anchor (deduplicated by
     *  the (sessionId, messageIndex) target — manual scrolling in the pane
     *  is only ever overridden when the target itself changes). Classic
     *  keeps the Alt+P anchorRef path instead. */
    selectionAnchored: boolean
    selectedRow: FlatRow | undefined
    /** Body wrap width in display columns — the caller's geometry (solo
     *  viewport vs bordered pane interior), not the model's business. */
    bodyWidth: number
    /** Scroll viewport height in terminal rows, likewise the caller's. */
    viewportHeight: number
  },
): PreviewModel {
  const { useState, useRef, useMemo, useCallback } = React
  const { readerActive, readerActiveRef, selectionAnchored, selectedRow, bodyWidth, viewportHeight } = options
  const [windowStart, setWindowStart] = useState(0)
  const anchorRef = useRef<number | undefined>(undefined)
  // The last selection-driven anchor target as "sessionId:messageIndex:hits"
  // — unrelated re-renders (toasts, progress ticks, wheel scrolls) repeat the
  // same key and must not yank the window back (the manual-scroll truce).
  const selectionAnchorRef = useRef<string | undefined>(undefined)
  const session = useMemo<ScannedSession | undefined>(() => {
    if (!readerActive) return undefined
    const row = selectedRow
    if (row === undefined) return undefined
    return row.kind === 'session' ? row.session : row.hit.session
  }, [readerActive, selectedRow])
  // The session's own MESSAGE hits: the ◆ markers and the n/N jump table
  // come from them (title hits have no message to anchor or mark). Recent
  // mode has no SessionHit, so a recent card's reader simply has none.
  const hits = useMemo<readonly MessageHit[]>(() => {
    const row = selectedRow
    if (!readerActive || row === undefined) return []
    const source = row.kind === 'message' ? row.hit.hits : (row.hits ?? [])
    return source.filter(entry => entry.kind === 'message')
  }, [readerActive, selectedRow])
  const hitIndices = useMemo(() => {
    const indices = new Set<number>()
    for (const entry of hits) {
      if (entry.sourceIndex !== undefined) indices.add(entry.sourceIndex)
    }
    return indices
  }, [hits])
  // Hit ranges per message index, for the reader's body highlighting: the
  // session's own message hits keyed by their position in the previewed
  // messages array (a 'message' row contributes its whole session's hits,
  // a card its `hits` field, recent mode nothing). searchSessions emits at
  // most one hit per message, so a plain set is lossless; title hits have
  // no sourceIndex and are skipped.
  const rangesByMessage = useMemo(() => {
    const map = new Map<number, readonly (readonly [number, number])[]>()
    for (const entry of hits) {
      if (entry.sourceIndex !== undefined) map.set(entry.sourceIndex, entry.ranges)
    }
    return map
  }, [hits])
  const lines = useMemo<PreviewLine[]>(
    () =>
      session === undefined
        ? []
        : buildPreviewLines(session.messages, hitIndices, bodyWidth, rangesByMessage),
    [session, hitIndices, bodyWidth, rangesByMessage],
  )
  // The n/N jump table, indexed by message index: the header line of that
  // message when it is a hit, the -1 sentinel when it is not (see
  // jumpHitLine, which reads it against the visible window).
  const hitStarts = useMemo(() => {
    const table = new Array<number>(session?.messages.length ?? 0).fill(-1)
    for (let at = 0; at < lines.length; at++) {
      const line = lines[at]
      if (line !== undefined && line.kind === 'header' && line.isHit) table[line.messageIndex] = at
    }
    return table
  }, [session, lines])
  // Preview wheel: one notch scrolls the window by the event's row count
  // (the host's ±3 convention), so the pane scrolls at the TUI's own speed
  // instead of a line per notch, clamped at both ends.
  const stepByWheel = useCallback(
    (event: WheelEventLike) => {
      if (!readerActiveRef.current) return
      const by = wheelRows(event.deltaY, event.deltaX)
      if (by === 0) return
      setWindowStart(current => {
        const { start } = scrollWindow(lines.length, current + by, viewportHeight)
        return start
      })
    },
    [lines.length, viewportHeight, readerActiveRef],
  )
  // Render after an anchor change: open the window on the anchor message's
  // landing line (hit-aware — see hitLanding), then clamp it into range —
  // the render-phase adjust pattern, legal HERE because the state belongs to
  // the component whose render is running (the scene calling this hook). The
  // panes must not do it themselves: a child calling the parent's setters
  // during its own render trips React's cross-component update warning and
  // has no guarantee under concurrent rendering. The adjusted values are
  // returned directly, so the committed frame is the anchored one.
  let adjustedWindow = windowStart
  let adjustedWindowEnd = 0
  if (readerActive) {
    let anchored: number | undefined
    if (selectionAnchored) {
      const row = selectedRow
      if (row !== undefined) {
        const target = anchorMessageOf(row)
        // The dedup key carries the hit SHAPE on top of the target message:
        // extending a query can move the match inside the very message the
        // reader shows, and that must re-land the window on the new hit —
        // typing a keyword without touching the selection is the everyday
        // case. Same query, same shape: the manual-scroll truce holds.
        const key = `${session?.id ?? ''}:${target}:${hitSignature(hits)}`
        if (selectionAnchorRef.current !== key) {
          selectionAnchorRef.current = key
          anchored = target
        }
      }
    } else {
      anchored = anchorRef.current
      if (anchored !== undefined) anchorRef.current = undefined
    }
    if (anchored !== undefined) {
      // The landing is hit-aware: a hit that cannot sit in the viewport
      // below its message's own header opens the window on the keyword
      // instead (hitLanding), so the reader never shows a long message with
      // the matched keyword below the fold. Header landings are unchanged.
      adjustedWindow = hitLanding(lines, anchored, viewportHeight)
      setWindowStart(adjustedWindow)
    }
    const view = scrollWindow(lines.length, adjustedWindow, viewportHeight)
    if (view.start !== adjustedWindow) setWindowStart(view.start)
    adjustedWindow = view.start
    adjustedWindowEnd = view.end
  }
  return {
    windowStart: adjustedWindow,
    windowEnd: adjustedWindowEnd,
    setWindowStart,
    anchorRef,
    session,
    hitStarts,
    lines,
    bodyWidth,
    stepByWheel,
  }
}

/** The reader's visible rows — the ONE renderer both panes draw with, so
 *  the full-screen preview and the split column never drift apart. Header
 *  rows carry the ROLE_MARK glyph with its generation-resolved colour and a
 *  warning `◆` marking the session's hits; body rows split indent from
 *  content so hit spans can be painted per-segment. Nothing here is
 *  selectable — the reader shows no marker, no selection bar and no accent
 *  tint of its own in either layout, which also leaves the split screen's
 *  list as the only surface that can ever read as focused. */
function ReaderRows(props: {
  React: TuiSceneProps['React']
  ui: Ui
  lines: readonly PreviewLine[]
  /** The visible slice [start, end) — clamped by usePreviewModel. */
  start: number
  end: number
  /** Truncation budget for header rows in display columns. */
  headerWidth: number
  /** Body wrap width the lines were built with (HighlightedText re-cuts). */
  bodyWidth: number
}): React.ReactElement {
  const { React: R, ui, lines, start, end, headerWidth, bodyWidth } = props
  const { Box, Text } = ui
  const visible = lines.slice(start, end)
  return (
    <>
      {visible.map((line, offset) => {
        const lineAt = start + offset
        if (line.kind === 'header') {
          const mark = ROLE_MARK[line.role]
          const label =
            line.role === 'user' ? t('role-user') : line.role === 'tool' ? t('role-tool') : t('role-assistant')
          const roleText = `${mark.glyph} ${label}${line.seq === undefined ? '' : ` #${line.seq}`}`
          const timeText = line.at === undefined ? '' : ` · ${formatWhen(line.at)}`
          const clipped = truncateWidth(`${roleText}${timeText}${line.isHit ? ' ◆' : ''}`, Math.max(0, headerWidth))
          const hasVisibleHit = line.isHit && clipped.endsWith(' ◆')
          const clippedBody = hasVisibleHit ? clipped.slice(0, -2) : clipped
          const clippedRole = clippedBody.slice(0, Math.min(roleText.length, clippedBody.length))
          const clippedTime = clippedBody.slice(clippedRole.length)
          return (
            <Box key={`h${lineAt}`} flexDirection="row" flexShrink={0}>
              <Text color="subtle">{'  '}</Text>
              <Text color={roleMarkColor(ui, line.role)}>{clippedRole}</Text>
              {clippedTime.length > 0 ? <Text dimColor>{clippedTime}</Text> : null}
              {hasVisibleHit ? <Text color="warning" bold> ◆</Text> : null}
            </Box>
          )
        }
        return (
          // Body rows split indent from content so the hit spans can be
          // painted per-segment: 'warning' bold highlights (the list's
          // own accent) over plain spans that keep the reader's hierarchy
          // — assistant bodies dim, user/tool bodies plain text.
          <Box key={`b${lineAt}`} flexDirection="row" flexShrink={0}>
            <Text dimColor={line.role === 'assistant'}>{line.bodyIndex === 0 ? '  ' : '    '}</Text>
            <HighlightedText
              React={R}
              ui={ui}
              text={line.text}
              ranges={line.ranges}
              color="warning"
              width={bodyWidth}
              plainDim={line.role === 'assistant'}
            />
          </Box>
        )
      })}
    </>
  )
}

/** The classic full-screen reader (widths budgeted against the terminal).
 *  Status + hint ride its own chrome; the split layout's pane carries no
 *  status/hint of its own — the scene's footer keeps those. */
export function PreviewPane(props: {
  React: TuiSceneProps['React']
  ui: Ui
  session: ScannedSession
  lines: readonly PreviewLine[]
  bodyWidth: number
  /** The visible slice, already anchor-adjusted and clamped by
   *  usePreviewModel — the pane is pure display and never writes scene
   *  state. */
  windowStart: number
  windowEnd: number
  status: StatusNote | undefined
  columns: number
  rows: number
  onWheel: (event: WheelEventLike) => void
  /** Right-click inside the reader; attached by the scene only on 0.10+ kits. */
  onPreviewContextMenu?: (event: ContextMenuEventLike) => void
}): React.ReactElement {
  const {
    React: R,
    ui,
    session,
    lines,
    bodyWidth,
    windowStart,
    windowEnd,
    status,
    columns,
    rows,
    onWheel,
    onPreviewContextMenu,
  } = props
  const { Box, Text } = ui
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps & ContextBoxProps>
  return (
    // Root pinned to the full viewport (the list root's own rule): fixed
    // chrome — title, meta, status, hint — surrounds a flexGrow scroll
    // region, so the hint row stays on the bottom edge however far the
    // reader scrolls.
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {` ${truncateWidth(t('preview-title', { title: displayTitle(session) }), Math.max(0, columns - 2))}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>
          {` ${truncateWidth(
            `${session.header.cwd ?? ''} · ${formatWhen(session.modifiedAt)} · ${t('msgs-count', { n: session.messages.length })}`,
            Math.max(0, columns - 2),
          )}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        {/* The session log's absolute path, tail-kept so the file name —
            the path's end — survives any terminal width. */}
        <Text dimColor>{` ${tailWidth(session.path, Math.max(0, columns - 4))}`}</Text>
      </Box>
      <WheelBox
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        onWheel={onWheel}
        {...(onPreviewContextMenu !== undefined ? { onContextMenu: onPreviewContextMenu } : {})}
      >
        <ReaderRows
          React={R}
          ui={ui}
          lines={lines}
          start={windowStart}
          end={windowEnd}
          headerWidth={columns - 2}
          bodyWidth={bodyWidth}
        />
      </WheelBox>
      <Box flexShrink={0}>
        <Text color={status?.tone === 'error' ? 'error' : 'success'}>
          {status === undefined
            ? ' '
            : ` ${status.tone === 'error' ? '✕' : '✔'} ${truncateWidth(status.text, Math.max(0, columns - 6))}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor italic>
          {' '}
          <HintLine React={R} ui={ui} text={t('hint-preview')} />
        </Text>
      </Box>
    </Box>
  )
}

/** The split layout's right column: the same reader rows inside the host
 *  browser's preview frame (round border, permission colour, one cell of
 *  horizontal padding) with its own title/meta head. Wheel and context-menu
 *  handlers ride the scroll region, so the pointer mapping is identical to
 *  the full-screen pane's (localRow 0 = first visible line).
 *
 *  The reader shows no selection vocabulary of its own (see ReaderRows), so
 *  the frame is this pane's ONLY focus cue: dim while the list owns the
 *  keyboard, undimmed while the reader does. That keeps a split screen
 *  showing exactly one lit surface — the lit list when it has the keyboard,
 *  the lit frame when the reader does — without a second selection bar. */
export function ReaderPane(props: {
  React: TuiSceneProps['React']
  ui: Ui
  session: ScannedSession
  lines: readonly PreviewLine[]
  /** The visible slice, already anchor-adjusted and clamped by
   *  usePreviewModel (see the full-screen pane's note). */
  windowStart: number
  windowEnd: number
  paneWidth: number
  bodyWidth: number
  /** Whether the reader holds the keyboard (see the block comment). */
  focused: boolean
  onWheel: (event: WheelEventLike) => void
  onContextMenu?: (event: ContextMenuEventLike) => void
}): React.ReactElement {
  const { React: R, ui, session, lines, windowStart, windowEnd, paneWidth, bodyWidth, focused, onWheel, onContextMenu } =
    props
  const { Box, Text } = ui
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps & ContextBoxProps>
  // Interior width = paneWidth - 4 (two border cells + one padding cell per
  // side); the head rows keep one trailing slack on top of that.
  const headWidth = Math.max(0, paneWidth - 5)
  return (
    <Box
      flexDirection="column"
      width={paneWidth}
      flexShrink={0}
      overflow="hidden"
      borderStyle="round"
      borderColor="permission"
      borderDimColor={!focused}
      paddingX={1}
    >
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {` ${truncateWidth(t('preview-title', { title: displayTitle(session) }), headWidth)}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>
          {` ${truncateWidth(
            `${session.header.cwd ?? ''} · ${formatWhen(session.modifiedAt)} · ${t('msgs-count', { n: session.messages.length })}`,
            headWidth,
          )}`}
        </Text>
      </Box>
      <WheelBox
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        onWheel={onWheel}
        {...(onContextMenu !== undefined ? { onContextMenu } : {})}
      >
        <ReaderRows
          React={R}
          ui={ui}
          lines={lines}
          start={windowStart}
          end={windowEnd}
          headerWidth={Math.max(0, paneWidth - 6)}
          bodyWidth={bodyWidth}
        />
      </WheelBox>
    </Box>
  )
}
