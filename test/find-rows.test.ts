/**
 * The extracted list model (find-rows.ts): the recent-mode filter, the
 * per-session grouping and the fold badge placement the full-screen scene and
 * the sidebar panel now share. The scene's own wiring tests cover the rendered
 * result; these pin the model directly, so a drift in the shared function that
 * both surfaces would inherit cannot hide behind either surface's tests.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import type { ScannedSession } from '../src/core/scan.js'
import type { MessageHit, SessionHit } from '../src/core/search.js'
import { buildRows, buildSearchOptions, rowSession, sinceMsFor } from '../src/find-rows.js'
import { PREVIEW_HITS } from '../src/find-types.js'

function session(id: string, options: { cwd?: string; modifiedAt?: number; messages?: number } = {}): ScannedSession {
  const messages = options.messages ?? 2
  return {
    id,
    path: `${id}.jsonl`,
    bytes: 10,
    modifiedAt: options.modifiedAt ?? 1_700_000_000_000,
    title: `Title ${id}`,
    header: { cwd: options.cwd ?? process.cwd(), createdAt: undefined },
    messages: Array.from({ length: messages }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      seq: index + 1,
      at: undefined,
      text: `message ${index} of ${id}`,
    })),
  }
}

function hit(sessionRef: ScannedSession, messages: number, title = true): MessageHit {
  return {
    kind: 'message',
    role: 'user',
    seq: messages + 1,
    text: `hit ${messages}`,
    at: undefined,
    ranges: [[0, 3]],
    sourceIndex: messages,
  }
}

function bundle(sessionRef: ScannedSession, messageHits: number, withTitle = true): SessionHit {
  const hits: MessageHit[] = []
  if (withTitle) {
    hits.push({
      kind: 'title',
      role: undefined,
      seq: undefined,
      text: sessionRef.title ?? '',
      at: undefined,
      ranges: [[0, 5]],
      sourceIndex: undefined,
    })
  }
  for (let index = 0; index < messageHits; index++) hits.push(hit(sessionRef, index))
  return { session: sessionRef, hits, total: hits.length }
}

const EMPTY = new Set<string>()

describe('sinceMsFor', () => {
  it('is undefined for the whole-time window and minute-quantized otherwise', () => {
    expect(sinceMsFor('all', 1_700_000_123_456)).toBeUndefined()
    const now = 1_700_000_123_456
    const minute = Math.floor(now / 60_000) * 60_000
    expect(sinceMsFor('7d', now)).toBe(minute - 7 * 86_400_000)
    expect(sinceMsFor('30d', now)).toBe(minute - 30 * 86_400_000)
    // Renders inside one minute share the cutoff (the memo-stability rule).
    expect(sinceMsFor('7d', now + 30_000)).toBe(sinceMsFor('7d', now))
  })
})

describe('buildSearchOptions', () => {
  it('carries only the enabled switches and the caller’s scope/cwd', () => {
    const config = resolveConfig({ caseSensitive: true, pinyin: false, regex: true, titleOnly: true })
    expect(
      buildSearchOptions(config, { scope: 'repo', repoCwd: 'P:\\repo', useRegex: true, titleOnly: true, sinceMs: 5 }),
    ).toEqual({ scope: 'repo', repoCwd: 'P:\\repo', caseSensitive: true, regex: true, titleOnly: true, sinceMs: 5 })

    // A panel with no cwd (no live channel) must not pass an explicit
    // `undefined` — the core treats a missing cwd as "repo scope matches
    // nothing", which is the honest answer.
    expect(
      buildSearchOptions(config, { scope: 'all', repoCwd: undefined, useRegex: false, titleOnly: false, sinceMs: undefined }),
    ).toEqual({ scope: 'all', caseSensitive: true })
  })
})

describe('buildRows — recent mode', () => {
  it('lists sessions holding conversation content, filtered by scope and window', () => {
    const inside = session('inside', { cwd: 'P:\\repo', modifiedAt: 1_000 })
    const otherRepo = session('other', { cwd: 'P:\\elsewhere', modifiedAt: 1_000 })
    const old = session('old', { cwd: 'P:\\repo', modifiedAt: 10 })
    const empty = session('empty', { cwd: 'P:\\repo', modifiedAt: 1_000, messages: 0 })

    const rows = buildRows({
      sessions: [inside, otherRepo, old, empty],
      hits: [],
      recentMode: true,
      scope: 'repo',
      repoCwd: 'P:\\repo',
      sinceMs: 500,
      expanded: EMPTY,
    })
    expect(rows.map(row => row.rowId)).toEqual(['s:inside'])
    expect(rows[0]).toMatchObject({ kind: 'session', titleHit: undefined })
  })

  it('keeps the sweep order and lets scope=all through', () => {
    const first = session('first', { cwd: 'P:\\a', modifiedAt: 1_000 })
    const second = session('second', { cwd: 'P:\\b', modifiedAt: 900 })
    const rows = buildRows({
      sessions: [first, second],
      hits: [],
      recentMode: true,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    expect(rows.map(row => row.rowId)).toEqual(['s:first', 's:second'])
  })
})

describe('buildRows — results mode', () => {
  it('puts a card first and its message hits under it, title hit inside the card', () => {
    const target = session('a', { messages: 4 })
    const rows = buildRows({
      sessions: [target],
      hits: [bundle(target, 2)],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    expect(rows.map(row => row.rowId)).toEqual(['s:a', 'm:a:0', 'm:a:1'])
    const card = rows[0]!
    expect(card.kind).toBe('session')
    if (card.kind !== 'session') throw new Error('unreachable')
    expect(card.titleHit?.kind).toBe('title')
    expect(card.hitTotal).toBe(3)
    expect(card.hits).toHaveLength(3)
  })

  it('caps the visible hits at PREVIEW_HITS and badges the last visible row', () => {
    const target = session('a', { messages: 10 })
    const rows = buildRows({
      sessions: [target],
      hits: [bundle(target, PREVIEW_HITS + 2)],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    const messageRows = rows.filter(row => row.kind === 'message')
    expect(messageRows).toHaveLength(PREVIEW_HITS)
    // Only the LAST visible row carries the badge, and it counts what is hidden.
    expect(messageRows.slice(0, -1).every(row => row.kind === 'message' && row.fold === undefined)).toBe(true)
    const badged = messageRows.at(-1)
    expect(badged?.kind === 'message' ? badged.fold : undefined).toEqual({ hidden: 2, expanded: false })
  })

  it('shows every hit and flips the badge once the session is expanded', () => {
    const target = session('a', { messages: 10 })
    const rows = buildRows({
      sessions: [target],
      hits: [bundle(target, PREVIEW_HITS + 2)],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: new Set(['a']),
    })
    const messageRows = rows.filter(row => row.kind === 'message')
    expect(messageRows).toHaveLength(PREVIEW_HITS + 2)
    const badged = messageRows.at(-1)
    expect(badged?.kind === 'message' ? badged.fold : undefined).toEqual({ hidden: 0, expanded: true })
  })

  it('carries no badge on a session at or under the preview budget', () => {
    const target = session('a', { messages: 4 })
    const rows = buildRows({
      sessions: [target],
      hits: [bundle(target, PREVIEW_HITS)],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    expect(rows.every(row => row.kind === 'session' || row.fold === undefined)).toBe(true)
  })

  it('keeps a message row’s identity across a fold (rowId names the message)', () => {
    const target = session('a', { messages: 10 })
    const bundleHit = bundle(target, PREVIEW_HITS + 1)
    const collapsed = buildRows({
      sessions: [target],
      hits: [bundleHit],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    const expanded = buildRows({
      sessions: [target],
      hits: [bundleHit],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: new Set(['a']),
    })
    const firstRowId = collapsed[1]!.rowId
    expect(expanded.find(row => row.rowId === firstRowId)).toBeDefined()
  })
})

describe('rowSession', () => {
  it('resolves both row kinds to their session', () => {
    const target = session('a', { messages: 4 })
    const rows = buildRows({
      sessions: [target],
      hits: [bundle(target, 1)],
      recentMode: false,
      scope: 'all',
      repoCwd: undefined,
      sinceMs: undefined,
      expanded: EMPTY,
    })
    for (const row of rows) expect(rowSession(row).id).toBe('a')
  })
})
