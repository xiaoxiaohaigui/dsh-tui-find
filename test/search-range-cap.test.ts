/**
 * The per-message highlight cap (`MESSAGE_RANGE_LIMIT`): a document's `ranges`
 * array is materialised only up to the cap, while the session's `total` keeps
 * counting every merged segment. Pinned here: `ranges.length ≤ limit` on every
 * hit, ascending and disjoint output, `ranges` equal to the uncapped list
 * truncated at the HEAD, `total` equal to the uncapped segment count, and the
 * uncapped list returned untouched when a document fits — which is every
 * document the list (`PREVIEW_HITS` rows) and the reader render in normal use.
 *
 * The fixture documents are pathological on purpose: they are the only ones
 * where the cap can bite, so they are where a lost count or a shifted segment
 * would show. The uncapped reference is the PRE-cap pipeline — every term's
 * `matchRanges` unioned once by `mergeRanges` — which is exact for the literal
 * paths (no pinyin chains, no regex). The pinyin and regex expectations are
 * spelled out per case instead, because neither is expressible through that
 * reference: the pinyin chains overlap each other, and the regex path
 * deliberately leaves touching matches separate (`matchRanges` merges them).
 */
import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import type { ScannedSession } from '../src/core/scan.js'
import {
  MESSAGE_RANGE_LIMIT,
  matchRanges,
  mergeRanges,
  searchSessions,
  type MessageHit,
  type SessionHit,
} from '../src/core/search.js'
import { PREVIEW_HITS } from '../src/find-types.js'

/** 200 single-character matches, one every third offset. */
const SPARSE = 'aZZ'.repeat(200)
/** 100 runs of three touching `a`s — one merged span per run. */
const RUNS = 'aaaZZ'.repeat(100)
/** 200 table characters whose pinyin chains and initials all open with `z`. */
const CJK = '中'.repeat(200)
/** The same characters separated by `x`, so their pinyin spans have gaps and
 *  stay separate through the union instead of touching into one. */
const CJK_SPACED = '中x'.repeat(200)

const message = (text: string): IndexedMessage => ({ seq: 1, role: 'user', text, at: undefined })

const make = (messages: readonly IndexedMessage[], title?: string): ScannedSession => ({
  id: 'cap-fixture',
  path: 'P:\\fixture\\cap',
  bytes: 1,
  modifiedAt: 0,
  title,
  header: { cwd: undefined, createdAt: undefined },
  messages,
})

/** The pre-cap literal pipeline: each term's matches over the original text,
 *  unioned once — what `rangesOf` returned before the cap existed, including
 *  the per-document AND (one term with no match kills the document). */
function referenceRanges(text: string, query: string, caseSensitive = false): [number, number][] {
  const matches: [number, number][] = []
  for (const term of query.split(/\s+/u)) {
    if (term.length === 0) continue
    // matchRanges takes the already-folded needle on the insensitive path.
    const ranges = matchRanges(text, caseSensitive ? term : term.toLowerCase(), caseSensitive)
    if (ranges.length === 0) return []
    matches.push(...ranges)
  }
  return mergeRanges(matches)
}

/** One session, one message (or the caller's own), and the plain-search
 *  options — spelled out as booleans so no option is ever `undefined`. */
function search(
  text: string,
  query: string,
  options: {
    readonly regex?: boolean
    readonly pinyin?: boolean
    readonly caseSensitive?: boolean
    readonly title?: string
    readonly messages?: readonly IndexedMessage[]
  } = {},
): SessionHit[] {
  const session = make(options.messages ?? [message(text)], options.title)
  return searchSessions([session], query, {
    scope: 'all',
    pinyin: options.pinyin === true,
    caseSensitive: options.caseSensitive === true,
    regex: options.regex === true,
  })
}

/** The first message hit of the first session of a one-session pool. */
function firstHit(hits: readonly SessionHit[]): MessageHit {
  const hit = hits[0]?.hits[0]
  if (hit === undefined) throw new Error('fixture matched nothing')
  return hit
}

/** Every `[start, end)` of a hit is well-formed, ascending and disjoint. */
function expectOrderedDisjoint(ranges: readonly (readonly [number, number])[]): void {
  for (const [start, end] of ranges) expect(start).toBeLessThan(end)
  for (let at = 1; at < ranges.length; at++) {
    expect(ranges[at]![0]).toBeGreaterThanOrEqual(ranges[at - 1]![1])
  }
}

