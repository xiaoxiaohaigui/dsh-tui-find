/**
 * Query evaluation over the scanned index: whitespace-separated terms
 * matched per document — a session title or one indexed message must
 * contain EVERY term (fzf-style AND; a double-quoted fragment is one term
 * whose inner spaces are literal) — with the configured case sensitivity
 * (v0.1 default: case-insensitive — instant, zero-dependency, and
 * CJK-correct without a segmenter), an optional JavaScript-regex mode over
 * the same index (v0.2 toggle, compiled once per query and deliberately
 * NOT term-split: inside a regex a space is pattern syntax, not a
 * separator, so splitting would be ambiguous), the optional time window
 * over session modification times, and per-message highlight ranges.
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
  /**
   * Half-open [start, end) character ranges to highlight — sorted and
   * disjoint (a multi-term hit carries the merged union of its terms'
   * ranges).
   */
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
  /**
   * Total match count across messages (title included), counting the
   * merged highlight spans — the segments the renderer actually draws.
   */
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
  /**
   * Treat the (trimmed) query as a JavaScript regular expression instead of
   * the per-term literal substring match (v0.2's regex toggle over the
   * substring baseline). The pattern is the WHOLE query — regex mode never
   * splits on whitespace, because inside a regex a space is pattern syntax
   * rather than a term separator and splitting would be ambiguous. Case
   * sensitivity still applies: insensitive matching compiles with the `i`
   * flag. An uncompilable pattern matches nothing here — the scene
   * surfaces the invalid-pattern notice through {@link compileRegex}, the
   * one compilation both paths share.
   */
  readonly regex?: boolean
}

/** Synchronous regex matching policy: reject patterns whose worst-case
 *  backtracking is easy to identify before native RegExp can block the UI. */
export const MAX_REGEX_PATTERN_LENGTH = 512
const UNSAFE_REGEX_PATTERNS = [
  /\\\d/u, // backreferences
  /\([^)]*[+*][^)]*\)[+*?]/u, // quantified groups containing quantifiers
  /\([^)]*\|[^)]*\)[+*?]/u, // quantified alternation groups
  /\)[{]/u, // any group quantified with a {n,m} brace (e.g. the (a+){2,} blowup)
]

export function isRegexAllowed(query: string): boolean {
  return query.length <= MAX_REGEX_PATTERN_LENGTH && !UNSAFE_REGEX_PATTERNS.some(pattern => pattern.test(query))
}

/**
 * Compile the query into the RegExp the regex path matches with: the `g`
 * Exported because the scene needs the same validity verdict for its
 * invalid-pattern notice — one compiler, so the two can never disagree.
 */
export function compileRegex(query: string, caseSensitive: boolean): RegExp | undefined {
  if (!isRegexAllowed(query)) return undefined
  try {
    return new RegExp(query, caseSensitive ? 'g' : 'gi')
  } catch {
    return undefined
  }
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
 * Every match of `pattern` in `text`, as ranges over the original text.
 * The pattern is the shared compiled query (`g` flag), so `lastIndex` is
 * reset per text. A zero-width match advances one code unit instead of
 * being recorded — the guard that keeps patterns like `a*` from looping
 * forever (and an empty highlight span renders nothing anyway). The flags
 * lack `u`, so a match may open or close inside a surrogate pair; such an
 * edge is widened onto the whole code point (unpairable lone units at the
 * string edges stay as they are) and a widened match folded into the
 * previous range, keeping the output disjoint like `matchRanges` does.
 */
function regexRanges(pattern: RegExp, text: string): [number, number][] {
  const ranges: [number, number][] = []
  pattern.lastIndex = 0
  for (;;) {
    const match = pattern.exec(text)
    if (match === null) break
    if (match[0].length === 0) {
      pattern.lastIndex += 1
      if (pattern.lastIndex > text.length) break
      continue
    }
    let start = match.index
    let end = start + match[0].length
    const startUnit = text.charCodeAt(start)
    if (start > 0 && startUnit >= 0xdc00 && startUnit <= 0xdfff) start -= 1
    const endUnit = text.charCodeAt(end - 1)
    if (end < text.length && endUnit >= 0xd800 && endUnit <= 0xdbff) end += 1
    const previous = ranges[ranges.length - 1]
    if (previous !== undefined && start < previous[1]) {
      if (end > previous[1]) previous[1] = end
      continue
    }
    ranges.push([start, end])
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

/** Single-unit whitespace test: every `\s` member is one UTF-16 unit, so
 *  scanning a string by index never splits a surrogate pair on a separator. */
const WHITESPACE = /\s/u

/**
 * Hard cap on the terms one query may carry ({@link parseQueryTerms} drops
 * later terms once reached): an AND over more terms has long stopped being
 * a useful search, and the cap keeps a pathological query bounded to a
 * per-keystroke-friendly amount of work.
 */
export const MAX_QUERY_TERMS = 16

/**
 * Split a query into the whitespace-separated terms the per-document AND
 * matches with. A double-quoted fragment is ONE term whose inner
 * whitespace is literal (the phrase form of `auth "retry logic"`); a quote
 * met inside a bare word closes the word and opens a phrase; a phrase
 * never closed runs to the end of the query. Empty and whitespace-only
 * quotes (`""`) are dropped — left in, they would make the AND vacuous —
 * so a query of nothing but them parses to no terms.
 *
 * AND semantics give a repeated term no extra say, so terms are deduped by
 * match shape — case-folded unless matching is case-sensitive, first
 * occurrence wins — and the list is capped at {@link MAX_QUERY_TERMS}.
 * Deduping before capping spends the cap slots on distinct, informative
 * terms instead of burning them on repeats; both bounds together keep a
 * pathological query from stretching the per-keystroke budget.
 *
 * @param query - The query to tokenize (leading/trailing whitespace is
 *   skipped here; callers usually pass their already-trimmed input).
 * @param caseSensitive - Dedupe verbatim instead of case-folded — the
 *   shape follows the case sensitivity the terms will match under.
 * @returns Terms in first-occurrence order; `[]` when nothing survives.
 */
export function parseQueryTerms(query: string, caseSensitive = false): string[] {
  const terms: string[] = []
  const shapes = new Set<string>()
  let index = 0
  while (index < query.length) {
    const unit = query[index]
    if (unit !== undefined && WHITESPACE.test(unit)) {
      index += 1
      continue
    }
    let term: string
    if (unit === '"') {
      // A phrase: the raw slice between the quotes, inner spaces literal.
      let end = query.indexOf('"', index + 1)
      if (end === -1) end = query.length // unclosed quote: run to the end
      term = query.slice(index + 1, end)
      index = end < query.length ? end + 1 : query.length
    } else {
      const start = index
      while (
        index < query.length &&
        query[index] !== '"' &&
        !WHITESPACE.test(query[index] ?? '')
      ) {
        index += 1
      }
      term = query.slice(start, index)
    }
    if (term.trim().length === 0) continue
    const shape = caseSensitive ? term : term.toLowerCase()
    if (shapes.has(shape) || terms.length === MAX_QUERY_TERMS) continue
    shapes.add(shape)
    terms.push(term)
  }
  return terms
}

/**
 * Union of half-open ranges: sorted by start, with ranges that overlap or
 * touch (share an endpoint) merged into one span. A multi-term AND hit
 * unions per-term ranges that can nest (`auth` inside `authentication`) or
 * touch; the renderer's highlight walk and the `total` count both assume
 * ordered disjoint spans, so every multi-term result passes through here.
 * Single-term results are already sorted and disjoint — they come out
 * unchanged.
 *
 * @param ranges - Any order, possibly overlapping; not mutated.
 * @returns A new sorted, disjoint array.
 */
export function mergeRanges(
  ranges: readonly (readonly [number, number])[],
): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && start <= previous[1]) {
      if (end > previous[1]) previous[1] = end
      continue
    }
    merged.push([start, end])
  }
  return merged
}

