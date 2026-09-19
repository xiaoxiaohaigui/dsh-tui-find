/**
 * Fold-build equivalence: the phase-1a rewrite of `buildFold` /
 * `buildPinyinFolds` (single pass over the original string, cached parsed
 * readings, ASCII fast path, dense segment bitmap) must produce the EXACT
 * tables the pre-refactor implementation produced — not merely similar
 * matches.
 *
 * The oracle is the frozen copy in `test/fold-reference.ts`. Every table is
 * compared field by field: the folded string, `cumUnits`, `cpStart`, the
 * syllable-boundary bitmap and `sourceLength`. A fold that is merely close
 * still scans and still highlights, only one character off, which is exactly
 * the class of regression no end-to-end assertion reliably catches — so this
 * suite is deliberately structural rather than behavioral. A separate case
 * pins the end-to-end half: the search results (hits and highlight ranges)
 * over the same corpus through both folds.
 *
 * Coverage is chosen for the fold's own edge cases: length-changing folds
 * (`İ` → two units, `ß` → `SS`), non-BMP code points (surrogate pairs fold
 * per code point, not per unit), polyphones (multi-reading chains plus their
 * `segmentStarts`), characters absent from the table, empty text, and a
 * seeded random corpus that mixes all of them.
 */
import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import { PINYIN_READINGS } from '../src/core/pinyin-data.js'
import type { ScannedSession } from '../src/core/scan.js'
import { foldTextForTest, pinyinFoldsForTest, searchSessions } from '../src/core/search.js'
import { refBuildFold, refBuildPinyinFolds, type RefFoldedText } from './fold-reference.js'

/** Every table of one fold compared, with the label naming the failing case.
 *
 * The comparison is CONTENT-based on purpose. Whether the live build was
 * allowed to omit a table (phase 2a's identity shortcut) is not decidable
 * from the reference's tables — the old build kept `cumUnits` for every fold,
 * identity or not — so this helper does not try: it compares `cumUnits` and
 * `cpStart` when the live fold carries them (where they must equal the
 * reference's) and stops at the folded string when it does not. What the
 * omitted tables have to be is not "shape X" but "genuinely redundant", and
 * that claim is proven two other ways: `test/search-baseline.test.ts` runs
 * the live search against the frozen pre-perf revision, and the table
 * character sweep below exercises all 3500 entries.
 */
function expectFoldEqual(
  label: string,
  actual: RefFoldedText,
  expected: RefFoldedText,
  cpStart: Uint32Array | undefined,
): void {
  expect(actual.folded, `${label}: folded`).toBe(expected.folded)
  expect(actual.sourceLength, `${label}: sourceLength`).toBe(expected.sourceLength)
  if (actual.cumUnits !== undefined) {
    expect(Array.from(actual.cumUnits), `${label}: cumUnits`).toEqual(Array.from(expected.cumUnits))
    if (cpStart !== undefined) {
      // The pinyin chains share one table, which lives on the PinyinFolds
      // object; the case fold carries its own.
      expect(Array.from(cpStart), `${label}: cpStart`).toEqual(
        Array.from(expected.cpStart.slice(0, cpStart.length)),
      )
    } else {
      expect(actual.cpStart, `${label}: cpStart present`).toBeDefined()
      expect(Array.from(actual.cpStart!), `${label}: cpStart`).toEqual(Array.from(expected.cpStart))
    }
  } else {
    expect(actual.cpStart, `${label}: omitted cpStart goes with omitted cumUnits`).toBeUndefined()
  }
  expect(actual.segmentStarts === undefined, `${label}: segmentStarts presence`).toBe(
    expected.segmentStarts === undefined,
  )
  if (actual.segmentStarts === undefined || expected.segmentStarts === undefined) return
  // The bitmap is indexed by folded UNIT, so only the positions a scan can
  // ever read are comparable: `indexOf` only returns indices below the folded
  // string's length. The pre-refactor build sized the array by the original
  // text's UTF-16 length instead, leaving a tail of zeros that no scan
  // reaches — the compact build drops it, which is why the lengths differ
  // while every reachable entry must match.
  const reachable = actual.folded.length
  expect(reachable, `${label}: bitmap covers the folded string`).toBeLessThanOrEqual(actual.segmentStarts.length)
  expect(
    Array.from(actual.segmentStarts.slice(0, reachable)),
    `${label}: segmentStarts (reachable prefix)`,
  ).toEqual(Array.from(expected.segmentStarts.slice(0, reachable)))
  expect(
    Array.from(expected.segmentStarts.slice(reachable)).every(entry => entry === 0),
    `${label}: segmentStarts tail is inert`,
  ).toBe(true)
}

