/**
 * The full-screen find scene. Card-style like the resume browser: a query
 * line with scope control, one card per matching session (first 3 hits with
 * `(+N)` expansion), a read-only preview pane, and a resume confirm that
 * warns loudly when the live session is mid-turn.
 *
 * Keyboard model (the scene owns the keyboard while open, per the scenes
 * contract): printable characters edit the query, ↑↓ moves between hit
 * entries, PgUp/PgDn pages, Tab toggles the scope, Enter on the list enters
 * resume confirm, `p` opens the read-only preview, `c` copies the selected
 * hit's original text, Esc steps back and closes.
 *
 * All React usage goes through the HOST-injected `React` and `ui` kit —
 * the plugin never imports its own React copy (see scenes.ts discipline).
 * The `react` import below is TYPE-ONLY (namespaces for JSX typings); no
 * runtime value crosses the host boundary.
 *
 * @module dsh-tui-find/scene
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { copyToClipboard } from './clipboard.js'
import type { ResolvedConfig } from './config.js'
import { getLang, t } from './i18n.js'
import { SessionScanner, type ScanProgress, type ScannedSession } from './core/scan.js'
import { searchSessions, type MessageHit, type SearchScope, type SessionHit } from './core/search.js'

/** The host ui kit's component/hook surface, derived from the scene props. */
type Ui = TuiSceneProps['ui']
/** The host's parsed-key flags, derived from the ui kit's own useInput. */
type InputKey = Parameters<Parameters<Ui['useInput']>[0]>[1]
/** The color vocabulary Text accepts (theme keys + raw values). */
type TextColor = NonNullable<React.ComponentProps<Ui['Text']>['color']>

type Mode = 'list' | 'preview' | 'confirm'

/** A row of the flattened list (session headers are not selectable). */
type FlatRow =
  | { kind: 'session'; hit: SessionHit; first: boolean }
  | { kind: 'message'; hit: SessionHit; message: MessageHit; index: number; more: number }

/** Hits shown per session card before `(+N)`. */
const PREVIEW_HITS = 3
/** Context messages on each side of a hit in the preview pane. */
const PREVIEW_CONTEXT = 2

const WEEKDAYS: Record<'zh' | 'en', readonly string[]> = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Compact human timestamp: weekday+time this week, date otherwise. */
export function formatTime(epochMs: number | undefined, lang: 'zh' | 'en'): string {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return ''
  const date = new Date(epochMs)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const sameYear = date.getFullYear() === now.getFullYear()
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (epochMs >= startOfToday) return time
  if (epochMs >= startOfToday - 6 * 86_400_000) {
    return `${WEEKDAYS[lang][date.getDay()]} ${time}`
  }
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return sameYear ? md : `${date.getFullYear()}-${md}`
}

/** Title fallback mirroring the host picker: cwd basename, then id prefix. */
function displayTitle(session: ScannedSession): string {
  if (session.title !== undefined && session.title !== '') return session.title
  const cwd = session.header.cwd ?? ''
  if (cwd !== '') {
    const parts = cwd.split(/[\\/]/)
    const base = parts[parts.length - 1]
    if (base !== undefined && base !== '') return base
  }
  return session.id.slice(0, 8)
}

/**
 * One query line with an inline block cursor (the ui kit's prompt input is
 * the chat composer's; a scene renders its own minimal editor so every
 * keystroke is ours to filter on).
 */
function QueryLine(props: {
  React: TuiSceneProps['React']
  ui: TuiSceneProps['ui']
  query: string
  scope: SearchScope
  progress: ScanProgress | undefined
}): React.ReactElement {
  const { React: R, ui, query, scope, progress } = props
  const { Box, Text } = ui
  const cursor = query.length === 0 ? t('search-placeholder') : query
  return (
    <Box flexDirection="row">
      <Text color="claude">{t('scene-title')} </Text>
      <Text color="text">{cursor}▏</Text>
      <Box flexGrow={1} />
      <Text color="inactive">
        {t('scope-label')}:[{scope === 'repo' ? t('scope-repo') : t('scope-all')}]
      </Text>
      {progress !== undefined ? (
        <Text color="inactive">
          {' '}
          {progress.total === undefined
            ? t('scanning-initial')
            : t('scanning', { resolved: progress.resolved, total: progress.total })}
        </Text>
      ) : null}
    </Box>
  )
}

