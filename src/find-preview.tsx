/**
 * The preview reader: a scrollable full-conversation view over one session.
 * `usePreviewModel` owns the cursor/window/anchor state and derives the
 * line list, weights and hit tables; it also consumes the pending anchor
 * and follows the scroll window during the SCENE's own render — the
 * render-phase adjust pattern (a component adjusting its own state while
 * rendering is legal, so the anchored frame is the committed one and
 * nothing flickers). `PreviewPane` is pure display over the already
 * adjusted cursor/window.
 *
 * @module dsh-tui-find/find-preview
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import type { ScannedSession } from './core/scan.js'
import type { MessageHit } from './core/search.js'
import { fitScrollWindow, tailWidth, truncateWidth } from './width.js'
import {
  buildPreviewLines,
  messageAtLine,
  messageHeaderLine,
  unitWeights,
  type PreviewLine,
} from './preview.js'
import { HighlightedText, HintLine } from './find-chrome.js'
import {
  displayTitle,
  formatWhen,
  PREVIEW_CHROME_LINES,
  ROLE_MARK,
  roleMarkColor,
  selectionMarker,
  wheelStep,
  type ContextBoxProps,
  type ContextMenuEventLike,
  type FlatRow,
  type Mode,
  type StatusNote,
  type Ui,
  type WheelBoxProps,
  type WheelEventLike,
} from './find-types.js'

/** The preview reader's state and derived tables, shared by the pane and
 *  the input dispatcher. The cursor is a LINE index into the preview's flat
 *  line list; the window start follows it through fitScrollWindow over
 *  1-weight lines. Both are discarded on exit: every Alt+P re-anchors (the
 *  hit message's header line, or the head for cards and title hits),
 *  delivered through anchorRef and consumed by the model during the
 *  scene's render. The ref/setter types stay structural so the scene's own
 *  useState/useRef values flow in regardless of the host React typings'
 *  version. */
export interface PreviewModel {
  cursor: number
  setCursor: (next: number | ((current: number) => number)) => void
  windowStart: number
  setWindowStart: (next: number | ((current: number) => number)) => void
  anchorRef: { current: number | undefined }
  session: ScannedSession | undefined
  hitStarts: number[]
  lines: PreviewLine[]
  weights: number[]
  bodyWidth: number
  stepByWheel: (event: WheelEventLike) => void
}

export function usePreviewModel(
  React: TuiSceneProps['React'],
  options: {
    mode: Mode
    /** The scene's mode mirror — the wheel callback must not scroll after
     *  the mode changed but before the re-render commits. */
    modeRef: { current: Mode }
    selectedRow: FlatRow | undefined
    columns: number
    /** Terminal height, for the scroll window's viewport budget. */
    rows: number
  },
): PreviewModel {
  const { useState, useRef, useMemo, useCallback } = React
  const { mode, modeRef, selectedRow, columns, rows } = options
  const [cursor, setCursor] = useState(0)
  const [windowStart, setWindowStart] = useState(0)
  const anchorRef = useRef<number | undefined>(undefined)
  const session = useMemo<ScannedSession | undefined>(() => {
    if (mode !== 'preview') return undefined
    const row = selectedRow
    if (row === undefined) return undefined
    return row.kind === 'session' ? row.session : row.hit.session
  }, [mode, selectedRow])
  // The session's own MESSAGE hits: the ◆ markers and the n/N jump table
  // come from them (title hits have no message to anchor or mark). Recent
  // mode has no SessionHit, so a recent card's reader simply has none.
  const hits = useMemo<readonly MessageHit[]>(() => {
    const row = selectedRow
    if (mode !== 'preview' || row === undefined) return []
    const source = row.kind === 'message' ? row.hit.hits : (row.hits ?? [])
    return source.filter(entry => entry.kind === 'message')
  }, [mode, selectedRow])
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
  // Body budget: marker (2) + the deepest continuation indent (4) inside the
  // terminal width, one column of slack — no line can soft-wrap past it.
  const bodyWidth = Math.max(1, columns - 5)
  const lines = useMemo<PreviewLine[]>(
    () =>
      session === undefined
        ? []
        : buildPreviewLines(session.messages, hitIndices, bodyWidth, rangesByMessage),
    [session, hitIndices, bodyWidth, rangesByMessage],
  )
  const weights = useMemo(() => unitWeights(lines.length), [lines])
  // jumpHit's table, indexed by message index: the header line of that
  // message when it is a hit, the -1 sentinel when it is not.
  const hitStarts = useMemo(() => {
    const table = new Array<number>(session?.messages.length ?? 0).fill(-1)
    for (let at = 0; at < lines.length; at++) {
      const line = lines[at]
      if (line !== undefined && line.kind === 'header' && line.isHit) table[line.messageIndex] = at
    }
    return table
  }, [session, lines])
  // Preview wheel: one line per notch — the cursor is the scroll driver,
  // the window follows it through fitScrollWindow.
  const stepByWheel = useCallback(
    (event: WheelEventLike) => {
      if (modeRef.current !== 'preview') return
      const by = wheelStep(event.deltaY, event.deltaX)
      if (by === 0) return
      setCursor(current => {
        const last = Math.max(0, lines.length - 1)
        return Math.min(last, Math.max(0, current + by))
      })
    },
    [lines.length, modeRef],
  )
  // First render after Alt+P: park the cursor (and the window) on the
  // anchor message's header line, then keep the window glued to the cursor
  // — the render-phase adjust pattern, legal HERE because the state belongs
  // to the component whose render is running (the scene calling this hook).
  // PreviewPane must not do it itself: a child calling the parent's setters
  // during its own render trips React's cross-component update warning and
  // has no guarantee under concurrent rendering. The adjusted values are
  // returned directly, so the committed frame is the anchored one.
  let adjustedCursor = cursor
  let adjustedWindow = windowStart
  if (mode === 'preview') {
    const anchored = anchorRef.current
    if (anchored !== undefined) {
      const start = messageHeaderLine(lines, anchored)
      anchorRef.current = undefined
      setCursor(start)
      setWindowStart(start)
      adjustedCursor = start
      adjustedWindow = start
    }
    adjustedCursor = Math.min(Math.max(0, adjustedCursor), Math.max(0, lines.length - 1))
    const view = fitScrollWindow(weights, adjustedCursor, Math.max(1, rows - PREVIEW_CHROME_LINES), adjustedWindow)
    if (view.start !== adjustedWindow) setWindowStart(view.start)
    adjustedWindow = view.start
  }
  return {
    cursor: adjustedCursor,
    setCursor,
    windowStart: adjustedWindow,
    setWindowStart,
    anchorRef,
    session,
    hitStarts,
    lines,
    weights,
    bodyWidth,
    stepByWheel,
  }
}

