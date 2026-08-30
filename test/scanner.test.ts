/**
 * Scanner + search tests over the generated fixtures: dual-encoding parity,
 * torn-tail tolerance, mtime-cache reuse, same-repo scope filtering, and
 * query semantics (case folding, CJK substrings, highlight ranges, MRU).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { SessionScanner, enumerateLogs } from '../src/core/scan.js'
import { matchRanges, searchSessions, sessionCwdMatches } from '../src/core/search.js'
import type { ScannedSession } from '../src/core/scan.js'

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'generated')

describe('enumerateLogs', () => {
  it('finds compressed and plain logs under the fixture root', () => {
    const logs = enumerateLogs(FIXTURE_ROOT)
    const ids = [...logs.keys()]
    expect(ids).toContain('11111111-1111-4111-8111-111111111111')
    expect(ids).toContain('22222222-2222-4222-8222-222222222222')
    expect(ids.some(id => id.includes('..') || id.includes('/'))).toBe(false)
  })
})

describe('SessionScanner', () => {
  it('sweeps every fixture session, most-recent-first, with titles extracted', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    expect(sessions.length).toBeGreaterThanOrEqual(6)
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1]!.modifiedAt).toBeGreaterThanOrEqual(sessions[i]!.modifiedAt)
    }
    const auth = sessions.find(s => s.id === '11111111-1111-4111-8111-111111111111')!
    expect(auth.title).toBe('fix auth retry backoff')
    expect(auth.header.cwd).toBe('D:/work/repo-auth')
    const roles = auth.messages.map(m => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    expect(roles).toContain('tool')
  })

  it('produces identical searchable content for the zstd and plain twins', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const pick = (s: ScannedSession) => ({
      title: s.title,
      cwd: s.header.cwd,
      texts: s.messages.map(m => m.text),
      roles: s.messages.map(m => m.role),
    })
    // Only the twin pairs exist in both encodings; corruption fixtures
    // (torn frame, garbage, torn plain line) are single-encoding on purpose.
    // Plain twins carry mirrored ids (99-nn prefix scheme) because the
    // scanner keeps one log per session id (compressed wins).
    const TWIN_IDS = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '88111111-1111-4111-8111-111111111111',
      '77222222-2222-4222-8222-222222222222',
      '66333333-3333-4333-8333-333333333333',
    ]
    const twins = sessions.filter(s => TWIN_IDS.includes(s.id))
    expect(twins).toHaveLength(6)
    // Sort by cwd: MRU order interleaves the twins (independent mtimes).
    const compressed = twins.filter(s => s.path.endsWith('.zstd')).map(pick).sort((a, b) => (a.cwd ?? '').localeCompare(b.cwd ?? ''))
    const plain = twins.filter(s => !s.path.endsWith('.zstd')).map(pick).sort((a, b) => (a.cwd ?? '').localeCompare(b.cwd ?? ''))
    expect(compressed).toHaveLength(3)
    expect(plain).toEqual(compressed)
  })

  it('reuses the cache when nothing changed (second sweep decodes nothing)', async () => {
    const scanner = new SessionScanner()
    const first = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    let decodedBytes = 0
    const second = await scanner.scan({
      sessionRoot: FIXTURE_ROOT,
      onProgress: progress => {
        decodedBytes = progress.decodedBytes
      },
    })
    expect(decodedBytes).toBe(0)
    expect(second).toEqual(first)
  })

  it('re-decodes when the log was touched (mtime token moves)', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const target = sessions.find(s => s.id === '22222222-2222-4222-8222-222222222222')!
    const future = new Date(Date.now() + 5000)
    utimesSync(target.path, future, future)
    let decoded = 0
    await scanner.scan({
      sessionRoot: FIXTURE_ROOT,
      onProgress: progress => {
        decoded = progress.decodedBytes
      },
    })
    expect(decoded).toBeGreaterThan(0)
  })

  it('tolerates a torn final frame: committed frames stay searchable', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const torn = sessions.find(s => s.id === '44444444-4444-4444-8444-444444444444')
    expect(torn).toBeDefined()
    // The header frame and the first message frame survived the cut; the
    // half-written final frame is dropped, not fatal.
    expect(torn!.messages.length).toBeGreaterThanOrEqual(1)
    expect(torn!.header.cwd).toBe('D:/work/repo-auth')
  })

  it('tolerates garbage and torn plain logs without failing the sweep', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const garbage = sessions.find(s => s.id === '55555555-5555-5555-8555-555555555555')
    if (garbage !== undefined) {
      expect(garbage.messages).toHaveLength(0)
    }
    const tornPlain = sessions.find(s => s.id === '66666666-6666-6666-8666-666666666666')
    if (tornPlain !== undefined) {
      // The complete line survived; the unterminated torn tail is dropped.
      expect(tornPlain.messages.map(m => m.text)).toContain('完整的行')
    }
  })

  it('stops cleanly when aborted and still resolves', async () => {
    const scanner = new SessionScanner()
    const controller = new AbortController()
    controller.abort()
    const result = await scanner.scan({ sessionRoot: FIXTURE_ROOT, signal: controller.signal })
    expect(result).toEqual([])
  })

  it('indexes an inbox-spliced prompt exactly once (splice is not indexed)', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const auth = sessions.find(s => s.id === '11111111-1111-4111-8111-111111111111')!
    // The fixture delivers session 1's first prompt through agent/inbox/
    // spliced BEFORE the durable user/message; both forms carry the same
    // text and only the durable one may be indexed.
    const texts = auth.messages.map(m => m.text)
    expect(texts.filter(t => t === '登录失败重试是不是没加退避？')).toHaveLength(1)
  })

  it('respects the indexTools switch', async () => {
    const scanner = new SessionScanner()
    const withTools = await scanner.scan({ sessionRoot: FIXTURE_ROOT, indexTools: true })
    const withoutTools = await scanner.scan({ sessionRoot: FIXTURE_ROOT, indexTools: false })
    const hasTool = (list: ScannedSession[]): boolean =>
      list.some(s => s.messages.some(m => m.role === 'tool'))
    expect(hasTool(withTools)).toBe(true)
    expect(hasTool(withoutTools)).toBe(false)
  })

  it('extracts header cwd/createdAt from both header-row shapes', async () => {
    const scanner = new SessionScanner()
    const sessions = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    // The real harness writes the header as {type:'session', …} with the
    // facts at top level (session 1); the legacy type-less first row (session
    // 3) must keep working. Before the fix, repo-scope search matched nothing
    // on real logs because cwd was never read off the real shape.
    const real = sessions.find(s => s.id === '22222222-2222-4222-8222-222222222222')!
    expect(real.header.cwd).toBe('D:/work/repo-payments')
    expect(real.header.createdAt).toBe(1_750_000_000_000)
    const legacy = sessions.find(s => s.id === '33333333-3333-4333-8333-333333333333')!
    expect(legacy.header.cwd).toBe('D:/work/repo-auth/submodule')
    expect(legacy.header.createdAt).toBe(1_750_000_000_000)
  })

  it('respects the indexThinking switch across reasoning/thinking block names', async () => {
    const scanner = new SessionScanner()
    const without = await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const reasoningIndexed = (list: ScannedSession[]): boolean =>
      list.some(s => s.messages.some(m => m.text.includes('渠道抽象的边界')))
    expect(reasoningIndexed(without)).toBe(false)
    const withThinking = await scanner.scan({ sessionRoot: FIXTURE_ROOT, indexThinking: true })
    // The fixture writes the block as `reasoning` (the real logs' name); the
    // switch must honor it — and the legacy `thinking` name with it.
    expect(reasoningIndexed(withThinking)).toBe(true)
  })

  it('garbage-collects cache entries for logs that left the sweep', async () => {
    const scanner = new SessionScanner()
    await scanner.scan({ sessionRoot: FIXTURE_ROOT })
    const before = scanner.size
    expect(before).toBeGreaterThan(0)
    // A sweep over an empty root resolves nothing and must evict everything
    // the previous sweep cached — the cache must not outlive its sessions.
    const empty = await scanner.scan({ sessionRoot: 'D:/nonexistent-root-4a2f' })
    expect(empty).toEqual([])
    expect(scanner.size).toBe(0)
  })
})

describe('searchSessions', () => {
  let sessions: ScannedSession[]
  beforeAll(async () => {
    sessions = await new SessionScanner().scan({ sessionRoot: FIXTURE_ROOT })
  })

  it('matches case-insensitively and reports highlight ranges', () => {
    const hits = searchSessions(sessions, 'AUTH', { scope: 'all' })
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      for (const message of hit.hits) {
        const lowered = message.text.toLowerCase()
        for (const [start, end] of message.ranges) {
          expect(lowered.slice(start, end)).toBe('auth')
        }
      }
    }
  })

  it('matches CJK substrings without a segmenter', () => {
    const hits = searchSessions(sessions, '指数退避', { scope: 'all' })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const flatText = hits[0]!.hits.map(h => h.text).join('\n')
    expect(flatText).toContain('指数退避')
  })

  it('honors the caseSensitive switch', () => {
    const folded = searchSessions(sessions, 'jitter', { scope: 'all' })
    expect(folded.length).toBeGreaterThanOrEqual(1)
    const foldedText = folded[0]!.hits.map(h => h.text).join('\n')
    expect(foldedText).toContain('jitter')

    const sensitive = searchSessions(sessions, 'JITTER', { scope: 'all', caseSensitive: true })
    expect(sensitive).toEqual([])
  })

  it('matches nothing under the repo scope when no cwd is given', () => {
    // "This repo" with no cwd is undefined — silently listing every session
    // under that label would be a lie (README documents the fallback away).
    const hits = searchSessions(sessions, 'auth', { scope: 'repo' })
    expect(hits).toEqual([])
  })

  it('maps highlight ranges back to the original text across length-changing folds', () => {
    // U+0130 (İ) folds to two code units; ranges must still index the
    // ORIGINAL string or every later highlight would shift.
    const text = 'İa AUTH İb auth'
    const ranges = matchRanges(text, 'auth', false)
    expect(ranges).toEqual([
      [3, 7],
      [11, 15],
    ])
    expect(text.slice(3, 7)).toBe('AUTH')
    expect(text.slice(11, 15)).toBe('auth')
  })

  it('indexes tool-call summaries when enabled', () => {
    const hits = searchSessions(sessions, 'src/auth/retry.ts', { scope: 'all' })
    expect(hits.length).toBe(2) // compressed + plain mirror
    expect(hits.every(h => h.hits.some(x => x.role === 'tool'))).toBe(true)
  })

  it('filters by repo scope through the header cwd', () => {
    const repoHits = searchSessions(sessions, 'auth', { scope: 'repo', repoCwd: 'D:/work/repo-auth' })
    expect(repoHits.length).toBeGreaterThan(0)
    for (const hit of repoHits) {
      expect(sessionCwdMatches('D:/work/repo-auth', hit.session.header.cwd ?? '')).toBe(true)
    }
    // A different workspace's session never leaks into the repo scope.
    const paymentsOnly = searchSessions(sessions, '支付渠道', { scope: 'repo', repoCwd: 'D:/work/repo-auth' })
    expect(paymentsOnly).toHaveLength(0)
  })

  it('keeps subdirectory sessions inside the repo scope', () => {
    const hits = searchSessions(sessions, '依赖', { scope: 'repo', repoCwd: 'D:/work/repo-auth' })
    expect(hits).toHaveLength(2) // compressed + plain mirror
    for (const hit of hits) {
      expect(hit.session.header.cwd).toBe('D:/work/repo-auth/submodule')
    }
  })

  it('returns nothing for the empty query', () => {
    expect(searchSessions(sessions, '   ', { scope: 'all' })).toEqual([])
  })
})

describe('sessionCwdMatches', () => {
  it('folds case on Windows-style comparisons', () => {
    expect(sessionCwdMatches('D:/Work/Repo', 'd:/work/repo', true)).toBe(true)
    expect(sessionCwdMatches('D:/Work/Repo', 'd:/work/repo', false)).toBe(false)
  })

  it('matches subdirectory descendants and the inverse', () => {
    expect(sessionCwdMatches('D:/work/repo', 'D:/work/repo/sub', true)).toBe(true)
    expect(sessionCwdMatches('D:/work/repo/sub', 'D:/work/repo', true)).toBe(true)
    expect(sessionCwdMatches('D:/work/other', 'D:/work/repo', true)).toBe(false)
  })

  it('matches container roots only exactly', () => {
    expect(sessionCwdMatches('C:/', 'D:/anything', true)).toBe(false)
    expect(sessionCwdMatches('C:/', 'c:/', true)).toBe(true)
  })
})
