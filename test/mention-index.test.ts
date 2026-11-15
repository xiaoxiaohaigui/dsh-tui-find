/**
 * The provider's runtime posture: an index that only ever answers from
 * memory, one bounded background pass, and a registration that is a no-op on
 * every host without the seam (the plugin floor is 0.13.0; the seam is
 * 0.20.1+).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as Ctx } from '@deepseek-ai/cordis'

import { resolveConfig } from '../src/config.js'
import type { ResolvedConfig } from '../src/config.js'
import type { ScannedSession, ScanOptions, SessionScanner } from '../src/core/scan.js'
import {
  createMentionProvider,
  MentionIndex,
  MENTION_PROVIDER_ID,
  registerMentionProvider,
  MentionRegistration,
  type MentionProvider,
} from '../src/mention.js'
import { SEAM_TOTAL_BUDGET_MS } from '../src/seam.js'

/** One scanned session with a single matching message. */
function session(id: string, title: string): ScannedSession {
  return {
    id,
    title,
    header: { cwd: '/repo', createdAt: 1 },
    messages: [{ seq: 0, role: 'user' as const, text: 'needle here', at: 0 }],
    path: `/${id}.jsonl`,
    bytes: 1,
    modifiedAt: 1,
  }
}

/** A scanner stand-in: records every call, resolves with a fixed list. */
function stubScanner(sessions: readonly ScannedSession[] = [session('a', 'Alpha')]) {
  const calls: ScanOptions[] = []
  const scanner = {
    scan: async (options: ScanOptions = {}) => {
      calls.push(options)
      return [...sessions]
    },
  } as unknown as SessionScanner
  return { scanner, calls }
}

/** A wiring stand-in: config from a partial row config, scene probe fixed. */
function wiring(
  scanner: SessionScanner,
  config: Partial<Config> = {},
  sceneOpen = false,
) {
  let resolved: ResolvedConfig = resolveConfig({ mention: true, ...config })
  return {
    scanner,
    config: () => resolved,
    isSceneOpen: () => sceneOpen,
    setConfig(next: Partial<Config>) {
      resolved = resolveConfig({ mention: true, ...next })
    },
  }
}

type Config = Parameters<typeof resolveConfig>[0]

/** Flush the index's scan → then → finally chain (async stub, no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('MentionIndex', () => {
  it('answers from memory and starts exactly one background pass', async () => {
    const { scanner, calls } = stubScanner()
    const index = new MentionIndex(wiring(scanner))
    expect(index.snapshot()).toEqual([])
    expect(index.isReady()).toBe(false)

    index.ensure()
    index.ensure()
    // The second call must not stack a second sweep.
    expect(calls).toHaveLength(1)
    // Let the stub settle (scan → then → finally is three microtask hops).
    await settle()
    expect(index.isReady()).toBe(true)
    expect(index.snapshot().map(entry => entry.id)).toEqual(['a'])
  })

  it('never sweeps again once a pass landed under the same index options', async () => {
    const { scanner, calls } = stubScanner()
    const index = new MentionIndex(wiring(scanner))
    index.ensure()
    // R-226: this MUST settle first. Waiting two microtasks left `running`
    // still set, so the assertions below passed on the in-flight guard alone —
    // deleting `landed && optionsKey` from ensure() kept the suite green.
    await settle()
    expect(index.isReady()).toBe(true)
    expect(calls).toHaveLength(1)
    index.ensure()
    await settle()
    index.ensure()
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('re-arms when a settings edit changes which documents exist', async () => {
    const { scanner, calls } = stubScanner()
    const w = wiring(scanner)
    const index = new MentionIndex(w)
    index.ensure()
    await settle()
    expect(index.isReady()).toBe(true)
    expect(calls).toHaveLength(1)

    // indexTools changes the documents the scanner yields: the landed list is
    // stale, so the next query buys one refresh — while still serving the old
    // answer in the meantime.
    w.setConfig({ indexTools: true })
    expect(index.snapshot().map(entry => entry.id)).toEqual(['a'])
    index.ensure()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.indexTools).toBe(true)
  })

  it('stays out of the way while the full-screen scene is up', () => {
    const { scanner, calls } = stubScanner()
    const index = new MentionIndex(wiring(scanner, {}, true))
    index.ensure()
    expect(calls).toHaveLength(0)
  })

  it('drops a pass that was aborted by dispose', async () => {
    const { scanner } = stubScanner()
    const index = new MentionIndex(wiring(scanner))
    index.ensure()
    index.dispose()
    await Promise.resolve(); await Promise.resolve()
    expect(index.isReady()).toBe(false)
  })
})

describe('createMentionProvider', () => {
  const okSignal = () => new AbortController().signal

  it('answers rows from the landed index', async () => {
    const { scanner } = stubScanner()
    // ONE wiring for both halves: the index and the provider must agree on
    // scope/sensitivity, or a row could be filtered by options the index was
    // never built under.
    const w = wiring(scanner)
    const index = new MentionIndex(w)
    const provider = createMentionProvider(w, index)
    index.adopt([session('a', 'Alpha')])
    const items = provider.complete('needle', okSignal()) as readonly { label: string }[]
    expect(items.map(item => item.label)).toEqual(['Alpha [a]'])
  })

  it('searches every session: the composer gives the provider no cwd', () => {
    const { scanner } = stubScanner()
    const w = wiring(scanner, { defaultScope: 'repo' })
    const index = new MentionIndex(w)
    const provider = createMentionProvider(w, index)
    index.adopt([session('a', 'Alpha')])
    // A repo-scoped call would have no cwd to compare against and the kernel
    // answers "match nothing" — an always-empty popup.
    // The label carries the short id (R-221); the sentence does not.
    expect((provider.complete('needle', okSignal()) as readonly { label: string }[]).map(item => item.label)).toEqual([
      'Alpha [a]',
    ])
  })

  it('returns nothing (and starts no scan) when the row is off', () => {
    const { scanner, calls } = stubScanner()
    const index = new MentionIndex(wiring(scanner))
    const provider = createMentionProvider(wiring(scanner, { mention: false }), index)
    expect(provider.complete('needle', okSignal())).toEqual([])
    // A row that cannot answer must not spend a decode finding out.
    expect(calls).toHaveLength(0)
  })

  it('returns nothing for an already-aborted call', () => {
    const { scanner } = stubScanner()
    const index = new MentionIndex(wiring(scanner))
    const provider = createMentionProvider(wiring(scanner), index)
    index.adopt([session('a', 'Alpha')])
    const controller = new AbortController()
    controller.abort()
    expect(provider.complete('needle', controller.signal)).toEqual([])
  })

  it('carries the host provider id and a non-empty title', () => {
    const { scanner } = stubScanner()
    const w = wiring(scanner)
    const provider = createMentionProvider(w, new MentionIndex(w))
    expect(provider.id).toBe(MENTION_PROVIDER_ID)
    expect(provider.title.length).toBeGreaterThan(0)
  })
})
