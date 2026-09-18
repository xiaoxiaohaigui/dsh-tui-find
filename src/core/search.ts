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
 * Pinyin matching (default on): a term made only of ASCII letters also
 * matches Chinese characters through their pinyin — both the full toneless
 * syllables (`zhangsan` → 张三) and the initials (`zs` → 张三) — on top of
 * the literal substring over the original text. Full-reading matches must
 * start at a syllable boundary, preventing a syllable tail from joining the
 * next character's initial; the initials chains instead run contiguously
 * across the whole text (one letter per character, `bjdx` → 北京大学),
 * which is what an IME-style initials query means. The pinyin variant of a
 * document is a fold just like the case fold (one CJK code point expands
 * to its readings; the same prefix tables map a hit back onto the original
 * character), built lazily per document and cached across keystrokes.
 * Regex mode never consults the pinyin folds: a pattern is pattern syntax
 * over the raw text, not a term, and expanding it would be ambiguous.
 *
 * Ordering is most-recent-first (the scanner already yields that order);
 * the sort key here only preserves it deterministically.
 *
 * @module dsh-tui-find/core/search
 */
import { homedir } from 'node:os'
import type { IndexedMessage } from './events.js'
import { PINYIN_READINGS } from './pinyin-data.js'
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
  /**
   * Match letter-only terms against Chinese characters through their
   * pinyin (full toneless syllables and initials) on top of the literal
   * substring. Default OFF at this boundary — the scene passes the user's
   * config, which itself defaults ON.
   */
  readonly pinyin?: boolean
  /**
   * Restrict matching to session TITLE documents: indexed messages are not
   * searched at all, so a session matches only through its title (the
   * `session/title` value — a session without one cannot match, and the
   * cwd/id display fallback is display-only, never indexed). Everything
   * else is unchanged: the per-document AND, pinyin folds and regex mode
   * all apply to the title exactly as they do in full search, and the
   * empty-query recent list is unaffected (this is a match-time
   * constraint, not a list filter). Default OFF — the scene passes the
   * user's Alt+N toggle.
   */
  readonly titleOnly?: boolean
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
export interface FoldedText {
  readonly folded: string
  readonly cumUnits: Uint32Array
  readonly cpStart: Uint32Array
  /** Original text length the fold was built from (staleness guard). */
  readonly sourceLength: number
  /** Pinyin syllable boundaries; absent on the ordinary case fold. */
  readonly segmentStarts?: Uint8Array
}

/** `copied` is the fold's accumulator: kept local so the JIT can tell the
 *  one string being appended to apart from every other local. */
interface FoldChunks {
  copied: string
}

/**
 * Append one code point's folded form to a fold accumulator.
 *
 * A code point is passed as its first UTF-16 unit plus its unit count; the
 * folded form comes from the original slice, so a surrogate pair is never
 * split.
 *
 * The ASCII fast path is the one branch in this loop: `toLowerCase()` costs
 * more than two comparisons, so an all-ASCII document folds ~15% faster than
 * the pre-refactor per-code-point `toLowerCase` build did. The two mappings
 * are canonical folds — neither maps an ASCII letter to a non-ASCII one or
 * the reverse — so branching on the code point is equivalent to calling them
 * unconditionally.
 */
function foldCodePoint(
  text: string,
  at: number,
  units: number,
  caseSensitive: boolean,
  chunks: FoldChunks,
): void {
  const code = text.charCodeAt(at)
  if (units === 1 && code < 0x80) {
    chunks.copied +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + (caseSensitive ? 0 : 0x20))
        : String.fromCharCode(code)
    return
  }
  const char = text.slice(at, at + units)
  chunks.copied += caseSensitive ? char.toUpperCase() : char.toLowerCase()
}

/**
 * Whether one UTF-16 unit is a low surrogate. Paired with the high-surrogate
 * test it is what makes the fold's per-code-point walk a plain char-code
 * scan: `codePointAt` would decode every unit, while the fold only needs the
 * code point's LENGTH and its start.
 */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** Build the fold of one text: one pass over the ORIGINAL string, one lookup
 *  per code point, no `[...text]` expansion of the whole text into a
 *  per-character array. */
