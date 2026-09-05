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
  ROLE_MARK,
  selectionMarker,
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

export function ListView(props: {
  React: TuiSceneProps['React']
  ui: Ui
  rows: readonly FlatRow[]
  selected: number
  height: number
  titleWidth: number
  hitWidth: number
  columns: number
  onRowClick: (rowIndex: number) => void
  onRowHover: (rowIndex: number) => void
  onWheel: (event: WheelEventLike) => void
}): React.ReactElement {
  const { React: R, ui, rows, selected, height, titleWidth, hitWidth, columns, onRowClick, onRowHover, onWheel } = props
  const { Box, Text } = ui
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps>
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
            <Box
              key={`s${rowIndex}`}
              flexDirection="column"
              flexShrink={0}
              {...(isSelected ? { backgroundColor: 'selectionBg' } : {})}
              onClick={() => onRowClick(rowIndex)}
              onMouseEnter={() => onRowHover(rowIndex)}
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
                    Math.max(1, columns - 4),
                  )}
                </Text>
              </Box>
            </Box>
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
          hit.role === undefined ? undefined : ROLE_MARK[hit.role].color
        const marker = selectionMarker(isSelected, 'message')
        // The `(+N)` tail is reserved from the text budget even while the
        // row is selected: a budget that depends on the selection would
        // reflow the row's whole content on every focus move.
        const more = row.more > 0 ? t('more-hits', { count: row.more }) : undefined
        const moreReserve = more === undefined ? 0 : displayWidth(more) + 1
        const prefix = `#${hit.seq ?? '·'} ${roleLabel}: `
        const budget = Math.max(1, hitWidth - displayWidth(marker) - displayWidth(prefix) - moreReserve)
        // One line, guaranteed: newlines flatten, and the visible slice is
        // cut around the first highlight so the keyword cannot be truncated
        // out of view on a long message.
        const line = hitLine(hit.text, hit.ranges, budget)
        return (
          <Box
            key={`m${rowIndex}`}
            flexDirection="row"
            flexShrink={0}
            {...(isSelected ? { backgroundColor: 'selectionBg' } : {})}
            onClick={() => onRowClick(rowIndex)}
            onMouseEnter={() => onRowHover(rowIndex)}
          >
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
            {more !== undefined ? <Text dimColor={!isSelected}>{` ${more}`}</Text> : null}
          </Box>
        )
      })}
    </WheelBox>
  )
}