/**
 * Phase 2b's invariant: two chains share ONE fold object exactly when they
 * spell the same string AND carry the same syllable bitmap, and never
 * otherwise — a shared chain that differed would silently drop matches, and a
 * duplicated one would just waste memory. Phase 2a's invariant rides along:
 * an identity chain carries no prefix tables, and a non-identity one carries
 * them (the pinyin chains through the shared `PinyinFolds.cpStart`).
 *
 * Identity IS reachable, which is what makes the phase-2a verdict worth
 * pinning structurally here rather than only through search results: a
 * document of single-letter readings (一 → `y`, 啊 → `a`) or an ASCII run
 * spells one unit per code point, needs no prefix table at all, and a build
 * that kept the table anyway STILL scans and highlights correctly — the
 * failure mode is a wasted table, invisible to every behavioral assertion.
 * The four verdicts are evaluated BEFORE the code-point counter advances (see
 * `buildPinyinFolds`); with the check after the increment nothing non-empty is
 * ever identity, so the assertions below are what catch that regression.
 */
function expectChainSharing(label: string, folds: NonNullable<ReturnType<typeof pinyinFoldsForTest>>): void {
  const pairs = [
    ['allReadings', 'firstReading', folds.allReadings, folds.firstReading],
    ['allInitials', 'firstInitials', folds.allInitials, folds.firstInitials],
  ] as const
  for (const [leftName, rightName, left, right] of pairs) {
    const sameFolded = left.folded === right.folded
    // The two chains' bitmaps are compared when both carry one; a chain
    // without a bitmap (the initials chains are scanned contiguously) has no
    // boundary rule to disagree about.
    const sameBits =
      left.segmentStarts === undefined
        ? right.segmentStarts === undefined
        : right.segmentStarts !== undefined &&
          left.segmentStarts.length === right.segmentStarts.length &&
          left.segmentStarts.every((bit, at) => bit === right.segmentStarts![at])
    const shareable = sameFolded && sameBits
    expect(left === right, `${label}: ${leftName}/${rightName} sharing`).toBe(shareable)
  }
  for (const [name, fold] of [
    ['allReadings', folds.allReadings],
    ['firstReading', folds.firstReading],
    ['allInitials', folds.allInitials],
    ['firstInitials', folds.firstInitials],
  ] as const) {
    const identity = fold.cumUnits === undefined
    if (identity) {
      expect(fold.cpStart, `${label}: ${name} identity carries no cpStart`).toBeUndefined()
      expect(fold.sourceLength, `${label}: ${name} identity length`).toBe(fold.folded.length)
    } else {
      expect(folds.cpStart, `${label}: ${name} shares the pinyin cpStart`).toBeDefined()
    }
  }
  // The shared table is allocated exactly when some chain needs it — which is
  // the assertion that sees the phase-2a verdict: with the identity check on
  // the wrong side of the counter it never omits a table, so a document whose
  // four chains are all identity must leave `cpStart` undefined here.
  const anyNonIdentity = [folds.allReadings, folds.firstReading, folds.allInitials, folds.firstInitials].some(
    fold => fold.cumUnits !== undefined,
  )
  expect(folds.cpStart === undefined, `${label}: cpStart presence`).toBe(!anyNonIdentity)
}

