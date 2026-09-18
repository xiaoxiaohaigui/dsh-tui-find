#!/usr/bin/env node
/**
 * Search-pipeline benchmark probe (the task file's phase 0).
 *
 * Synthesizes an in-memory index of the scanner's shape (ScannedSession
 * objects — never a real log sweep; the decode path is out of scope) and
 * measures the keystroke-cost scenarios the performance plan names: the
 * FIRST letter query on an index (which pays the pinyin fold build), the same
 * query warm, rarer single-letter needles, a CJK needle (case fold only), the
 * letter needle with `pinyin: false`, a case-sensitive verbatim scan, and the
 * memory each stage leaves behind. An optional `--scenario preview` half
 * measures the reader's re-wrap instead (buildPreviewLines per keystroke).
 *
 * Every number is wall-clock on THIS machine: absolute milliseconds are only
 * comparable against a run of the same command on the same host, which is why
 * the plan re-bases its thresholds per implementation machine instead of
 * hard-coding them into tests.
 *
 * The COLD group runs each measurement on a freshly built index (fresh
 * `ScannedSession` objects ⇒ empty fold caches), so "first letter" really is
 * the first fold build. The WARM group runs on ONE index after a full
 * warm-up query, so those numbers are the per-keystroke steady state the
 * user's second and later keystrokes pay. The index composition report says
 * what the synthetic corpus actually contains (table-character share, shape
 * shares, average message length), because a fold benchmark is meaningless
 * without knowing how much of the text can expand into readings.
 *
 * Usage:
 *   node --expose-gc scripts/bench-search.mjs [options]
 *
 *   --sessions <n>     sessions in the synthetic index      (default 100)
 *   --messages <n>     messages per session                 (default 40)
 *   --chars <n>        characters per message               (default 1200)
 *   --ascii <0..1>     ASCII share of the body characters   (default 0.5)
 *   --title <text>     session title; also the TEXT query   (default 'auth flow')
 *   --letter <text>    the first/hot letter needle          (default 'a')
 *   --letter2 <text>   a second, rarer letter needle        (default 'q')
 *   --cjk <text>       the CJK needle, case fold only       (default '中文')
 *   --repeats <n>      timed repetitions per scenario       (default 3)
 *   --scenario <name>  all | search | preview               (default all)
 *   --json             emit JSON instead of tables
 *   --no-gc            skip the forced GC before memory reads (nosier)
 *
 * Requires a built `dist/` (`npm run build`): the probe imports the compiled
 * module exactly as the plugin runs it, so the numbers measure shipped code.
 * Deliberately NOT part of `npm test` — one run is seconds long and its
 * absolutes are machine-specific.
 *
 * @module scripts/bench-search
 */
import { availableParallelism, cpus, totalmem } from 'node:os'

const args = process.argv.slice(2)

function option(name, fallback) {
  const at = args.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) return true
  return value
}

const sessions = Number(option('sessions', 100))
const messages = Number(option('messages', 40))
const chars = Number(option('chars', 1200))
const asciiShare = Number(option('ascii', 0.5))
const titleText = String(option('title', 'auth flow'))
const letterNeedle = String(option('letter', 'a'))
const letterNeedle2 = String(option('letter2', 'q'))
const cjkNeedle = String(option('cjk', '中文'))
const repeats = Number(option('repeats', 3))
const scenarioName = String(option('scenario', 'all'))
const asJson = option('json', false) === true
const useGc = option('no-gc', false) !== true

for (const [name, value] of [
  ['sessions', sessions],
  ['messages', messages],
  ['chars', chars],
  ['repeats', repeats],
]) {
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`bench-search: --${name} must be a positive integer, got ${value}`)
    process.exit(2)
  }
}
if (!(asciiShare >= 0 && asciiShare <= 1)) {
  console.error(`bench-search: --ascii must be within [0,1], got ${asciiShare}`)
  process.exit(2)
}
if (!['all', 'search', 'preview'].includes(scenarioName)) {
  console.error(`bench-search: --scenario must be all|search|preview, got ${scenarioName}`)
  process.exit(2)
}

