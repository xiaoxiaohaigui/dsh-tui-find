/**
 * The Alt+H help overlay: a full-screen sheet listing every key the find
 * scene answers, grouped list / preview / mouse — the same partition the
 * README's keyboard tables use.
 *
 * Integration contract (the scene owns the keyboard): this module is PURE
 * RENDER. It never calls `useInput`, keeps no state, and owns no key
 * handling — the scene opens the overlay from its own Alt+H branch (the
 * `hint-seg-help` hint segment advertises it) and keeps handling Esc itself:
 * while the sheet is up, Esc (or a second Alt+H) simply leaves it. The
 * content is assembled by the pure `helpSections()` so tests can pin the
 * key list without rendering; the component only paints it.
 *
 * Layout discipline is the scene's: a root Box pinned to
 * `width={columns} height={rows}`, fixed chrome (title + dim-italic footer)
 * around a flex body, and every cell budgeted in DISPLAY columns via
 * src/width.ts so CJK action copy can never push a row past the viewport.
 * When the terminal is too short for the whole sheet the inter-section blank
 * separators are dropped first and the tail is clipped — deterministic, and
 * the chrome (title/footer) always stays on screen.
 *
 * All React usage goes through the HOST-injected `React` and `ui` kit —
 * the plugin never imports its own React copy (the scene's discipline).
 * The `react` import below is TYPE-ONLY (namespaces for JSX typings); no
 * runtime value crosses the host boundary.
 *
 * @module dsh-tui-find/help
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import { displayWidth, truncateWidth } from './width.js'

/** One help line: a language-free key combo plus its localized action. */
export interface HelpRow {
  /** The key combination exactly as the hint lines spell it (`Alt+P`). */
  readonly keys: string
  /** The localized action copy, already cut to the row's column budget. */
  readonly action: string
}

/** A titled group of help rows (list / preview / mouse). */
export interface HelpSection {
  readonly title: string
  readonly rows: readonly HelpRow[]
}

/** Leading space + right margin kept on every row (the scene's ' ' prefix). */
const CONTENT_MARGIN = 2
/** Blank columns between the keys cell and the action cell. */
const KEY_GUTTER = 2
/** Fixed chrome of the sheet: the page title row + the footer hint row. */
const HELP_CHROME_LINES = 2

/** Display columns the keys cell needs: the widest combo on the sheet, so
 *  every action starts on one shared column (the caller pads to this). */
export function keysColumnWidth(sections: readonly HelpSection[]): number {
  let width = 0
  for (const section of sections) {
    for (const row of section.rows) width = Math.max(width, displayWidth(row.keys))
  }
  return width
}

/**
 * The help sheet's content, sized for `columns`: the full key inventory of
 * the scene (verified against its useInput handler) in three sections, with
 * every action truncated to the row budget the overlay actually renders
 * (content width minus the keys cell and gutter), so a narrow terminal cuts
 * copy instead of overflowing the line.
 *
 * The keys column is intentionally language-free — only `action` localizes.
 */