const FIXTURES: readonly [string, string][] = [
  ['empty', ''],
  ['plain ascii lower', 'auth flow retry logic'],
  ['ascii mixed case', 'Auth Flow RETRY Logic'],
  ['single-reading chains', '啊俄哦一乙'],
  ['single-reading chained with ascii', 'x啊y一z'],
  ['digits and punctuation', 'a1b2-c3_d4 (e5) [f6] {g7} 8.9'],
  ['table chars', '张三的会话'],
  ['polyphones', '重庆长沙银行行业音乐快乐'],
  ['mixed scripts', 'deploy 张三 to prod 搜索 done'],
  ['dotted i', 'İstanbul İzmir'],
  ['sharp s', 'straße STRASSE groß'],
  ['ligature and specials', 'Ǆ ǅ ǆ ﬁ ﬂ'],
  ['greek and cyrillic', 'ΑΒΓΔ αβγδ Привет МИР'],
  ['non-bmp', 'a😀b𠮷c𝕏d'],
  ['non-bmp only', '😀𠮷𝕏'],
  ['newlines and tabs', 'line one\nline two\tline three\n'],
  ['unlisted cjk', '龘齉爨鑫'],
  ['table then unlisted', '中龘文齉'],
  ['keystroke shapes', 'a', 'A', 'u', 'auth', 'zs', 'zhangsan', 'chongqing'],
  ['trailing space', 'auth '],
  ['single space', ' '],
  ['lone high surrogate', '\ud83d'],
  ['lone low surrogate', '\ude00'],
  ['high surrogate then ascii', '\ud83da'],
  ['combining marks', 'e\u0301a\u0308'],
  ['fullwidth latin', 'ＡＵＴＨ ｆｌｏｗ'],
  ['mixed everything', 'İß 张三😀 auth 龘\nAUTH 重庆 zs'],
]

/** Deterministic LCG so a failure reproduces exactly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const POOL = [
  'auth',
  'Auth',
  'AUTH',
  'retry logic',
  '张三',
  '重庆',
  '长沙',
  '银行',
  '搜索',
  'İ',
  'ß',
  '😀',
  '𠮷',
  '龘',
  'е',
  'А',
  'Ａ',
  '1',
  '-',
  '_',
  '\n',
  '\t',
  ' ',
  'e\u0301',
  '\ud83d',
  '\ude00',
]

/** Random texts over the pool, 0..60 units each — the broad sweep the fixed
 *  fixtures cannot cover. */
function randomCorpus(count: number, seed: number): string[] {
  const next = seeded(seed)
  const out: string[] = []
  for (let at = 0; at < count; at++) {
    const length = Math.floor(next() * 60)
    let text = ''
    for (let unit = 0; unit < length; unit++) {
      text += POOL[Math.floor(next() * POOL.length)]!
    }
    out.push(text)
  }
  return out
}

