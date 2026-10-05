/**
 * The progressive first sweep as a hook: one scanner sweep per mount,
 * aborted when the scene unmounts. The scanner itself is plugin-scoped
 * (main.tsx) — its per-file decode cache survives close/open, so a re-open
 * pays only per-file stats. Results stream in: sessions the scanner
 * resolves join the list in recency-ordered bursts through a doubling
 * flush gap (PARTIAL_FLUSH_MS — a per-arrival flush would re-search the
 * growing list once per session; the geometric gap keeps the sweep's total
 * re-search cost proportional to a single final search), with the header
 * counting the sweep's progress per arrival.
 *
 * @module dsh-tui-find/find-sweep
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import type { ResolvedConfig } from './config.js'
import { compareSessionRecency, type ScanOptions, type ScanProgress, type ScannedSession, type SessionScanner } from './core/scan.js'
import { PARTIAL_FLUSH_MAX_MS, PARTIAL_FLUSH_MS, type StatusNote } from './find-types.js'

/**
 * The scan request one sweep makes, assembled from the row config. Shared by
 * the two sweepers (this scene hook and the sidebar panel's driver): the
 * options decide which sessions and messages even EXIST for a surface, so a
 * drift between them would show the panel a different index than the scene
 * hands over to — the same reason find-rows.ts owns the list shape.
 */
export function buildScanOptions(
  config: ResolvedConfig,
  handlers: {
    readonly signal: AbortSignal
    readonly onProgress: (progress: ScanProgress) => void
    readonly onSession: (session: ScannedSession) => void
  },
): ScanOptions {
  return {
    indexTools: config.indexTools,
    indexThinking: config.indexThinking,
    maxMessageChars: config.maxMessageChars,
    // Delegated sub-agent runs stay out of the list and the search index
    // unless the config asks for them (default off; see config.ts).
    includeSubagents: config.showSubagentSessions,
    ...(config.sessionRoot === undefined ? {} : { sessionRoot: config.sessionRoot }),
    signal: handlers.signal,
    onProgress: handlers.onProgress,
    onSession: handlers.onSession,
  }
}

/**
 * The progressive-flush policy both sweepers publish their streaming list
 * with. Arrivals are enumeration order (readdir); each flush is MRU-sorted —
 * but a LATER arrival can still be more recent than everything already on
 * screen and insert above it, shifting the displayed rows down. That is why
 * both surfaces anchor their selection by `rowId` instead of trusting the
 * index across a flush (REVIEW R-103). A cold sweep delivers each arrival in
 * its own event-loop turn, and every flush hands the search derivation a
 * fresh session-list identity — one full search over the accumulated prefix,
 * in query mode. So the flush interval doubles with the prefix (the
 * geometric-growth argument): the sweep's total re-search cost stays
 * proportional to a single final search instead of the session count squared,
 * while the header's progress ticks stay per-arrival.
 */
export class SessionFlush {
  private readonly partial: ScannedSession[] = []
  private nextFlushAt = 0
  private gap = PARTIAL_FLUSH_MS

  /** Record one arrival and answer what to publish: the accumulated list,
   *  MRU-sorted, when this arrival is due — `undefined` while the gap has not
   *  elapsed. */
  push(session: ScannedSession, now: number = Date.now()): readonly ScannedSession[] | undefined {
    this.partial.push(session)
    if (now < this.nextFlushAt) return undefined
    this.nextFlushAt = now + this.gap
    this.gap = Math.min(this.gap * 2, PARTIAL_FLUSH_MAX_MS)
    return this.settled()
  }

  /** Everything recorded so far, MRU-sorted — the sweep's running list. */
  settled(): readonly ScannedSession[] {
    return [...this.partial].sort(compareSessionRecency)
  }
}

export function useSessionSweep(
  React: TuiSceneProps['React'],
  options: {
    scanner: SessionScanner
    config: ResolvedConfig
    setSessions: (next: readonly ScannedSession[]) => void
    setProgress: (next: ScanProgress | undefined) => void
    setStatus: (next: StatusNote | undefined) => void
    /** Final withheld-sub-agent count. It has to be delivered HERE rather
     *  than read off `progress`: a warm sweep can run to completion inside
     *  one render, so a scene watching `progress` may never observe the last
     *  tick, and the header must keep saying why the list is shorter than
     *  the sweep's own total (REVIEW R-115). */
    setHiddenSubagents: (next: number) => void
    /** The sweep is over — landed or failed. Fired AFTER the final state
     *  updates are scheduled, so a consumer's effect sees the settled list
     *  (the seed handoff's "this row never arrived" decision; R-136). */
    onSettled?: () => void
  },
): void {
  const { useEffect } = React
  const { scanner, config, setSessions, setProgress, setStatus, setHiddenSubagents, onSettled } = options

  useEffect(() => {
    const signal = new AbortController()
    // Each onSession callback hands over the exact objects the completed
    // sweep's array holds, so the final setSessions below replaces — not
    // duplicates — the accumulation and the search-side per-object fold
    // caches stay warm. The publish schedule is {@link SessionFlush}'s.
    const flush = new SessionFlush()
    // The scanner's running withheld-sub-agent count; the last tick (sent
    // after the loop, totals settled) is the sweep's answer.
    let hidden = 0
    const scanOptions = buildScanOptions(config, {
      signal: signal.signal,
      onProgress: (next: ScanProgress) => {
        hidden = next.hiddenSubagents
        setProgress(next)
      },
      onSession: (session: ScannedSession) => {
        const flushed = flush.push(session)
        if (flushed !== undefined) setSessions(flushed)
      },
    })
    void scanner
      .scan(scanOptions)
      .then(result => {
        if (!signal.signal.aborted) {
          setSessions(result)
          setHiddenSubagents(hidden)
          setProgress(undefined)
          onSettled?.()
        }
      })
      .catch((error: unknown) => {
        // An aborted sweep RESOLVES with its partial results; a rejection here
        // is a real failure and must not borrow the "aborted" copy.
        setStatus({
          text: t('scan-failed', { error: error instanceof Error ? error.message : String(error) }),
          tone: 'error',
        })
        // Over either way: nothing more is streaming in.
        onSettled?.()
      })
    return () => {
      signal.abort()
    }
    // Sweep once per mount; config is stable for the scene's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
