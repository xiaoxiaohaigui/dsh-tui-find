/**
 * The background fold prewarm (`prewarmFolds`, staged plan phase 1b): the
 * second half of `warmup.tsx`'s sweep, which builds the fold caches the
 * user's first keystroke would otherwise buy on the frame they type into.
 *
 * The pass is a BUDGET, never a dependency — those are the properties pinned
 * here: it walks titles and messages, it stops on the document cap, the wall
 * clock cap and the abort signal, it yields to the event loop as it goes
 * (tested with an injected yield, so no timers are involved), and what it
 * builds is the search's own cache rather than a copy of it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import { PINYIN_READINGS } from '../src/core/pinyin-data.js'
import type { ScannedSession } from '../src/core/scan.js'
import {
  foldIsCachedForTest,
  pinyinFoldsAreCachedForTest,
  prewarmFolds,
  searchSessions,
} from '../src/core/search.js'

/** A session whose messages hold `chars` characters of mixed text each. */
function makeSession(id: number, messages: number, chars: number, title?: string): ScannedSession {
  const list: IndexedMessage[] = []
  for (let at = 0; at < messages; at++) {
    let text = ''
    while (text.length < chars) text += `${text.length === 0 ? '' : ' '}auth 张三 retry 搜索 queue 预览`
    list.push({ seq: at + 1, role: 'user', text: text.slice(0, chars), at: undefined })
  }
  return {
    id: `s${id}`,
    path: `P:\\warm\\s${id}\\session.jsonl`,
    bytes: messages * chars,
    modifiedAt: 1_700_000_000_000 - id,
    ...(title === undefined ? {} : { title }),
    header: { cwd: 'P:\\warm', createdAt: undefined },
    messages: list,
  }
}

/** A yielding stand-in that counts its calls instead of scheduling timers. */
function countingYield() {
  const calls: number[] = []
  return {
    calls,
    yield: async (): Promise<void> => {
      calls.push(1)
    },
  }
}

const P = { scope: 'all', pinyin: true } as const

/** One session's first message — the object whose fold the search caches, and
 *  so the key the prewarm has to fill (see `prewarmFolds`). */
function firstMessage(session: ScannedSession): IndexedMessage {
  const message = session.messages[0]
  if (message === undefined) throw new Error('fixture session has no messages')
  return message
}

/** A search result's hit ranges per session, in order — comparable across
 *  two fixtures whose only difference is their identity (id, path,
 *  modifiedAt). */
function hitRangesBySession(
  results: ReturnType<typeof searchSessions>,
): (readonly (readonly [number, number])[])[] {
  return results.map(entry => entry.hits.map(hit => hit.ranges))
}

