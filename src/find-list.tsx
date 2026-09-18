/**
 * The two-line-per-session list: a physical-line scroll window fitted over
 * the flat rows (a card is two lines, a hit row one) and the row renderers —
 * the browser's title/meta card and the one-line hit row with per-span hit
 * highlights. Mouse wiring (click/hover/wheel) rides the same WheelBox.
 *
 * @module dsh-tui-find/find-list
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import { displayWidth, fitScrollWindow, hitLine, truncateWidth } from './width.js'
import { HighlightedText } from './find-chrome.js'
import {
  displayTitle,
  formatWhen,
  roleMarkColor,
  selectionMarker,
  type ClickEventLike,
  type ContextBoxProps,
  type ContextMenuEventLike,
  type FlatRow,
  type TextColor,
  type Ui,
  type WheelBoxProps,
  type WheelEventLike,
} from './find-types.js'

/** Physical terminal lines a flat row spends: a session card is the title +
 * metadata pair, a hit row is exactly one (windowed, non-wrapping) line.
 * The scroll window is fitted in these units — a row-count window lets the
 * selection walk off the bottom of a card-heavy list without the page ever
 * following (the on-device bug). */
function rowLineCount(row: FlatRow): number {
  return row.kind === 'session' ? 2 : 1
}

/**
 * The fold control on a card's final visible hit row: `▸ (+N)` while the
 * card hides hits, `▴ 收起` while it shows them all. A nested click target —
 * the host dispatches to the deepest hit node and honours the bubble-stop,
 * so this click folds the card and never reaches the row's own handler
 * (which would otherwise open the resume confirm: Alt+E had no mouse
 * counterpart, that was the reported gap).
 *
 * The hover tint — the host's own clickable-affordance idiom (ClickableDivider,
 * the todo fold) — is COMPONENT-LOCAL state, and that is the point rather
 * than a detail. A parent-held flag has to name the badge somehow, and the
 * names on offer are the row's index or its id; either can outlive the
 * control it refers to, because the host sends no `onMouseLeave` for a node
 * that a re-render unmounted (its hover dispatch skips detached nodes) and
 * keyboard folding never touches the pointer at all. A row index is worse
 * still: folding rewrites the row array, so the index one card's badge
 * occupied can come to name the NEXT card's badge and paint a tint on a
 * control the pointer is nowhere near (REVIEW R-068). Held here, the flag
 * dies with the badge — a fold, a windowed scroll, a dropped card — while a
 * plain re-render (typing, a sweep flush) keeps both.
 *
 * Local state alone is not enough, and the fold is exactly why: the caller
 * must ALSO key these rows by their stable id. Keyed by row index, React
 * recycles this very component onto the next card's badge instead of
 * unmounting it — same position, same key, so its `hovered` walks across —
 * reproducing the stray tint by a second route (verified: with stable ids
 * removed, the R-068 regression test still fails with this component in
 * place).
 */
