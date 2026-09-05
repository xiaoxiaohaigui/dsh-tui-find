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
 * toggles the scope, Alt+R toggles regex matching, Alt+T cycles the time
 * window, Alt+N toggles title-only search, ↑↓/PgUp/PgDn move, Esc backs out
 * one layer (query, then screen).
 * Alt+P opens the session as a scrollable full-conversation reader anchored
 * on the selected hit — ↑↓ step messages, PgUp/PgDn/wheel scroll it, `n`/`N` walk the
 * session's own hits, Alt+C copies the message under the cursor.
 * With an empty query the scene
 * lists recent sessions (most-recent-first, sessions with no conversation
 * excluded, like the browser's empty-session discipline) so /find opens as
 * a live browser, not a dead prompt. Results stream in while the sweep is
 * still running: every session the scanner resolves joins the list at once
 * (recency-ordered), with the header counting the sweep's progress.
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
import { compareSessionRecency, type ScanProgress, type ScannedSession, type SessionScanner } from './core/scan.js'
import { compileRegex, searchSessions, sessionCwdMatches, type MessageHit, type SearchScope, type SessionHit } from './core/search.js'
import { displayWidth, fitScrollWindow, hitLine, spreadRow, tailWidth, truncateWidth } from './width.js'
import {
  buildPreviewLines,
  hitOrdinal,
  jumpHit,
  messageAtLine,
  messageHeaderLine,
  stepMessage,
  unitWeights,
  type PreviewLine,
} from './preview.js'
import { HelpOverlay } from './help.js'
import { useHostDeclaredCursor } from './vendor/host-cursor.js'

/** The host ui kit's component/hook surface, derived from the scene props. */
type Ui = TuiSceneProps['ui']
/** The host's parsed-key flags, derived from the ui kit's own useInput. */
type InputKey = Parameters<Parameters<Ui['useInput']>[0]>[1]
/** The color vocabulary Text accepts (theme keys + raw values). */
type TextColor = NonNullable<React.ComponentProps<Ui['Text']>['color']>

/**
 * The installed dsh-tui 0.9.3 declarations predate `onWheel`, although its
 * runtime dispatcher already routes wheel events to handler props. Keep the
 * widening local to this scene instead of weakening the injected ui surface.
 */
type WheelEventLike = { readonly deltaY: number; readonly deltaX?: number }
type WheelBoxProps = React.ComponentProps<Ui['Box']> & {
  onWheel?: (event: WheelEventLike) => void
}

type Mode = 'list' | 'preview' | 'confirm' | 'help'

/** The time window the list and search filter sessions by — the same
 *  vocabulary as the `defaultTime` config knob (its initial value). */
type TimeFilter = ResolvedConfig['defaultTime']

/** A row of the flattened list. Every row is selectable — a session card
 *  resumes its session, a hit row resumes the session it hit. A card's
 *  title hit rides INSIDE the card's title line (highlighted there, the
 *  browser's own title treatment) and never as a separate row. A results
 *  card also carries its session's own hit list so Alt+P can open the
 *  reader anchored anywhere and `n`/`N` can walk its hits; recent-mode
 *  cards have no SessionHit and set nothing (exactOptionalPropertyTypes). */
type FlatRow =
  | { kind: 'session'; session: ScannedSession; titleHit: MessageHit | undefined; hits?: readonly MessageHit[] }
  | { kind: 'message'; hit: SessionHit; message: MessageHit; index: number; more: number }

/** Vertical chrome of the layout: header + search card (3) + notice +
 *  divider + hints. The list gets whatever remains. */
const CHROME_LINES = 7
/** Hits shown per session card before `(+N)`. */
const PREVIEW_HITS = 3
/** Fixed chrome rows of the preview pane: title + meta + log path + status
 *  + hint. The scroll region gets rows minus these; PgUp/PgDn page by the
 *  same. */
const PREVIEW_CHROME_LINES = 5

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
export function formatWhen(at: number | undefined): string {
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
 * The list hint line: key segments joined by ` · `, fitted to the viewport.
 * A static wide/narrow pair cannot track the actual rendered width (CJK
 * labels, per-language lengths), so the line is composed here: the first and
 * last segments always render, middle segments drop in reverse priority
 * order when the full line would exceed the columns budget.
 */
function composeListHint(columns: number): string {
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
function SearchCard(props: {
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
function HighlightedText(props: {
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

export function wheelStep(deltaY: number, deltaX = 0): -1 | 0 | 1 {
  if (deltaY === 0 || !Number.isFinite(deltaY) || !Number.isFinite(deltaX)) return 0
  return deltaY > 0 ? 1 : -1
}

/** Selection marker shared by title and message rows. Both arrows occupy the
 * first terminal column, while message rows retain their extra two-cell
 * content indent so the list hierarchy remains visible. */
export function selectionMarker(selected: boolean, row: 'title' | 'message' = 'title'): string {
  if (row === 'message') return selected ? '❯   ' : '    '
  return selected ? '❯ ' : '  '
}

export function FindScene(props: TuiSceneProps & {
  config: ResolvedConfig
  /** Plugin-scoped scanner (created in main.tsx): its decode cache outlives the scene. */
  scanner: SessionScanner
  initialQuery: () => string
}): React.ReactElement {
  const { React, ui, channel, close, config, scanner } = props
  const { Box, Text, useInput, useTerminalSize } = ui
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
  const timeFilterRef = useRef(timeFilter)
  timeFilterRef.current = timeFilter
  const useRegexRef = useRef(useRegex)
  useRegexRef.current = useRegex
  const titleOnlyRef = useRef(titleOnly)
  titleOnlyRef.current = titleOnly
  // Locks the resume pipeline so a repeated Enter cannot start the same
  // async operation twice before the mode change renders.
  const actionPendingRef = useRef(false)

  // One sweep per mount: a fresh abort controller, aborted when the scene
  // unmounts. The scanner itself is plugin-scoped (main.tsx) — its per-file
  // decode cache survives close/open, so a re-open pays only per-file stats.
  // Results stream in: every resolved session is folded into the list right
  // away (progressive first sweep) instead of after the whole sweep lands.
  useEffect(() => {
    const signal = new AbortController()
    // Sessions resolved so far, in arrival order. Each onSession callback
    // hands over the exact object the completed sweep's array holds, so the
    // final setSessions below replaces — not duplicates — the accumulation
    // and the search-side per-object fold caches stay warm.
    const partial: ScannedSession[] = []
    const scanOptions = {
      indexTools: config.indexTools,
      indexThinking: config.indexThinking,
      maxMessageChars: config.maxMessageChars,
      ...(config.sessionRoot === undefined ? {} : { sessionRoot: config.sessionRoot }),
      signal: signal.signal,
      onProgress: setProgress,
      onSession: (session: ScannedSession) => {
        partial.push(session)
        // Arrivals are enumeration order; interleaving in the scanner's own
        // recency order keeps the partial list MRU-sorted so the completed
        // sweep never reshuffles what is already on screen.
        setSessions([...partial].sort(compareSessionRecency))
      },
    }
    void scanner
      .scan(scanOptions)
      .then(result => {
        if (!signal.signal.aborted) {
          setSessions(result)
          setProgress(undefined)
        }
      })
      .catch((error: unknown) => {
        // An aborted sweep RESOLVES with its partial results; a rejection here
        // is a real failure and must not borrow the "aborted" copy.
        setStatus({
          text: t('scan-failed', { error: error instanceof Error ? error.message : String(error) }),
          tone: 'error',
        })
      })
    return () => {
      signal.abort()
    }
    // Sweep once per mount; config is stable for the scene's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // ── preview pane (scrollable full-conversation reader) ────────────────
  // The cursor is a LINE index into the preview's flat line list; the
  // window start follows it through fitScrollWindow over 1-weight lines.
  // Both are discarded on exit: every Alt+P re-anchors (the hit message's
  // header line, or the head for cards and title hits), delivered through
  // previewAnchorRef and consumed on the preview's first render.
  const [previewCursor, setPreviewCursor] = useState(0)
  const [previewWindowStart, setPreviewWindowStart] = useState(0)
  const previewAnchorRef = useRef<number | undefined>(undefined)
  const previewSession = useMemo<ScannedSession | undefined>(() => {
    if (mode !== 'preview') return undefined
    const row = selectedRow
    if (row === undefined) return undefined
    return row.kind === 'session' ? row.session : row.hit.session
  }, [mode, selectedRow])
  // The session's own MESSAGE hits: the ◆ markers and the n/N jump table
  // come from them (title hits have no message to anchor or mark). Recent
  // mode has no SessionHit, so a recent card's reader simply has none.
  const previewHits = useMemo<readonly MessageHit[]>(() => {
    const row = selectedRow
    if (mode !== 'preview' || row === undefined) return []
    const source = row.kind === 'message' ? row.hit.hits : (row.hits ?? [])
    return source.filter(entry => entry.kind === 'message')
  }, [mode, selectedRow])
  const previewHitIndices = useMemo(() => {
    const indices = new Set<number>()
    for (const entry of previewHits) {
      if (entry.sourceIndex !== undefined) indices.add(entry.sourceIndex)
    }
    return indices
  }, [previewHits])
  // Hit ranges per message index, for the reader's body highlighting: the
  // session's own message hits keyed by their position in the previewed
  // messages array (a 'message' row contributes its whole session's hits,
  // a card its `hits` field, recent mode nothing). searchSessions emits at
  // most one hit per message, so a plain set is lossless; title hits have
  // no sourceIndex and are skipped.
  const previewRangesByMessage = useMemo(() => {
    const map = new Map<number, readonly (readonly [number, number])[]>()
    for (const entry of previewHits) {
      if (entry.sourceIndex !== undefined) map.set(entry.sourceIndex, entry.ranges)
    }
    return map
  }, [previewHits])
  // Body budget: marker (2) + the deepest continuation indent (4) inside the
  // terminal width, one column of slack — no line can soft-wrap past it.
  const previewBodyWidth = Math.max(1, columns - 5)
  const previewLines = useMemo<PreviewLine[]>(
    () =>
      previewSession === undefined
        ? []
        : buildPreviewLines(previewSession.messages, previewHitIndices, previewBodyWidth, previewRangesByMessage),
    [previewSession, previewHitIndices, previewBodyWidth, previewRangesByMessage],
  )
  const previewWeights = useMemo(() => unitWeights(previewLines.length), [previewLines])
  // jumpHit's table, indexed by message index: the header line of that
  // message when it is a hit, the -1 sentinel when it is not.
  const previewHitStarts = useMemo(() => {
    const table = new Array<number>(previewSession?.messages.length ?? 0).fill(-1)
    for (let at = 0; at < previewLines.length; at++) {
      const line = previewLines[at]
      if (line !== undefined && line.kind === 'header' && line.isHit) table[line.messageIndex] = at
    }
    return table
  }, [previewSession, previewLines])

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
    (entry: {
      readonly role: 'user' | 'assistant' | 'tool' | undefined
      readonly text: string
      readonly at: number | undefined
    }) => {
      const when = entry.at === undefined ? '' : ` ${new Date(entry.at).toISOString()}`
      const role = entry.role === 'user' ? t('role-user') : entry.role === 'assistant' ? t('role-assistant') : t('role-tool')
      const body = `[${role}${when}]\n${entry.text}`
      try {
        copyToClipboard(body, process.stdout)
        setStatus({ text: t('copied', { chars: body.length }), tone: 'info' })
      } catch {
        setStatus({ text: t('copy-failed'), tone: 'error' })
      }
    },
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
      // Letter shortcuts match case-insensitively: Shift+Alt+C arrives as
      // meta + 'C', and the hint lines label the keys as capital letters.
      // The typing path below still consumes the raw input untouched.
      const lower = input.toLowerCase()

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
      if (modeRef.current === 'help') {
        // Alt+H toggles the panel closed (its own row says so); Esc lands in
        // the shared escape branch above. Every other key stays swallowed —
        // the help screen is inert and typing must never leak into the query.
        if (altOnly && lower === 'h') setMode('list')
        return
      }
      if (modeRef.current === 'preview') {
        const lastLine = Math.max(0, previewLines.length - 1)
        if (isPlainReturn(key)) beginResume()
        else if (lower === 'c' && altOnly) {
          // Alt+C copies the message the cursor sits on, whatever line of
          // it (header or body) holds the cursor.
          const entry = previewSession?.messages[messageAtLine(previewLines, previewCursor) ?? 0]
          if (entry !== undefined) copyMessage(entry)
        } else if (key.upArrow) {
          setPreviewCursor(current => stepMessage(previewLines, current, -1))
        } else if (key.downArrow) {
          setPreviewCursor(current => stepMessage(previewLines, current, 1))
        } else if (key.pageUp || key.pageDown) {
          const jump = Math.max(1, rows - PREVIEW_CHROME_LINES)
          setPreviewCursor(current => {
            const next = key.pageUp ? current - jump : current + jump
            return Math.min(lastLine, Math.max(0, next))
          })
        } else if (plain && lower === 'n') {
          // Walk the session's own hits (`n` forward, Shift+n back). A
          // recent-session card has an empty hit table and no-ops silently;
          // a session's hit table is circular, so moving past either end
          // wraps and a non-empty table always yields a target.
          const currentMessage = messageAtLine(previewLines, previewCursor) ?? 0
          const { total } = hitOrdinal(previewHitStarts, currentMessage)
          if (total > 0) {
            const target = jumpHit(previewHitStarts, currentMessage, key.shift ? -1 : 1)!
            setPreviewCursor(target)
            const { index } = hitOrdinal(previewHitStarts, messageAtLine(previewLines, target) ?? 0)
            setStatus({ text: t('preview-hit-jump', { index, total }), tone: 'info' })
          }
        }
        // Every other key stays swallowed: the preview is read-only and
        // typing must never leak back into the query.
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
      if (altOnly && lower === 't') {
        // Cycle the time window: 全部 → 近 7 天 → 近 30 天 → 全部.
        const current = timeFilterRef.current
        const next: TimeFilter = current === 'all' ? '7d' : current === '7d' ? '30d' : 'all'
        timeFilterRef.current = next
        setTimeFilter(next)
        setStatus({
          text: t('time-switched', {
            range: t(next === 'all' ? 'time-all' : next === '7d' ? 'time-7d' : 'time-30d'),
          }),
          tone: 'info',
        })
        return
      }
      if (altOnly && lower === 'r') {
        const next = !useRegexRef.current
        useRegexRef.current = next
        setUseRegex(next)
        setStatus({ text: t(next ? 'regex-on' : 'regex-off'), tone: 'info' })
        return
      }
      if (altOnly && lower === 'n') {
        // Title-only matching: a title hit still highlights inside the
        // card's title line; message rows simply stop matching.
        const next = !titleOnlyRef.current
        titleOnlyRef.current = next
        setTitleOnly(next)
        setStatus({ text: t(next ? 'title-only-on' : 'title-only-off'), tone: 'info' })
        return
      }
      if (isPlainReturn(key)) {
        beginResume()
        return
      }
      // Preview/copy/expand live on Alt+P / Alt+C / Alt+E ONLY. Bare letters
      // always type — a bare-key form fought the first keystroke of every
      // query on a real terminal and was removed in v0.1.2. Alt+P works on
      // cards too (preview from the head of the conversation); Alt+C needs a
      // concrete hit, while Alt+E toggles every message hit on the card.
      if (altOnly && lower === 'p') {
        const row = selectedRow
        if (row !== undefined) {
          // Anchor: a hit row parks the cursor on its own message's header
          // line; a card (or a title hit, which has no message) starts from
          // the head of the conversation.
          previewAnchorRef.current = row.kind === 'message' ? (row.message.sourceIndex ?? -1) : -1
          setMode('preview')
        }
        return
      }
      if (altOnly && lower === 'c') {
        copySelected()
        return
      }
      if (altOnly && lower === 'e') {
        const row = selectedRow
        if (row !== undefined) {
          const id = row.kind === 'message' ? row.hit.session.id : row.session.id
          // Recent-mode cards have no hit bundle, so there is nothing to
          // expand. Result cards and their child rows share one session id.
          const hasHits = row.kind === 'message' || (row.hits !== undefined && row.hits.some(entry => entry.kind === 'message'))
          if (!hasHits) return
          setExpanded(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        return
      }
      if (altOnly && lower === 'h') {
        setMode('help')
        return
      }
      if (key.upArrow) {
        setSelected(current => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelected(current => Math.min(Math.max(0, flat.length - 1), current + 1))
        return
      }
      if (key.pageUp || key.pageDown) {
        const jump = Math.max(1, rows - CHROME_LINES)
        setSelected(current => {
          const next = key.pageUp ? current - jump : current + jump
          return Math.min(Math.max(0, flat.length - 1), Math.max(0, next))
        })
        return
      }
      if (key.backspace || key.delete) {
        // Delete a whole CODE POINT — a UTF-16 code-unit slice would leave a
        // lone surrogate behind after backspacing over an emoji.
        setQuery(current => {
          if (current.length === 0) return current
          const characters = [...current]
          characters.pop()
          return characters.join('')
        })
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

  /** Preview wheel: one line per notch — the cursor is the scroll driver,
   *  the window follows it through fitScrollWindow. */
  const stepPreview = useCallback(
    (event: WheelEventLike) => {
      if (modeRef.current !== 'preview') return
      const by = wheelStep(event.deltaY, event.deltaX)
      if (by === 0) return
      setPreviewCursor(current => {
        const last = Math.max(0, previewLines.length - 1)
        return Math.min(last, Math.max(0, current + by))
      })
    },
    [previewLines.length],
  )

  if (mode === 'help') {
    // Render-only overlay: the keyboard stays with the branches above
    // (Alt+H toggles, Esc returns, everything else is swallowed).
    return <HelpOverlay React={React} ui={ui} columns={columns} rows={rows} />
  }

  if (mode === 'confirm' && resumeTarget !== undefined) {
    const session = resumeTarget
    const working = channel.working
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

  if (mode === 'preview' && selectedRow !== undefined) {
    const session = selectedRow.kind === 'session' ? selectedRow.session : selectedRow.hit.session
    // First render after Alt+P: park the cursor (and the window) on the
    // anchor message's header line — the render-phase adjust pattern the
    // ListView scroll window already uses, so the anchored frame is the
    // committed one and nothing flickers.
    let anchored: number | undefined = previewAnchorRef.current
    if (anchored !== undefined) {
      const start = messageHeaderLine(previewLines, anchored)
      previewAnchorRef.current = undefined
      setPreviewCursor(start)
      setPreviewWindowStart(start)
      anchored = start
    }
    const cursorLine = Math.min(Math.max(0, anchored ?? previewCursor), Math.max(0, previewLines.length - 1))
    const cursorMessage = messageAtLine(previewLines, cursorLine) ?? 0
    const windowPrevious = anchored ?? previewWindowStart
    const view = fitScrollWindow(
      previewWeights,
      cursorLine,
      Math.max(1, rows - PREVIEW_CHROME_LINES),
      windowPrevious,
    )
    if (view.start !== windowPrevious) setPreviewWindowStart(view.start)
    const visible = previewLines.slice(view.start, view.end)
    const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps>
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
        <WheelBox flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" onWheel={stepPreview}>
          {visible.map((line, offset) => {
            const lineAt = view.start + offset
            if (line.kind === 'header') {
              // The header row carries the list's selection vocabulary —
              // marker arrow plus selectionBg for the cursor's message —
              // the ROLE_MARK glyph/colour, and a warning `◆` marking the
              // session's hits (a hit tool row would otherwise share the
              // tool role's own warning colour).
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
                  <Text color={mark.color}>{clippedRole}</Text>
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
                  React={React}
                  ui={ui}
                  text={line.text}
                  ranges={line.ranges}
                  color="warning"
                  width={previewBodyWidth}
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
            <HintLine React={React} ui={ui} text={t('hint-preview')} />
          </Text>
        </Box>
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

/** Physical terminal lines a flat row spends: a session card is the title +
 *  metadata pair, a hit row is exactly one (windowed, non-wrapping) line.
 *  The scroll window is fitted in these units — a row-count window lets the
 *  selection walk off the bottom of a card-heavy list without the page ever
 *  following (the on-device bug). */
function rowLineCount(row: FlatRow): number {
  return row.kind === 'session' ? 2 : 1
}

function ListView(props: {
  React: TuiSceneProps['React']
  ui: TuiSceneProps['ui']
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