function buildFold(text: string): FoldedText {
  // One row per UTF-16 unit is an upper bound on the code-point rows (a
  // surrogate pair consumes two units and one row); the tables are cut down
  // to the exact size afterwards. Sizing them here avoids a separate
  // code-point counting pass, which on a cold build costs more than the
  // trimming does.
  const cpStart = new Uint32Array(text.length + 1)
  const cumUnits = new Uint32Array(text.length + 1)
  const chunks: FoldChunks = { copied: '' }
  let utf16 = 0
  let units = 0
  while (utf16 < text.length) {
    const at = utf16
    const high = text.charCodeAt(at)
    // A surrogate pair is ONE code point and therefore one table row: the
    // low unit is consumed here and never becomes a row of its own.
    utf16 += high >= 0xd800 && high <= 0xdbff && isLowSurrogate(text.charCodeAt(at + 1)) ? 2 : 1
    cpStart[units] = at
    foldCodePoint(text, at, utf16 - at, false, chunks)
    units += 1
    cumUnits[units] = chunks.copied.length
  }
  cpStart[units] = utf16
  return {
    folded: chunks.copied,
    cumUnits: cumUnits.slice(0, units + 1),
    cpStart: cpStart.slice(0, units + 1),
    sourceLength: text.length,
  }
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

/**
 * The pinyin variant of a document: the same {@link FoldedText} contract as
 * the case fold, but a table character expands to its reading(s) instead of
 * folding to itself. Four folds come out of one pass, two per matching
 * chain — `allReadings` spells every reading space-separated (a needle can
 * never contain a space, so the separators are invisible to matching while
 * keeping a polyphone's readings from gluing into phantom syllables) and
 * `firstReading` spells only the frequency-first reading of each character;
 * a reading can only chain forward into the NEXT character from its fold's
 * trailing position, so 重庆 needs `allReadings` (`chongqing`) while 长沙
 * needs `firstReading` (`changsha`). Each chain also carries an initials
 * fold — `allInitials` keeps one letter per reading (`cq` finds 重庆),
 * `firstInitials` one letter per character (`cs` finds 长沙). The initials
 * chains carry no separators between characters: an initials query types
 * one letter per character contiguously (`bjdx` → 北京大学), which is why
 * they are scanned directly rather than through the syllable-start rule the
 * reading chains use. Non-table
 * characters fold to their lowercased self under insensitive matching — so
 * for a letter-only needle these folds already contain every literal
 * case-insensitive occurrence and the case fold needs no second scan — and
 * to their UPPERCASE self under case-sensitive matching: the needle these
 * folds are scanned with is always lowercase (`pinyinNeedleOf`, so Chinese
 * readings themselves match either way) while a Unicode uppercase mapping
 * never produces a lowercase ASCII letter, so the sensitive folds carry
 * readings only and the literal path's sensitivity is never widened by the
 * pinyin path — opposite-case literal hits stay impossible here, and
 * literal matching under sensitivity is the caller's verbatim scan's
 * business. All four share one
 * `cpStart` table: the original UTF-16 start per code point is the same,
 * only the cumulative unit counts differ, which is what lets a hit inside
 * any reading map back onto its character for highlighting.
 */
export interface PinyinFolds {
  readonly allReadings: FoldedText
  readonly firstReading: FoldedText
  readonly allInitials: FoldedText
  readonly firstInitials: FoldedText
}

/**
 * One table character's readings, pre-split. The generated table stores them
 * as one space-separated string; every fold build used to re-`indexOf` and
 * re-`slice` it per character, per document, per keystroke — the single
 * hottest loop in the build. Parsing each character's entry once, lazily, and
 * keeping the pieces lets the build append them directly.
 */
interface PinyinReadings {
  /** The table's own space-separated reading string. */
  readonly raw: string
  /** The reading-string prefix up to the first reading. */
  readonly first: string
  readonly initials: string
}

const readingsCache = new Map<string, PinyinReadings>()

function readingsOf(char: string): PinyinReadings | undefined {
  const cached = readingsCache.get(char)
  if (cached !== undefined) return cached
  const raw = PINYIN_READINGS[char]
  if (raw === undefined) return undefined
  const parts = raw.split(' ')
  const parsed: PinyinReadings = {
    raw,
    first: parts[0]!,
    initials: parts.map(part => part[0]!).join(''),
  }
  readingsCache.set(char, parsed)
  return parsed
}

const pinyinFoldCache = new WeakMap<object, PinyinFoldEntry>()

/** Whether `text` holds a character the pinyin table covers. A cheap scan
 *  (a CJK code point is what the table holds, so anything below the first
 *  table range is skipped without a lookup) that lets the prewarm skip its
 *  pinyin half on the common ASCII-only message — the search path makes the
 *  same distinction for free, by looking the reading up while it folds. */
function hasTableChar(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) >= 0x2e80) return true
  }
  return false
}