let searchSessions
let buildPreviewLines
let prewarmFolds
try {
  ;({ searchSessions, prewarmFolds } = await import('../dist/core/search.js'))
  if (scenarioName !== 'search') ({ buildPreviewLines } = await import('../dist/preview.js'))
} catch (error) {
  console.error(
    `bench-search: cannot import dist/ (${error instanceof Error ? error.message : String(error)}) — run \`npm run build\` first`,
  )
  process.exit(1)
}

// ── the synthetic corpus ──────────────────────────────────────────────────

/** ASCII body vocabulary — ordinary log/prose words, none over 12 units, so a
 *  single-letter needle hits a realistic minority of them. */
const ASCII_WORDS = [
  'the',
  'and',
  'with',
  'from',
  'this',
  'that',
  'data',
  'text',
  'line',
  'path',
  'file',
  'node',
  'user',
  'auth',
  'token',
  'retry',
  'queue',
  'frame',
  'decode',
  'buffer',
  'request',
  'response',
  'session',
  'message',
  'scanner',
  'watermark',
  'preview',
  'highlight',
  'search',
  'index',
  'config',
  'plugin',
  'window',
  'render',
  'commit',
  'merge',
  'cache',
  'header',
  'content',
  'value',
]
/** CJK body vocabulary: common table characters, mostly single-reading so the
 *  fold chains stay honest, plus a few real polyphones (重/长/行/乐) that the
 *  reading chains must carry. */
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
const ASCII_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

const pick = (list, seed) => list[seed % list.length]

/** A sentence of `chunk` characters from one vocabulary (a word separator is
 *  charged against the chunk once it is non-empty). */
function chunkOf(list, chunk, next) {
  let out = ''
  while (out.length < chunk) {
    out += `${out.length === 0 ? '' : ' '}${pick(list, next())}`
  }
  return out.slice(0, chunk)
}

/**
 * One message body: alternating ASCII/CJK ORIGINAL sentences joined by
 * newlines, trimmed to `chars` UTF-16 units. Deterministic (a seeded LCG per
 * message plus the index's own `seedOffset`) so two runs of the same command
 * measure the same text.
 *
 * `seedOffset` is what keeps separate INDEXES textually distinct. Two
 * `makeIndex` calls that produced identical strings would let V8 dedupe them
 * into one object, and the per-object fold cache would then be warm on the
 * "fresh" index — a cold scenario that silently measures nothing.
 */
function makeBody(seed, targetChars) {
  let state = (seed * 2654435761 + 0x9e3779b9) >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
  let out = ''
  while (out.length < targetChars) {
    const ascii = (next() % 1000) / 1000 < asciiShare
    const sentence = chunkOf(ascii ? ASCII_WORDS : CJK_WORDS, 60 + (next() % 40), next)
    out += `${out.length === 0 ? '' : '\n'}${sentence}`
  }
  return out.slice(0, targetChars)
}

function makeIndex(sessionCount, messageCount, bodyChars, seedOffset = 0) {
  const out = []
  for (let session = 0; session < sessionCount; session++) {
    const messageList = []
    for (let message = 0; message < messageCount; message++) {
      messageList.push({
        seq: message + 1,
        role: message % 3 === 0 ? 'user' : message % 3 === 1 ? 'assistant' : 'tool',
        text: makeBody(seedOffset + session * messageCount + message + 1, bodyChars),
        at: undefined,
      })
    }
    out.push({
      id: `bench-session-${session}`,
      path: `P:\\bench\\bench-session-${session}\\session.jsonl`,
      bytes: messageCount * bodyChars,
      modifiedAt: 1_700_000_000_000 - session,
      title: `${titleText} ${session}`,
      header: { cwd: 'P:\\bench\\repo', createdAt: undefined },
      messages: messageList,
    })
  }
  return out
}