describe('fold build equivalence (phase 1a-2b)', () => {
  it('builds the identical case fold for every fixture', () => {
    for (const [label, text] of FIXTURES) {
      expectFoldEqual(label, foldTextForTest(text), refBuildFold(text), undefined)
    }
  })

  it('builds identical pinyin folds, including the negative verdict', () => {
    for (const [label, text] of FIXTURES) {
      for (const caseSensitive of [false, true]) {
        const actual = pinyinFoldsForTest(text, caseSensitive)
        const expected = refBuildPinyinFolds(text, caseSensitive)
        const name = `${label} (caseSensitive ${caseSensitive})`
        expect(actual === undefined, `${name}: build verdict`).toBe(expected === undefined)
        if (actual === undefined || expected === undefined) continue
        expectFoldEqual(`${name} allReadings`, actual.allReadings, expected.allReadings, actual.cpStart)
        expectFoldEqual(`${name} firstReading`, actual.firstReading, expected.firstReading, actual.cpStart)
        expectFoldEqual(`${name} allInitials`, actual.allInitials, expected.allInitials, actual.cpStart)
        expectFoldEqual(`${name} firstInitials`, actual.firstInitials, expected.firstInitials, actual.cpStart)
        expectChainSharing(name, actual)
      }
    }
  })

  it('omits the prefix tables when every chain is identity (phase 2a reachability)', () => {
    // One unit per code point in ALL four chains: single-letter readings
    // (啊 → `a`, 俄 → `e`) and ASCII, so the folded index is the original index
    // and not one prefix table is needed. This is the case the counter-order
    // regression erases, and this case is the only assertion that sees it —
    // a table that should have been omitted still holds the reference's
    // values field by field, so every comparison above stays green either way.
    for (const text of ['啊', 'x啊y俄z']) {
      for (const caseSensitive of [false, true]) {
        const folds = pinyinFoldsForTest(text, caseSensitive)
        const name = `${JSON.stringify(text)} (caseSensitive ${caseSensitive})`
        expect(folds, `${name}: builds (the text holds a table char)`).toBeDefined()
        expect(folds!.cpStart, `${name}: all-identity chains omit the shared table`).toBeUndefined()
        for (const [chainName, fold] of [
          ['allReadings', folds!.allReadings],
          ['firstReading', folds!.firstReading],
          ['allInitials', folds!.allInitials],
          ['firstInitials', folds!.firstInitials],
        ] as const) {
          expect(fold.cumUnits, `${name}: ${chainName} omits its table`).toBeUndefined()
          expect(fold.sourceLength, `${name}: ${chainName} identity length`).toBe(fold.folded.length)
        }
      }
    }
  })

  it('builds identical folds across a seeded random corpus', () => {
    for (const text of randomCorpus(300, 0x5eed)) {
      const label = `random ${JSON.stringify(text)}`
      expectFoldEqual(label, foldTextForTest(text), refBuildFold(text), undefined)
      for (const caseSensitive of [false, true]) {
        const actual = pinyinFoldsForTest(text, caseSensitive)
        const expected = refBuildPinyinFolds(text, caseSensitive)
        expect(actual === undefined, `${label} (sensitive ${caseSensitive}): verdict`).toBe(
          expected === undefined,
        )
        if (actual === undefined || expected === undefined) continue
        expectFoldEqual(
          `${label} (sensitive ${caseSensitive}) all`,
          actual.allReadings,
          expected.allReadings,
          actual.cpStart,
        )
        expectFoldEqual(
          `${label} (sensitive ${caseSensitive}) first`,
          actual.firstReading,
          expected.firstReading,
          actual.cpStart,
        )
        expectChainSharing(`${label} (sensitive ${caseSensitive})`, actual)
      }
    }
  })

  it('builds identical folds for every listed table character, alone and chained', () => {
    const characters = Object.keys(PINYIN_READINGS)
    expect(characters.length).toBeGreaterThan(3000)
    for (const char of characters) {
      const texts = [char, `${char}${char}`, `x${char}y`, `${char}龘${char}`]
      for (const text of texts) {
        const actual = pinyinFoldsForTest(text, false)
        const expected = refBuildPinyinFolds(text, false)
        expect(actual === undefined, `${JSON.stringify(text)}: verdict`).toBe(expected === undefined)
        if (actual === undefined || expected === undefined) continue
        expectFoldEqual(`${JSON.stringify(text)} all`, actual.allReadings, expected.allReadings, actual.cpStart)
        expectFoldEqual(`${JSON.stringify(text)} first`, actual.firstReading, expected.firstReading, actual.cpStart)
        expectFoldEqual(`${JSON.stringify(text)} allInit`, actual.allInitials, expected.allInitials, actual.cpStart)
        expectFoldEqual(
          `${JSON.stringify(text)} firstInit`,
          actual.firstInitials,
          expected.firstInitials,
          actual.cpStart,
        )
        expectChainSharing(JSON.stringify(text), actual)
      }
    }
  })

  it('keeps the search results and highlight ranges byte-identical', () => {
    const make = (text: string, index: number): ScannedSession => {
      const message: IndexedMessage = { seq: 1, role: 'user', text, at: undefined }
      return {
        id: `fixture-${index}`,
        path: `P:\\fixture\\${index}`,
        bytes: 1,
        modifiedAt: index,
        title: text,
        header: { cwd: undefined, createdAt: undefined },
        messages: [message],
      }
    }
    const texts = [...FIXTURES.map(([, text]) => text), ...randomCorpus(120, 0xc0ffee)]
    const pool = texts.map(make)
    // Needles that exercise every path: literal, pinyin readings, initials,
    // case sensitivity, a mixed one and a CJK one.
    const queries = ['auth', 'AUTH', 'zs', 'zhangsan', 'chongqing', 'zhang', '中', '龘', 'ß', 'İ', '😀', 'e']
    for (const query of queries) {
      for (const caseSensitive of [false, true]) {
        for (const pinyin of [false, true]) {
          const options = { scope: 'all', caseSensitive, pinyin } as const
          const hits = searchSessions(pool, query, options)
          const name = `${JSON.stringify(query)} sensitive=${caseSensitive} pinyin=${pinyin}`
          // The same query against the FROZEN folds: every hit and every
          // highlight range must come out identically, which is end-to-end
          // proof that the rewritten build feeds the scan the same tables.
          const expected = referenceHits(pool, query, { caseSensitive, pinyin })
          if (JSON.stringify(hits) !== JSON.stringify(expected)) {
            for (let at = 0; at < Math.max(hits.length, expected.length); at++) {
              const left = hits[at]?.hits ?? []
              const right = expected[at]?.hits ?? []
              if (JSON.stringify(left) !== JSON.stringify(right)) {
                console.log('MISMATCH', name, 'text', JSON.stringify(left[0]?.text ?? right[0]?.text))
                console.log('  live', JSON.stringify(left.map(entry => entry.ranges)))
                console.log('  ref ', JSON.stringify(right.map(entry => entry.ranges)))
                break
              }
            }
          }
          expect(JSON.stringify(hits), name).toBe(JSON.stringify(expected))
        }
      }
    }
  })
})

