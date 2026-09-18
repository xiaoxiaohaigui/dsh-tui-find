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
 * derivations, and delegates to the find-* siblings — find-input.ts (the
 * keyboard dispatcher: typing always edits the query; Enter opens the
 * resume confirm, Tab toggles the scope, Alt+R regex, Alt+T time window,
 * Alt+N title-only, ↑↓/PgUp/PgDn move, Esc backs out one layer; Alt+P opens
 * the scrollable conversation reader, Alt+C copies, Alt+E expands; Alt+H
 * help), find-sweep.ts (the progressive scan hook that streams sessions in),
 * find-menu.ts (the right-click menu's pure model), find-preview.tsx (the
 * reader pane and its model), find-list.tsx (the two-line-per-session
 * list), find-chrome.tsx (search card, hints, confirm pane), find-types.ts
 * (shared vocabulary).
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
  PREVIEW_CHROME_LINES,
  PREVIEW_HITS,
  PANE_CHROME_LINES,
  hasTerminalImageHooks,
  splitLayout,
  wheelRows,
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
  highlightAt,
  highlightedItem,
  moveHighlight,
  openMenu,
  type ContextMenuState,
  type MenuItem,
} from './find-menu.js'
import { ConfirmPane, HintLine, SearchCard, composeListHint } from './find-chrome.js'
import { ListView } from './find-list.js'
import { PreviewPane, ReaderPane, usePreviewModel } from './find-preview.js'
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