describe('per-message range cap', () => {
  it('caps the materialised ranges but keeps the exact segment count', () => {
    const reference = referenceRanges(SPARSE, 'a')
    expect(reference).toHaveLength(200)
    const hits = search(SPARSE, 'a')
    const hit = firstHit(hits)
    expect(hit.ranges).toHaveLength(MESSAGE_RANGE_LIMIT)
    expect(hit.ranges).toEqual(reference.slice(0, MESSAGE_RANGE_LIMIT))
    // The count is what the header sums, and it is uncapped.
    expect(hits[0]!.total).toBe(reference.length)
    expectOrderedDisjoint(hit.ranges)
  })

  it('unions the terms instead of summing them, capped or not', () => {
    // `a` and `aa` both match inside the same runs, so the union is one span
    // per run and the count must not grow with the term count.
    const reference = referenceRanges(RUNS, 'a aa')
    expect(reference).toHaveLength(100)
    const hits = search(RUNS, 'a aa')
    expect(hits[0]!.total).toBe(reference.length)
    expect(firstHit(hits).ranges).toEqual(reference.slice(0, MESSAGE_RANGE_LIMIT))

    // The same union below the cap: `PREVIEW_HITS + 7` runs is several times
    // the row budget the list renders, and still fits — the whole list of
    // highlighted segments must survive.
    const small = 'aaaZZ'.repeat(PREVIEW_HITS + 7)
    const smallReference = referenceRanges(small, 'a aa')
    expect(smallReference.length).toBeLessThanOrEqual(MESSAGE_RANGE_LIMIT)
    const smallHits = search(small, 'a aa')
    expect(firstHit(smallHits).ranges).toEqual(smallReference)
    expect(smallHits[0]!.total).toBe(smallReference.length)
  })

  it('applies the cap to a title hit too, count included', () => {
    const hits = search('unused', 'a', { title: SPARSE, messages: [] })
    const hit = firstHit(hits)
    expect(hit.kind).toBe('title')
    expect(hit.ranges).toHaveLength(MESSAGE_RANGE_LIMIT)
    expect(hits[0]!.total).toBe(200)
  })

  it('keeps every matched message a hit, capped or not', () => {
    const hits = search('unused', 'a', {
      messages: [message(SPARSE), message('nothing to see'), message(RUNS)],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits).toHaveLength(2)
    // The two messages' counts land in the session total: 200 + 100.
    expect(hits[0]!.total).toBe(300)
    for (const hit of hits[0]!.hits) {
      expect(hit.ranges.length).toBeLessThanOrEqual(MESSAGE_RANGE_LIMIT)
      expectOrderedDisjoint(hit.ranges)
    }
  })

  it('is deterministic across repeated searches (cached folds keep the head)', () => {
    const first = JSON.stringify(search(RUNS, 'a'))
    expect(JSON.stringify(search(RUNS, 'a'))).toBe(first)
    const cjkFirst = JSON.stringify(search(CJK_SPACED, 'z', { pinyin: true }))
    expect(JSON.stringify(search(CJK_SPACED, 'z', { pinyin: true }))).toBe(cjkFirst)
  })

  it('merges the overlapping pinyin chains and still counts every span', () => {
    // `z` opens each character's reading AND its place in the initials chain,
    // so several chains hold matches over the same characters: 200 spans, not
    // one per chain. The `x` separators keep the spans from touching.
    const hits = search(CJK_SPACED, 'z', { pinyin: true })
    expect(hits[0]!.total).toBe(200)
    const hit = firstHit(hits)
    expect(hit.ranges).toHaveLength(MESSAGE_RANGE_LIMIT)
    expect(hit.ranges[0]).toEqual([0, 1])
    expect(hit.ranges[MESSAGE_RANGE_LIMIT - 1]).toEqual([
      (MESSAGE_RANGE_LIMIT - 1) * 2,
      (MESSAGE_RANGE_LIMIT - 1) * 2 + 1,
    ])
    expectOrderedDisjoint(hit.ranges)

    // Contiguous characters: each reading spans its own character and the
    // spans touch, so the union is ONE segment for the whole document — and a
    // full reading (`zhong`) is the same union reached through one chain.
    for (const needle of ['z', 'zhong']) {
      const whole = search(CJK, needle, { pinyin: true })
      expect(whole[0]!.total, needle).toBe(1)
      expect(firstHit(whole).ranges, needle).toEqual([[0, 200]])
    }
  })

  it('leaves touching regex matches separate and caps them from the head', () => {
    const hits = search(RUNS, 'a', { regex: true })
    // Three separate one-unit matches per run (the substring path merges them
    // into one) — the regex output shape test/scanner.test.ts already pins.
    expect(hits[0]!.total).toBe(300)
    const hit = firstHit(hits)
    expect(hit.ranges).toHaveLength(MESSAGE_RANGE_LIMIT)
    expect(hit.ranges[0]).toEqual([0, 1])
    expect(hit.ranges[1]).toEqual([1, 2])
    expectOrderedDisjoint(hit.ranges)
  })

  it('returns the uncapped list when the document fits the cap', () => {
    // Every row the list renders (`PREVIEW_HITS`) and every message a realistic
    // reader opens sits here: their ranges must be complete.
    const corpus: readonly string[] = [
      'auth flow retry logic',
      'the data text line path file node user',
      'AUTH FLOW RETRY LOGIC',
      'aaaa auth',
      'aZZ aZZ aZZ auth',
      'retry the queue',
      'preview highlight search index config',
      '中文搜索 预览窗口',
      'zhangsha chongqing zs cq',
    ]
    let comparisons = 0
    for (const text of corpus) {
      for (const query of ['a', 'auth', 'a auth', 'aa', 'retry', '中文']) {
        // The reference is the literal pipeline: it cannot express the pinyin
        // chain selection, so a CJK query skips the pinyin pass.
        const pinyinFlags = /[\u4e00-\u9fff]/u.test(query) ? [false] : [false, true]
        for (const caseSensitive of [false, true]) {
          for (const pinyin of pinyinFlags) {
            const reference = referenceRanges(text, query, caseSensitive)
            const hits = search(text, query, { caseSensitive, pinyin })
            const label = `${JSON.stringify(query)} sensitive=${caseSensitive} pinyin=${pinyin} text=${JSON.stringify(text)}`
            // The corpus stays under the cap: this IS the uncapped comparison.
            expect(reference.length, label).toBeLessThanOrEqual(MESSAGE_RANGE_LIMIT)
            if (reference.length === 0) {
              expect(hits, label).toEqual([])
              continue
            }
            expect(hits.length, label).toBeGreaterThan(0)
            expect(firstHit(hits).ranges, label).toEqual(reference)
            expect(hits[0]!.total, label).toBe(reference.length)
            comparisons += 1
          }
        }
      }
    }
    // A silently empty sweep would pass vacuously.
    expect(comparisons).toBeGreaterThan(50)
  })
})