export function helpSections(columns: number): readonly HelpSection[] {
  const sections: readonly HelpSection[] = [
    {
      title: t('help-section-list'),
      rows: [
        { keys: '<char>', action: t('help-list-type') },
        { keys: 'Tab', action: t('help-list-scope') },
        { keys: 'Alt+R', action: t('help-list-regex') },
        { keys: 'Alt+T', action: t('help-list-time') },
        { keys: 'Alt+N', action: t('help-list-title-only') },
        { keys: 'Alt+P', action: t('help-list-preview') },
        { keys: 'Alt+C', action: t('help-list-copy') },
        { keys: 'Alt+E', action: t('help-list-expand') },
        { keys: 'Enter', action: t('help-list-resume') },
        { keys: '↑↓', action: t('help-list-select') },
        { keys: 'PgUp/PgDn', action: t('help-list-page') },
        { keys: 'Esc', action: t('help-list-esc') },
        { keys: 'Alt+H', action: t('help-list-help') },
        { keys: 'Alt+F', action: t('help-list-global') },
      ],
    },
    {
      title: t('help-section-preview'),
      rows: [
        { keys: '↑↓', action: t('help-preview-scroll') },
        { keys: 'PgUp/PgDn', action: t('help-preview-page') },
        { keys: 'n/N', action: t('help-preview-hits') },
        { keys: 'Enter', action: t('help-preview-resume') },
        { keys: 'Alt+C', action: t('help-preview-copy') },
        { keys: 'Esc', action: t('help-preview-esc') },
      ],
    },
    {
      title: t('help-section-mouse'),
      rows: [
        { keys: 'Click', action: t('help-mouse-click') },
        { keys: 'Hover', action: t('help-mouse-hover') },
        { keys: 'Wheel', action: t('help-mouse-wheel') },
      ],
    },
  ]
  const contentWidth = Math.max(1, columns - CONTENT_MARGIN)
  const actionBudget = Math.max(1, contentWidth - keysColumnWidth(sections) - KEY_GUTTER)
  return sections.map(section => ({
    title: section.title,
    rows: section.rows.map(row => ({ keys: row.keys, action: truncateWidth(row.action, actionBudget) })),
  }))
}

/**
 * The scene's HintLine discipline, recreated locally: `**key**` spans render
 * bold inside a dim-italic line. (scene.tsx keeps its own private copy and
 * this module must not import scene internals, so the tiny splitter lives
 * here too.)
 */
function BoldSpans(props: { ui: TuiSceneProps['ui']; text: string }): React.ReactElement {
  const { ui, text } = props
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
 * The full-screen help sheet. PURE RENDER — no hooks, no useInput: the
 * scene owns the keyboard and is responsible for opening this on Alt+H and
 * closing it on Esc/Alt+H (see the module contract above).
 *
 * `React` is part of the injected props contract for rendering uniformity
 * with the other scene components, but this sheet is hook-free, so it stays
 * undestructured.
 */
export function HelpOverlay(props: {
  React: TuiSceneProps['React']
  ui: TuiSceneProps['ui']
  columns: number
  rows: number
}): React.ReactElement {
  const { ui, columns, rows } = props
  const { Box, Text } = ui
  const sections = helpSections(columns)
  const keyWidth = keysColumnWidth(sections)

  // The body as one flat line list; blank separators between sections carry
  // weight 0 so a short terminal sacrifices them before any content.
  type BodyLine = { weight: 0 | 1; node: React.ReactElement }
  const body: BodyLine[] = []
  let line = 0
  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) {
      body.push({ weight: 0, node: <Text key={`b${line++}`}> </Text> })
    }
    body.push({
      weight: 1,
      node: (
        <Box key={`s${line++}`} flexShrink={0}>
          <Text bold color="subtle">
            {` ${section.title}`}
          </Text>
        </Box>
      ),
    })
    for (const row of section.rows) {
      body.push({
        weight: 1,
        node: (
          <Box key={`r${line++}`} flexDirection="row" flexShrink={0}>
            <Text> </Text>
            <Box width={keyWidth} flexShrink={0}>
              <Text bold>{row.keys}</Text>
            </Box>
            <Text dimColor>{`  ${row.action}`}</Text>
          </Box>
        ),
      })
    }
  })
  const maxBody = Math.max(1, rows - HELP_CHROME_LINES)
  let visible = body
  if (body.length > maxBody) {
    visible = body.filter(entry => entry.weight > 0).slice(0, maxBody)
  }

  return (
    // Root pinned to the full viewport (the scene roots' own rule): fixed
    // chrome — page title and dim-italic Esc hint — surrounds a flex body,
    // so the footer stays on the bottom row however the body clips.
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {` ${t('help-title')}`}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {visible.map(entry => entry.node)}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor italic>
          {' '}
          <BoldSpans ui={ui} text={t('help-footer')} />
        </Text>
      </Box>
    </Box>
  )
}