/** One owner's cached pinyin folds. `folds` is undefined when the text holds
 *  no table character at all and nothing was built — the length/sensitivity
 *  ride the entry so that negative result validates exactly like a positive
 *  one instead of rebuilding on every probe. */
interface PinyinFoldEntry {
  readonly folds: PinyinFolds | undefined
  readonly sourceLength: number
  readonly caseSensitive: boolean
}

/**
 * The pinyin folds a document matches through, built once and cached. The
 * `buildPinyin` knob lets the background warm-up skip the pinyin half for a
 * configuration that has it off: building folds no search will ever read is
 * pure waste, and skipping it also keeps the cache free of entries whose
 * `caseSensitive` shape would never be probed.
 */
function pinyinFoldsOf(
  owner: object,
  text: string,
  caseSensitive: boolean,
  buildPinyin: boolean,
): PinyinFolds | undefined {
  if (!buildPinyin) return undefined
  const cached = pinyinFoldCache.get(owner)
  if (
    cached !== undefined &&
    cached.sourceLength === text.length &&
    cached.caseSensitive === caseSensitive
  ) {
    return cached.folds
  }
  const built = buildPinyinFolds(text, caseSensitive)
  pinyinFoldCache.set(owner, { folds: built, sourceLength: text.length, caseSensitive })
  return built
}