/** The session a list row belongs to — both row kinds carry one. */
function rowSession(row: FlatRow): ScannedSession {
  return row.kind === 'session' ? row.session : row.hit.session
}

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

  // The reader's geometry, decided once per render: the split layout is a
  // config choice gated by terminal width (narrow crossings fall back to the
  // classic rendering with no notice and no state), and both shapes budget
  // the reader's wrap width and scroll viewport off their own surface.
  const listHeight = Math.max(2, rows - CHROME_LINES)
  const layout = splitLayout(columns)
  const splitActive = config.layout !== 'classic' && layout.split
  const readerActive = splitActive ? mode === 'list' || mode === 'preview' : mode === 'preview'
  const readerActiveRef = useRef(readerActive)
  readerActiveRef.current = readerActive
  // Split body budget: the bordered pane's interior is paneWidth - 4; the
  // classic budget (marker 2 / deepest continuation indent 4 / one column
  // of slack) applies to that interior, i.e. paneWidth - 9 overall.
  const readerBodyWidth = splitActive ? Math.max(1, layout.paneWidth - 9) : Math.max(1, columns - 5)
  const readerViewport = splitActive
    ? Math.max(1, listHeight - PANE_CHROME_LINES)
    : Math.max(1, rows - PREVIEW_CHROME_LINES)

  const {
    windowStart: previewWindowStart,
    windowEnd: previewWindowEnd,
    setWindowStart: setPreviewWindowStart,
    anchorRef: previewAnchorRef,
    session: previewSession,
    hitStarts: previewHitStarts,
    lines: previewLines,
    bodyWidth: previewBodyWidth,
    stepByWheel: stepPreview,
    // The anchor consumption and window following run inside usePreviewModel,
    // i.e. during THIS component's render — the render-phase adjust pattern
    // is legal on a component's own state, so the panes stay pure display
    // (a child writing the parent's state mid-render warns and is
    // concurrency-unsafe; see REVIEW R-039).
  } = usePreviewModel(React, {
    readerActive,
    readerActiveRef,
    // Split anchors the reader to the list selection (deduplicated inside
    // the model); classic keeps the Alt+P anchorRef path.
    selectionAnchored: splitActive,
    selectedRow,
    bodyWidth: readerBodyWidth,
    viewportHeight: readerViewport,
  })

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
   *  the preview's Alt+C copies the message at the top of its window — same
   *  shape, so both feed this one builder. */
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
    // Mirror write first: Enter's call sites sit inside the keyboard
    // dispatcher's batch, and a later key of the same stdin chunk reads
    // modeRef to pick its branch — render-time sync alone leaves that key
    // on the stale mode (the Esc-after-Enter chunk fell through to the
    // list-mode Esc and closed the whole scene; REVIEW R-055).
    modeRef.current = 'confirm'
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
  // Menu mutators write menuRef before setState: a merged stdin block runs
  // the handler once per key inside one batch, and Enter's activateMenu
  // reads the mirror — render-time sync alone would activate the highlight
  // the block's earlier keys moved away from (REVIEW R-054).
  const closeMenu = useCallback(() => {
    menuRef.current = undefined
    setMenu(undefined)
  }, [])
  const moveMenuHighlight = useCallback((delta: number) => {
    const current = menuRef.current
    if (current === undefined) return
    const next = moveHighlight(current, delta)
    menuRef.current = next
    setMenu(next)
  }, [])
  /** The mouse path over the open menu's rows — hover moves the highlight,
   *  mirroring the list's own hover-moves-focus rule. */
  const hoverMenuHighlight = useCallback((index: number) => {
    const current = menuRef.current
    if (current === undefined) return
    const next = highlightAt(current, index)
    menuRef.current = next
    setMenu(next)
  }, [])
  const activateMenu = useCallback(() => {
    const current = menuRef.current
    if (current === undefined) return
    const item = highlightedItem(current)
    if (item === undefined) return
    menuRef.current = undefined
    setMenu(undefined)
    item.action()
  }, [])

  /** Whether the rendered list column answers the pointer right now: list
   *  focus in both layouts, plus the split reader focus — the list stays
   *  visible there and already answers the wheel (stepRows), so hover,
   *  click and the row menu answer it too (REVIEW R-056). The classic
   *  preview and the confirm/help screens render no list at all, so the
   *  mode gate is defense-in-depth there. */
  const listPointerLive = useCallback(() => {
    if (actionPendingRef.current) return false
    return modeRef.current === 'list' || (splitActive && modeRef.current === 'preview')
  }, [splitActive])

  /** Right-click on a list row: the row selects (mirroring hover), and the
   *  menu offers the row's vocabulary — a hit row adds its message copy; a
   *  card offers path + resume. Resume mirrors Enter (the confirm pane). */
  const openRowMenu = useCallback(
    (rowIndex: number, event: ContextMenuEventLike) => {
      if (!listPointerLive()) return
      const row = flat[rowIndex]
      if (row === undefined) return
      const session = rowSession(row)
      const items: SceneMenuItem[] = []
      if (row.kind === 'message') {
        items.push({ id: 'copy-message', label: t('menu-copy-message'), action: () => copyMessage(row.message) })
      }
      items.push(
        { id: 'copy-log', label: t('menu-copy-log'), action: () => copySessionPath(session) },
        {
          id: 'resume',
          // Resume the session the menu was OPENED on, not whatever row
          // occupies that index when the item activates — a background sweep
          // flush can reshuffle or shrink the list while the menu sits open.
          // The row is re-located by session id at activation time; a session
          // no longer listed has nothing to confirm, so the item no-ops.
          label: t('menu-resume'),
          action: () => {
            const at = flat.findIndex(candidate => rowSession(candidate).id === session.id)
            if (at === -1) return
            setSelected(at)
            modeRef.current = 'confirm'
            setMode('confirm')
          },
        },
      )
      setSelected(rowIndex)
      const opened = openMenu(event.col, event.row, items)
      menuRef.current = opened
      setMenu(opened)
    },
    [flat, copyMessage, copySessionPath, listPointerLive],
  )

  /** Right-click in the reader: copy the message under the POINTER (the
   *  WheelBox's local row maps through the scroll window to a message). The
   *  pane is up in both split focus states, so the split gate is the pane's
   *  visibility, not which side holds the keyboard. */
  const openPreviewMenu = useCallback(
    (event: ContextMenuEventLike) => {
      if (actionPendingRef.current) return
      if (!splitActive && modeRef.current !== 'preview') return
      const session = previewSession
      if (session === undefined) return
      const lineAt = previewWindowStart + event.localRow
      const messageIndex = messageAtLine(previewLines, lineAt)
      const message = messageIndex === undefined ? undefined : session.messages[messageIndex]
      if (message === undefined) return
      const opened = openMenu(event.col, event.row, [
        { id: 'copy-message', label: t('menu-copy-message'), action: () => copyMessage(message) },
      ])
      menuRef.current = opened
      setMenu(opened)
    },
    [previewSession, previewLines, previewWindowStart, copyMessage, splitActive],
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
    setPreviewWindowStart,
    setStatus,
    closeMenu,
    moveMenuHighlight,
    activateMenu,
    flatLength: flat.length,
    rows,
    // Split focus handoff for ←/→, and the reader-side page jump (the
    // classic full-screen pane and the split pane have different viewports).
    splitActive,
    previewPageJump: readerViewport,
    selectedRow,
    previewLines,
    // The window's own position: with no reader cursor left, this is what
    // ↑↓/PgUp/PgDn/n/N act on and Alt+C refers to (the end is what keeps n/N
    // from re-targeting a hit that is already on screen).
    previewWindowStart,
    previewWindowEnd,
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

  // Left-column width parameters: derived from the list column (the whole
  // viewport in classic), keeping every row's content inside its surface
  // even when the viewport is narrower than the desktop prefix budget.
  const titleWidth = Math.max(1, Math.min(48, (splitActive ? layout.listWidth : columns) - 4))
  const hitWidth = Math.max(1, (splitActive ? layout.listWidth : columns) - 4)
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

  const listHint = composeListHint(columns, splitActive)

  // The open menu's overlay: a full-viewport click-catcher (click/right-click
  // anywhere outside closes) plus the clamped anchored panel — as SIBLINGS,
  // deliberately not nested. Any menu-internal change (hover moving the
  // highlight, keyboard ↑↓) dirties every DOM ancestor of the changed row,
  // and a dirty full-viewport absolute node makes the host renderer damage
  // the entire screen for that frame: the node's own clear is recorded as an
  // absolute clear, which suppresses every clean subtree's prevScreen blit
  // row-wise, and the frame outside the menu comes up empty (the 0.10.1
  // real-machine white-screen). As siblings the dirty chain stops at the
  // panel — the backdrop stays clean and its blit is a harmless copy.
  // The panel is `opaque`: the host fills its interior with blank cells
  // before the items paint, so the list text underneath cannot bleed
  // through between the labels. Highlight rides the ROW box (the list's own
  // selected-row idiom): the host's box fill spans the full interior width,
  // and hover moves it like the list does. The panel's width budget mirrors
  // the list's own truncation discipline.
  const menuOverlay = (() => {
    if (menu === undefined) return undefined
    const MenuBox = Box as unknown as React.ComponentType<ContextBoxProps>
    const width =
      menu.items.length === 0 ? 0 : Math.max(...menu.items.map(item => displayWidth(item.label))) + 4
    const left = Math.max(0, Math.min(menu.anchorCol, Math.max(0, columns - width - 1)))
    const top = Math.max(0, Math.min(menu.anchorRow, Math.max(0, rows - menu.items.length - 3)))
    return (
      <>
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
        />
        <MenuBox
          position="absolute"
          top={top}
          left={left}
          flexDirection="column"
          borderStyle="round"
          opaque
          onClick={event => event.stopImmediatePropagation()}
          onContextMenu={event => event.stopImmediatePropagation()}
        >
          {menu.items.map((item, index) => (
            <MenuBox
              key={item.id}
              flexShrink={0}
              {...(index === menu.highlight ? { backgroundColor: 'selectionBg' as const } : {})}
              onMouseEnter={() => hoverMenuHighlight(index)}
              onClick={event => {
                event.stopImmediatePropagation()
                closeMenu()
                item.action()
              }}
            >
              <Text>{` ${item.label} `}</Text>
            </MenuBox>
          ))}
        </MenuBox>
      </>
    )
  })()

  /** Mouse selection mirrors the browser: hover moves focus. */
  const selectRow = useCallback(
    (rowIndex: number) => {
      if (!listPointerLive()) return
      setSelected(Math.min(Math.max(0, rowIndex), Math.max(0, flat.length - 1)))
      setStatus(undefined)
    },
    [flat.length, listPointerLive],
  )
  /** A row click follows the browser's open path, including confirmation. */
  const clickRow = useCallback(
    (rowIndex: number) => {
      if (!listPointerLive()) return
      const row = flat[rowIndex]
      if (row === undefined) return
      setSelected(rowIndex)
      setStatus(undefined)
      modeRef.current = 'confirm'
      setMode('confirm')
    },
    [flat, listPointerLive],
  )
  const stepRows = useCallback(
    (event: WheelEventLike) => {
      // No mode gate: the wheel is area-local (the pane scrolls itself via
      // stepPreview), and in the split layout the list must keep answering
      // the wheel while the reader holds the keyboard focus. While a menu
      // stands the backdrop consumes pointer events anyway, and outside the
      // list modes the list box is not rendered at all. One notch moves the
      // selection by the event's own row count (the host's ±3 convention),
      // not a single row.
      if (actionPendingRef.current || flat.length === 0) return
      const by = wheelRows(event.deltaY, event.deltaX)
      if (by === 0) return
      setSelected(current => Math.min(Math.max(0, flat.length - 1), Math.max(0, current + by)))
    },
    [flat.length],
  )

  // The content body shared by both roots: the reading notice while a sweep
  // is in flight and nothing has been resolved yet — a query-mode user must
  // not see "no matching sessions" for what is only the scan's head of line
  // (results stream in as sessions resolve) — the empty states, or the list
  // windowed to the content row.
  const listBody =
    progress !== undefined && sessions.length === 0 ? (
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
        width={splitActive ? layout.listWidth : columns}
        onRowClick={clickRow}
        onRowHover={selectRow}
        onWheel={stepRows}
        {...(contextMenuCapable ? { onRowContextMenu: openRowMenu } : {})}
      />
    )

  // Footer chrome shared by both roots: the notice slot keeps mutation
  // feedback from shifting the list under the cursor, then one divider and
  // the dim-italic hint line.
  const noticeRow = (
    <Box flexShrink={0}>
      <Text color={status?.tone === 'error' ? 'error' : 'success'}>
        {status === undefined
          ? ' '
          : ` ${status.tone === 'error' ? '✕' : '✔'} ${truncateWidth(status.text, Math.max(0, columns - 6))}`}
      </Text>
    </Box>
  )
  const dividerRow = (
    <Box flexShrink={0}>
      <Text dimColor>{'─'.repeat(Math.max(0, columns - 1))}</Text>
    </Box>
  )
  const hintRow = (text: string) => (
    <Box flexShrink={0}>
      <Text dimColor italic>
        {' '}
        <HintLine React={React} ui={ui} text={text} />
      </Text>
    </Box>
  )

  if (mode === 'help') {
    // Render-only overlay: the keyboard stays with the find-input branches
    // (Alt+H toggles, Esc returns, everything else is swallowed).
    return <HelpOverlay React={React} ui={ui} columns={columns} rows={rows} splitActive={splitActive} />
  }

  if (mode === 'confirm' && resumeTarget !== undefined) {
    return <ConfirmPane React={React} ui={ui} session={resumeTarget} working={channel.working} columns={columns} />
  }

  if (!splitActive && mode === 'preview' && selectedRow !== undefined) {
    const session = selectedRow.kind === 'session' ? selectedRow.session : selectedRow.hit.session
    return (
      <>
        <PreviewPane
          React={React}
          ui={ui}
          session={session}
          lines={previewLines}
          bodyWidth={previewBodyWidth}
          windowStart={previewWindowStart}
          windowEnd={previewWindowEnd}
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

  if (splitActive) {
    // The split root: header + search card + the content row — left list
    // column and bordered reader pane side by side, the pane's own round
    // frame separating the two (no gap column) — then the shared footer.
    // The reader is visible in BOTH focus states: mode only says which side
    // owns the keyboard, so the hint line switches vocabulary with it.
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
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          <Box flexDirection="column" width={layout.listWidth} flexShrink={0}>
            {listBody}
          </Box>
          {previewSession !== undefined && (
            <ReaderPane
              React={React}
              ui={ui}
              session={previewSession}
              lines={previewLines}
              windowStart={previewWindowStart}
              windowEnd={previewWindowEnd}
              paneWidth={layout.paneWidth}
              bodyWidth={previewBodyWidth}
              // One lit surface per screen: the frame is the pane's only
              // focus cue (the reader carries no selection vocabulary), so
              // it undims exactly while the reader owns the keyboard.
              focused={mode === 'preview'}
              onWheel={stepPreview}
              {...(contextMenuCapable ? { onContextMenu: openPreviewMenu } : {})}
            />
          )}
        </Box>
        {noticeRow}
        {dividerRow}
        {hintRow(mode === 'preview' ? t('hint-preview-split') : listHint)}
        {menuOverlay}
      </Box>
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
        {listBody}
      </Box>
      {noticeRow}
      {dividerRow}
      {hintRow(listHint)}
      {menuOverlay}
    </Box>
  )
}
