/**
 * Pinyin matching tests: a letter-only term matches Chinese characters
 * through their pinyin on top of the literal substring — full toneless
 * syllables (`zhangsan` → 张三), the frequency-first reading chained into
 * the next character (`zhongqing` → 重庆), and initials (`zs` → 张三) —
 * with highlight ranges mapped back onto the original characters. Pinned:
 * polyphone coverage through both reading chains, the ü-as-v keyboard
 * form, case sensitivity still applying to the literal path, regex mode
 * ignoring pinyin, the toggle reverting to the substring baseline, and the
 * generated table's own integrity.
 */
import { describe, expect, it } from 'vitest'
import type { IndexedMessage } from '../src/core/events.js'
import { PINYIN_READINGS } from '../src/core/pinyin-data.js'
import type { ScannedSession } from '../src/core/scan.js'
import { searchSessions, type SessionHit } from '../src/core/search.js'

const make = (
  text: string,
  extra: {
    title?: string
    messages?: readonly IndexedMessage[]
  } = {},
): ScannedSession => ({
  id: text,
  path: `P:\\fixture\\${text}`,
  bytes: 1,
  modifiedAt: 0,
  title: extra.title,
  header: { cwd: undefined, createdAt: undefined },
  messages: extra.messages ?? [{ seq: 1, role: 'user', text, at: undefined }],
})

/** First hit's [text, ranges] pairs across sessions, in result order. */
const flat = (hits: readonly SessionHit[]): [string, string][] =>
  hits.flatMap(session => session.hits.map(hit => [hit.text, JSON.stringify(hit.ranges)]))

const P = { scope: 'all', pinyin: true } as const

describe('pinyin data table', () => {
  it('covers the common-character table with well-formed readings', () => {
    const entries = Object.entries(PINYIN_READINGS)
    expect(entries.length).toBeGreaterThan(3000)
    for (const [char, readings] of entries) {
      expect([...char]).toHaveLength(1) // one code point per key
      expect(readings).toMatch(/^[a-z]+( [a-z]+)*$/) // toneless, space-separated
    }
  })

  it('keeps the polyphones and the keyboard ü form the core relies on', () => {
    expect(PINYIN_READINGS['张']).toContain('zhang')
    expect(PINYIN_READINGS['三']).toContain('san')
    expect(PINYIN_READINGS['重']).toContain('zhong')
    expect(PINYIN_READINGS['重']).toContain('chong')
    expect(PINYIN_READINGS['长']).toContain('chang')
    expect(PINYIN_READINGS['长']).toContain('zhang')
    expect(PINYIN_READINGS['绿']).toContain('lv')
    expect(PINYIN_READINGS['女']).toContain('nv')
  })
})

