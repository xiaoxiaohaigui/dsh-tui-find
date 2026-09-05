/**
 * Multi-term search tests: the query splits into whitespace-separated terms
 * (double-quoted phrases keep their inner spaces) and the AND is per
 * document — a session title or ONE message must contain every term — with
 * the highlight ranges merged into a sorted, disjoint union. Also pinned:
 * regex mode staying one whole pattern (never term-split), the dedupe and
 * term cap, and the scope/time-window filters still applying to multi-term
 * queries. Single-term behavior must stay byte-identical to the substring
 * baseline the scanner suite already covers.
 */
import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import type { ScannedSession } from '../src/core/scan.js'
import {
  MAX_QUERY_TERMS,
  mergeRanges,
  parseQueryTerms,
  searchSessions,
  type SessionHit,
} from '../src/core/search.js'

/** Minimal ScannedSession fixture in the scanner suite's shape. */
const make = (
  text: string,
  extra: {
    title?: string
    messages?: readonly IndexedMessage[]
    cwd?: string
    modifiedAt?: number
  } = {},
): ScannedSession => ({
  id: text,
  path: `P:\\fixture\\${text}`,
  bytes: 1,
  modifiedAt: extra.modifiedAt ?? 0,
  title: extra.title,
  header: { cwd: extra.cwd, createdAt: undefined },
  messages: extra.messages ?? [{ seq: 1, role: 'user', text, at: undefined }],
})

const message = (text: string, role: IndexedMessage['role'] = 'user'): IndexedMessage => ({
  seq: 1,
  role,
  text,
  at: undefined,
})

/** Every MessageHit of every session, in result order. */
const flatHits = (hits: readonly SessionHit[]) => hits.flatMap(session => session.hits)

describe('parseQueryTerms', () => {
  it('splits on whitespace outside quotes and keeps phrase spaces', () => {
    expect(parseQueryTerms('auth "retry logic" now')).toEqual(['auth', 'retry logic', 'now'])
    expect(parseQueryTerms('  spaced   out  ')).toEqual(['spaced', 'out'])
    expect(parseQueryTerms('a\tb\nc')).toEqual(['a', 'b', 'c'])
    expect(parseQueryTerms('')).toEqual([])
  })

  it('treats an unclosed quote as one term running to the end', () => {
    expect(parseQueryTerms('a "b c')).toEqual(['a', 'b c'])
    expect(parseQueryTerms('"b c')).toEqual(['b c'])
  })

  it('drops empty and whitespace-only quoted terms', () => {
    expect(parseQueryTerms('""')).toEqual([])
    expect(parseQueryTerms('"   "')).toEqual([])
    expect(parseQueryTerms('"" " " auth')).toEqual(['auth'])
  })

  it('lets a quote inside a bare word close the word and open a phrase', () => {
    expect(parseQueryTerms('auth"retry logic"')).toEqual(['auth', 'retry logic'])
  })

  it('dedupes by match shape and caps the term count', () => {
    // Insensitive matching folds the shape: a repeated term is a no-op.
    expect(parseQueryTerms('auth AUTH Auth')).toEqual(['auth'])
    // Sensitive matching dedupes verbatim instead.
    expect(parseQueryTerms('auth AUTH', true)).toEqual(['auth', 'AUTH'])
    const many = Array.from({ length: MAX_QUERY_TERMS + 2 }, (_, i) => `w${i}`)
    expect(parseQueryTerms(many.join(' '))).toHaveLength(MAX_QUERY_TERMS)
    expect(parseQueryTerms(many.join(' ')).at(-1)).toBe('w15')
    // Dedupe runs before the cap, so a repeat never burns a cap slot.
    const bloated = ['a', 'A', ...Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `w${i}`)]
    const parsed = parseQueryTerms(bloated.join(' '))
    expect(parsed).toHaveLength(MAX_QUERY_TERMS)
    expect(parsed[0]).toBe('a')
    expect(parsed.at(-1)).toBe('w14')
  })
})

