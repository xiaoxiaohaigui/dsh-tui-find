/**
 * Query evaluation over the scanned index: substring matching with the
 * configured case sensitivity (v0.1 default: case-insensitive — instant,
 * zero-dependency, and CJK-correct without a segmenter), per-message
 * highlight ranges, and the two-range session filter.
 *
 * Scope filter mirrors the host's `/resume` project filter semantics
 * (`sessionCwdMatches`): exact cwd match plus subdirectory descendants and
 * the resumed-into-subdirectory inverse, with container boundaries (home,
 * drive roots, UNC share roots) matching only exactly. Comparison follows
 * the platform's filesystem case-insensitivity (Windows folds case).
 *
 * Ordering is most-recent-first (the scanner already yields that order);
 * the sort key here only preserves it deterministically.
 *
 * @module dsh-tui-find/core/search
 */
import { homedir } from 'node:os'
import type { IndexedMessage } from './events.js'
import type { ScannedSession } from './scan.js'

/** A message (or the session title) that matched, with highlight ranges. */
export interface MessageHit {
  readonly kind: 'title' | 'message'
  readonly role: IndexedMessage['role'] | undefined
  readonly seq: number | undefined
  readonly text: string
  readonly at: number | undefined
  /** Half-open [start, end) character ranges to highlight. */
  readonly ranges: readonly (readonly [number, number])[]
  /**
   * Position of the matched message inside `session.messages`; undefined
   * for title hits (which are not in that array). Lets the preview pane
   * anchor context reads without re-matching.
   */
  readonly sourceIndex: number | undefined
}

/** One session's match bundle. */
export interface SessionHit {
  readonly session: ScannedSession
  readonly hits: readonly MessageHit[]
  /** Total match count across messages (title included). */
  readonly total: number
}

export type SearchScope = 'repo' | 'all'

export interface SearchOptions {
  readonly scope: SearchScope
  /**
   * The live channel's cwd. The repo scope matches nothing without it —
   * "this repo" is undefined when there is no cwd, and silently showing
   * every session under that label would be a lie.
   */
  readonly repoCwd?: string
  /** Case-sensitive matching. Default OFF (spec §6 freeze). */
  readonly caseSensitive?: boolean
}

/** Normalize a cwd for comparison: forward slashes, no trailing slash; case
 *  folded when the platform's filesystem semantics are case-insensitive. */
function normalizeCwd(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

const isContainer = (home: string, path: string): boolean =>
  (home !== '' && path === home) ||
  /^[a-z]:$/i.test(path) || // drive root: C:
  /^\/\/[^/]+\/[^/]+$/.test(path) || // UNC share root: //server/share
  /^\/\/\?\/[a-z]:$/i.test(path) || // extended drive root: //?/C:
  /^\/\/\?\/unc\/[^/]+\/[^/]+$/i.test(path) // extended UNC root: //?/UNC/server/share

/**
 * Same-workspace test with the host's exact semantics (see module doc):
 * exact match, subdirectory descendants, the resumed-into-subdirectory
 * inverse, and container boundaries matching only exactly.
 */
export function sessionCwdMatches(
  stateCwd: string,
  headerCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  const cwd = normalizeCwd(stateCwd, caseInsensitive)
  const recorded = normalizeCwd(headerCwd, caseInsensitive)
  if (recorded === '' || cwd === '') return false
  const home = normalizeCwd(homedir(), caseInsensitive)
  if (isContainer(home, cwd) || isContainer(home, recorded)) return recorded === cwd
  return (
    recorded === cwd ||
    recorded.startsWith(`${cwd}/`) ||
    cwd.startsWith(`${recorded}/`)
  )
}

/**
 * Every occurrence of `needle` in `haystack`, returning ranges over the
 * ORIGINAL string.
 *
 * Case-insensitive matching cannot simply fold the haystack once and index
 * into it: a fold that changes length (e.g. U+0130 `İ` folds to two code
 * units) shifts every later offset. Instead the haystack is folded code
 * point by code point while recording, for each folded unit, the original
 * span it came from — matches found in the folded string are mapped back
 * onto exact original ranges.
 *
 * @param haystack - Original text.
 * @param needle - The already-folded needle (`toLowerCase`d by the caller
 *   when matching is case-insensitive; verbatim otherwise).
 * @param caseSensitive - Match without folding.
 */
export function matchRanges(
  haystack: string,
  needle: string,
  caseSensitive = false,
): [number, number][] {
  if (needle.length === 0) return []

  // Fold per code point, remembering each folded unit's original span.
  let folded = ''
  const spans: Array<[number, number]> = []
  if (caseSensitive) {
    folded = haystack
    for (let index = 0; index < haystack.length; index++) spans.push([index, index + 1])
  } else {
    let at = 0
    for (const char of haystack) {
      const lower = char.toLowerCase()
      for (let unit = 0; unit < lower.length; unit++) spans.push([at, at + char.length])
      folded += lower
      at += char.length
    }
  }

  const ranges: [number, number][] = []
  let searchFrom = 0
  for (;;) {
    const found = folded.indexOf(needle, searchFrom)
    if (found === -1) break
    const spanStart = spans[found]
    const spanEnd = spans[found + needle.length - 1]
    if (spanStart !== undefined && spanEnd !== undefined) {
      ranges.push([spanStart[0], spanEnd[1]])
    }
    searchFrom = found + needle.length
  }
  return ranges
}

/**
 * Run one query over the index.
 *
 * A session matches when its title or any indexed message contains the
 * query; matching messages carry highlight ranges over the original text.
 * Sessions arrive in most-recent-first order and that order is preserved.
 * The empty query matches nothing by design — the scene renders the recent
 * list instead — and the repo scope matches nothing without a cwd.
 *
 * @param sessions - The scanned index (order preserved by the caller).
 * @param query - Raw user input (trimmed here).
 * @param options - Scope and sensitivity configuration.
 */
export function searchSessions(
  sessions: readonly ScannedSession[],
  query: string,
  options: SearchOptions,
): SessionHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const caseSensitive = options.caseSensitive === true
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase()

  // "This repo" with no cwd to compare against matches nothing.
  const repoCwd = options.repoCwd ?? ''
  if (options.scope === 'repo' && repoCwd.trim().length === 0) {
    return []
  }

  const hits: SessionHit[] = []
  for (const session of sessions) {
    if (options.scope === 'repo' && !sessionCwdMatches(repoCwd, session.header.cwd ?? '')) {
      continue
    }

    const messageHits: MessageHit[] = []
    let total = 0

    const titleRanges = matchRanges(session.title ?? '', needle, caseSensitive)
    if (titleRanges.length > 0) {
      messageHits.push({
        kind: 'title',
        role: undefined,
        seq: undefined,
        text: session.title ?? '',
        at: undefined,
        ranges: titleRanges,
        sourceIndex: undefined,
      })
      total += titleRanges.length
    }

    for (const [sourceIndex, message] of session.messages.entries()) {
      const ranges = matchRanges(message.text, needle, caseSensitive)
      if (ranges.length === 0) continue
      messageHits.push({
        kind: 'message',
        role: message.role,
        seq: message.seq,
        text: message.text,
        at: message.at,
        ranges,
        sourceIndex,
      })
      total += ranges.length
    }

    if (messageHits.length > 0) {
      hits.push({ session, hits: messageHits, total })
    }
  }
  return hits
}