describe('prewarmFolds', () => {
  it('folds titles and every message, reporting progress', async () => {
    const sessions = [makeSession(1, 3, 200, 'titled'), makeSession(2, 2, 200)]
    const seen: { resolved: number; total: number; warmed: number }[] = []
    const result = await prewarmFolds(sessions, {
      pinyin: true,
      yield: async () => {},
      onProgress: progress => seen.push(progress),
    })
    // 2 sessions x (1 title each? no: only session 1 has one) + 5 messages.
    expect(result.total).toBe(6)
    expect(result.warmed).toBe(6)
    expect(result.timedOut).toBe(false)
    expect(seen.at(-1)).toEqual({ resolved: 6, total: 6, warmed: 6 })
  })

  it('stops at the document cap and reports the timeout', async () => {
    const sessions = [makeSession(1, 10, 200), makeSession(2, 10, 200)]
    const result = await prewarmFolds(sessions, { maxMessages: 4, yield: async () => {} })
    expect(result.warmed).toBe(4)
    expect(result.total).toBe(20)
    expect(result.timedOut).toBe(true)
  })

  it('stops at the wall-clock cap', async () => {
    const sessions = [makeSession(1, 40, 400)]
    let clock = 0
    // Each yield advances the fake clock past the budget.
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 50))
    try {
      const result = await prewarmFolds(sessions, { maxMs: 100, yieldEvery: 1, yield: async () => {} })
      expect(result.timedOut).toBe(true)
      expect(result.warmed).toBeLessThan(40)
    } finally {
      now.mockRestore()
    }
  })

  it('stops on the abort signal at the next yield', async () => {
    const sessions = [makeSession(1, 40, 400)]
    const controller = new AbortController()
    const result = await prewarmFolds(sessions, {
      yieldEvery: 2,
      signal: controller.signal,
      yield: async () => {
        controller.abort()
      },
    })
    expect(result.warmed).toBe(2)
    expect(result.timedOut).toBe(false)
  })

  it('yields on its own cadence instead of folding everything in one tick', async () => {
    const sessions = [makeSession(1, 25, 200)]
    const { calls, yield: yieldTo } = countingYield()
    await prewarmFolds(sessions, { yieldEvery: 5, yield: yieldTo })
    expect(calls).toHaveLength(5)
  })

  it('hands the search warm folds: the first query no longer builds them', async () => {
    // Big enough that a cold fold build is unmistakable against the noise
    // floor, small enough to stay a fast unit test.
    const sessions = [makeSession(1, 60, 4_000)]
    const before = Date.now()
    const first = searchSessions(sessions, 'a', P)
    const coldMs = Date.now() - before
    const second = Date.now()
    const again = searchSessions(sessions, 'a', P)
    const warmMs = Date.now() - second
    // The two runs agree exactly (the prewarm changes no result).
    expect(JSON.stringify(again)).toBe(JSON.stringify(first))

    // A fresh index, prewarmed: the first query behaves like the warm one.
    const fresh = [makeSession(1, 60, 4_000)]
    await prewarmFolds(fresh, { pinyin: true, yield: async () => {} })
    const third = Date.now()
    const prewarmed = searchSessions(fresh, 'a', P)
    const prewarmedMs = Date.now() - third
    expect(JSON.stringify(prewarmed)).toBe(JSON.stringify(first))
    // Guard against a machine too fast for the comparison to mean anything:
    // the cold build must at least have been measurable.
    if (coldMs >= 5) {
      expect(prewarmedMs).toBeLessThanOrEqual(Math.max(warmMs * 4, coldMs))
    }
  })

  it('fills exactly the cache entries the search reads, in the shape it probes', async () => {
    // Small fixtures: this case is about WHICH cache keys exist, not how long
    // anything takes (the timing case above covers the wall clock).
    //
    // The search resolves a document's folds through `foldOf` /
    // `pinyinFoldsOf`, which answer from these caches for a cached owner — so
    // "the entry exists" is the structural form of "the first keystroke does
    // not build it", and it does not depend on the machine's speed.
    const unwarmed = [makeSession(1, 2, 200)]
    const unwarmedMessage = firstMessage(unwarmed[0]!)
    expect(foldIsCachedForTest(unwarmedMessage)).toBe(false)
    expect(pinyinFoldsAreCachedForTest(unwarmedMessage, false)).toBe(false)

    const warmed = [makeSession(2, 2, 200)]
    const warmedMessage = firstMessage(warmed[0]!)
    const result = await prewarmFolds(warmed, { pinyin: true, yield: async () => {} })
    expect(result.warmed).toBe(2)
    expect(foldIsCachedForTest(warmedMessage)).toBe(true)
    expect(pinyinFoldsAreCachedForTest(warmedMessage, false)).toBe(true)

    // Case folds only when the config has pinyin off: the pinyin entry must
    // stay absent, which is what the old `warmed === 5` smoke assertion could
    // only claim through the equivalence suite.
    const caseOnly = [makeSession(3, 2, 200)]
    const caseOnlyMessage = firstMessage(caseOnly[0]!)
    await prewarmFolds(caseOnly, { pinyin: false, yield: async () => {} })
    expect(foldIsCachedForTest(caseOnlyMessage)).toBe(true)
    expect(pinyinFoldsAreCachedForTest(caseOnlyMessage, false)).toBe(false)

    // A pinyin-capable search after the case-only warm still returns the
    // same hit ranges as a fully warmed one (it simply builds the chains it
    // needs). Compared per session: the two fixtures differ in their identity
    // (id, path, modifiedAt), so their full result JSON could never be equal.
    expect(hitRangesBySession(searchSessions(caseOnly, 'zs', P))).toEqual(
      hitRangesBySession(searchSessions(warmed, 'zs', P)),
    )
  })

  it('warms the case-sensitive pinyin shape when that is the configured one', async () => {
    // The sensitivity rides the cached pinyin entry, so prewarming the
    // insensitive shape leaves the first sensitive letter key paying the whole
    // build. The two cases pin the contract from both sides.
    const sensitive = [makeSession(1, 2, 300)]
    const sensitiveMessage = firstMessage(sensitive[0]!)
    await prewarmFolds(sensitive, { pinyin: true, caseSensitive: true, yield: async () => {} })
    expect(pinyinFoldsAreCachedForTest(sensitiveMessage, true)).toBe(true)
    expect(pinyinFoldsAreCachedForTest(sensitiveMessage, false)).toBe(false)
    // The warm is READ, not merely written: the sensitive query below finds
    // the folded-entry key it probes (a shape mismatch would have rebuilt it
    // and overwritten the entry).
    const options = { scope: 'all', pinyin: true, caseSensitive: true } as const
    expect(searchSessions(sensitive, 'zs', options)).toHaveLength(1)
    expect(pinyinFoldsAreCachedForTest(sensitiveMessage, true)).toBe(true)

    const insensitive = [makeSession(2, 2, 300)]
    const insensitiveMessage = firstMessage(insensitive[0]!)
    await prewarmFolds(insensitive, { pinyin: true, caseSensitive: false, yield: async () => {} })
    expect(pinyinFoldsAreCachedForTest(insensitiveMessage, false)).toBe(true)
    expect(pinyinFoldsAreCachedForTest(insensitiveMessage, true)).toBe(false)
    expect(searchSessions(insensitive, 'zs', P)).toHaveLength(1)
    expect(pinyinFoldsAreCachedForTest(insensitiveMessage, false)).toBe(true)
  })

  it('warms exactly the documents the generated table can read', async () => {
    // The prewarm's "does this text hold a table character" scan is bounded by
    // the table's own lowest code point, so the boundary is the property worth
    // pinning — not the behaviour of one hard-coded range. Both sides are
    // derived from the table HERE, so the case cannot go stale when the
    // generator moves: the lowest table character must be warmed, and a code
    // point below the minimum (no reading can be built from it) must not be.
    // A literal bound fails the second half: 0x2E80 treats CJK Ext-A and the
    // Kangxi radicals as table text and caches a fold build that can never
    // match anything (see MIN_TABLE_CODE_POINT).
    const tableMin = Math.min(...Object.keys(PINYIN_READINGS).map(char => char.codePointAt(0)!))
    const lowest = String.fromCodePoint(tableMin)
    expect(PINYIN_READINGS[lowest], 'the lowest table code point is a table entry').toBeDefined()
    const belowMin = tableMin - 1
    expect(PINYIN_READINGS[String.fromCodePoint(belowMin)], 'the code point below it is not').toBeUndefined()

    /** A one-message session holding exactly `text`. */
    const sessionWith = (id: number, text: string): ScannedSession => {
      const message: IndexedMessage = { seq: 1, role: 'user', text, at: undefined }
      return {
        id: `min-${id}`,
        path: `P:\\warm\\min\\${id}.jsonl`,
        bytes: text.length,
        modifiedAt: 1_700_000_000_000 - id,
        header: { cwd: 'P:\\warm', createdAt: undefined },
        messages: [message],
      }
    }

    const covered = sessionWith(1, lowest.repeat(20))
    await prewarmFolds([covered], { pinyin: true, yield: async () => {} })
    expect(foldIsCachedForTest(firstMessage(covered))).toBe(true)
    expect(pinyinFoldsAreCachedForTest(firstMessage(covered), false)).toBe(true)

    for (const [at, code] of [0x2e80, 0x2f00, 0x3400, belowMin].entries()) {
      if (code >= tableMin) continue
      const uncovered = sessionWith(10 + at, String.fromCodePoint(code).repeat(20))
      await prewarmFolds([uncovered], { pinyin: true, yield: async () => {} })
      expect(foldIsCachedForTest(firstMessage(uncovered)), `U+${code.toString(16)}: case fold`).toBe(true)
      expect(
        pinyinFoldsAreCachedForTest(firstMessage(uncovered), false),
        `U+${code.toString(16)}: no reading exists, so no pinyin chains`,
      ).toBe(false)
    }
  })

  it('does not build the pinyin chains when the config has pinyin off', async () => {
    const sessions = [makeSession(1, 5, 300)]
    const { calls, yield: yieldTo } = countingYield()
    // The structural claim — the pinyin cache entries stay absent while the
    // case entries are filled — is pinned above ("fills exactly the cache
    // entries the search reads"); this case keeps the pass's own accounting
    // and yield cadence under a pinyin-off config.
    const result = await prewarmFolds(sessions, { pinyin: false, yieldEvery: 2, yield: yieldTo })
    expect(result.warmed).toBe(5)
    expect(calls.length).toBe(2)
    // A pinyin-capable search after a case-only warm still returns correct
    // results (it simply builds the chains it needs). The message bodies hold
    // no table character here, so only the title can match.
    expect(searchSessions(sessions, 'zs', P).length).toBe(1)
  })
})