// ── the reference scan ────────────────────────────────────────────────────
//
// `searchSessions` itself cannot serve as its own oracle, so the expected
// highlights are computed here from the FROZEN folds: build them with the
// reference implementation, then scan them with the same contract the live
// `rangesInFold` / `rangesInPinyinFold` implement. Comparing the JSON of the
// two result sets covers the fold tables, the mapping back onto the original
// text, the syllable-boundary rule and the range merge in one assertion.

interface RefHit {
  readonly kind: 'title' | 'message'
  readonly role: IndexedMessage['role'] | undefined
  readonly seq: number | undefined
  readonly text: string
  readonly at: number | undefined
  readonly ranges: readonly (readonly [number, number])[]
  readonly sourceIndex: number | undefined
}

function refCharOfUnit(fold: RefFoldedText, unit: number): number {
  let low = 0
  let high = fold.cumUnits.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (fold.cumUnits[mid]! <= unit) low = mid + 1
    else high = mid
  }
  return low - 1
}

function refRangesInFold(fold: RefFoldedText, needle: string): [number, number][] {
  const ranges: [number, number][] = []
  let searchFrom = 0
  for (;;) {
    const found = fold.folded.indexOf(needle, searchFrom)
    if (found === -1) break
    const startChar = refCharOfUnit(fold, found)
    const endChar = refCharOfUnit(fold, found + needle.length - 1)
    ranges.push([fold.cpStart[startChar]!, fold.cpStart[endChar + 1]!])
    searchFrom = found + needle.length
  }
  return ranges
}

