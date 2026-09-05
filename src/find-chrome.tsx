/**
 * Leaf chrome of the find scene: the bold-`**key**` hint line, the list
 * hint composer, the bordered search card with its caret/IME discipline,
 * the range highlighter shared by list and preview, and the resume confirm
 * pane. Purely presentational — every piece receives the host React and ui
 * kit through props (the scenes.ts discipline: the plugin never imports its
 * own React copy).
 *
 * @module dsh-tui-find/find-chrome
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import type { ScannedSession } from './core/scan.js'
import type { SearchScope } from './core/search.js'
import { displayWidth, tailWidth, truncateWidth } from './width.js'
import { useHostDeclaredCursor } from './vendor/host-cursor.js'
import { displayTitle, type TextColor, type Ui } from './find-types.js'

/**
 * A dim-italic hint line whose `**key**` spans render bold — the HintLine
 * discipline from the host's design system, recreated on the scene-side kit.
 */
export function HintLine(props: { React: TuiSceneProps['React']; ui: Ui; text: string }): React.ReactElement {
  const { React: R, ui, text } = props
  const { Text } = ui
  const parts = text.split('**')
  if (parts.length < 3) return <Text>{text}</Text>
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <Text key={index} bold>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </>
  )
}

/**
 * The list hint line: key segments joined by ` · `, fitted to the viewport.
 * A static wide/narrow pair cannot track the actual rendered width (CJK
 * labels, per-language lengths), so the line is composed here: the first and
 * last segments always render, middle segments drop in reverse priority
 * order when the full line would exceed the columns budget.
 */
export function composeListHint(columns: number): string {
  const segments = [
    t('hint-seg-resume'),
    t('hint-seg-scope'),
    t('hint-seg-preview'),
    t('hint-seg-copy'),
    t('hint-seg-expand'),
    t('hint-seg-regex'),
    t('hint-seg-time'),
    t('hint-seg-title'),
    t('hint-seg-help'),
    t('hint-seg-navigate'),
  ]
  const last = t('hint-seg-esc')
  const separator = ' · '
  const budget = Math.max(1, columns - 2)
  let line = segments[0]!
  for (let index = 1; index < segments.length; index++) {
    const candidate = `${line}${separator}${segments[index]!}`
    if (displayWidth(candidate) + separator.length + displayWidth(last) > budget) break
    line = candidate
  }
  return truncateWidth(`${line}${separator}${last}`, budget)
}

/**
 * The bordered search card: `⌕ ` prefix, inverse block caret at the query's
 * end (the caret is append-only — the scene never moves it), and a
 * right-aligned dimmed placeholder carrying the scope while empty, so the
 * terminal-painted IME preedit can never collide with it (the host
 * SearchBox's own empty-state shape).
 *
 * When the host's cursor hook is reachable, the native terminal cursor is
 * declared at the caret every frame — that is what pins the IME preedit
 * INLINE at the input instead of the screen's bottom row.
 */