export function PreviewPane(props: {
  React: TuiSceneProps['React']
  ui: Ui
  session: ScannedSession
  lines: readonly PreviewLine[]
  weights: readonly number[]
  bodyWidth: number
  /** Already anchor-adjusted and window-followed by usePreviewModel — the
   *  pane is pure display and never writes scene state. */
  cursor: number
  windowStart: number
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
    weights,
    bodyWidth,
    cursor,
    windowStart,
    status,
    columns,
    rows,
    onWheel,
    onPreviewContextMenu,
  } = props
  const { Box, Text } = ui
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps & ContextBoxProps>
  const cursorLine = Math.min(Math.max(0, cursor), Math.max(0, lines.length - 1))
  const cursorMessage = messageAtLine(lines, cursorLine) ?? 0
  const view = fitScrollWindow(
    weights,
    cursorLine,
    Math.max(1, rows - PREVIEW_CHROME_LINES),
    windowStart,
  )
  const visible = lines.slice(view.start, view.end)
  return (
    // Root pinned to the full viewport (the list root's own rule): fixed
    // chrome — title, meta, status, hint — surrounds a flexGrow scroll
    // region windowed by fitScrollWindow, so the hint row stays on the
    // bottom edge however far the reader scrolls.
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
        {visible.map((line, offset) => {
          const lineAt = view.start + offset
          if (line.kind === 'header') {
            // The header row carries the list's selection vocabulary —
            // marker arrow plus selectionBg for the cursor's message —
            // the ROLE_MARK glyph with its generation-resolved colour, and
            // a warning `◆` marking the session's hits (a hit tool row
            // would otherwise share the tool role's own warning colour).
            const isCursorMessage = line.messageIndex === cursorMessage
            const mark = ROLE_MARK[line.role]
            const label =
              line.role === 'user' ? t('role-user') : line.role === 'tool' ? t('role-tool') : t('role-assistant')
            const roleText = `${mark.glyph} ${label}${line.seq === undefined ? '' : ` #${line.seq}`}`
            const timeText = line.at === undefined ? '' : ` · ${formatWhen(line.at)}`
            const clipped = truncateWidth(`${roleText}${timeText}${line.isHit ? ' ◆' : ''}`, Math.max(0, columns - 2))
            const hasVisibleHit = line.isHit && clipped.endsWith(' ◆')
            const clippedBody = hasVisibleHit ? clipped.slice(0, -2) : clipped
            const clippedRole = clippedBody.slice(0, Math.min(roleText.length, clippedBody.length))
            const clippedTime = clippedBody.slice(clippedRole.length)
            return (
              <Box
                key={`h${lineAt}`}
                flexDirection="row"
                flexShrink={0}
                {...(isCursorMessage ? { backgroundColor: 'selectionBg' } : {})}
              >
                <Text color={isCursorMessage ? 'suggestion' : 'subtle'}>{selectionMarker(isCursorMessage)}</Text>
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
