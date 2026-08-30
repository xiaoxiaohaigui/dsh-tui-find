/**
 * The full-screen find scene, styled region-for-region after the host's own
 * session browser (`/resume`, dsh-tui 0.9.3): a header row with live counts,
 * a round-bordered search card with a block caret, a two-line-per-session
 * list, a notice slot, one divider, and a dim-italic hint line whose
 * `**key**` spans render bold — the same keyboard vocabulary the browser
 * uses, so the two screens read as siblings.
 *
 * Keyboard model (the scene owns the keyboard while open, per the scenes
 * contract): typing ALWAYS edits the query — no bare letter is ever
 * intercepted (v0.1.2: bare `p`/`c` fought the first keystroke of every
 * query). Preview/copy/expand moved to Alt+P / Alt+C / Alt+E exclusively;
 * the host reports Alt as `key.meta`. Enter opens the resume confirm, Tab
 * toggles the scope, ↑↓/PgUp/PgDn move, Esc backs out one layer (query,
 * then screen). With an empty query the scene lists recent sessions
 * (most-recent-first, sessions with no conversation excluded, like the
 * browser's empty-session discipline) so /find opens as a live browser,
 * not a dead prompt.
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
import { spreadRow, tailWidth, truncateWidth } from './width.js'

/** The host ui kit's component/hook surface, derived from the scene props. */
type Ui = TuiSceneProps['ui']
/** The host's parsed-key flags, derived from the ui kit's own useInput. */
type InputKey = Parameters<Parameters<Ui['useInput']>[0]>[1]
/** The color vocabulary Text accepts (theme keys + raw values). */
type TextColor = NonNullable<React.ComponentProps<Ui['Text']>['color']>

type Mode = 'list' | 'preview' | 'confirm'

/** A row of the flattened list. Session rows are selectable only in the
 *  recent list (empty query); in results mode selection rides the hits. */
type FlatRow =
  | { kind: 'session'; session: ScannedSession }
  | { kind: 'message'; hit: SessionHit; message: MessageHit; index: number; more: number }

/** Vertical chrome of the layout: header + search card (3) + notice +
 *  divider + hints. The list gets whatever remains. */
const CHROME_LINES = 7
/** Hits shown per session card before `(+N)`. */
const PREVIEW_HITS = 3
/** Context messages on each side of a hit in the preview pane. */
const PREVIEW_CONTEXT = 2

/** Role glyph and colour for a preview entry, the host preview's vocabulary
 *  (user ❯, assistant ✦) plus a tool marker for tool-call rows. */
const ROLE_MARK: Record<'user' | 'assistant' | 'tool', { glyph: string; color: TextColor }> = {
  user: { glyph: '❯', color: 'suggestion' },
  assistant: { glyph: '✦', color: 'claude' },
  tool: { glyph: '⚙', color: 'warning' },
}

/**
 * Elapsed time as a person would say it, mirroring the host browser's
 * `formatWhen` thresholds and wording (relative up to a week, then a date).
 */
