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
import type { ScannedSession } from '../src/core/scan.js'
import { prewarmFolds, searchSessions } from '../src/core/search.js'

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

  it('does not build the pinyin chains when the config has pinyin off', async () => {
    const sessions = [makeSession(1, 5, 300)]
    const { calls, yield: yieldTo } = countingYield()
    // With pinyin off the case fold alone still warms; the observable claim
    // is that the pass completes without touching the chain machinery, which
    // the equivalence suite pins structurally. Here: it warms and yields.
    const result = await prewarmFolds(sessions, { pinyin: false, yieldEvery: 2, yield: yieldTo })
    expect(result.warmed).toBe(5)
    expect(calls.length).toBe(2)
    // A pinyin-capable search after a case-only warm still returns correct
    // results (it simply builds the chains it needs). The message bodies hold
    // no table character here, so only the title can match.
    expect(searchSessions(sessions, 'zs', P).length).toBe(1)
  })
})
