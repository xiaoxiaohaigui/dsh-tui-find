/**
 * The full-screen find scene, styled region-for-region after the host's own
 * session browser (`/resume`, dsh-tui 0.9.3): a header row with live counts,
 * a round-bordered search card with a block caret, a two-line-per-session
 * list, a notice slot, one divider, and a dim-italic hint line whose
 * `**key**` spans render bold — the same keyboard vocabulary the browser
 * uses, so the two screens read as siblings.
 *
 * With an empty query the scene lists recent sessions (most-recent-first,
 * sessions with no conversation excluded, like the browser's empty-session
 * discipline) so /find opens as a live browser, not a dead prompt. Results
 * stream in while the sweep is still running (see find-sweep.ts).
 *
 * This module is the orchestrator: it owns the scene state and the search
 * derivations, and delegates to the find-* siblings — find-input.tsx (the
 * keyboard dispatcher: typing always edits the query; Enter opens the
 * resume confirm, Tab toggles the scope, Alt+R regex, Alt+T time window,
 * Alt+N title-only, ↑↓/PgUp/PgDn move, Esc backs out one layer; Alt+P opens
 * the scrollable conversation reader, Alt+C copies, Alt+E expands; Alt+H
 * help), find-preview.tsx (the reader pane and its model), find-list.tsx
 * (the two-line-per-session list), find-chrome.tsx (search card, hints,
 * confirm pane), find-types.ts (shared vocabulary).
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
import { t } from './i18n.js'
import type { Notifier } from './notify.js'
import type { ScanProgress, ScannedSession, SessionScanner } from './core/scan.js'
import { compileRegex, searchSessions, sessionCwdMatches, type MessageHit, type SearchScope } from './core/search.js'
import { messageAtLine } from './preview.js'
import { displayWidth, spreadRow, truncateWidth } from './width.js'
import { HelpOverlay } from './help.js'
import {
  CHROME_LINES,
  PREVIEW_HITS,
  hasTerminalImageHooks,
  wheelStep,
  type ContextBoxProps,
  type ContextMenuEventLike,
  type CopyEntry,
  type FlatRow,
  type Mode,
  type StatusNote,
  type TimeFilter,
  type WheelEventLike,
} from './find-types.js'
import {
  highlightedItem,
  moveHighlight,
  openMenu,
  type ContextMenuState,
  type MenuItem,
} from './find-menu.js'
import { ConfirmPane, HintLine, SearchCard, composeListHint } from './find-chrome.js'
import { ListView } from './find-list.js'
import { PreviewPane, usePreviewModel } from './find-preview.js'
import { useFindInput } from './find-input.js'
import { useSessionSweep } from './find-sweep.js'

/** The scene's open menu: the pure anchored list plus the action each item
 *  runs (bound at open time — the actions close over the row/message the
 *  menu was opened on). */
type SceneMenuItem = MenuItem & { action: () => void }
type SceneMenuState = ContextMenuState<SceneMenuItem>

/** A no-op notifier: the scene's own footer feedback stands alone when the
 *  host has no toast service (0.9.x) or none was passed. */
const noopNotify: Notifier = () => {}