describe('mergeRanges', () => {
  it('sorts and unions overlapping or touching spans', () => {
    expect(mergeRanges([[0, 4], [2, 8], [10, 12]])).toEqual([[0, 8], [10, 12]])
    expect(mergeRanges([[0, 3], [3, 5]])).toEqual([[0, 5]]) // touching
    expect(mergeRanges([[5, 9], [0, 4]])).toEqual([[0, 4], [5, 9]]) // any order
    expect(mergeRanges([[12, 26], [12, 16]])).toEqual([[12, 26]]) // nested
  })

  it('leaves sorted disjoint input unchanged (single-term passthrough)', () => {
    expect(mergeRanges([[0, 4], [9, 14]])).toEqual([[0, 4], [9, 14]])
    expect(mergeRanges([])).toEqual([])
  })
})

describe('searchSessions multi-term AND', () => {
  it('requires every term inside the same message and highlights the union', () => {
    const pool = [
      make('auth fixed by retrying'),
      make('auth logged the failure'), // only 'auth'
      make('retry the flaky test'), // only 'retry'
    ]
    const hits = searchSessions(pool, 'auth retry', { scope: 'all' })
    expect(hits).toHaveLength(1)
    const hit = hits[0]!.hits[0]!
    expect(hit.text).toBe('auth fixed by retrying')
    expect(hit.ranges).toEqual([[0, 4], [14, 19]])
    expect(hits[0]!.total).toBe(2)
  })

  it('does not match when the terms split across documents (per-document AND)', () => {
    // Title holds one term, a message the other — the AND is per document,
    // so this is a miss (not a session-level OR).
    expect(searchSessions([make('retry the flaky test', { title: 'auth session' })], 'auth retry', { scope: 'all' })).toEqual([])
    // Same across two messages.
    const twoMessages = make('', {
      messages: [message('auth note'), message('retry note')],
    })
    expect(searchSessions([twoMessages], 'auth retry', { scope: 'all' })).toEqual([])
    // Positive control: when BOTH documents carry both terms, both hit.
    const both = make('auth and retry', { title: 'auth retry' })
    const hits = searchSessions([both], 'auth retry', { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits).toHaveLength(2) // title hit + message hit
    expect(hits[0]!.total).toBe(4)
  })

  it('ANDs CJK terms without a segmenter', () => {
    const pool = [make('指数退避与抖动抑制'), make('指数退避策略')]
    const hits = searchSessions(pool, '指数 抖动', { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits[0]!.text).toBe('指数退避与抖动抑制')
    expect(hits[0]!.hits[0]!.ranges).toEqual([[0, 2], [5, 7]])
  })

  it('folds case per term by default and honors caseSensitive across terms', () => {
    const pool = [make('AUTH with Retry backoff')]
    const folded = searchSessions(pool, 'auth retry', { scope: 'all' })
    expect(folded).toHaveLength(1)
    expect(folded[0]!.hits[0]!.ranges).toEqual([[0, 4], [10, 15]])
    // 'RETRY' never appears verbatim in the document.
    expect(searchSessions(pool, 'AUTH RETRY', { scope: 'all', caseSensitive: true })).toEqual([])
    const sensitive = searchSessions(pool, 'AUTH Retry', { scope: 'all', caseSensitive: true })
    expect(sensitive).toHaveLength(1)
    expect(sensitive[0]!.hits[0]!.ranges).toEqual([[0, 4], [10, 15]])
  })

  it('keeps a quoted phrase as one term with literal spaces', () => {
    const pool = [make('auth: retry logic explained'), make('auth and retry and logic')]
    const hits = searchSessions(pool, 'auth "retry logic"', { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits[0]!.text).toBe('auth: retry logic explained')
    expect(hits[0]!.hits[0]!.ranges).toEqual([[0, 4], [6, 17]])
  })

  it('treats an unclosed quote as running to the end of the query', () => {
    const pool = [make('the retry logic holds')]
    expect(searchSessions(pool, 'auth "retry logic', { scope: 'all' })).toEqual([])
    const hits = searchSessions(pool, '"retry logic', { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits[0]!.ranges).toEqual([[4, 15]])
  })

  it('matches nothing when the query parses to no terms', () => {
    const pool = [make('auth note'), make('"" quoted')]
    expect(searchSessions(pool, '""', { scope: 'all' })).toEqual([])
    expect(searchSessions(pool, '"   "', { scope: 'all' })).toEqual([])
    expect(searchSessions(pool, '""  ""', { scope: 'all' })).toEqual([])
    expect(searchSessions(pool, '', { scope: 'all' })).toEqual([])
  })

  it('drops terms beyond the cap before matching', () => {
    const capped = Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `w${i}`)
    const withAll = make(capped.join(' ')) // holds w0..w15
    const missingOne = make(
      [...capped.slice(0, MAX_QUERY_TERMS - 1), 'w16'].join(' '), // w0..w14, w16 — no w15
    )
    // 17 distinct terms: the 17th (w16) is dropped by the cap, so the
    // document missing w15 does not match while the complete one does.
    const query = [...capped, 'w16'].join(' ')
    const hits = searchSessions([withAll, missingOne], query, { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.session).toBe(withAll)
  })

  it('merges nested and overlapping term ranges into disjoint highlights', () => {
    const pool = [make('auth inside authentication flows')]
    const hits = searchSessions(pool, 'auth authentication', { scope: 'all' })
    expect(hits).toHaveLength(1)
    const hit = hits[0]!.hits[0]!
    expect(hit.ranges).toEqual([[0, 4], [12, 26]]) // 'auth' at 12..16 absorbed
    expect(hits[0]!.total).toBe(2)
    for (let i = 1; i < hit.ranges.length; i++) {
      expect(hit.ranges[i]![0]).toBeGreaterThanOrEqual(hit.ranges[i - 1]![1])
    }
    // Overlapping (not just nested) terms merge the same way.
    const overlap = searchSessions([make('abc')], '"ab" "bc"', { scope: 'all' })
    expect(overlap).toHaveLength(1)
    expect(overlap[0]!.hits[0]!.ranges).toEqual([[0, 3]])
    expect(overlap[0]!.total).toBe(1)
  })

  it('keeps regex mode one whole pattern: the space stays part of it', () => {
    const pool = [make('auth retry'), make('auth X retry')]
    // Term-splitting would match BOTH documents; as one pattern, only the
    // document with the literal space does.
    const hits = searchSessions(pool, 'auth retry', { scope: 'all', regex: true })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits[0]!.text).toBe('auth retry')
    expect(hits[0]!.hits[0]!.ranges).toEqual([[0, 10]])
    // A pattern using the space structurally is untouched by parsing.
    const structural = searchSessions(pool, 'auth . retry', { scope: 'all', regex: true })
    expect(structural).toHaveLength(1)
    expect(structural[0]!.hits[0]!.text).toBe('auth X retry')
    expect(structural[0]!.hits[0]!.ranges).toEqual([[0, 12]])
    // Contrast: the same query as substrings ANDs per document — both hit.
    expect(searchSessions(pool, 'auth retry', { scope: 'all' })).toHaveLength(2)
  })

  it('applies the repo scope and the time window to multi-term queries', () => {
    const now = Date.now()
    const day = 86_400_000
    const inRepo = make('auth retry note', { cwd: 'D:/work/repo-auth', modifiedAt: now - day })
    const otherRepo = make('auth retry note', { cwd: 'D:/work/other', modifiedAt: now - day })
    const stale = make('auth retry note', { cwd: 'D:/work/repo-auth', modifiedAt: now - 40 * day })
    const pool = [inRepo, otherRepo, stale]

    expect(searchSessions(pool, 'auth retry', { scope: 'all' })).toHaveLength(3)
    // Repo scope keeps both repo-cwd sessions regardless of age...
    const repo = searchSessions(pool, 'auth retry', { scope: 'repo', repoCwd: 'D:/work/repo-auth' })
    expect(repo).toHaveLength(2)
    expect(repo.map(hit => hit.session)).toEqual([inRepo, stale])
    // ...the time window alone keeps the two fresh sessions...
    expect(searchSessions(pool, 'auth retry', { scope: 'all', sinceMs: now - 7 * day })).toHaveLength(2)
    // ...and together only the fresh in-repo session survives.
    const windowed = searchSessions(pool, 'auth retry', {
      scope: 'repo',
      repoCwd: 'D:/work/repo-auth',
      sinceMs: now - 7 * day,
    })
    expect(windowed).toHaveLength(1)
    expect(windowed[0]!.session).toBe(inRepo)
  })

  it('keeps single-term behavior identical (folded ranges, CJK, sensitivity)', () => {
    const pool = [make('İa AUTH İb auth'), make('指数退避与抖动')]
    const hits = searchSessions(pool, 'auth', { scope: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.hits[0]!.ranges).toEqual([[3, 7], [11, 15]]) // original-string offsets
    expect(hits[0]!.total).toBe(2)
    const cjk = searchSessions(pool, '指数退避', { scope: 'all' })
    expect(cjk).toHaveLength(1)
    expect(cjk[0]!.hits[0]!.ranges).toEqual([[0, 4]])
    expect(searchSessions(pool, 'AUTH', { scope: 'all', caseSensitive: true })[0]!.hits[0]!.ranges).toEqual([[3, 7]])
    expect(searchSessions(pool, 'auth', { scope: 'all', caseSensitive: true })[0]!.hits[0]!.ranges).toEqual([[11, 15]])
  })

  it('stays idempotent across repeated multi-term searches (shared fold cache)', () => {
    const pool = [make('auth fixed by retrying')]
    const first = searchSessions(pool, 'auth retry', { scope: 'all' })
    const second = searchSessions(pool, 'auth retry', { scope: 'all' })
    expect(second).toEqual(first)
    expect(flatHits(second)[0]!.ranges).toEqual([[0, 4], [14, 19]])
  })
})

describe('title-only matching', () => {
  it('searches title documents alone — message hits disappear', () => {
    const pool = [
      make('unused body', { title: 'auth retry session' }),
      make('auth retry body', { title: 'unrelated title' }),
    ]
    expect(searchSessions(pool, 'auth', { scope: 'all' })).toHaveLength(2)
    const titleOnly = searchSessions(pool, 'auth', { scope: 'all', titleOnly: true })
    expect(titleOnly).toHaveLength(1)
    expect(titleOnly[0]!.hits).toHaveLength(1)
    expect(titleOnly[0]!.hits[0]!.kind).toBe('title')
    expect(titleOnly[0]!.hits[0]!.ranges).toEqual([[0, 4]])
    expect(titleOnly[0]!.total).toBe(1)
  })

  it('cannot match a session without an indexed title (display fallback is not content)', () => {
    const untitled = make('auth in body')
    expect(searchSessions([untitled], 'auth', { scope: 'all' })).toHaveLength(1)
    expect(searchSessions([untitled], 'auth', { scope: 'all', titleOnly: true })).toHaveLength(0)
  })

  it('keeps the per-document AND inside the title', () => {
    const both = make('auth elsewhere', { title: 'auth retry notes' })
    const split = make('retry here', { title: 'auth notes' })
    const hits = searchSessions([both, split], 'auth retry', { scope: 'all', titleOnly: true })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.session).toBe(both)
    expect(hits[0]!.hits[0]!.ranges).toEqual([[0, 4], [5, 10]])
  })

  it('extends pinyin and regex matching to the title', () => {
    const chinese = make('nothing here', { title: '重庆调研' })
    const pinyin = searchSessions([chinese], 'chongqing', { scope: 'all', titleOnly: true, pinyin: true })
    expect(pinyin).toHaveLength(1)
    expect(pinyin[0]!.hits[0]!.ranges).toEqual([[0, 2]])
    const patterned = make('plain body', { title: 'auth-retry v2' })
    const regex = searchSessions([patterned], 'v\\d', { scope: 'all', titleOnly: true, regex: true })
    expect(regex).toHaveLength(1)
    expect(regex[0]!.hits[0]!.ranges).toEqual([[11, 13]])
    // In full mode the same session still matches - through the title (the
    // body 'plain body' carries no match), with the title as the only hit.
    const full = searchSessions([patterned], 'v\\d', { scope: 'all', regex: true })
    expect(full).toHaveLength(1)
    expect(full[0]!.hits.map(hit => hit.kind)).toEqual(['title'])
  })
})