function buildPinyinFolds(text: string, caseSensitive: boolean): PinyinFolds | undefined {
  // One pass over the original string builds all four chains, the shared
  // per-code-point UTF-16 start table, and the two syllable-boundary
  // bitmaps. A document without a single table character has no readings to
  // match — its insensitive folds would hold nothing but the lowercased
  // literal text the plain case fold already covers, and its sensitive folds
  // would hold only uppercase forms a lowercase needle can never hit — so the
  // build stops after this pass and nothing is cached but the negative
  // verdict (see pinyinFoldsOf).
  const cpStart = new Uint32Array(text.length + 1)
  const cumUnits = {
    all: new Uint32Array(text.length + 1),
    first: new Uint32Array(text.length + 1),
    allInit: new Uint32Array(text.length + 1),
    firstInit: new Uint32Array(text.length + 1),
  }
  const all: FoldChunks = { copied: '' }
  const first: FoldChunks = { copied: '' }
  const allInit: FoldChunks = { copied: '' }
  const firstInit: FoldChunks = { copied: '' }
  // Segment starts are recorded as folded-unit positions in one list per
  // chain and turned into the dense bitmap only at the end, where both the
  // unit totals and the positions are known: a bitmap pre-sized for the
  // worst case would have to guess a reading's length (there is no small
  // bound — a polyphone's reading string runs to a dozen units), and the
  // build is on the first keystroke's critical path.
  const allStarts: number[] = []
  const firstStarts: number[] = []
  let allUnits = 0
  let firstUnits = 0
  let allInitUnits = 0
  let firstInitUnits = 0
  let hasTable = false
  let utf16 = 0
  let codePoints = 0
  while (utf16 < text.length) {
    const at = utf16
    const high = text.charCodeAt(at)
    const size = high >= 0xd800 && high <= 0xdbff && isLowSurrogate(text.charCodeAt(at + 1)) ? 2 : 1
    utf16 += size
    cpStart[codePoints] = at
    const parsed = readingsOf(text.slice(at, utf16))
    if (parsed !== undefined) {
      hasTable = true
      // Every reading is appended exactly as the table spells it — readings
      // separated by one space — because a needle can never contain a space:
      // the separators stay invisible to matching while keeping a polyphone's
      // readings from gluing into phantom syllables. Each reading's first
      // unit is a syllable boundary the reading chains may start on.
      allStarts.push(allUnits)
      let readingAt = 0
      for (;;) {
        const next = parsed.raw.indexOf(' ', readingAt)
        const reading = next === -1 ? parsed.raw.slice(readingAt) : parsed.raw.slice(readingAt, next)
        all.copied += reading
        allUnits += reading.length
        if (next === -1) break
        all.copied += ' '
        allUnits += 1
        allStarts.push(allUnits)
        readingAt = next + 1
      }
      firstStarts.push(firstUnits)
      first.copied += parsed.first
      firstUnits += parsed.first.length
      // The initials folds take one letter per reading (`allInitials`, so a
      // polyphone can be reached either way — `cq` finds 重庆) and one per
      // character (`firstInitials`, the frequency-first reading alone).
      allInit.copied += parsed.initials
      allInitUnits += parsed.initials.length
      firstInit.copied += parsed.first[0]!
      firstInitUnits += 1
    } else {
      // Under sensitive matching a non-table character must fold to a form
      // the lowercase needle can NEVER hit: `pinyinNeedleOf` hands over a
      // lowercase needle (Chinese readings are lowercase ASCII and must
      // match either way, e.g. `ZS` → 张三), and a Unicode uppercase
      // mapping never produces a lowercase ASCII letter — so uppercase
      // leaves these folds carrying readings only. Keeping the original
      // self here would let the lowered needle hit an opposite-case
      // literal occurrence and silently widen the literal path's
      // sensitivity (literal hits under sensitivity already come from the
      // caller's verbatim `matchRanges` scan). Any length change the
      // mapping introduces (ß → SS) is absorbed by `cumUnits`/`cpStart`
      // like in every other fold.
      const char = text.slice(at, utf16)
      const literal = caseSensitive ? char.toUpperCase() : char.toLowerCase()
      // Non-table text remains ordinary case-insensitive literal text in
      // every chain, and each code point is a valid segment so words such
      // as `auth` still match across their character boundaries.
      allStarts.push(allUnits)
      all.copied += literal
      allUnits += literal.length
      firstStarts.push(firstUnits)
      first.copied += literal
      firstUnits += literal.length
      allInit.copied += literal
      allInitUnits += literal.length
      firstInit.copied += literal
      firstInitUnits += literal.length
    }
    codePoints += 1
    cumUnits.all[codePoints] = allUnits
    cumUnits.first[codePoints] = firstUnits
    cumUnits.allInit[codePoints] = allInitUnits
    cumUnits.firstInit[codePoints] = firstInitUnits
  }
  cpStart[codePoints] = utf16
  if (!hasTable) return undefined
  // The dense bitmaps, built once from the recorded starts: `rangesInPinyinFold`
  // asks `starts[indexOf(...)]`, and every index `indexOf` can return is a
  // folded-unit position, so a bitmap covering each chain's unit total is
  // exactly enough.
  const bitmap = (starts: readonly number[], length: number): Uint8Array => {
    const out = new Uint8Array(length + 1)
    for (const start of starts) out[start] = 1
    return out
  }
  // Trim once, so all four chains keep sharing ONE `cpStart` table (the unit
  // counts differ per chain; the original-text offsets never do).
  const sharedStart = cpStart.slice(0, codePoints + 1)
  return {
    allReadings: {
      folded: all.copied,
      cumUnits: cumUnits.all.slice(0, codePoints + 1),
      cpStart: sharedStart,
      sourceLength: text.length,
      segmentStarts: bitmap(allStarts, allUnits),
    },
    firstReading: {
      folded: first.copied,
      cumUnits: cumUnits.first.slice(0, codePoints + 1),
      cpStart: sharedStart,
      sourceLength: text.length,
      segmentStarts: bitmap(firstStarts, firstUnits),
    },
    allInitials: {
      folded: allInit.copied,
      cumUnits: cumUnits.allInit.slice(0, codePoints + 1),
      cpStart: sharedStart,
      sourceLength: text.length,
    },
    firstInitials: {
      folded: firstInit.copied,
      cumUnits: cumUnits.firstInit.slice(0, codePoints + 1),
      cpStart: sharedStart,
      sourceLength: text.length,
    },
  }
}