function refRangesInPinyinFold(fold: RefFoldedText, needle: string): [number, number][] {
  const starts = fold.segmentStarts
  if (starts === undefined) return refRangesInFold(fold, needle)
  const ranges: [number, number][] = []
  let searchFrom = 0
  for (;;) {
    const found = fold.folded.indexOf(needle, searchFrom)
    if (found === -1) break
    const finish = found + needle.length
    const startChar = refCharOfUnit(fold, found)
    const endChar = refCharOfUnit(fold, finish - 1)
    if (starts[found] === 1) ranges.push([fold.cpStart[startChar]!, fold.cpStart[endChar + 1]!])
    searchFrom = found + Math.max(1, needle.length)
  }
  return ranges
}

function refMergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
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

/** Every pinyin occurrence, in the live `pinyinRanges` contract: the shared
 *  folds (a document without polyphones spells two chains identically) are
 *  scanned ONCE, which phase 2b introduced — scanning a shared chain twice
 *  would double every range it produces. */
function refPinyinRanges(folds: NonNullable<ReturnType<typeof refBuildPinyinFolds>>, needle: string): [number, number][] {
  const ranges: [number, number][] = []
  const seen = new Set<RefFoldedText>()
  for (const [fold, bySegment] of [
    [folds.allReadings, true],
    [folds.firstReading, true],
    [folds.allInitials, false],
    [folds.firstInitials, false],
  ] as const) {
    if (seen.has(fold)) continue
    seen.add(fold)
    ranges.push(...(bySegment ? refRangesInPinyinFold(fold, needle) : refRangesInFold(fold, needle)))
  }
  return ranges
}

/** The reference implementation's answer for one document. */
function refRangesOf(
  text: string,
  query: string,
  options: { caseSensitive: boolean; pinyin: boolean },
): [number, number][] {
  const matches: [number, number][] = []
  for (const term of query.split(' ')) {
    const needle = term.toLowerCase()
    // The pinyin eligibility rule, mirrored exactly: a term of ASCII letters
    // only (`pinyinNeedleOf` lowercases a sensitive term first). A word such
    // as `auth` therefore DOES scan the chains — its letters can fall inside
    // a reading or initials fold — which is why this oracle must not narrow
    // the rule to consonants.
    const pinyin = options.pinyin && /^[a-z]+$/.test(needle)
    let ranges: [number, number][]
    if (options.caseSensitive) {
      ranges = []
      let searchFrom = 0
      for (;;) {
        const found = text.indexOf(term, searchFrom)
        if (found === -1) break
        ranges.push([found, found + term.length])
        searchFrom = found + term.length
      }
      if (pinyin) {
        const folds = refBuildPinyinFolds(text, true)
        if (folds !== undefined) ranges = [...ranges, ...refPinyinRanges(folds, needle)]
      }
    } else if (pinyin) {
      const folds = refBuildPinyinFolds(text, false)
      ranges = folds === undefined ? refRangesInFold(refBuildFold(text), needle) : refPinyinRanges(folds, needle)
    } else {
      ranges = refRangesInFold(refBuildFold(text), needle)
    }
    if (ranges.length === 0) return []
    for (const range of ranges) matches.push(range)
  }
  return refMergeRanges(matches)
}

/** The whole `searchSessions` answer over the fixtures, from frozen folds. */
function referenceHits(
  sessions: readonly ScannedSession[],
  query: string,
  options: { caseSensitive: boolean; pinyin: boolean },
): { session: ScannedSession; hits: RefHit[]; total: number }[] {
  const out: { session: ScannedSession; hits: RefHit[]; total: number }[] = []
  for (const session of sessions) {
    const hits: RefHit[] = []
    let total = 0
    if (session.title !== undefined) {
      const ranges = refRangesOf(session.title, query, options)
      if (ranges.length > 0) {
        hits.push({
          kind: 'title',
          role: undefined,
          seq: undefined,
          text: session.title,
          at: undefined,
          ranges,
          sourceIndex: undefined,
        })
        total += ranges.length
      }
    }
    for (const [sourceIndex, message] of session.messages.entries()) {
      const ranges = refRangesOf(message.text, query, options)
      if (ranges.length === 0) continue
      hits.push({
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
    if (hits.length > 0) out.push({ session, hits, total })
  }
  return out
}