function FoldBadge(props: {
  React: TuiSceneProps['React']
  ui: Ui
  /** The badge text, chevron included — measured by the caller for its own
   *  text budget, so the caller composes it once. */
  label: string
  /** The row's selection, which keeps the label un-dimmed (a selected row
   *  would otherwise dim the badge away in the middle of the highlight). */
  selected: boolean
  onFold: () => void
}): React.ReactElement {
  const { React: R, ui, label, selected, onFold } = props
  const { Box, Text } = ui
  const [hovered, setHovered] = R.useState(false)
  return (
    <Box
      flexShrink={0}
      {...(hovered ? { backgroundColor: 'userMessageBackgroundHover' as const } : {})}
      onClick={(event: ClickEventLike) => {
        event.stopImmediatePropagation()
        onFold()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Text
        {...(hovered ? { color: 'suggestion' as const } : {})}
        dimColor={!hovered && !selected}
        bold={hovered}
      >{` ${label}`}</Text>
    </Box>
  )
}

export function ListView(props: {
  React: TuiSceneProps['React']
  ui: Ui
  rows: readonly FlatRow[]
  selected: number
  height: number
  titleWidth: number
  hitWidth: number
  /** The list's own surface width — the terminal width in classic, the left
   *  column's width in the split layout; card metadata truncates to it. */
  width: number
  onRowClick: (rowIndex: number) => void
  onRowHover: (rowIndex: number) => void
  /** Toggle a session's folded hits — the `(+N)` badge's own click, which
   *  never reaches the row's resume path (see the badge below). */
  onRowFold: (rowIndex: number) => void
  onWheel: (event: WheelEventLike) => void
  /** Right-click a row; attached by the scene only on 0.10+ kits (the 0.9
   *  runtime dispatches no context-menu events and the prop stays absent). */
  onRowContextMenu?: (rowIndex: number, event: ContextMenuEventLike) => void
}): React.ReactElement {
  const { React: R, ui, rows, selected, height, titleWidth, hitWidth, width, onRowClick, onRowHover, onRowFold, onWheel, onRowContextMenu } = props
  const { Box, Text } = ui
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps>
  const ContextBox = Box as unknown as React.ComponentType<ContextBoxProps>
  const { useState, useMemo } = R

  // Scroll window over the flat rows, fitted in physical lines so the
  // selected row is always on screen (fitScrollWindow for the contract).
  const [scroll, setScroll] = useState(0)
  const weights = useMemo(() => rows.map(rowLineCount), [rows])
  const view = useMemo(
    () => fitScrollWindow(weights, selected, height, scroll),
    [weights, selected, height, scroll],
  )
  if (view.start !== scroll) setScroll(view.start)
  const visible = rows.slice(view.start, view.end)

  return (
    <WheelBox
      flexDirection="column"
      height={height}
      overflow="hidden"
      onWheel={onWheel}
    >
      {visible.map((row, offset) => {
        const rowIndex = view.start + offset
        const isSelected = selected === rowIndex
        if (row.kind === 'session') {
          const session = row.session
          // Two lines per session, the browser's rule: the title answers "is
          // this the conversation I mean", the metadata line answers "which
          // of the ones that look alike is it". The card's title hit rides
          // INSIDE the title line — highlighted there, never as a separate
          // row repeating the title — and is windowed around the match so a
          // long title cannot cut the keyword off.
          const titleLine =
            row.titleHit === undefined
              ? undefined
              : hitLine(displayTitle(session), row.titleHit.ranges, titleWidth)
          return (
            <ContextBox
              key={row.rowId}
              flexDirection="column"
              flexShrink={0}
              {...(isSelected ? { backgroundColor: 'selectionBg' } : {})}
              onClick={() => onRowClick(rowIndex)}
              onMouseEnter={() => onRowHover(rowIndex)}
              {...(onRowContextMenu !== undefined
                ? { onContextMenu: (event: ContextMenuEventLike) => onRowContextMenu(rowIndex, event) }
                : {})}
            >
              <Box flexShrink={0}>
                <Text color={isSelected ? 'suggestion' : 'subtle'}>{selectionMarker(isSelected)}</Text>
                {titleLine === undefined ? (
                  <Text color={isSelected ? 'suggestion' : 'text'} bold={isSelected}>
                    {truncateWidth(displayTitle(session), titleWidth)}
                  </Text>
                ) : (
                  <HighlightedText
                    React={R}
                    ui={ui}
                    text={titleLine.text}
                    ranges={titleLine.ranges}
                    color="warning"
                    width={titleWidth}
                    selected={isSelected}
                  />
                )}
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>
                  {'  '}
                  {truncateWidth(
                    [
                      formatWhen(session.modifiedAt),
                      t('msgs-count', { n: session.messages.length }),
                      session.header.cwd?.split(/[\\/]/).pop() ?? session.id.slice(0, 8),
                    ].join(' · '),
                    Math.max(1, width - 4),
                  )}
                </Text>
              </Box>
            </ContextBox>
          )
        }
        const hit = row.message
        // Title hits carry no role of their own; they render as the
        // session's title row rather than as a tool/assistant message.
        const roleLabel =
          hit.role === undefined
            ? t('role-title')
            : hit.role === 'user'
              ? t('role-user')
              : hit.role === 'assistant'
                ? t('role-assistant')
                : t('role-tool')
        const roleColor: TextColor | undefined =
          hit.role === undefined ? undefined : roleMarkColor(ui, hit.role)
        const marker = selectionMarker(isSelected, 'message')
        // The fold badge reserves its own cells from the text budget even
        // while the row is selected: a budget that depends on the selection
        // would reflow the row's whole content on every focus move. The
        // triangles are the host's own fold vocabulary (PromptInput's
        // `▸ stats` badge): a bare `(+N)` reads as a passive counter, and the
        // point of this control is that it invites a click. The two states
        // point OPPOSITE ways — `▸` at the fold (more below), `▴` folding it
        // back up — and stay in one glyph family so the badge keeps its width
        // and weight when it flips. A literal `↑` would read as navigation:
        // the hint line right below the list spells `↑↓` for selection.
        const foldLabel =
          row.fold === undefined
            ? undefined
            : row.fold.expanded
              ? `▴ ${t('fold-collapse')}`
              : `▸ ${t('more-hits', { count: row.fold.hidden })}`
        const badgeReserve = foldLabel === undefined ? 0 : displayWidth(foldLabel) + 1
        const prefix = `#${hit.seq ?? '·'} ${roleLabel}: `
        const budget = Math.max(1, hitWidth - displayWidth(marker) - displayWidth(prefix) - badgeReserve)
        // One line, guaranteed: newlines flatten, and the visible slice is
        // cut around the first highlight so the keyword cannot be truncated
        // out of view on a long message.
        const line = hitLine(hit.text, hit.ranges, budget)
        return (
          <ContextBox
            key={row.rowId}
            flexDirection="row"
            flexShrink={0}
            // The row stretches to the list surface on its own (a column
            // parent stretches its children), and the badge rides its RIGHT
            // edge — the same column on every row, so the fold control is a
            // stable mouse target instead of trailing whatever each hit's
            // text happens to measure.
            justifyContent="space-between"
            {...(isSelected ? { backgroundColor: 'selectionBg' } : {})}
            onClick={() => onRowClick(rowIndex)}
            onMouseEnter={() => onRowHover(rowIndex)}
            {...(onRowContextMenu !== undefined
              ? { onContextMenu: (event: ContextMenuEventLike) => onRowContextMenu(rowIndex, event) }
              : {})}
          >
            <Box flexDirection="row" flexShrink={1}>
              <Text color={isSelected ? 'suggestion' : 'subtle'}>{marker}</Text>
              <Text dimColor={!isSelected} {...(isSelected && roleColor !== undefined ? { color: roleColor } : {})}>
                {prefix}
              </Text>
              <HighlightedText
                React={R}
                ui={ui}
                text={line.text}
                ranges={line.ranges}
                color="warning"
                width={budget}
              />
            </Box>
            {foldLabel !== undefined ? (
              <FoldBadge
                React={R}
                ui={ui}
                label={foldLabel}
                selected={isSelected}
                onFold={() => onRowFold(rowIndex)}
              />
            ) : null}
          </ContextBox>
        )
      })}
    </WheelBox>
  )
}