// A build copy is enough for the composition report — every index the probe
// builds carries the same seeded text, so counting once is exact.
const report = makeIndex(sessions, messages, chars)
const composition = {
  sessions,
  messagesPerSession: messages,
  charsPerMessage: chars,
  asciiShare,
  totalChars: 0,
  asciiChars: 0,
  cjkChars: 0,
  nonBmpChars: 0,
  newlines: 0,
}
{
  let asciiUnits = 0
  let cjkUnits = 0
  let otherUnits = 0
  for (const session of report) {
    for (const message of session.messages) {
      const text = message.text
      composition.totalChars += text.length
      for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at)
        if (code >= 0xd800 && code <= 0xdbff) {
          composition.nonBmpChars += 1
          at += 1
          otherUnits += 1
        } else if (code === 0x0a) {
          composition.newlines += 1
          otherUnits += 1
        } else if (code >= 0x20 && code <= 0x7e) {
          asciiUnits += 1
        } else {
          cjkUnits += 1
        }
      }
    }
  }
  composition.asciiChars = asciiUnits
  composition.cjkChars = cjkUnits
  composition.otherUnits = otherUnits
  composition.asciiShareActual = Number((asciiUnits / composition.totalChars).toFixed(3))
}

// ── measurement ───────────────────────────────────────────────────────────

const gc = () => {
  if (useGc && typeof globalThis.gc === 'function') {
    globalThis.gc()
    globalThis.gc()
  }
}

const memory = () => {
  const usage = process.memoryUsage()
  return {
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
  }
}

const mb = bytes => Number((bytes / 1024 / 1024).toFixed(1))

/**
 * Run `fn` `repeats` times; report the median, min and max. A single sample
 * on a noisy desktop is a coin flip, and the median is the least misleading
 * summary of a handful of runs without pretending to a percentile.
 */