/**
 * Run one query over the index.
 *
 * The query is split into whitespace-separated terms (see
 * {@link parseQueryTerms}); a session matches when its title or any indexed
 * message contains EVERY term — the AND is per document, so terms split
 * across a title and a message (or across two messages) do not match — and
 * each matching document carries the union of all its terms' highlight
 * ranges over the original text. Regex mode (`options.regex`) keeps the
 * whole trimmed query as one pattern instead: inside a regex a space is
 * pattern syntax, not a term separator. Sessions arrive in
 * most-recent-first order and that order is preserved. A literal empty query
 * matches nothing and the scene renders the recent list; a non-empty query
 * that parses to no terms (e.g. `""`) also matches nothing, but the scene
 * renders its no-results empty state. The repo scope matches nothing without
 * a cwd.
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

  // Regex mode compiles once up front and keeps the WHOLE trimmed query as
  // one pattern — inside a regex a space is pattern syntax, not a term
  // separator, so there is nothing to split into terms. An invalid pattern
  // matches nothing; the substring paths keep the folded-needle baseline
  // (below).
  const pattern =
    options.regex === true ? compileRegex(trimmed, caseSensitive) : undefined
  if (options.regex === true && pattern === undefined) return []

  // Substring mode parses whitespace-separated terms and matches them with
  // a per-document AND (below). A non-empty query that parses to no terms
  // (e.g. `""`) matches nothing; the scene distinguishes its empty state
  // from the literal empty query's recent-session mode.
  const terms = pattern === undefined ? parseQueryTerms(trimmed, caseSensitive) : []
  if (pattern === undefined && terms.length === 0) return []
  // Folded needles are a per-query constant, not per-document work.
  const needles = terms.map(term => term.toLowerCase())

  // "This repo" with no cwd to compare against matches nothing.
  const repoCwd = options.repoCwd ?? ''
  if (options.scope === 'repo' && repoCwd.trim().length === 0) {
    return []
  }

  // One matcher for titles and messages alike: the regex path when a
  // pattern is live, otherwise every term against the document under an
  // AND — the first term that misses kills the document (cheap early
  // exit) — and survivors yield the union of all terms' ranges. The
  // case-insensitive path takes the fold ONCE per document and reuses it
  // for every term (see foldOf).
  const rangesOf = (text: string, owner: object): [number, number][] => {
    if (pattern !== undefined) return regexRanges(pattern, text)
    const matches: [number, number][] = []
    if (caseSensitive) {
      for (const term of terms) {
        const termRanges = matchRanges(text, term, true)
        if (termRanges.length === 0) return []
        for (const range of termRanges) matches.push(range)
      }
    } else {
      const fold = foldOf(owner, text)
      for (const needle of needles) {
        const needleRanges = rangesInFold(fold, needle)
        if (needleRanges.length === 0) return []
        for (const range of needleRanges) matches.push(range)
      }
    }
    // Per-term ranges can nest or touch (`auth` inside `authentication`);
    // the renderer walks ordered disjoint spans, so union and merge once.
    return mergeRanges(matches)
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
    const titleRanges = session.title === undefined ? [] : rangesOf(session.title, session)
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
      const ranges = rangesOf(message.text, message)
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