export function formatWhen(at: number | undefined, _lang: 'zh' | 'en'): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return t('when-now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('when-minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('when-hours', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t('when-days', { n: days })
  const date = new Date(at)
  return t('when-date', { m: date.getMonth() + 1, d: date.getDate() })
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
 * A dim-italic hint line whose `**key**` spans render bold — the HintLine
 * discipline from the host's design system, recreated on the scene-side kit.
 */
function HintLine(props: { React: TuiSceneProps['React']; ui: Ui; text: string }): React.ReactElement {
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
 * The bordered search card: `⌕ ` prefix, inverse block caret at the query's
 * end (the caret is append-only — the scene never moves it), and a
 * right-aligned dimmed placeholder carrying the scope while empty, so the
 * terminal-painted IME preedit can never collide with it (the host
 * SearchBox's own empty-state shape).
 */
function SearchCard(props: {
  React: TuiSceneProps['React']
  ui: Ui
  query: string
  scope: SearchScope
  columns: number
}): React.ReactElement {
  const { React: R, ui, query, scope, columns } = props
  const { Box, Text } = ui
  const placeholder = t('search-placeholder', {
    scope: scope === 'repo' ? t('scope-repo') : t('scope-all'),
  })
  const contentWidth = Math.max(8, columns - 4)
  const empty = query.length === 0
  const tail = empty ? '' : tailWidth(query, contentWidth - 3)
  return (
    <Box flexShrink={0} borderStyle="round" borderColor="suggestion" paddingX={1} width={columns}>
      {empty ? (
        <Box flexDirection="row" width="100%">
          <Text>⌕ </Text>
          <Text inverse>{' '}</Text>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {placeholder}
          </Text>
        </Box>
      ) : (
        <Text wrap="truncate-end">
          {'⌕ '}
          {tail}
          <Text inverse>{' '}</Text>
        </Text>
      )}
    </Box>
  )
}

/** Highlight `ranges` inside `text` with the theme accent. */
function HighlightedText(props: {
  React: TuiSceneProps['React']
  ui: Ui
  text: string
  ranges: readonly (readonly [number, number])[]
  color: TextColor
  width: number
}): React.ReactElement {
  const { React: R, ui, text, ranges, color, width } = props
  const { Text } = ui
  const parts: React.ReactElement[] = []
  let cursor = 0
  const clipped = truncateWidth(text, width)
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
  const [status, setStatus] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  const { columns, rows } = useTerminalSize()

  // React batches every parsed key from one stdin chunk, so the handler can
  // run several times before a re-render — branch decisions read mirrors
  // updated the moment the handler acts (the host browser's focusRef
  // discipline), while position edits go through functional setState.
  const modeRef = useRef<Mode>('list')
  modeRef.current = mode
  const queryRef = useRef(query)
  queryRef.current = query
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  // Locks the resume pipeline so a repeated Enter cannot start the same
  // async operation twice before the mode change renders.
  const actionPendingRef = useRef(false)

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
        if (!signal.signal.aborted) {
          setSessions(result)
          setProgress(undefined)
        }
      })
      .catch(() => setStatus({ text: t('scan-aborted'), tone: 'error' }))
    return () => {
      signal.abort()
    }
    // Sweep once per mount; config is stable for the scene's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recentMode = query.trim().length === 0
  const hits = useMemo(
    () => searchSessions(sessions, query, { scope, repoCwd: channel.cwd }),
    [sessions, query, scope, channel],
  )

  // Flatten to rows. Recent mode lists every session that holds conversation
  // content (the scanner's MRU order); results mode groups hits per session.
  const flat = useMemo<FlatRow[]>(() => {
    if (recentMode) {
      return sessions
        .filter(session => session.messages.length > 0)
        .map(session => ({ kind: 'session' as const, session }))
    }
    const rows: FlatRow[] = []
    for (const hit of hits) {
      const isExpanded = expanded.has(hit.session.id)
      const shown = isExpanded ? hit.hits.length : Math.min(PREVIEW_HITS, hit.hits.length)
      rows.push({ kind: 'session', session: hit.session })
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
  }, [recentMode, sessions, hits, expanded])

  const selectable = useMemo(
    () => flat.flatMap((row, rowIndex) => (row.kind === 'message' || recentMode ? [rowIndex] : [])),
    [flat, recentMode],
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

  /** The session a resume would target, whatever kind of row is selected. */
  const resumeTarget = useMemo<ScannedSession | undefined>(() => {
    const row = selectedRow
    if (row === undefined) return undefined
    return row.kind === 'session' ? row.session : row.hit.session
  }, [selectedRow])

  const selectedMessage = useCallback((): MessageHit | undefined => {
    const row = selectedRow
    return row !== undefined && row.kind === 'message' ? row.message : undefined
  }, [selectedRow])

  const copySelected = useCallback(() => {
    const hit = selectedMessage()
    if (hit === undefined) return
    const when = hit.at === undefined ? '' : ` ${new Date(hit.at).toISOString()}`
    const role = hit.role === 'user' ? t('role-user') : hit.role === 'assistant' ? t('role-assistant') : t('role-tool')
    const body = hit.kind === 'title' ? hit.text : `[${role}${when}]\n${hit.text}`
    try {
      copyToClipboard(body, process.stdout)
      setStatus({ text: t('copied', { chars: body.length }), tone: 'info' })
    } catch {
      setStatus({ text: t('copy-failed'), tone: 'error' })
    }
  }, [selectedMessage])

  const beginResume = useCallback(() => {
    if (resumeTarget === undefined) return
    setMode('confirm')
  }, [resumeTarget])

  const confirmResume = useCallback(async () => {
    const target = resumeTarget
    if (target === undefined) return
    try {
      const result = await channel.resumeTo(target.id)
      if (result.ok) {
        setStatus({ text: t('resumed'), tone: 'info' })
        close()
        return
      }
      if (result.reason === 'working') setStatus({ text: t('resume-working'), tone: 'error' })
      else if (result.reason === 'cancelled') setStatus({ text: t('resume-cancelled'), tone: 'info' })
      else if (result.reason === 'unavailable') setStatus({ text: t('resume-unavailable'), tone: 'error' })
      else setStatus({ text: t('resume-failed', { error: result.error }), tone: 'error' })
    } catch (error) {
      setStatus({
        text: t('resume-failed', { error: error instanceof Error ? error.message : String(error) }),
        tone: 'error',
      })
    }
    setMode('list')
  }, [resumeTarget, channel, close])

  /** Only a modifier-free Enter may commit a modal (the host's #110 rule:
   *  Option/Shift/Ctrl+Enter arrive as return+modifier and must not). */
  const isPlainReturn = useCallback(
    (key: InputKey): boolean =>
      key.return === true && !key.ctrl && !key.meta && !key.shift && !key.super,
    [],
  )

  useInput(
    (input: string, key: InputKey) => {
      // Modifier gates. The host reports Alt as key.meta (parse-keypress
      // maps the Windows ALT modifier state onto meta; classic terminals
      // report Alt via the ESC prefix the same way). Single letters must
      // never be intercepted while ctrl/meta/super is held — the host
      // delivers Ctrl+C as input 'c' + key.ctrl, and hijacking that would
      // break the scene's interrupt path.
      const plain = !key.ctrl && !key.meta && !key.super
      const altOnly = key.meta && !key.ctrl && !key.super

      if (key.escape) {
        if (modeRef.current === 'list') {
          if (queryRef.current.length > 0) setQuery('')
          else close()
        } else {
          setMode('list')
        }
        return
      }
      if (modeRef.current === 'confirm') {
        if (isPlainReturn(key) && !actionPendingRef.current) {
          actionPendingRef.current = true
          void confirmResume().finally(() => {
            actionPendingRef.current = false
          })
        }
        return
      }
      if (modeRef.current === 'preview') {
        if (isPlainReturn(key)) beginResume()
        else if (input === 'c' && (plain || altOnly)) copySelected()
        return
      }
      // list mode
      if (key.tab) {
        const next: SearchScope = scopeRef.current === 'repo' ? 'all' : 'repo'
        scopeRef.current = next
        setScope(next)
        setStatus({
          text: t('scope-switched', { scope: next === 'repo' ? t('scope-repo') : t('scope-all') }),
          tone: 'info',
        })
        return
      }
      if (isPlainReturn(key)) {
        beginResume()
        return
      }
      // Preview/copy/expand live on Alt+P / Alt+C / Alt+E ONLY. Bare letters
      // always type — a bare-key form fought the first keystroke of every
      // query on a real terminal and was removed in v0.1.2.
      if (altOnly && input === 'p') {
        if (selectedRow !== undefined && selectedRow.kind === 'message') setMode('preview')
        return
      }
      if (altOnly && input === 'c') {
        copySelected()
        return
      }
      if (altOnly && input === 'e') {
        const row = selectedRow
        if (row !== undefined && row.kind === 'message') {
          const id = row.hit.session.id
          setExpanded(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
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
        const jump = Math.max(1, rows - CHROME_LINES)
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
        // Only real characters reach the query — control bytes inside a
        // paste (newlines included) must not type invisibly.
        const typed = input.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) setQuery(current => current + typed)
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

  const listHeight = Math.max(2, rows - CHROME_LINES)
  const titleWidth = Math.max(16, Math.min(48, columns - 40))
  const hitWidth = Math.max(24, columns - 14)
  const totalHits = hits.reduce((sum, hit) => sum + hit.total, 0)

  // Header right side: scan progress while sweeping, then hit counts in
  // results mode and the session total in recent mode.
  const headerRight =
    progress !== undefined
      ? progress.total === undefined
        ? t('scanning-initial')
        : t('scanning', { resolved: progress.resolved, total: progress.total })
      : recentMode
        ? t('session-count', { n: flat.length })
        : t('hit-count', { sessions: hits.length, hits: totalHits })
  const header = spreadRow(` ${t('scene-title')}`, headerRight, Math.max(0, columns - 1))

  const listHint = columns >= 84 ? t('hint-list') : t('hint-list-short')

  if (mode === 'confirm' && resumeTarget !== undefined) {
    const session = resumeTarget
    const working = channel.working
    return (
      <Box flexDirection="column" paddingX={1} width={columns}>
        <Text color="remember" bold>
          {' '}
          {t('scene-title')}
        </Text>
        <Text color="warning" bold>
          {' '}
          {t('confirm-title')}
        </Text>
        <Text color="text">
          {' '}
          {t('confirm-target', { title: truncateWidth(displayTitle(session), Math.max(0, columns - 12)) })}
        </Text>
        {working ? (
          <Text color="error" bold>
            {' '}
            {t('confirm-warning-working')}
          </Text>
        ) : null}
        <Text dimColor>
          {' '}
          {t('confirm-warning-context')}
        </Text>
        <Box marginTop={1}>
          <Text dimColor italic>
            {' '}
            <HintLine React={React} ui={ui} text={t('hint-confirm')} />
          </Text>
        </Box>
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
      <Box flexDirection="column" paddingX={1} width={columns}>
        <Text color="remember" bold>
          {' '}
          {truncateWidth(t('preview-title', { title: displayTitle(session) }), Math.max(0, columns - 2))}
        </Text>
        <Text dimColor>
          {' '}
          {truncateWidth(
            `${session.header.cwd ?? ''} · ${formatWhen(session.modifiedAt, lang)} · ${t('msgs-count', { n: all.length })}`,
            Math.max(0, columns - 2),
          )}
        </Text>
        <Text> </Text>
        {context.map((entry, index) => (
          <Box key={index} flexDirection="column">
            <Text color={ROLE_MARK[entry.role].color}>
              {ROLE_MARK[entry.role].glyph}{' '}
              {entry.role === 'user'
                ? t('role-user')
                : entry.role === 'tool'
                  ? t('role-tool')
                  : t('role-assistant')}
              {entry.at === undefined ? '' : ` · ${formatWhen(entry.at, lang)}`}
            </Text>
            <Text dimColor={entry.role === 'assistant'}>{entry.text.slice(0, hitWidth * 4)}</Text>
            <Text> </Text>
          </Box>
        ))}
        <Text dimColor italic>
          {' '}
          <HintLine React={React} ui={ui} text={t('hint-preview')} />
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {header.left}
        </Text>
        <Text dimColor>
          {header.gap > 0 ? ' '.repeat(header.gap) : ''}
          {header.right}
        </Text>
      </Box>
      <SearchCard React={React} ui={ui} query={query} scope={scope} columns={columns} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {recentMode && progress !== undefined && sessions.length === 0 ? (
          <Text dimColor italic>
            {' '}
            {t('reading-sessions')}
          </Text>
        ) : flat.length === 0 ? (
          recentMode ? (
            <Text dimColor italic>
              {t('no-sessions')}
            </Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor italic>
                {t('no-results')}
              </Text>
              <Text dimColor italic>
                {t('no-results-scope-hint', { scope: scope === 'repo' ? t('scope-repo') : t('scope-all') })}
              </Text>
            </Box>
          )
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
            recentMode={recentMode}
          />
        )}
      </Box>
      <Box flexShrink={0}>
        <Text color={status?.tone === 'error' ? 'error' : 'success'}>
          {status === undefined
            ? ' '
            : ` ${status.tone === 'error' ? '✕' : '✔'} ${truncateWidth(status.text, Math.max(0, columns - 6))}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{'─'.repeat(Math.max(0, columns - 1))}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor italic>
          {' '}
          <HintLine React={React} ui={ui} text={listHint} />
        </Text>
      </Box>
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
  recentMode: boolean
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
          const session = row.session
          // Two lines per session, the browser's rule: the title answers "is
          // this the conversation I mean", the metadata line answers "which
          // of the ones that look alike is it".
          return (
            <Box key={`s${rowIndex}`} flexDirection="column" flexShrink={0}>
              <Box>
                <Text color={isSelected ? 'suggestion' : 'subtle'}>{isSelected ? '❯ ' : '  '}</Text>
                <Text color={isSelected ? 'suggestion' : 'text'} bold={isSelected}>
                  {truncateWidth(displayTitle(session), titleWidth)}
                </Text>
              </Box>
              <Box>
                <Text dimColor>
                  {'  '}
                  {truncateWidth(
                    [
                      formatWhen(session.modifiedAt, lang),
                      t('msgs-count', { n: session.messages.length }),
                      session.header.cwd?.split(/[\\/]/).pop() ?? session.id.slice(0, 8),
                    ].join(' · '),
                    Math.max(12, titleWidth + 18),
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
        const marker = isSelected ? '  ❯ ' : '    '
        const more = row.more > 0 && !isSelected ? <Text dimColor>{t('more-hits', { count: row.more })}</Text> : null
        return (
          <Box key={`m${rowIndex}`} flexDirection="row">
            <Text color={isSelected ? 'suggestion' : 'subtle'}>{marker}</Text>
            <Text dimColor={!isSelected} {...(isSelected && roleColor !== undefined ? { color: roleColor } : {})}>
              #{hit.seq ?? '·'} {roleLabel}:{' '}
            </Text>
            <HighlightedText React={R} ui={ui} text={hit.text} ranges={hit.ranges} color="warning" width={hitWidth} />
            {more}
          </Box>
        )
      })}
    </Box>
  )
}