function timed(fn) {
  const samples = []
  let result
  for (let at = 0; at < repeats; at++) {
    const started = process.hrtime.bigint()
    result = fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((left, right) => left - right)
  return { ms: samples[(samples.length - 1) >> 1], min: samples[0], max: samples[samples.length - 1], result }
}

const row = (name, note, measurement, extra = {}) => ({
  name,
  note,
  ms: Number(measurement.ms.toFixed(1)),
  min: Number(measurement.min.toFixed(1)),
  max: Number(measurement.max.toFixed(1)),
  hits: extra.hits ?? null,
  total: extra.total ?? null,
  lines: extra.lines ?? null,
})

/** One query, reporting the median plus the result shape (sessions matched,
 *  highlight spans) that explains where the time went. */
function queryOnce(list, query, options) {
  let hits = 0
  let total = 0
  const measurement = timed(() => {
    const result = searchSessions(list, query, options)
    hits = result.length
    total = result.reduce((sum, entry) => sum + entry.total, 0)
    return result
  })
  return { ...measurement, hits, total }
}

/**
 * The FIRST query the scene runs over one index, as the median of `repeats`
 * INDEPENDENT cold samples: every repetition builds a fresh index and starts
 * from empty fold caches (they are per-object WeakMaps, so reusing one index
 * would warm every later repetition and the "cold" label would be a lie).
 * This is the scenario phase 1 is about — the user's first letter key, which
 * pays the whole fold build today.
 */
function coldOnce(query, options) {
  const samples = []
  let shape = { hits: 0, total: 0 }
  for (let at = 0; at < repeats; at++) {
    const fresh = makeIndex(sessions, messages, chars, at * 100_000)
    const started = process.hrtime.bigint()
    const result = searchSessions(fresh, query, options)
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    shape = { hits: result.length, total: result.reduce((sum, entry) => sum + entry.total, 0) }
  }
  samples.sort((left, right) => left - right)
  return { ms: samples[(samples.length - 1) >> 1], min: samples[0], max: samples[samples.length - 1], ...shape }
}

/** The prewarm budget the probe grants the background pass: generous on
 *  purpose, because this scenario asks "what does the first keystroke cost
 *  once the folds ARE built", not "did the production budget finish".
 *  warmup.tsx picks its own, smaller budget. */
const PREWARM_MAX_MESSAGES = 1_000_000
const PREWARM_MAX_MS = 60_000

/** The same first query after a background prewarm — what a scene open sees
 *  once phase 1b's sweep has run. Null when the build has no prewarm yet. */
async function coldPrewarmedOnce(query, options) {
  if (prewarmFolds === undefined) return null
  const samples = []
  let shape = { hits: 0, total: 0 }
  for (let at = 0; at < repeats; at++) {
    const fresh = makeIndex(sessions, messages, chars, at * 100_000 + 50_000)
    await prewarmFolds(fresh, { maxMessages: PREWARM_MAX_MESSAGES, maxMs: PREWARM_MAX_MS })
    const started = process.hrtime.bigint()
    const result = searchSessions(fresh, query, options)
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    shape = { hits: result.length, total: result.reduce((sum, entry) => sum + entry.total, 0) }
  }
  samples.sort((left, right) => left - right)
  return { ms: samples[(samples.length - 1) >> 1], min: samples[0], max: samples[samples.length - 1], ...shape }
}

const scenarios = []
let memoryReport = null
let previewReport = null

if (scenarioName !== 'preview') {
  const base = { scope: 'all' }
  const baseOn = { ...base, pinyin: true }
  const baseOff = { ...base, pinyin: false }

  // A cosmetic index for the WARM group: it is fully warmed first, and the
  // fold caches are global, so it must not be the same OBJECTS the cold group
  // measured (that would hide the build).
  const warmIndex = makeIndex(sessions, messages, chars)

  gc()
  const memBefore = memory()

  // ── cold group: a fresh index per sample, empty fold caches ─────────────
  for (const [name, query, options, note] of [
    ['first letter (cold folds)', letterNeedle, baseOn, 'first query on a fresh index; pinyin on'],
    ['first letter (cold, pinyin off)', letterNeedle, baseOff, 'case fold build alone'],
    ['first CJK (cold, case fold)', cjkNeedle, baseOn, 'never builds the pinyin chains'],
  ]) {
    const measurement = coldOnce(query, options)
    scenarios.push(row(name, note, measurement, measurement))
  }

  // ── the same first query, folds prewarmed (phase 1b) ────────────────────
  const prewarmedLetter = await coldPrewarmedOnce(letterNeedle, baseOn)
  if (prewarmedLetter !== null) {
    scenarios.push(
      row('first letter (prewarmed folds)', 'same query after a background prewarm', prewarmedLetter, prewarmedLetter),
    )
  }

  // ── warm group: one index, warmed before timing ─────────────────────────
  searchSessions(warmIndex, cjkNeedle, baseOn)
  searchSessions(warmIndex, 'zzzqqq', baseOn)
  gc()
  const memWarm = memory()

  const hotLetter = queryOnce(warmIndex, letterNeedle, baseOn)
  const memAfterLetter = memory()
  const hotLetter2 = queryOnce(warmIndex, letterNeedle2, baseOn)
  const hotCjk = queryOnce(warmIndex, cjkNeedle, baseOn)
  const memAfterCjk = memory()
  const noPinyin = queryOnce(warmIndex, letterNeedle, baseOff)
  const sensitive = queryOnce(warmIndex, letterNeedle, { ...baseOff, caseSensitive: true })
  const multiTerm = queryOnce(warmIndex, `${letterNeedle} ${cjkNeedle}`, baseOn)
  const titleOnly = queryOnce(warmIndex, letterNeedle, { ...base, titleOnly: true })

  scenarios.push(row('hot letter', 'same needle, folds cached', hotLetter, hotLetter))
  scenarios.push(row(`hot letter ${JSON.stringify(letterNeedle2)} (rarer)`, 'fewer hits, same scans', hotLetter2, hotLetter2))
  scenarios.push(row(`hot CJK ${JSON.stringify(cjkNeedle)}`, 'case fold only', hotCjk, hotCjk))
  scenarios.push(row('hot letter (pinyin off)', 'case fold alone', noPinyin, noPinyin))
  scenarios.push(row('hot letter (case-sensitive)', 'verbatim scan, no fold', sensitive, sensitive))
  scenarios.push(row('multi-term AND', `${JSON.stringify(letterNeedle)} ${JSON.stringify(cjkNeedle)}`, multiTerm, multiTerm))
  scenarios.push(row('title-only', 'titles alone are searched', titleOnly, titleOnly))

  gc()
  const memAfter = memory()
  memoryReport = {
    before: memBefore,
    afterWarmup: memWarm,
    afterLetter: memAfterLetter,
    afterCjk: memAfterCjk,
    after: memAfter,
    arrayBuffersPerChar: Number((memAfter.arrayBuffers / composition.totalChars).toFixed(2)),
  }
}

if (scenarioName !== 'search' && buildPreviewLines !== undefined) {
  // The split layout's per-keystroke re-wrap: a long conversation laid out
  // with fresh (new-identity) ranges every time — exactly what the memo's
  // `rangesByMessage` dependency produces on a keystroke.
  const previewMessages = makeIndex(1, 500, 3000)[0].messages
  const width = 96
  const rangesByMessage = new Map()
  let at = 0
  for (const [index] of previewMessages.entries()) {
    const ranges = []
    for (let n = 0; n < 8; n++) {
      const start = (at * 7919) % 2800
      ranges.push([start, start + 6])
      at += 1
    }
    rangesByMessage.set(index, ranges)
  }
  const hitIndices = new Set([0, 1, 2, 7, 40, 200, 499])
  const build = () => buildPreviewLines(previewMessages, hitIndices, width, rangesByMessage)
  const measurement = timed(build)
  previewReport = row(
    `preview re-wrap ${previewMessages.length}×3000 @${width} cols`,
    'buildPreviewLines with fresh ranges',
    measurement,
    { lines: measurement.result.length },
  )
}

// ── output ────────────────────────────────────────────────────────────────

const summary = {
  machine: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: availableParallelism(),
    totalMemMb: mb(totalmem()),
  },
  index: composition,
  scenarios,
  memory: memoryReport,
  preview: previewReport,
  options: { repeats, forcedGc: useGc, asciiShare },
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.log(`# bench-search — ${process.version} / ${summary.machine.cpu} / ${summary.machine.cores} cores`)
console.log('')
console.log(
  `Index: ${sessions} sessions × ${messages} messages × ${chars} chars = ${composition.totalChars.toLocaleString('en-US')} chars` +
    `; repeats ${repeats}; forced GC ${useGc ? 'on' : 'off'}; scenario ${scenarioName}`,
)
console.log(
  `Composition: ASCII ${composition.asciiChars.toLocaleString('en-US')} (${composition.asciiShareActual})` +
    ` / CJK ${composition.cjkChars.toLocaleString('en-US')}` +
    ` / other ${composition.otherUnits.toLocaleString('en-US')} (newlines ${composition.newlines})`,
)
console.log('')
console.log('| scenario | median ms | min–max | sessions | spans | note |')
console.log('|---|---|---|---|---|---|')
for (const scenario of scenarios) {
  console.log(
    `| ${scenario.name} | ${scenario.ms} | ${scenario.min}–${scenario.max} | ${scenario.hits ?? ''} | ${scenario.total ?? ''} | ${scenario.note} |`,
  )
}
if (memoryReport !== null) {
  console.log('')
  console.log('| memory (MB) | before | after warm-up | after letter | after CJK | after all |')
  console.log('|---|---|---|---|---|---|')
  const cell = key =>
    [
      memoryReport.before[key],
      memoryReport.afterWarmup[key],
      memoryReport.afterLetter[key],
      memoryReport.afterCjk[key],
      memoryReport.after[key],
    ]
      .map(mb)
      .join(' | ')
  console.log(`| heapUsed | ${cell('heapUsed')} |`)
  console.log(`| arrayBuffers | ${cell('arrayBuffers')} |`)
  console.log(`| rss | ${cell('rss')} |`)
  console.log('')
  console.log(`arrayBuffers per index char (after all): ${memoryReport.arrayBuffersPerChar} bytes`)
}
if (previewReport !== null) {
  console.log('')
  console.log('| scenario | median ms | min–max | lines |')
  console.log('|---|---|---|---|')
  console.log(`| ${previewReport.name} | ${previewReport.ms} | ${previewReport.min}–${previewReport.max} | ${previewReport.lines} |`)
}