export function SearchCard(props: {
  React: TuiSceneProps['React']
  ui: Ui
  query: string
  scope: SearchScope
  /** Active non-default filters, precomposed ('近 7 天 · 正则'); '' when none. */
  filters: string
  columns: number
}): React.ReactElement {
  const { React: R, ui, query, scope, filters, columns } = props
  const { Box, Text } = ui
  const placeholder = t('search-placeholder', {
    scope: scope === 'repo' ? t('scope-repo') : t('scope-all'),
  })
  const contentWidth = Math.max(1, columns - 4)
  const empty = query.length === 0
  const filterWidth =
    filters === '' ? 0 : Math.min(displayWidth(filters), Math.max(1, Math.floor(contentWidth / 2)))
  const queryWidth = Math.max(1, contentWidth - filterWidth - (filters === '' ? 0 : 1))
  const tail = empty ? '' : tailWidth(query, Math.max(0, queryWidth - 3))
  // Caret column relative to the bordered box: border (1) + paddingX (1) +
  // `⌕ ` (2) + the visible query tail before the caret.
  const caretColumn = 4 + (empty ? 0 : displayWidth(tail))
  const declareCursor =
    useHostDeclaredCursor !== undefined
      ? useHostDeclaredCursor({ line: 1, column: caretColumn, active: true })
      : undefined
  return (
    <Box
      flexShrink={0}
      borderStyle="round"
      borderColor="suggestion"
      paddingX={1}
      width={columns}
      {...(declareCursor !== undefined ? { ref: declareCursor } : {})}
    >
      {empty ? (
        <Box flexDirection="row" width="100%">
          <Text>⌕ </Text>
          <Text inverse>{' '}</Text>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {filters === '' ? placeholder : `${placeholder} · ${filters}`}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="row" width="100%">
          <Box flexDirection="row" width={queryWidth}>
            <Text wrap="truncate-end">
            {'⌕ '}
            {tail}
            <Text inverse>{' '}</Text>
            </Text>
          </Box>
          {filters === '' ? null : (
            <>
              <Box flexGrow={1} />
              <Box width={filterWidth}>
                <Text dimColor wrap="truncate">
                  {filters}
                </Text>
              </Box>
            </>
          )}
        </Box>
      )}
    </Box>
  )
}

/** Highlight `ranges` inside `text` with the theme accent. Plain spans keep
 *  the row's selection treatment (suggestion + bold) so a card whose title
 *  carries the highlight reads as selected exactly like every other card;
 *  `plainDim` dims them instead, so the preview reader's assistant bodies
 *  keep their dim treatment under per-span coloring. */
export function HighlightedText(props: {
  React: TuiSceneProps['React']
  ui: Ui
  text: string
  ranges: readonly (readonly [number, number])[]
  color: TextColor
  width: number
  selected?: boolean
  plainDim?: boolean
}): React.ReactElement {
  const { React: R, ui, text, ranges, color, width, selected, plainDim } = props
  const { Text } = ui
  const plainColor: TextColor = selected === true ? 'suggestion' : 'text'
  const parts: React.ReactElement[] = []
  let cursor = 0
  const clipped = truncateWidth(text, width)
  ranges.forEach(([start, end], index) => {
    if (start >= clipped.length) return
    const safeEnd = Math.min(end, clipped.length)
    if (start > cursor)
      parts.push(
        <Text key={`p${index}`} color={plainColor} bold={selected === true} dimColor={plainDim === true}>
          {clipped.slice(cursor, start)}
        </Text>,
      )
    parts.push(
      <Text key={`h${index}`} color={color} bold>
        {clipped.slice(start, safeEnd)}
      </Text>,
    )
    cursor = safeEnd
  })
  if (cursor < clipped.length)
    parts.push(
      <Text key="tail" color={plainColor} bold={selected === true} dimColor={plainDim === true}>
        {clipped.slice(cursor)}
      </Text>,
    )
  return <>{parts}</>
}

/**
 * The resume confirm pane: who is about to take over the terminal, and the
 * working-session warning. Enter confirms, Esc cancels — the keyboard stays
 * with useFindInput's confirm branch.
 */
export function ConfirmPane(props: {
  React: TuiSceneProps['React']
  ui: Ui
  session: ScannedSession
  working: boolean
  columns: number
}): React.ReactElement {
  const { React, ui, session, working, columns } = props
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" paddingX={1} width={columns}>
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {' '}
          {t('scene-title')}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color="warning" bold>
          {' '}
          {t('confirm-title')}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color="text">
          {' '}
          {t('confirm-target', { title: truncateWidth(displayTitle(session), Math.max(0, columns - 12)) })}
        </Text>
      </Box>
      {working ? (
        <Box flexShrink={0}>
          <Text color="error" bold>
            {' '}
            {t('confirm-warning-working')}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text dimColor>
          {' '}
          {t('confirm-warning-context')}
        </Text>
      </Box>
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor italic>
          {' '}
          <HintLine React={React} ui={ui} text={t('hint-confirm')} />
        </Text>
      </Box>
    </Box>
  )
}