/** Highlight `ranges` inside `text` with the theme accent. */
function HighlightedText(props: {
  React: TuiSceneProps['React']
  ui: TuiSceneProps['ui']
  text: string
  ranges: readonly (readonly [number, number])[]
  color: TextColor
  width: number
}): React.ReactElement {
  const { React: R, ui, text, ranges, color, width } = props
  const { Text } = ui
  const parts: React.ReactElement[] = []
  let cursor = 0
  const clipped = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
  ranges.forEach(([start, end], index) => {
    if (start >= clipped.length) return
    const safeEnd = Math.min(end, clipped.length)
    if (start > cursor) parts.push(<Text key={`p${index}`} color="text">{clipped.slice(cursor, start)}</Text>)
    parts.push(
      <Text key={`h${index}`} color={color} bold>
        {clipped.slice(start, safeEnd)}
      </Text>,
    )
    cursor = safeEnd
  })
  if (cursor < clipped.length) parts.push(<Text key="tail" color="text">{clipped.slice(cursor)}</Text>)
  return <>{parts}</>
}

/** The main scene component, registered under `dsh-tui-find-scene`. */
export function FindScene(props: TuiSceneProps & { config: ResolvedConfig; initialQuery: () => string }): React.ReactElement {
  const { React, ui, channel, close, config } = props
  const { Box, Text, useInput, useTerminalSize } = ui
  const { useState, useEffect, useMemo, useRef, useCallback } = React

  const lang = getLang()
  const [query, setQuery] = useState(() => props.initialQuery())
  const [scope, setScope] = useState<SearchScope>(config.defaultScope)
  const [sessions, setSessions] = useState<readonly ScannedSession[]>([])
  const [progress, setProgress] = useState<ScanProgress | undefined>(undefined)
  const [mode, setMode] = useState<Mode>('list')
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<string | undefined>(undefined)
  const { columns, rows } = useTerminalSize()

  // One scanner per scene; the sweep aborts when the scene unmounts.
  useEffect(() => {
    const scanner = new SessionScanner()
    const signal = new AbortController()
    const scanOptions = {
      indexTools: config.indexTools,
      indexThinking: config.indexThinking,
      maxMessageChars: config.maxMessageChars,
      ...(config.sessionRoot === undefined ? {} : { sessionRoot: config.sessionRoot }),
      signal: signal.signal,
      onProgress: setProgress,
    }
    void scanner
      .scan(scanOptions)
      .then(result => {
        if (!signal.signal.aborted) setSessions(result)
      })
      .catch(() => setStatus(t('scan-aborted')))
    return () => {
      signal.abort()
    }
    // Sweep once per mount; config is stable for the scene's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hits = useMemo(
    () => searchSessions(sessions, query, { scope, repoCwd: channel.cwd }),
    [sessions, query, scope, channel],
  )

  // Flatten to navigable rows; session headers render but are not selected.
  const flat = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = []
    for (const hit of hits) {
      const isExpanded = expanded.has(hit.session.id)
      const shown = isExpanded ? hit.hits.length : Math.min(PREVIEW_HITS, hit.hits.length)
      rows.push({ kind: 'session', hit, first: true })
      for (let index = 0; index < shown; index++) {
        rows.push({
          kind: 'message',
          hit,
          message: hit.hits[index]!,
          index,
          more: isExpanded ? 0 : hit.hits.length - shown,
        })
      }
    }
    return rows
  }, [hits, expanded])

  const selectable = useMemo(
    () => flat.flatMap((row, rowIndex) => (row.kind === 'message' ? [rowIndex] : [])),
    [flat],
  )

  // Keep the selection valid as results change.
  useEffect(() => {
    setSelected(current => Math.min(current, Math.max(0, selectable.length - 1)))
  }, [selectable.length])

  const selectedRow = useMemo<FlatRow | undefined>(() => {
    const rowIndex = selectable[selected]
    return rowIndex === undefined ? undefined : flat[rowIndex]
  }, [flat, selectable, selected])

  // Reset selection when the query or scope changes shape.
  useEffect(() => {
    setSelected(0)
  }, [query, scope])

  const copySelected = useCallback(() => {
    const row = selectedRow
    if (row === undefined || row.kind !== 'message') return
    const hit = row.message
    const when = hit.at === undefined ? '' : ` ${new Date(hit.at).toISOString()}`
    const role = hit.role === 'user' ? t('role-user') : hit.role === 'assistant' ? t('role-assistant') : t('role-tool')
    const body = hit.kind === 'title' ? hit.text : `[${role}${when}]\n${hit.text}`
    try {
      copyToClipboard(body, process.stdout)
      setStatus(t('copied', { chars: body.length }))
    } catch {
      setStatus(t('copy-failed'))
    }
  }, [selectedRow])

  const beginResume = useCallback(() => {
    const row = selectedRow
    if (row === undefined || row.kind !== 'message') return
    setMode('confirm')
  }, [selectedRow])

  const confirmResume = useCallback(async () => {
    const row = selectedRow
    if (row === undefined || row.kind !== 'message') return
    const sessionId = row.hit.session.id
    try {
      const result = await channel.resumeTo(sessionId)
      if (result.ok) {
        setStatus(t('resumed'))
        close()
        return
      }
      if (result.reason === 'working') setStatus(t('resume-working'))
      else if (result.reason === 'cancelled') setStatus(t('resume-cancelled'))
      else if (result.reason === 'unavailable') setStatus(t('resume-unavailable'))
      else setStatus(t('resume-failed', { error: result.error }))
    } catch (error) {
      setStatus(t('resume-failed', { error: error instanceof Error ? error.message : String(error) }))
    }
    setMode('list')
  }, [selectedRow, channel, close])

  useInput(
    (input: string, key: InputKey) => {
      // Modifier gates. The host reports Alt as key.meta (parse-keypress
      // maps the Windows ALT modifier state onto meta; classic terminals
      // report Alt via the ESC prefix the same way), so "meta" here covers
      // both Alt and Meta. Single letters must never be intercepted while
      // ctrl/meta/super is held — the host delivers Ctrl+C as input 'c' +
      // key.ctrl, and hijacking that would break the scene's interrupt path.
      const plain = !key.ctrl && !key.meta && !key.super
      const metaOnly = key.meta && !key.ctrl && !key.super

      if (key.escape) {
        if (mode === 'list') {
          if (query.length > 0) setQuery('')
          else close()
        } else {
          setMode('list')
        }
        return
      }
      if (mode === 'confirm') {
        if (key.return) void confirmResume()
        return
      }
      if (mode === 'preview') {
        if (key.return) beginResume()
        else if (input === 'c' && (plain || metaOnly)) copySelected()
        return
      }
      // list mode
      if (key.tab) {
        setScope(current => (current === 'repo' ? 'all' : 'repo'))
        return
      }
      if (key.return) {
        beginResume()
        return
      }
      // Preview/copy commands: bare p/c only while the query is empty (no
      // typing intent); once the user is typing, the same commands move to
      // alt+p / alt+c (key.meta) so every character stays reachable.
      const previewKey = input === 'p' && ((plain && query.length === 0) || metaOnly)
      const copyKey = input === 'c' && ((plain && query.length === 0) || metaOnly)
      if (previewKey) {
        const row = selectedRow
        if (row !== undefined && row.kind === 'message') {
          setMode('preview')
        }
        return
      }
      if (copyKey) {
        copySelected()
        return
      }
      if (key.upArrow) {
        setSelected(current => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelected(current => Math.min(Math.max(0, selectable.length - 1), current + 1))
        return
      }
      if (key.pageUp || key.pageDown) {
        const jump = Math.max(1, rows - 8)
        setSelected(current => {
          const next = key.pageUp ? current - jump : current + jump
          return Math.min(Math.max(0, selectable.length - 1), Math.max(0, next))
        })
        return
      }
      if (key.backspace || key.delete) {
        setQuery(current => (current.length > 0 ? current.slice(0, -1) : current))
        return
      }
      if (input.length > 0 && plain) {
        setQuery(current => current + input)
      }
    },
    { isActive: true },
  )

  // Clear a transient status after a short delay.
  useEffect(() => {
    if (status === undefined) return
    const timer = setTimeout(() => setStatus(undefined), 2500)
    return () => clearTimeout(timer)
  }, [status])

  const listHeight = Math.max(4, rows - 6)
  const titleWidth = Math.max(16, Math.min(48, columns - 46))
  const hitWidth = Math.max(24, columns - 12)

  if (mode === 'confirm' && selectedRow !== undefined && selectedRow.kind === 'message') {
    const session = selectedRow.hit.session
    const working = channel.working
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="warning" bold>{t('confirm-title')}</Text>
        <Text color="text">{t('confirm-target', { title: displayTitle(session) })}</Text>
        {working ? <Text color="error" bold>{t('confirm-warning-working')}</Text> : null}
        <Text color="inactive">{t('confirm-warning-context')}</Text>
        <Text color="inactive">{t('footer-confirm')}</Text>
      </Box>
    )
  }

  if (mode === 'preview' && selectedRow !== undefined && selectedRow.kind === 'message') {
    const { hit, message } = selectedRow
    const all = hit.session.messages
    // Anchor on the hit's own index in the session's message list (title
    // hits have none and fall back to the head of the conversation).
    const anchor = message.sourceIndex ?? -1
    const context =
      anchor >= 0
        ? all.slice(Math.max(0, anchor - PREVIEW_CONTEXT), anchor + PREVIEW_CONTEXT + 1)
        : all.slice(0, PREVIEW_CONTEXT * 2 + 1)
    const session = hit.session
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="claude" bold>
          {t('preview-title', { title: displayTitle(session) })}
        </Text>
        <Text color="inactive">
          {session.header.cwd ?? ''} · {formatTime(session.modifiedAt, lang)} ·{' '}
          {all.length} msgs
          {context.length < all.length ? ' · ' : ''}
          {context.length < all.length ? t('preview-context-note', { count: PREVIEW_CONTEXT }) : ''}
        </Text>
        {context.map((entry, index) => (
          <Box key={index} flexDirection="column">
            <Text color={entry.role === 'user' ? 'claude' : entry.role === 'tool' ? 'warning' : 'text'}>
              {entry.role === 'user' ? t('role-user') : entry.role === 'tool' ? t('role-tool') : t('role-assistant')}
              {entry.at === undefined ? '' : ` · ${formatTime(entry.at, lang)}`}
            </Text>
            <Text color="text">{entry.text.slice(0, hitWidth * 4)}</Text>
          </Box>
        ))}
        <Text color="inactive">{t('footer-preview')}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <QueryLine
        React={React}
        ui={ui}
        query={query}
        scope={scope}
        progress={progress}
      />
      <Text color="subtle">{'─'.repeat(Math.max(0, columns - 2))}</Text>
      {query.trim().length === 0 ? (
        <Text color="inactive">{t('no-query-hint')}</Text>
      ) : hits.length === 0 ? (
        <Box flexDirection="column">
          <Text color="inactive">{t('no-results')}</Text>
          <Text color="inactive">{t('no-results-scope-hint', { scope: scope === 'repo' ? t('scope-repo') : t('scope-all') })}</Text>
        </Box>
      ) : (
        <ListView
          React={React}
          ui={ui}
          rows={flat}
          selectable={selectable}
          selected={selected}
          height={listHeight}
          titleWidth={titleWidth}
          hitWidth={hitWidth}
          lang={lang}
        />
      )}
      {query.trim().length > 0 && hits.length > 0 ? (
        <Text color="inactive">
          {t('hit-count', {
            sessions: hits.length,
            hits: hits.reduce((sum, hit) => sum + hit.total, 0),
          })}
        </Text>
      ) : null}
      {status !== undefined ? <Text color="success">{status}</Text> : null}
      <Text color="inactive">{query.trim().length > 0 ? t('footer-main-typing') : t('footer-main')}</Text>
    </Box>
  )
}

