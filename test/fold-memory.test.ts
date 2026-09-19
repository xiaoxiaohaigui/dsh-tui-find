/**
 * The fold's REPRESENTATION, not its contents: what the cached fold costs in
 * retained heap.
 *
 * `test/fold-equivalence.test.ts` compares every table of a built fold against
 * the frozen reference, and `test/search-baseline.test.ts` compares search
 * results against the frozen pre-perf revision — both are blind to this
 * failure mode, because a ConsString tree scans exactly like a flat string.
 * V8 represents repeated concatenation as such a tree (a rope, ~30 bytes per
 * appended piece) and collapses it only when something reads the string. A
 * fold built inside a query is read at once by the `indexOf` that follows, so
 * the tree never survived; `prewarmFolds` caches folds nobody reads — with
 * `pinyin` on, its case-fold half is never read at all — which is how a
 * per-code-point build parked ~180 MB of heap (and 643 MB on the pinyin
 * chains) on a 4.8M-character index (REVIEW.md R-083).
 *
 * So the assertion is on retained heap per index character, with a full GC
 * settled on both sides of the build. `foldTextForTest` / `pinyinFoldsForTest`
 * are the very builders the caches hold, and the corpus is the plugin's own
 * shape (ASCII/CJK mix, `maxMessageChars`-sized bodies), so what is measured
 * is what the plugin keeps after a warm-up sweep.
 *
 * Thresholds are absolute bytes per character — the unit the memory model is
 * written in — and they depend on how V8 stores a string, not on machine
 * speed. Each sits between the two measured sides (see each test).
 *
 * What makes these assertions red is a `FoldSink.take` that CONCATENATES its
 * pieces instead of joining them (measured 37.4 and 68.0 bytes/char, below).
 * Disabling the flush alone is NOT a red control: the split `take` does before
 * joining keeps the result flat even with a single unbounded buffer, so only
 * the join itself carries the guarantee.
 */
import vm from 'node:vm'
import v8 from 'node:v8'
import { describe, expect, it } from 'vitest'
import { foldTextForTest, pinyinFoldsForTest } from '../src/core/search.js'

// A plain Node test process carries no `gc`; the flag can still be set at
// runtime and applies to contexts created afterwards, which is all the probe
// needs. Asserted below rather than silently skipped — a memory test that
// measures nothing is worse than no test.
v8.setFlagsFromString('--expose-gc')
const forceGc = vm.runInNewContext('gc') as (() => void) | undefined

/** Bytes of heap retained per character on the whole corpus. */
type RetainedPerChar = number

const settle = async (): Promise<void> => {
  for (let at = 0; at < 3; at++) {
    forceGc?.()
    await new Promise(resolve => setImmediate(resolve))
  }
}

/**
 * Retained bytes per index character of whatever `build` keeps alive: the
 * heapUsed delta across the build, with a full GC settled on both sides, taken
 * as the MINIMUM of `attempts` runs. Background noise can only inflate a
 * sample, so the minimum is the closest estimate of true retention; `kept`
 * holds the results while the second GC runs, and is emptied before the next
 * attempt so the runs do not stack.
 */
async function retainedPerChar(
  build: (kept: unknown[]) => void,
  chars: number,
  attempts = 3,
): Promise<RetainedPerChar> {
  let best = Number.POSITIVE_INFINITY
  const kept: unknown[] = []
  for (let attempt = 0; attempt < attempts; attempt++) {
    await settle()
    const before = process.memoryUsage().heapUsed
    build(kept)
    await settle()
    best = Math.min(best, (process.memoryUsage().heapUsed - before) / chars)
    kept.length = 0
  }
  await settle()
  return best
}

// ── the corpus: the plugin's own shape, deterministic ──────────────────────

const MESSAGES = 400
const CHARS = 1200

const ASCII_WORDS =
  'the and with from this that data text line path file node user auth token retry queue frame decode buffer request response session message scanner watermark preview highlight search index config plugin window render commit merge cache header content value'.split(
    ' ',
  )
const CJK_WORDS = [
  '中文搜索',
  '预览窗口',
  '会话记录',
  '折叠缓存',
  '索引构建',
  '高亮区间',
  '性能优化',
  '重试请求',
  '长沙分行',
  '银行数据',
  '北京节点',
  '配置项',
  '解析日志',
  '渲染文本',
  '消息队列',
  '文档内容',
]

/** `MESSAGES` bodies of `CHARS` units, half ASCII / half CJK — the mix the
 *  fold benchmark and the memory measurements in REVIEW.md R-083 use, so the
 *  thresholds below stay comparable to those numbers. */
function corpus(): string[] {
  const out: string[] = []
  for (let message = 0; message < MESSAGES; message++) {
    let state = (message * 2654435761 + 0x9e3779b9) >>> 0
    const next = (): number => (state = (state * 1664525 + 1013904223) >>> 0)
    let body = ''
    while (body.length < CHARS) {
      const words = next() % 2 === 0 ? ASCII_WORDS : CJK_WORDS
      const sentence = words[next() % words.length]!
      body += `${body.length === 0 ? '' : ' '}${sentence}`
    }
    out.push(body.slice(0, CHARS))
  }
  return out
}

const TEXTS = corpus()
const TOTAL_CHARS = TEXTS.reduce((sum, text) => sum + text.length, 0)

describe('fold memory', () => {
  it('can force a full GC in a plain test process', () => {
    expect(typeof forceGc).toBe('function')
  })

  it('caches a flat case fold, not a ConsString tree', async () => {
    // Both sides measured on this corpus, minimum of three settled attempts:
    // 1.4 bytes/char flat (the folded string is UTF-16, so 2 is the floor and
    // a noise-biased sample reads lower) against 37.4 with a concatenating
    // `take`. The threshold sits between them, ~5x from each.
    const perChar = await retainedPerChar(kept => {
      for (const text of TEXTS) kept.push(foldTextForTest(text))
    }, TOTAL_CHARS)
    expect(perChar).toBeLessThan(8)
  })

  it('caches flat pinyin chains too, not four ropes per document', async () => {
    // The chains are inherently long (every character expands to one or more
    // readings, and the `all*` chains repeat alternating readings), so the
    // flat cost is a real ~4.9 bytes/char rather than the case fold's 1.4; the
    // concatenating `take` measured 68.0. The threshold sits between them, 4x
    // from each.
    const perChar = await retainedPerChar(kept => {
      for (const text of TEXTS) kept.push(pinyinFoldsForTest(text, false))
    }, TOTAL_CHARS)
    expect(perChar).toBeLessThan(20)
  })
})
