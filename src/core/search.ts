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
  /**
   * Time window: only sessions whose log was modified at or after this
   * epoch-ms participate (the scene's time filter). The comparison is
   * inclusive — a session modified exactly at the cutoff passes. Undefined
   * disables the filter.
   */
  readonly sinceMs?: number
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
 * A case-folded text plus the mapping needed to translate a match found in
 * the folded string back onto exact original ranges.
 *
 * Case-insensitive matching cannot simply fold the haystack once and index
 * into it: a fold that changes length (e.g. U+0130 `İ` folds to two code
 * units) shifts every later offset. The fold is therefore built per code
 * point with two prefix tables — `cumUnits[c]` counts the folded UTF-16
 * units produced by the first `c` code points, `cpStart[c]` is the code
 * point's UTF-16 start in the original text — so a folded index maps back
 * onto its original span with a binary search. This costs ~8 bytes per code
 * point instead of one heap tuple per unit, which is what makes caching the
 * fold across keystrokes affordable.
 */
interface FoldedText {
  readonly folded: string
  readonly cumUnits: Uint32Array
  readonly cpStart: Uint32Array
  /** Original text length the fold was built from (staleness guard). */
  readonly sourceLength: number
}

/** Build the fold of one text. */
function buildFold(text: string): FoldedText {
  const characters = [...text]
  const cpStart = new Uint32Array(characters.length + 1)
  const cumUnits = new Uint32Array(characters.length + 1)
  let folded = ''
  let utf16 = 0
  let units = 0
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index]!
    cpStart[index] = utf16
    utf16 += char.length
    const lower = char.toLowerCase()
    folded += lower
    units += lower.length
    cumUnits[index + 1] = units
  }
  cpStart[characters.length] = utf16
  return { folded, cumUnits, cpStart, sourceLength: text.length }
}

/**
 * The fold is a pure function of the text, and scanned texts are stable
 * objects held alive by the scanner's cache — so one WeakMap entry per
 * message (and per session title) lets every keystroke after the first
 * search against a session skip the fold entirely. Rebuilding per call was
 * the dominant per-keystroke cost on large indexes.
 */
const foldCache = new WeakMap<object, FoldedText>()

function foldOf(owner: object, text: string): FoldedText {
  const cached = foldCache.get(owner)
  if (cached !== undefined && cached.sourceLength === text.length) return cached
  const built = buildFold(text)
  foldCache.set(owner, built)
  return built
}

/** The code point a folded UTF-16 index belongs to (binary search). */
function charOfUnit(fold: FoldedText, unit: number): number {
  let low = 0
  let high = fold.cumUnits.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (fold.cumUnits[mid]! <= unit) low = mid + 1
    else high = mid
  }
  return low - 1
}

/** Every occurrence of `needle` in a fold, as ranges over the ORIGINAL text. */
function rangesInFold(fold: FoldedText, needle: string): [number, number][] {
  const ranges: [number, number][] = []
  let searchFrom = 0
  for (;;) {
    const found = fold.folded.indexOf(needle, searchFrom)
    if (found === -1) break
    const startChar = charOfUnit(fold, found)
    const endChar = charOfUnit(fold, found + needle.length - 1)
    ranges.push([fold.cpStart[startChar]!, fold.cpStart[endChar + 1]!])
    searchFrom = found + needle.length
  }
  return ranges
}

/**
 * Every occurrence of `needle` in `haystack`, returning ranges over the
 * ORIGINAL string.
 *
 * The case-insensitive path folds per code point (see {@link FoldedText});
 * the case-sensitive path is a direct scan. Standalone calls build the fold
 * per invocation — hot paths should go through `foldOf` instead.
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
  if (caseSensitive) {
    const ranges: [number, number][] = []
    let searchFrom = 0
    for (;;) {
      const found = haystack.indexOf(needle, searchFrom)
      if (found === -1) break
      ranges.push([found, found + needle.length])
      searchFrom = found + needle.length
    }
    return ranges
  }
  return rangesInFold(buildFold(haystack), needle)
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
 * @param options - Scope, sensitivity and time-window configuration.
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
    if (options.sinceMs !== undefined && session.modifiedAt < options.sinceMs) {
      continue
    }

    const messageHits: MessageHit[] = []
    let total = 0

    // Title and message folds are cached per object (see foldOf) — across
    // keystrokes only the indexOf scan repeats, never the fold.
    const titleRanges =
      session.title === undefined
        ? []
        : caseSensitive
          ? matchRanges(session.title, needle, true)
          : rangesInFold(foldOf(session, session.title), needle)
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
      const ranges = caseSensitive
        ? matchRanges(message.text, needle, true)
        : rangesInFold(foldOf(message, message.text), needle)
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