export function FindScene(props: TuiSceneProps & {
  config: ResolvedConfig
  /** Plugin-scoped scanner (created in main.tsx): its decode cache outlives the scene. */
  scanner: SessionScanner
  initialQuery: () => string
  /** Host toast surface (0.10+, structural soft-probe in notify.ts); the
   *  footer status stays the primary in-scene feedback either way. */
  notify?: Notifier
}): React.ReactElement {
  const { React, ui, channel, close, config, scanner } = props
  const notify = props.notify ?? noopNotify
  const { Box, Text, useTerminalSize } = ui
  const { useState, useEffect, useMemo, useRef, useCallback } = React

  const [query, setQuery] = useState(() => props.initialQuery())
  const [scope, setScope] = useState<SearchScope>(config.defaultScope)
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(config.defaultTime)
  const [useRegex, setUseRegex] = useState(config.regex)
  const [titleOnly, setTitleOnly] = useState(config.titleOnly)
  const [sessions, setSessions] = useState<readonly ScannedSession[]>([])
  const [progress, setProgress] = useState<ScanProgress | undefined>(undefined)
  const [mode, setMode] = useState<Mode>('list')
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<StatusNote | undefined>(undefined)
  const [menu, setMenu] = useState<SceneMenuState | undefined>(undefined)
  const { columns, rows } = useTerminalSize()

  // React batches every parsed key from one stdin chunk, so the input
  // handler can run several times before a re-render — branch decisions
  // read these mirrors updated the moment the handler acts (the host
  // browser's focusRef discipline), while position edits go through
  // functional setState. The mouse callbacks below share the same mirrors.
  const modeRef = useRef<Mode>('list')
  modeRef.current = mode
  const queryRef = useRef(query)
  queryRef.current = query
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const timeFilterRef = useRef(timeFilter)
  timeFilterRef.current = timeFilter
  const useRegexRef = useRef(useRegex)
  useRegexRef.current = useRegex
  const titleOnlyRef = useRef(titleOnly)
  titleOnlyRef.current = titleOnly
  const actionPendingRef = useRef(false)
  const menuRef = useRef<SceneMenuState | undefined>(undefined)
  menuRef.current = menu

  useSessionSweep(React, { scanner, config, setSessions, setProgress, setStatus })

  const recentMode = query.trim().length === 0
  // The time window's cutoff, quantized to the minute: renders within the
  // same minute share one cutoff, so the `hits`/`flat` memos stay stable
  // across direction-key steps, toasts and progress ticks instead of
  // re-searching on every render — while a mounted scene that sits open
  // still crosses its own window boundary on the first render after the
  // minute flips (the boundary can trail the exact one by up to a minute).
  const sinceMs =
    timeFilter === 'all'
      ? undefined
      : Math.floor(Date.now() / 60_000) * 60_000 - (timeFilter === '7d' ? 7 : 30) * 86_400_000
  const hits = useMemo(
    () =>
      searchSessions(sessions, query, {
        scope,
        repoCwd: channel.cwd,
        caseSensitive: config.caseSensitive,
        ...(config.pinyin ? { pinyin: true } : {}),
        ...(useRegex ? { regex: true } : {}),
        ...(titleOnly ? { titleOnly: true } : {}),
        ...(sinceMs === undefined ? {} : { sinceMs }),
      }),
    [sessions, query, scope, channel, config.caseSensitive, config.pinyin, useRegex, titleOnly, sinceMs],
  )
  // The scene mirrors the core's own regex compilation so a pattern that is
  // not (yet) valid mid-typing can be explained instead of silently showing
  // "no results".
  const regexInvalid = useMemo(
    () =>
      useRegex &&
      query.trim().length > 0 &&
      compileRegex(query.trim(), config.caseSensitive) === undefined,
    [useRegex, query, config.caseSensitive],
  )

  // Flatten to rows. Recent mode lists every session that holds conversation
  // content (the scanner's MRU order), narrowed by the time window; results
  // mode groups hits per session — the title hit (if any) rides the card's
  // title line, message hits render under the card.
  const recentScopeCwd = channel.cwd
  const flat = useMemo<FlatRow[]>(() => {
    if (recentMode) {
      return sessions
        .filter(
          session =>
            session.messages.length > 0 &&
            (scope === 'all' || sessionCwdMatches(recentScopeCwd ?? '', session.header.cwd ?? '')) &&
            (sinceMs === undefined || session.modifiedAt >= sinceMs),
        )
        .map(session => ({ kind: 'session' as const, session, titleHit: undefined }))
    }
    const rows: FlatRow[] = []
    for (const hit of hits) {
      const titleHit = hit.hits.find(entry => entry.kind === 'title')
      const messageHits = hit.hits.filter(entry => entry.kind === 'message')
      const isExpanded = expanded.has(hit.session.id)
      const shown = isExpanded ? messageHits.length : Math.min(PREVIEW_HITS, messageHits.length)
      rows.push({ kind: 'session', session: hit.session, titleHit, hits: hit.hits })
      for (let index = 0; index < shown; index++) {
        rows.push({
          kind: 'message',
          hit,
          message: messageHits[index]!,
          index,
          // The remaining-count tail belongs to the final visible hit only;
          // attaching it to every row repeats the same (+N) on the card.
          more: !isExpanded && index === shown - 1 ? messageHits.length - shown : 0,
        })
      }
    }
    return rows
  }, [recentMode, sessions, hits, expanded, sinceMs, scope, recentScopeCwd])

  // Every row is selectable: cards answer Enter (resume) and Alt+P (preview
  // from the top), hit rows answer the full hit vocabulary. The selection is
  // a flat index into `rows` directly.

  // Keep the selection valid as results change.
  useEffect(() => {
    setSelected(current => Math.min(current, Math.max(0, flat.length - 1)))
  }, [flat.length])

  const selectedRow = useMemo<FlatRow | undefined>(() => flat[selected], [flat, selected])

  const {
    cursor: previewCursor,
    setCursor: setPreviewCursor,
    windowStart: previewWindowStart,
    setWindowStart: setPreviewWindowStart,
    anchorRef: previewAnchorRef,
    session: previewSession,
    hitStarts: previewHitStarts,
    lines: previewLines,
    weights: previewWeights,
    bodyWidth: previewBodyWidth,
    stepByWheel: stepPreview,
  } = usePreviewModel(React, { mode, modeRef, selectedRow, columns })

  // Reset selection when the query, scope, time window or match mode changes shape.
  useEffect(() => {
    setSelected(0)
  }, [query, scope, timeFilter, useRegex, titleOnly])

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

  /** The shared copy body: the list's Alt+C copies the selected hit row,
   *  the preview's Alt+C copies the message under the cursor — same shape,
   *  so both feed this one builder. */
  const copyMessage = useCallback(
    (entry: CopyEntry) => {
      const when = entry.at === undefined ? '' : ` ${new Date(entry.at).toISOString()}`
      const role = entry.role === 'user' ? t('role-user') : entry.role === 'assistant' ? t('role-assistant') : t('role-tool')
      const body = `[${role}${when}]\n${entry.text}`
      try {
        copyToClipboard(body, process.stdout)
        setStatus({ text: t('copied', { chars: body.length }), tone: 'info' })
        notify(t('copied', { chars: body.length }), 'info')
      } catch {
        setStatus({ text: t('copy-failed'), tone: 'error' })
        notify(t('copy-failed'), 'error')
      }
    },
    // The notifier is stable per activation; it deliberately stays out of
    // the deps so the copy identity the list and preview share never churns.
    [],
  )

  const copySelected = useCallback(() => {
    const hit = selectedMessage()
    if (hit === undefined) return
    copyMessage(hit)
  }, [copyMessage, selectedMessage])

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
        // The toast outlives the closing scene — the footer note would not.
        notify(t('resumed'), 'info')
        close()
        return
      }
      if (result.reason === 'working') {
        setStatus({ text: t('resume-working'), tone: 'error' })
        notify(t('resume-working'), 'error')
      } else if (result.reason === 'cancelled') {
        setStatus({ text: t('resume-cancelled'), tone: 'info' })
        notify(t('resume-cancelled'), 'info')
      } else if (result.reason === 'unavailable') {
        setStatus({ text: t('resume-unavailable'), tone: 'error' })
        notify(t('resume-unavailable'), 'error')
      } else {
        setStatus({ text: t('resume-failed', { error: result.error }), tone: 'error' })
        notify(t('resume-failed', { error: result.error }), 'error')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setStatus({ text: t('resume-failed', { error: detail }), tone: 'error' })
      notify(t('resume-failed', { error: detail }), 'error')
    }
    setMode('list')
  }, [resumeTarget, channel, close])

  /** Copy one session's log path — the context menu's path entry and any
   *  future caller share the same feedback vocabulary as message copies. */
  const copySessionPath = useCallback(
    (session: ScannedSession) => {
      try {
        copyToClipboard(session.path, process.stdout)
        setStatus({ text: t('copied-path'), tone: 'info' })
        notify(t('copied-path'), 'info')
      } catch {
        setStatus({ text: t('copy-failed'), tone: 'error' })
        notify(t('copy-failed'), 'error')
      }
    },
    // Deliberately no notify dep — stable per activation, as in copyMessage.
    [],
  )

  // ── context menu (right-click; attached only on 0.10+ kits) ───────────
  const closeMenu = useCallback(() => setMenu(undefined), [])
  const moveMenuHighlight = useCallback((delta: number) => {
    setMenu(current => (current === undefined ? undefined : moveHighlight(current, delta)))
  }, [])
  const activateMenu = useCallback(() => {
    const current = menuRef.current
    if (current === undefined) return
    const item = highlightedItem(current)
    if (item === undefined) return
    setMenu(undefined)
    item.action()
  }, [])

  /** Right-click on a list row: the row selects (mirroring hover), and the
   *  menu offers the row's vocabulary — a hit row adds its message copy; a
   *  card offers path + resume. Resume mirrors Enter (the confirm pane). */
  const openRowMenu = useCallback(
    (rowIndex: number, event: ContextMenuEventLike) => {
      if (modeRef.current !== 'list' || actionPendingRef.current) return
      const row = flat[rowIndex]
      if (row === undefined) return
      const session = row.kind === 'session' ? row.session : row.hit.session
      const items: SceneMenuItem[] = []
      if (row.kind === 'message') {
        items.push({ id: 'copy-message', label: t('menu-copy-message'), action: () => copyMessage(row.message) })
      }
      items.push(
        { id: 'copy-log', label: t('menu-copy-log'), action: () => copySessionPath(session) },
        {
          id: 'resume',
          label: t('menu-resume'),
          action: () => {
            setSelected(rowIndex)
            modeRef.current = 'confirm'
            setMode('confirm')
          },
        },
      )
      setSelected(rowIndex)
      setMenu(openMenu(event.col, event.row, items))
    },
    [flat, copyMessage, copySessionPath],
  )

  /** Right-click in the preview: copy the message under the POINTER (the
   *  WheelBox's local row maps through the scroll window to a message). */
  const openPreviewMenu = useCallback(
    (event: ContextMenuEventLike) => {
      if (modeRef.current !== 'preview' || actionPendingRef.current) return
      const session = previewSession
      if (session === undefined) return
      const lineAt = previewWindowStart + event.localRow
      const messageIndex = messageAtLine(previewLines, lineAt)
      const message = messageIndex === undefined ? undefined : session.messages[messageIndex]
      if (message === undefined) return
      setMenu(
        openMenu(event.col, event.row, [
          { id: 'copy-message', label: t('menu-copy-message'), action: () => copyMessage(message) },
        ]),
      )
    },
    [previewSession, previewLines, previewWindowStart, copyMessage],
  )

  // The right-click vocabulary rides the 0.10 kit generation probe (0.9.x
  // hosts have no context-menu dispatch — the handlers are never attached).
  const contextMenuCapable = hasTerminalImageHooks(ui)

  useFindInput({
    ui,
    modeRef,
    queryRef,
    scopeRef,
    timeFilterRef,
    useRegexRef,
    titleOnlyRef,
    actionPendingRef,
    menuRef,
    setQuery,
    setScope,
    setTimeFilter,
    setUseRegex,
    setTitleOnly,
    setMode,
    setExpanded,
    setSelected,
    setPreviewCursor,
    setStatus,
    closeMenu,
    moveMenuHighlight,
    activateMenu,
    flatLength: flat.length,
    rows,
    selectedRow,
    previewLines,
    previewCursor,
    previewSession,
    previewHitStarts,
    previewAnchorRef,
    beginResume,
    confirmResume,
    copyMessage,
    copySelected,
    close,
  })

  // Clear a transient status after a short delay.
  useEffect(() => {
    if (status === undefined) return
    const timer = setTimeout(() => setStatus(undefined), 2500)
    return () => clearTimeout(timer)
  }, [status])

  const listHeight = Math.max(2, rows - CHROME_LINES)
  const titleWidth = Math.max(1, Math.min(48, columns - 4))
  // Keep every row's content inside the terminal even when the viewport is
  // narrower than the desktop prefix budget.
  const hitWidth = Math.max(1, columns - 4)
  const totalHits = hits.reduce((sum, hit) => sum + hit.total, 0)
  // Active non-default filters, shown in the search card (placeholder row
  // when the query is empty, right-aligned badges otherwise).
  const activeFilters = [
    ...(timeFilter === 'all' ? [] : [t(timeFilter === '7d' ? 'time-7d' : 'time-30d')]),
    ...(useRegex ? [t('badge-regex')] : []),
    ...(titleOnly ? [t('badge-title-only')] : []),
  ].join(' · ')

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

  const listHint = composeListHint(columns)

  // The open menu's overlay: a full-viewport backdrop (click/right-click
  // anywhere outside closes) with the clamped anchored panel on top. The
  // panel's width budget mirrors the list's own truncation discipline.
  const menuOverlay = (() => {
    if (menu === undefined) return undefined
    const MenuBox = Box as unknown as React.ComponentType<ContextBoxProps>
    const width =
      menu.items.length === 0 ? 0 : Math.max(...menu.items.map(item => displayWidth(item.label))) + 4
    const left = Math.max(0, Math.min(menu.anchorCol, Math.max(0, columns - width - 1)))
    const top = Math.max(0, Math.min(menu.anchorRow, Math.max(0, rows - menu.items.length - 3)))
    return (
      <MenuBox
        position="absolute"
        top={0}
        left={0}
        width={columns}
        height={rows}
        onClick={event => {
          event.stopImmediatePropagation()
          closeMenu()
        }}
        onContextMenu={event => {
          event.stopImmediatePropagation()
          closeMenu()
        }}
      >
        <MenuBox
          position="absolute"
          top={top}
          left={left}
          flexDirection="column"
          borderStyle="round"
          onClick={event => event.stopImmediatePropagation()}
          onContextMenu={event => event.stopImmediatePropagation()}
        >
          {menu.items.map((item, index) => (
            <MenuBox
              key={item.id}
              flexShrink={0}
              onClick={event => {
                event.stopImmediatePropagation()
                setMenu(undefined)
                item.action()
              }}
            >
              <Text {...(index === menu.highlight ? { backgroundColor: 'selectionBg' as const } : {})}>
                {` ${item.label} `}
              </Text>
            </MenuBox>
          ))}
        </MenuBox>
      </MenuBox>
    )
  })()

  /** Mouse selection mirrors the browser: hover moves focus. */
  const selectRow = useCallback(
    (rowIndex: number) => {
      if (modeRef.current !== 'list' || actionPendingRef.current) return
      setSelected(Math.min(Math.max(0, rowIndex), Math.max(0, flat.length - 1)))
      setStatus(undefined)
    },
    [flat.length],
  )
  /** A row click follows the browser's open path, including confirmation. */
  const clickRow = useCallback(
    (rowIndex: number) => {
      if (modeRef.current !== 'list' || actionPendingRef.current) return
      const row = flat[rowIndex]
      if (row === undefined) return
      setSelected(rowIndex)
      setStatus(undefined)
      modeRef.current = 'confirm'
      setMode('confirm')
    },
    [flat],
  )
  const stepRows = useCallback(
    (event: WheelEventLike) => {
      if (modeRef.current !== 'list' || actionPendingRef.current || flat.length === 0) return
      const by = wheelStep(event.deltaY, event.deltaX)
      if (by === 0) return
      setSelected(current => Math.min(Math.max(0, flat.length - 1), Math.max(0, current + by)))
    },
    [flat.length],
  )

  if (mode === 'help') {
    // Render-only overlay: the keyboard stays with the find-input branches
    // (Alt+H toggles, Esc returns, everything else is swallowed).
    return <HelpOverlay React={React} ui={ui} columns={columns} rows={rows} />
  }

  if (mode === 'confirm' && resumeTarget !== undefined) {
    return <ConfirmPane React={React} ui={ui} session={resumeTarget} working={channel.working} columns={columns} />
  }

  if (mode === 'preview' && selectedRow !== undefined) {
    const session = selectedRow.kind === 'session' ? selectedRow.session : selectedRow.hit.session
    return (
      <>
        <PreviewPane
          React={React}
          ui={ui}
          session={session}
          lines={previewLines}
          weights={previewWeights}
          bodyWidth={previewBodyWidth}
          cursor={previewCursor}
          windowStart={previewWindowStart}
          setCursor={setPreviewCursor}
          setWindowStart={setPreviewWindowStart}
          anchorRef={previewAnchorRef}
          status={status}
          columns={columns}
          rows={rows}
          onWheel={stepPreview}
          {...(contextMenuCapable ? { onPreviewContextMenu: openPreviewMenu } : {})}
        />
        {menuOverlay}
      </>
    )
  }

  // Root pinned to the full viewport (the host browser's own rule: every
  // screen roots at `width: columns, height: rows`): the list box grows to
  // fill rows-CHROME_LINES exactly, so the notice/divider/hint footer stays
  // on the bottom row even when the visible window ends on a one-line hit
  // row instead of a two-line card — an unpinned root is content-sized and
  // the footer rides up and down a line as the window's line total changes
  // (the on-device footer-jump bug).
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {header.left}
        </Text>
        <Text dimColor>
          {header.gap > 0 ? ' '.repeat(header.gap) : ''}
          {header.right}
        </Text>
      </Box>
      <SearchCard React={React} ui={ui} query={query} scope={scope} filters={activeFilters} columns={columns} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {/* While a sweep is in flight and nothing has been resolved yet,
            both list modes show the reading notice — a query-mode user must
            not see "no matching sessions" for what is only the scan's head
            of line (results stream in as sessions resolve). */}
        {progress !== undefined && sessions.length === 0 ? (
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
            <Box flexDirection="column" flexShrink={0}>
              <Text dimColor italic>
                {t('no-results')}
              </Text>
              {regexInvalid ? (
                <Text dimColor italic>
                  {t('regex-invalid')}
                </Text>
              ) : (
                <Text dimColor italic>
                  {t('no-results-scope-hint', { scope: scope === 'repo' ? t('scope-repo') : t('scope-all') })}
                </Text>
              )}
            </Box>
          )
        ) : (
          <ListView
            React={React}
            ui={ui}
            rows={flat}
            selected={selected}
            height={listHeight}
            titleWidth={titleWidth}
            hitWidth={hitWidth}
            columns={columns}
            onRowClick={clickRow}
            onRowHover={selectRow}
            onWheel={stepRows}
            {...(contextMenuCapable ? { onRowContextMenu: openRowMenu } : {})}
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
      {menuOverlay}
    </Box>
  )
}