/**
 * A term qualifies for pinyin matching only when every unit is an ASCII
 * letter: anything else (digits, punctuation, CJK — needles never carry
 * whitespace) has no pinyin reading to compare with. Returns the lowered
 * form the folds are scanned with, or undefined when the term is not
 * pinyin-eligible.
 */
function pinyinNeedleOf(term: string, caseSensitive: boolean): string | undefined {
  const lowered = caseSensitive ? term.toLowerCase() : term
  return /^[a-z]+$/.test(lowered) ? lowered : undefined
}

/** Every pinyin occurrence of `needle` — both reading chains and both
 *  initials chains together, as ranges over the ORIGINAL text. */
function pinyinRanges(folds: PinyinFolds, needle: string): [number, number][] {
  return [
    ...rangesInPinyinFold(folds.allReadings, needle),
    ...rangesInPinyinFold(folds.firstReading, needle),
    ...rangesInFold(folds.allInitials, needle),
    ...rangesInFold(folds.firstInitials, needle),
  ]
}

/** Match pinyin only at syllable boundaries. This prevents a query from
 * taking the tail of one syllable and the head of the next (for example
 * `is` in `shi sou`), while still allowing a prefix inside one syllable such
 * as `zhang` in 张.
 */
function rangesInPinyinFold(fold: FoldedText, needle: string): [number, number][] {
  const starts = fold.segmentStarts
  if (starts === undefined) return rangesInFold(fold, needle)
  const ranges: [number, number][] = []
  let searchFrom = 0
  for (;;) {
    const found = fold.folded.indexOf(needle, searchFrom)
    if (found === -1) break
    const finish = found + needle.length
    const startChar = charOfUnit(fold, found)
    const endChar = charOfUnit(fold, finish - 1)
    const startsAtSegment = starts[found] === 1
    // Once a query starts at a syllable boundary it may continue through
    // following syllables and stop at any prefix of the final one. The only
    // forbidden shape is a query that starts in the middle of a syllable.
    if (startsAtSegment) {
      ranges.push([fold.cpStart[startChar]!, fold.cpStart[endChar + 1]!])
    }
    searchFrom = found + Math.max(1, needle.length)
  }
  return ranges
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

// ── fold-build diagnostics ───────────────────────────────────────────────
//
// The fold tables are the one place where a "faster but wrong" change fails
// SILENTLY: a miscounted `cumUnits` row still scans and still highlights,
// just one character off. These two entry points expose the built structures
// so `test/fold-equivalence.test.ts` can diff them field by field against a
// frozen copy of the pre-refactor implementation. They are a diagnostics
// surface, not a public API — nothing in the plugin calls them.

/** Build one text's case fold (the {@link FoldedText} contract: `folded`,
 *  `cumUnits`, `cpStart`, `sourceLength`). Diagnostics surface — see the
 *  block comment above. */
export function foldTextForTest(text: string): FoldedText {
  return buildFold(text)
}

/** Build one text's pinyin folds, or undefined when the text holds no table
 *  character (the same negative the search path caches). Diagnostics surface
 *  — see the block comment above. */
export function pinyinFoldsForTest(text: string, caseSensitive: boolean): PinyinFolds | undefined {
  return buildPinyinFolds(text, caseSensitive)
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
 * ranges over the original text. Letter-only terms additionally match
 * Chinese characters through their pinyin when {@link SearchOptions.pinyin}
 * is on (full toneless syllables and initials; see the module doc). Regex
 * mode (`options.regex`) keeps the whole trimmed query as one pattern
 * instead: inside a regex a space is pattern syntax, not a term separator.
 * Title-only mode (`options.titleOnly`) searches the title documents alone —
 * indexed messages are skipped, so a session can only match through its
 * title.
 * Sessions arrive in
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
  // for every term (see foldOf). Letter-only terms under pinyin matching
  // scan the pinyin folds instead of the case fold — the full fold already
  // contains the folded non-table text, so the case fold would only repeat
  // the same occurrences — and it is built lazily so a query of Chinese
  // terms never pays for it (both folds cache across keystrokes). A
  // document without table characters builds no pinyin folds at all: the
  // case fold stands in for them on the insensitive path, and the
  // sensitive path gains nothing from them (see buildPinyinFolds).
  const pinyinOn = options.pinyin === true
  const rangesOf = (text: string, owner: object): [number, number][] => {
    if (pattern !== undefined) return regexRanges(pattern, text)
    const matches: [number, number][] = []
    if (caseSensitive) {
      for (const term of terms) {
        const termRanges = matchRanges(text, term, true)
        const pinyinNeedle = pinyinOn ? pinyinNeedleOf(term, true) : undefined
        let extended = termRanges
        if (pinyinNeedle !== undefined) {
          const folds = pinyinFoldsOf(owner, text, true, true)
          if (folds !== undefined) extended = [...termRanges, ...pinyinRanges(folds, pinyinNeedle)]
        }
        if (extended.length === 0) return []
        for (const range of extended) matches.push(range)
      }
    } else {
      let fold: FoldedText | undefined
      const caseFold = (): FoldedText => {
        if (fold === undefined) fold = foldOf(owner, text)
        return fold
      }
      for (const needle of needles) {
        const pinyinNeedle = pinyinOn ? pinyinNeedleOf(needle, false) : undefined
        let needleRanges: [number, number][]
        if (pinyinNeedle === undefined) {
          needleRanges = rangesInFold(caseFold(), needle)
        } else {
          const folds = pinyinFoldsOf(owner, text, false, pinyinOn)
          needleRanges =
            folds === undefined ? rangesInFold(caseFold(), needle) : pinyinRanges(folds, pinyinNeedle)
        }
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
    // keystrokes only the indexOf scan repeats, never the fold. Title-only
    // mode stops here: messages are not searched, so the title is the only
    // document a session can match through.
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

    if (options.titleOnly === true) {
      if (messageHits.length > 0) hits.push({ session, hits: messageHits, total })
      continue
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

// ── background fold prewarm (staged plan phase 1b) ───────────────────────

/** How the prewarm paces itself. */
export interface PrewarmOptions {
  /**
   * Build the pinyin chains too, not just the case folds. The caller passes
   * the scene's own `pinyin` config: with pinyin off, the chains are dead
   * weight (see pinyinFoldsOf).
   */
  readonly pinyin?: boolean
  /** Stop after this many documents (title + messages). */
  readonly maxMessages?: number
  /** Stop after this much wall clock. */
  readonly maxMs?: number
  /** Cancellation — checked at every yield. */
  readonly signal?: AbortSignal
  /**
   * How many documents to fold between event-loop yields. The default keeps
   * one synchronous chunk near `PREWARM_YIELD_EVERY` × the per-document cost
   * (tens of microseconds on a session-sized message), i.e. a few
   * milliseconds — well inside a frame.
   */
  readonly yieldEvery?: number
  /** The yield itself, defaulting to `setImmediate` (the scan path's own
   *  discipline). Injectable so a test can run the pass without timers. */
  readonly yield?: () => Promise<void>
  /** Progress reporting, called once per document the pass resolves. */
  readonly onProgress?: (progress: { resolved: number; total: number; warmed: number }) => void
}

/** Documents folded between yields when the caller does not say. */
export const PREWARM_YIELD_EVERY = 32

/** Default document cap — a budget, not a guarantee: the warm-up is an
 *  optimization, and a library larger than this simply warms up partway. */
export const PREWARM_MAX_MESSAGES = 20_000

/** Default wall-clock cap, for the reason above: roughly twice the measured
 *  build of a 4.8M-character index, and a hard stop for a pathological one. */
export const PREWARM_MAX_MS = 2_000

const defaultYield = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Build and cache the fold of every document in `sessions`, in the background
 * — the phase-1b fix for the one remaining cost on the user's FIRST keystroke.
 *
 * Why it is needed at all: `warmup.tsx`'s sweep pays the per-file decode, and
 * the decode never builds folds (search.ts builds them lazily, on the first
 * query that needs them), so the first letter key still bought the whole fold
 * build — hundreds of milliseconds on a multi-million-character index, on the
 * frame the user is typing into.
 *
 * The pass is a budget, never a dependency: it yields to the event loop every
 * `yieldEvery` documents so it can never block a render tick, stops on the
 * abort signal, on `maxMessages` or on `maxMs`, and the caches it fills are
 * the very ones the search reads (per-object WeakMaps), so searchSessions
 * needs no change at all — whatever was warmed is simply not rebuilt. A
 * partial warm is a partial win, and a skipped warm is today's behavior.
 *
 * The object IDs matter: the scanner hands out stable `ScannedSession` and
 * message objects and KEEPS them (its cache is the index), so folding against
 * these objects populates the same cache keys the scene's sweep will search
 * with. Warming a copy would be thrown away.
 *
 * @param sessions - The scanned index, in any order.
 * @param options - See {@link PrewarmOptions}.
 * @returns How many documents were folded and how many the budget left.
 */
export async function prewarmFolds(
  sessions: readonly ScannedSession[],
  options: PrewarmOptions = {},
): Promise<{ warmed: number; total: number; timedOut: boolean }> {
  const buildPinyin = options.pinyin === true
  const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY
  const maxMs = options.maxMs ?? Number.POSITIVE_INFINITY
  const yieldEvery = Math.max(1, options.yieldEvery ?? PREWARM_YIELD_EVERY)
  const yieldTo = options.yield ?? defaultYield
  const signal = options.signal

  let total = 0
  for (const session of sessions) {
    total += session.messages.length
    if (session.title !== undefined) total += 1
  }

  const started = Date.now()
  let resolved = 0
  let warmed = 0
  let timedOut = false
  let sinceYield = 0

  /** Fold one document on its own cache key; false once the budget is spent
   *  or the pass was cancelled, which unwinds both loops. */
  const warmOne = (owner: object, text: string): boolean => {
    if (resolved >= maxMessages) {
      timedOut = true
      return false
    }
    foldOf(owner, text)
    // No table character means no pinyin chain to build (the search skips the
    // probe entirely on such a document), so the half is skipped here too.
    if (buildPinyin && hasTableChar(text)) pinyinFoldsOf(owner, text, false, true)
    resolved += 1
    warmed += 1
    return true
  }

  outer: for (const session of sessions) {
    if (signal?.aborted) break
    // The title is a document like any message (searchSessions runs the AND
    // against it), so it warms on the session's own key.
    if (session.title !== undefined && !warmOne(session, session.title)) break
    for (const message of session.messages) {
      if (!warmOne(message, message.text)) break outer
      sinceYield += 1
      if (sinceYield >= yieldEvery) {
        sinceYield = 0
        options.onProgress?.({ resolved, total, warmed })
        await yieldTo()
        if (signal?.aborted) break outer
        if (Date.now() - started >= maxMs) {
          timedOut = true
          break outer
        }
      }
    }
  }
  options.onProgress?.({ resolved, total, warmed })
  return { warmed, total, timedOut }
}
