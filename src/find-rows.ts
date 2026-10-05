/**
 * The list both find surfaces draw from: the search-option assembly and the
 * flat row model, as pure functions with no React and no host types.
 *
 * The scene (`scene.tsx`) and the sidebar panel (`panel.tsx`) ask different
 * containers for their state — a full-screen scene owns hook state, the panel
 * owns a plugin-scoped store — but they must show the SAME list for the same
 * query, or the sidebar's "open in /find" handoff would land the user on a
 * row the panel never showed. Everything that decides which sessions match,
 * which hits survive, and how they flatten into rows therefore lives here
 * once. Extracted from the scene verbatim (REVIEW-free refactor): the row
 * ids, the fold badge placement and the recent-mode filter are the parts
 * tests pin.
 *
 * @module dsh-tui-find/find-rows
 */

import type { ResolvedConfig } from './config.js'
import { PREVIEW_HITS, type FlatRow, type TimeFilter } from './find-types.js'
import { sessionCwdMatches, type SearchOptions, type SearchScope, type SessionHit } from './core/search.js'
import type { ScannedSession } from './core/scan.js'

/**
 * The time window's cutoff, quantized to the minute: renders within the same
 * minute share one cutoff, so the derived-list memos stay stable across
 * direction-key steps, toasts and progress ticks instead of re-searching on
 * every render — while a surface that sits open still crosses its own window
 * boundary on the first render after the minute flips (the boundary can trail
 * the exact one by up to a minute).
 */
export function sinceMsFor(timeFilter: TimeFilter, now: number = Date.now()): number | undefined {
  if (timeFilter === 'all') return undefined
  return Math.floor(now / 60_000) * 60_000 - (timeFilter === '7d' ? 7 : 30) * 86_400_000
}

/**
 * The core search options one surface's controls ask for. `useRegex` and
 * `titleOnly` are parameters rather than config reads because the scene's
 * Alt+R / Alt+N toggles override the config defaults per session; the panel
 * passes the config values straight through (Ctrl/Alt chords never reach a
 * sidebar panel, so it has no toggles of its own — see panel.tsx).
 */
export function buildSearchOptions(
  config: ResolvedConfig,
  controls: {
    readonly scope: SearchScope
    readonly repoCwd: string | undefined
    readonly useRegex: boolean
    readonly titleOnly: boolean
    readonly sinceMs: number | undefined
  },
): SearchOptions {
  return {
    scope: controls.scope,
    // Spread-conditionally: exactOptionalPropertyTypes rejects an explicit
    // `undefined` for an optional field, and the two surfaces genuinely
    // differ here (a scene always has a cwd; a panel may not).
    ...(controls.repoCwd === undefined ? {} : { repoCwd: controls.repoCwd }),
    caseSensitive: config.caseSensitive,
    ...(config.pinyin ? { pinyin: true } : {}),
    ...(controls.useRegex ? { regex: true } : {}),
    ...(controls.titleOnly ? { titleOnly: true } : {}),
    ...(controls.sinceMs === undefined ? {} : { sinceMs: controls.sinceMs }),
  }
}

/** The session a list row belongs to — both row kinds carry one. */
export function rowSession(row: FlatRow): ScannedSession {
  return row.kind === 'session' ? row.session : row.hit.session
}

/**
 * Flatten hits (or, in recent mode, the sweep's own list) into rows. Recent
 * mode lists every session that holds conversation content (the scanner's MRU
 * order), narrowed by the time window; results mode groups hits per session —
 * the title hit (if any) rides the card's title line, message hits render
 * under the card.
 */
export function buildRows(options: {
  readonly sessions: readonly ScannedSession[]
  readonly hits: readonly SessionHit[]
  readonly recentMode: boolean
  readonly scope: SearchScope
  /** The cwd the repo scope (and the recent-mode filter) compares against. */
  readonly repoCwd: string | undefined
  readonly sinceMs: number | undefined
  /** Session ids whose hit rows are fully expanded. */
  readonly expanded: ReadonlySet<string>
}): FlatRow[] {
  const { sessions, hits, recentMode, scope, repoCwd, sinceMs, expanded } = options
  if (recentMode) {
    return sessions
      .filter(
        session =>
          session.messages.length > 0 &&
          (scope === 'all' || sessionCwdMatches(repoCwd ?? '', session.header.cwd ?? '')) &&
          (sinceMs === undefined || session.modifiedAt >= sinceMs),
      )
      .map(session => ({ kind: 'session' as const, session, titleHit: undefined, rowId: `s:${session.id}` }))
  }
  const rows: FlatRow[] = []
  for (const hit of hits) {
    const titleHit = hit.hits.find(entry => entry.kind === 'title')
    const messageHits = hit.hits.filter(entry => entry.kind === 'message')
    const isExpanded = expanded.has(hit.session.id)
    const shown = isExpanded ? messageHits.length : Math.min(PREVIEW_HITS, messageHits.length)
    rows.push({
      kind: 'session',
      session: hit.session,
      titleHit,
      hits: hit.hits,
      hitTotal: hit.total,
      rowId: `s:${hit.session.id}`,
    })
    // The fold badge belongs to the final visible hit row only, and only
    // when the card actually has hidden hits or shows them under a state
    // the badge can leave: attaching it to every row would repeat the same
    // (+N) on the card, and a card with nothing to fold carries no control
    // to click. A card whose hits are all visible WITHOUT an expand-state
    // (≤ PREVIEW_HITS) is the third case: there is no fold at all.
    const foldable = messageHits.length > PREVIEW_HITS
    for (let index = 0; index < shown; index++) {
      const message = messageHits[index]!
      rows.push({
        kind: 'message',
        hit,
        message,
        index,
        // Identity is the matched MESSAGE, not the row the fold happens to
        // put it on: folding moves this row without moving the message (see
        // FlatRow). sourceIndex is set for every message hit — only title
        // hits leave it undefined, and they never become rows — so the
        // ordinal is a defensive fallback, not a second identity rule.
        rowId: `m:${hit.session.id}:${message.sourceIndex ?? index}`,
        fold:
          foldable && index === shown - 1
            ? { hidden: messageHits.length - shown, expanded: isExpanded }
            : undefined,
      })
    }
  }
  return rows
}
