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
import { compareSessionRecency, type ScanProgress, type ScannedSession, type SessionScanner } from './core/scan.js'
import { PARTIAL_FLUSH_MAX_MS, PARTIAL_FLUSH_MS, type StatusNote } from './find-types.js'

export function useSessionSweep(
  React: TuiSceneProps['React'],
  options: {
    scanner: SessionScanner
    config: ResolvedConfig
    setSessions: (next: readonly ScannedSession[]) => void
    setProgress: (next: ScanProgress | undefined) => void
    setStatus: (next: StatusNote | undefined) => void
  },
): void {
  const { useEffect } = React
  const { scanner, config, setSessions, setProgress, setStatus } = options

  useEffect(() => {
    const signal = new AbortController()
    // Sessions resolved so far, in arrival order. Each onSession callback
    // hands over the exact object the completed sweep's array holds, so the
    // final setSessions below replaces — not duplicates — the accumulation
    // and the search-side per-object fold caches stay warm.
    const partial: ScannedSession[] = []
    let nextFlushAt = 0
    let flushGap = PARTIAL_FLUSH_MS
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
        // sweep never reshuffles what is already on screen. A cold sweep
        // delivers each arrival in its own event-loop turn, and every flush
        // hands the memos a fresh `sessions` identity — one full search over
        // the accumulated prefix, in query mode. So the flush interval
        // doubles with the prefix (the geometric-growth argument): the
        // sweep's total re-search cost stays proportional to a single final
        // search instead of the session count squared, while the header's
        // progress ticks stay per-arrival.
        const now = Date.now()
        if (now < nextFlushAt) return
        nextFlushAt = now + flushGap
        flushGap = Math.min(flushGap * 2, PARTIAL_FLUSH_MAX_MS)
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
}