function ListView(props: {
  React: TuiSceneProps['React']
  ui: TuiSceneProps['ui']
  rows: readonly FlatRow[]
  selectable: readonly number[]
  selected: number
  height: number
  titleWidth: number
  hitWidth: number
  lang: 'zh' | 'en'
}): React.ReactElement {
  const { React: R, ui, rows, selectable, selected, height, titleWidth, hitWidth, lang } = props
  const { Box, Text } = ui
  const { useState } = R

  // Scroll window over the flat rows, keeping the selected row visible.
  const selectedIndex = selectable[selected]
  const [scroll, setScroll] = useState(0)
  if (selectedIndex !== undefined) {
    if (selectedIndex < scroll) setScroll(selectedIndex)
    else if (selectedIndex >= scroll + height) setScroll(selectedIndex - height + 1)
  }
  const visible = rows.slice(scroll, scroll + height)

  return (
    <Box flexDirection="column">
      {visible.map((row, offset) => {
        const rowIndex = scroll + offset
        const isSelected = selectable[selected] === rowIndex
        if (row.kind === 'session') {
          const session = row.hit.session
          return (
            <Box key={`s${rowIndex}`} flexDirection="row">
              <Text color="claude" bold>
                {isSelected ? '▸ ' : '  '}
                {displayTitle(session).slice(0, titleWidth)}
              </Text>
              <Text color="inactive">
                {' '}
                {formatTime(session.modifiedAt, lang)} · {session.messages.length} msgs ·{' '}
                {session.header.cwd === undefined ? '' : session.header.cwd.split(/[\\/]/).pop() ?? ''}
              </Text>
            </Box>
          )
        }
        const hit = row.message
        const roleLabel =
          hit.role === 'user' ? t('role-user') : hit.role === 'assistant' ? t('role-assistant') : t('role-tool')
        const roleColor = hit.role === 'user' ? 'claude' : hit.role === 'tool' ? 'warning' : 'text'
        const prefix = isSelected ? '  ● ' : '    '
        const more =
          row.more > 0 && !isSelected ? (
            <Text color="inactive"> {t('more-hits', { count: row.more })}</Text>
          ) : null
        return (
          <Box key={`m${rowIndex}`} flexDirection="row">
            <Text color="subtle">{prefix}</Text>
            <Text color={roleColor}>#{hit.seq ?? '·'} {roleLabel}: </Text>
            <HighlightedText
              React={R}
              ui={ui}
              text={hit.text}
              ranges={hit.ranges}
              color="warning"
              width={hitWidth}
            />
            {more}
          </Box>
        )
      })}
    </Box>
  )
}