describe('searchSessions pinyin matching', () => {
  it('matches full pinyin, syllable prefixes and initials over Chinese text', () => {
    const pool = [make('张三的会话')]
    expect(flat(searchSessions(pool, 'zhangsan', P))).toEqual([['张三的会话', '[[0,2]]']])
    expect(flat(searchSessions(pool, 'zhang', P))).toEqual([['张三的会话', '[[0,1]]']])
    expect(flat(searchSessions(pool, 'zs', P))).toEqual([['张三的会话', '[[0,2]]']])
  })

  it('maps a pinyin highlight onto the original characters, not the fold', () => {
    // 'zhang' hits 张 through pinyin AND the literal "zhang" in the text —
    // both ranges land on original-string offsets and stay disjoint.
    const pool = [make('张三zhangsan')]
    expect(flat(searchSessions(pool, 'zhang', P))).toEqual([['张三zhangsan', '[[0,1],[2,7]]']])
  })

  it('covers polyphones through both reading chains', () => {
    // 重庆: "chongqing" chains through the all-readings fold's trailing
    // reading, "zhongqing" through the first-reading fold; both highlight
    // the same two characters, and a needle can never bridge two readings
    // of one character (the space separator is untypable).
    const chongqing = [make('重庆的会话')]
    expect(flat(searchSessions(chongqing, 'chongqing', P))).toEqual([['重庆的会话', '[[0,2]]']])
    expect(flat(searchSessions(chongqing, 'zhongqing', P))).toEqual([['重庆的会话', '[[0,2]]']])
    expect(flat(searchSessions(chongqing, 'cq', P))).toEqual([['重庆的会话', '[[0,2]]']])
    expect(searchSessions(chongqing, 'zhongc', P)).toEqual([])
    // 长沙: "changsha" is the first-reading chain, the rarer "zhangsha"
    // still matches through the all-readings fold.
    const changsha = [make('长沙的会话')]
    expect(flat(searchSessions(changsha, 'changsha', P))).toEqual([['长沙的会话', '[[0,2]]']])
    expect(flat(searchSessions(changsha, 'zhangsha', P))).toEqual([['长沙的会话', '[[0,2]]']])
    expect(flat(searchSessions(changsha, 'cs', P))).toEqual([['长沙的会话', '[[0,2]]']])
  })

  it('uses the keyboard ü form (lv/nv) for ü-readings', () => {
    const pool = [make('绿色通道'), make('女流量')]
    expect(flat(searchSessions(pool, 'lvse', P))).toHaveLength(1)
    expect(flat(searchSessions(pool, 'nvliu', P))).toHaveLength(1)
  })

  it('matches session titles and ANDs pinyin terms with literal terms', () => {
    const titled = [make('无关内容', { title: '张三会话' })]
    expect(flat(searchSessions(titled, 'zhangsan', P))).toEqual([['张三会话', '[[0,2]]']])
    // "zs" (pinyin) and 测试 (literal) both inside the same message.
    expect(flat(searchSessions([make('张三的测试记录')], 'zs 测试', P))).toEqual([
      ['张三的测试记录', '[[0,2],[3,5]]'],
    ])
    // Terms split across documents still miss — the AND stays per document.
    expect(searchSessions([make('张三', { messages: [{ seq: 1, role: 'user', text: '测试', at: undefined }] })], 'zs 测试', P)).toEqual([])
  })

  it('leaves literal letter matching untouched alongside the pinyin hits', () => {
    const pool = [make('zs token'), make('张三')]
    expect(flat(searchSessions(pool, 'zs', P))).toEqual([
      ['zs token', '[[0,2]]'],
      ['张三', '[[0,2]]'],
    ])
    expect(flat(searchSessions([make('auth token')], 'auth', P))).toEqual([['auth token', '[[0,4]]']])
  })

  it('falls back gracefully for characters outside the table', () => {
    // 㐀 (U+3400) is not in the common-character table: it folds to itself
    // and the surrounding text still matches, highlighting only 测试.
    const pool = [make('\u3400测试')]
    expect(flat(searchSessions(pool, 'ceshi', P))).toEqual([['\u3400测试', '[[1,3]]']])
  })

  it('is off unless requested and stays out of regex mode', () => {
    const pool = [make('张三')]
    // The option boundary defaults OFF; the scene passes the config (which
    // itself defaults ON).
    expect(searchSessions(pool, 'zhangsan', { scope: 'all' })).toEqual([])
    expect(searchSessions(pool, 'zhangsan', { scope: 'all', pinyin: false })).toEqual([])
    // Regex patterns match the raw text, never the pinyin folds.
    expect(searchSessions(pool, 'zhangsan', { scope: 'all', pinyin: true, regex: true })).toEqual([])
    expect(flat(searchSessions([make('zhangsan 张三')], 'zhangsan', { scope: 'all', pinyin: true, regex: true }))).toEqual([
      ['zhangsan 张三', '[[0,8]]'],
    ])
  })

  it('keeps case sensitivity meaningful for the literal path', () => {
    // Chinese has no case: pinyin matching works under caseSensitive too.
    expect(flat(searchSessions([make('张三')], 'ZS', { scope: 'all', pinyin: true, caseSensitive: true }))).toEqual([
      ['张三', '[[0,2]]'],
    ])
    // But the literal English path stays case-sensitive as before.
    const pool = [make('张三 AUTH')]
    expect(searchSessions(pool, 'auth', { scope: 'all', pinyin: true, caseSensitive: true })).toEqual([])
    const both = searchSessions(pool, 'AUTH', { scope: 'all', pinyin: true, caseSensitive: true })
    expect(both[0]!.hits[0]!.ranges).toEqual([[3, 7]])
  })

  it('never widens literal sensitivity through the sensitive pinyin folds', () => {
    // Sensitive folds fold non-table characters to UPPERCASE while the
    // scanned needle is always lowercase, so a folded needle can only hit
    // readings — an opposite-case literal occurrence can never match.
    expect(searchSessions([make('auth token')], 'AUTH', { scope: 'all', pinyin: true, caseSensitive: true })).toEqual([])
    // 'ZS' still reaches 张三 through the initials, but no longer the
    // literal lowercase "zs" — literal matching stays the verbatim scan's
    // business, which still lands exact-case hits.
    expect(flat(searchSessions([make('zs 张三')], 'ZS', { scope: 'all', pinyin: true, caseSensitive: true }))).toEqual([
      ['zs 张三', '[[3,5]]'],
    ])
    expect(flat(searchSessions([make('auth token')], 'auth', { scope: 'all', pinyin: true, caseSensitive: true }))).toEqual([
      ['auth token', '[[0,4]]'],
    ])
  })

  it('stays idempotent across repeated pinyin searches (shared fold cache)', () => {
    const pool = [make('张三的测试记录')]
    const first = searchSessions(pool, 'zs ceshi', P)
    const second = searchSessions(pool, 'zs ceshi', P)
    expect(second).toEqual(first)
    expect(flat(second)[0]![1]).toBe('[[0,2],[3,5]]')
  })
})
