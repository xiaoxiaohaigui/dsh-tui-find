/**
 * Behavioral baseline: the live `searchSessions` must return exactly what the
 * search returned BEFORE the staged performance work began (commit
 * `e6ccb2a`'s parent, `fbc09cd`). The change is supposed to be pure speed —
 * folds, caches, sharing and identity shortcuts must not move a single
 * highlight range — and the fold-equivalence suite alone cannot prove that:
 * an "identity" shortcut that is *structurally* consistent but semantically
 * wrong (a non-BMP document whose code-point rows and UTF-16 units drift
 * apart) passes every table comparison and still shifts ranges by one. That
 * bug was real during development, which is why this oracle exists.
 *
 * The oracle is the parent revision's `search.ts`, read out of git and
 * transpiled on the fly next to copies of its sibling modules. It is frozen
 * by SHA on purpose: it must never follow the working tree. If git cannot
 * produce that revision (a shallow or exported checkout), the suite skips
 * itself rather than failing — the plugin has no runtime dependency on this
 * test.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import type { ScannedSession } from '../src/core/scan.js'
import { searchSessions } from '../src/core/search.js'

/** The last revision before the perf work (phase 1a landed in e6ccb2a). */
const BASELINE_REVISION = 'fbc09cd'

interface BaselineModule {
  searchSessions(
    sessions: readonly ScannedSession[],
    query: string,
    options: Record<string, unknown>,
  ): readonly { readonly hits: readonly { readonly ranges: readonly (readonly [number, number])[] }[] }[]
}

/** Load the frozen baseline module, or undefined when git cannot serve it. */
async function loadBaseline(): Promise<BaselineModule | undefined> {
  let source: string
  try {
    source = execFileSync('git', ['show', `${BASELINE_REVISION}:src/core/search.ts`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
  const root = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-baseline-'))
  writeFileSync(join(dir, 'search.ts'), source)
  // The baseline module's sibling imports (./events.js etc.) resolve to these
  // copies; they are byte-identical in the two revisions.
  for (const module of ['events.ts', 'pinyin-data.ts', 'scan.ts', 'frames.ts', 'roots.ts']) {
    cpSync(join(root, 'src', 'core', module), join(dir, module))
  }
  cleanupDirs.push(dir)
  return (await import(/* @vite-ignore */ join(dir, 'search.ts'))) as BaselineModule
}

const cleanupDirs: string[] = []
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
})

/** Texts chosen to stress the shortcut conditions: non-BMP pairs, folds that
 *  change length, polyphones, initials material, and plain ASCII. */
const TEXTS: readonly string[] = [
  '',
  'auth flow retry logic',
  'Auth Flow RETRY Logic',
  '张三的会话',
  '重庆长沙银行行业音乐快乐',
  'deploy 张三 to prod 搜索 done',
  'İstanbul İzmir',
  'straße STRASSE groß',
  'a\u{1F600}b\u{20BB7}c\u{1D54F}d',
  '\u{1F600}\u{20BB7}\u{1D54F}',
  '\u9F98\u{20BB7}\u0410\u91CD\u5E86\u5F20\u4E09Auth\u957F\u6C99\u957F\u6C99\t',
  '龘𠮷А重庆张三Auth长沙长沙\t',
  'zhangsha chongqing zs cq bjdx',
  'a',
  ' ',
  '\u{1F600}\u{20BB7}auth\u91CD\u5E86',
  'e\u0301a\u0308 auth 中文',
  'ＡＵＴＨ ｆｌｏｗ',
  'line one\nline two\tline three\n',
]

const QUERIES: readonly string[] = [
  'auth',
  'AUTH',
  'Auth',
  'a',
  'u',
  'zs',
  'cq',
  'bjdx',
  'zhang',
  'zhangsan',
  'zhangsha',
  'chongqing',
  '中',
  '中文',
  '龘',
  'ß',
  'İ',
  '😀',
  'e',
  'flow',
]

const make = (text: string, index: number): ScannedSession => {
  const message: IndexedMessage = { seq: 1, role: 'user', text, at: undefined }
  return {
    id: `baseline-${index}`,
    path: `P:\\baseline\\${index}`,
    bytes: 1,
    modifiedAt: index,
    title: text,
    header: { cwd: undefined, createdAt: undefined },
    messages: [message, { seq: 2, role: 'assistant', text: `${text} tail`, at: undefined }],
  }
}

describe('search baseline (frozen parent revision)', () => {
  it('returns identical hits and ranges for every text and query', async () => {
    const baseline = await loadBaseline()
    if (baseline === undefined) {
      // A checkout without the baseline revision: nothing to compare against.
      return
    }
    const pool = TEXTS.map(make)
    let comparisons = 0
    for (const query of QUERIES) {
      for (const caseSensitive of [false, true]) {
        for (const pinyin of [false, true]) {
          for (const titleOnly of [false, true]) {
            const options = { scope: 'all', caseSensitive, pinyin, titleOnly }
            const before = baseline.searchSessions(pool, query, options)
            const after = searchSessions(pool, query, options)
            const label = `${JSON.stringify(query)} sensitive=${caseSensitive} pinyin=${pinyin} titleOnly=${titleOnly}`
            expect(JSON.stringify(after), label).toBe(JSON.stringify(before))
            comparisons += 1
          }
        }
      }
    }
    // Guard against a silently empty sweep: the matrix above is the point.
    expect(comparisons).toBe(QUERIES.length * 8)
  })

  it('returns identical hits for a case-sensitive mixed corpus and multi-term queries', async () => {
    const baseline = await loadBaseline()
    if (baseline === undefined) return
    const pool = TEXTS.map(make)
    for (const query of ['auth flow', 'zhang 中', '"auth flow"', 'Auth 张三', 'zs auth']) {
      for (const caseSensitive of [false, true]) {
        const options = { scope: 'all', caseSensitive, pinyin: true }
        expect(JSON.stringify(searchSessions(pool, query, options)), query).toBe(
          JSON.stringify(baseline.searchSessions(pool, query, options)),
        )
      }
    }
  })
})
