/**
 * The background warm-up index (src/warmup.tsx): one delayed sweep on the
 * plugin-scoped scanner plus the 0.10+ `tuiStatus.registerView` progress
 * row. The driver tests pin the trade-offs decided in
 * docs/decisions/2026-09-12-background-warmup-index.md (delayed start,
 * start-time config/scene gates, three-layer cancellation, silent 0.9.x);
 * the seam tests pin the structural soft probe and the guarded-retry
 * posture; the view tests render the real host ui kit.
 */
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import type { Context as Ctx } from '@deepseek-ai/cordis'
import { resolveConfig, type Config } from '../src/config.js'
import type { ScanOptions, ScannedSession, SessionScanner } from '../src/core/scan.js'
import { setLangOverride } from '../src/i18n.js'
import { REGISTER_RETRY_DELAY_MS, REGISTER_RETRY_MAX_ATTEMPTS } from '../src/seam.js'
import { PREWARM_YIELD_EVERY } from '../src/core/search.js'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { stripAnsi } from './harness.js'
import {
  WARMUP_DELAY_MS,
  WARMUP_VIEW_KEY,
  WarmupDriver,
  WarmupStore,
  buildWarmupView,
  setupWarmup,
  type WarmupSnapshot,
  type WarmupStatusViewDescriptor,
  type WarmupViewComponent,
  type WarmupViewUi,
} from '../src/warmup.js'

// The end-to-end seam tests mount the wiring; keep the watermark journal
// off so no test ever writes against the real ~/.dsh-tui tree.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

/** A scanner stand-in whose sweeps resolve only when the test says so, and
 *  which remembers every call's options (signal included). */
function stubScanner() {
  interface ScanCall {
    options: ScanOptions
    resolve(sessions?: ScannedSession[]): void
    reject(error: unknown): void
  }
  const calls: ScanCall[] = []
  return {
    calls,
    scan(options: ScanOptions): Promise<ScannedSession[]> {
      return new Promise((resolve, reject) => {
        calls.push({ options, resolve: (sessions = []) => resolve(sessions), reject })
      })
    },
  }
}

type StubScanner = ReturnType<typeof stubScanner>

/** A session with `messages` messages of `chars` characters each — the work
 *  the prewarm half of the sweep has to get through. */
function stubSession(id: number, messages: number, chars: number): ScannedSession {
  const list = []
  for (let at = 0; at < messages; at++) {
    let text = ''
    while (text.length < chars) text += `${text.length === 0 ? '' : ' '}auth 张三 retry 搜索`
    list.push({ seq: at + 1, role: 'user' as const, text: text.slice(0, chars), at: undefined })
  }
  return {
    id: `s${id}`,
    path: `P:\\stub\\s${id}\\session.jsonl`,
    bytes: messages * chars,
    modifiedAt: 1_700_000_000_000 - id,
    header: { cwd: 'P:\\stub', createdAt: undefined },
    messages: list,
  }
}

/** Let the prewarm's real `setImmediate` yields drain (fake timers do not
 *  patch setImmediate, so awaiting a macrotask is what advances it). */
async function flushPrewarm(): Promise<void> {
  for (let at = 0; at < 200; at++) await new Promise(resolve => setImmediate(resolve))
}

/** Minimal activation-context stand-in: warn capture, effect collection and
 *  a string-keyed service map for the soft probes. */
function stubCtx(services: Record<string, unknown> = {}) {
  const warns: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    logger: {
      warn: (message: string) => {
        warns.push(message)
      },
    },
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    get: (name: string) => services[name],
  } as unknown as Ctx
  return { ctx, warns, disposers }
}

/** A 0.10-shaped tuiStatus stand-in: registerView keeps the descriptor and
 *  hands back a real disposer (duplicate-key semantics not needed here). */
function stubStatus() {
  const views: WarmupStatusViewDescriptor[] = []
  const runtime = {
    registerView: vi.fn((descriptor: WarmupStatusViewDescriptor) => {
      views.push(descriptor)
      return () => {
        const at = views.indexOf(descriptor)
        if (at >= 0) views.splice(at, 1)
      }
    }),
  }
  return { runtime, views, registerView: runtime.registerView }
}

interface DriverFixture {
  driver: WarmupDriver
  store: WarmupStore
  scanner: StubScanner
  setSceneOpen(open: boolean): void
  setConfig(config: Config): void
}

function makeDriver(config: Config = {}, ctx?: Ctx): DriverFixture {
  const store = new WarmupStore()
  const scanner = stubScanner()
  let sceneOpen = false
  let currentConfig: Config = config
  const driver = new WarmupDriver(
    ctx ?? stubCtx().ctx,
    {
      scanner: scanner as unknown as SessionScanner,
      config: () => resolveConfig(currentConfig),
      isSceneOpen: () => sceneOpen,
    },
    store,
  )
  return {
    driver,
    store,
    scanner,
    setSceneOpen(open: boolean) {
      sceneOpen = open
    },
    setConfig(next: Config) {
      currentConfig = next
    },
  }
}

function wireSetup(ctx: Ctx, services: { scanner?: StubScanner } = {}): { scanner: StubScanner } {
  const scanner = services.scanner ?? stubScanner()
  setupWarmup(ctx, {
    scanner: scanner as unknown as SessionScanner,
    config: () => resolveConfig({}),
    isSceneOpen: () => false,
  })
  return { scanner }
}

const PROGRESS_3_57 = { resolved: 3, total: 57, decodedBytes: 100, resumed: 0 }

/** Drain the promise chain a settled sweep rides (scan → then → settle). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('WarmupDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps once after the quiet delay with the scene sweep options', async () => {
    const { driver, scanner } = makeDriver({
      indexTools: true,
      indexThinking: true,
      maxMessageChars: 6000,
      sessionRoot: 'X:/sessions-override',
    })
    driver.arm()
    expect(scanner.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS - 1)
    expect(scanner.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(scanner.calls).toHaveLength(1)

    const { options } = scanner.calls[0]!
    expect(options.indexTools).toBe(true)
    expect(options.indexThinking).toBe(true)
    expect(options.maxMessageChars).toBe(6000)
    expect(options.sessionRoot).toBe('X:/sessions-override')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(typeof options.onProgress).toBe('function')

    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS * 2)
    expect(scanner.calls).toHaveLength(1)
  })

  it('never sweeps when the warmup config row is off (re-read at start time)', async () => {
    const { driver, scanner, setConfig } = makeDriver()
    driver.arm()
    // Flipping the row off between arm and fire still suppresses the sweep.
    setConfig({ warmup: false })
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS * 2)
    expect(scanner.calls).toHaveLength(0)
  })

  it('never starts when the find scene is already open', async () => {
    const { driver, scanner, setSceneOpen } = makeDriver()
    setSceneOpen(true)
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS * 2)
    expect(scanner.calls).toHaveLength(0)
  })

  it('publishes per-file progress to the store and settles to idle on completion', async () => {
    const { driver, store, scanner } = makeDriver()
    const seen: WarmupSnapshot[] = []
    store.subscribe(() => {
      seen.push(store.getSnapshot())
    })
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)

    scanner.calls[0]!.options.onProgress?.(PROGRESS_3_57)
    expect(store.getSnapshot()).toEqual({ phase: 'running', resolved: 3, total: 57 })

    // Same-count ticks must not re-render the prompt (stable snapshots).
    scanner.calls[0]!.options.onProgress?.(PROGRESS_3_57)
    expect(seen).toHaveLength(1)

    scanner.calls[0]!.resolve()
    await flush()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', resolved: 0, total: undefined })
  })

  it('supersedes to the scene: a positive scene-open check aborts and settles', async () => {
    const { driver, store, scanner, setSceneOpen } = makeDriver()
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    const call = scanner.calls[0]!

    setSceneOpen(true)
    call.options.onProgress?.(PROGRESS_3_57)
    expect(call.options.signal!.aborted).toBe(true)
    expect(store.getSnapshot().phase).toBe('idle')

    // The aborted file still delivers one trailing tick — the view must not
    // resurrect, and the late resolution must not warn.
    call.options.onProgress?.(PROGRESS_3_57)
    expect(store.getSnapshot().phase).toBe('idle')
    call.resolve()
    await flush()
    expect(store.getSnapshot().phase).toBe('idle')
  })

  it('cancels from the view click path and ignores trailing progress ticks', async () => {
    const { driver, store, scanner } = makeDriver()
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    const { options } = scanner.calls[0]!

    driver.cancel()
    expect(options.signal!.aborted).toBe(true)
    expect(store.getSnapshot().phase).toBe('idle')

    // The scene is NOT open here: only the aborted-signal guard keeps the
    // trailing tick from resurrecting the running view.
    options.onProgress?.(PROGRESS_3_57)
    expect(store.getSnapshot().phase).toBe('idle')
  })

  it('dispose before the delay leaves nothing scheduled', async () => {
    const { driver, scanner } = makeDriver()
    driver.arm()
    driver.dispose()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS * 2)
    expect(scanner.calls).toHaveLength(0)
  })

  it('dispose mid-sweep aborts the sweep', async () => {
    const { driver, scanner } = makeDriver()
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    driver.dispose()
    expect(scanner.calls[0]!.options.signal!.aborted).toBe(true)
  })

  it('degrades a failed sweep to a single warning and an idle store', async () => {
    const { ctx, warns } = stubCtx()
    const { driver, store, scanner } = makeDriver({}, ctx)
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    scanner.calls[0]!.reject(new Error('boom'))
    await flush()
    expect(store.getSnapshot().phase).toBe('idle')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('warm-up sweep failed')
    expect(warns[0]).toContain('boom')
  })

  // The phase-1b half of the sweep: once the decode is done, the same run
  // builds the fold caches the first keystroke would otherwise buy. The
  // driver tests below pin the wiring (it runs, it reports, the three
  // cancellation layers stop it); prewarm.test.ts pins the pass's own
  // budgets and its effect on a cold query.
  //
  // These cases drop the fake clock after firing the delayed start: the
  // prewarm yields with a real `setImmediate`, and a fake clock would leave
  // those yields pending behind the test's own timeout.
  it('prewarms the folds after the sweep and reports the documents it folded', async () => {
    const { driver, store, scanner } = makeDriver()
    const phases: string[] = []
    store.subscribe(() => {
      phases.push(store.getSnapshot().phase)
    })
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    vi.useRealTimers()
    scanner.calls[0]!.resolve([stubSession(1, 2, 200), stubSession(2, 2, 200)])
    await flushPrewarm()
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('idle')
    expect(phases).toContain('running')
    expect(scanner.calls[0]!.options.signal!.aborted).toBe(false)
  })

  it('stops the prewarm when the sweep is cancelled, without resurrecting the view', async () => {
    const { driver, store, scanner } = makeDriver()
    const snapshots: WarmupSnapshot[] = []
    store.subscribe(() => {
      snapshots.push(store.getSnapshot())
    })
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    vi.useRealTimers()
    // Enough documents that the pass must yield before finishing.
    const messages = PREWARM_YIELD_EVERY * 4
    scanner.calls[0]!.resolve([stubSession(1, messages, 2_000)])
    // One macrotask turn lands the scan's `.then` and lets the prewarm fold
    // its first chunk and yield — i.e. the pass is in flight.
    await new Promise(resolve => setImmediate(resolve))
    driver.cancel()
    expect(scanner.calls[0]!.options.signal!.aborted).toBe(true)
    await flushPrewarm()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', resolved: 0, total: undefined })
    // The pass really stopped early: it never reported folding every message.
    expect(snapshots.every(entry => entry.total !== messages || entry.resolved < messages)).toBe(true)
  })

  it('stops the prewarm when /find opens mid-pass', async () => {
    const { driver, store, scanner, setSceneOpen } = makeDriver()
    driver.arm()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    vi.useRealTimers()
    scanner.calls[0]!.resolve([stubSession(1, PREWARM_YIELD_EVERY * 4, 2_000)])
    await new Promise(resolve => setImmediate(resolve))
    setSceneOpen(true)
    // The scene check runs on the next progress tick / yield boundary.
    await flushPrewarm()
    expect(scanner.calls[0]!.options.signal!.aborted).toBe(true)
    expect(store.getSnapshot().phase).toBe('idle')
  })
})

describe('setupWarmup seam', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers a 0.10+ view, scopes its disposer and arms the driver', async () => {
    const status = stubStatus()
    const { ctx, disposers } = stubCtx({ tuiStatus: status.runtime })
    const { scanner } = wireSetup(ctx)
    expect(status.registerView).toHaveBeenCalledTimes(1)

    const descriptor = status.views[0]!
    expect(descriptor.key).toBe(WARMUP_VIEW_KEY)
    // The host's KEY_PATTERN: colon-namespaced lowercase slug segments.
    expect(descriptor.key).toMatch(/^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)+$/)
    expect(descriptor.maxRows).toBe(1)
    expect(typeof descriptor.component).toBe('function')
    // The view's disposer and the driver's dispose both ride the activation.
    expect(disposers.length).toBeGreaterThanOrEqual(2)

    // Disposal unwinds the driver too: a mid-sweep dispose aborts it.
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    expect(scanner.calls).toHaveLength(1)
    for (const dispose of disposers) dispose()
    expect(scanner.calls[0]!.options.signal!.aborted).toBe(true)
    expect(status.views).toHaveLength(0)
  })

  it('warms up silently when the host has no tuiStatus service', async () => {
    const { ctx } = stubCtx({})
    const { scanner } = wireSetup(ctx)
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    expect(scanner.calls).toHaveLength(1)
  })

  it('treats a 0.9.x-shaped tuiStatus (set only) as no view seam, warm-up intact', async () => {
    const set = vi.fn()
    const { ctx } = stubCtx({ tuiStatus: { set } })
    const { scanner } = wireSetup(ctx)
    expect(set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    expect(scanner.calls).toHaveLength(1)
  })

  it('retries a boot-window refusal and lands the view once the gate opens', async () => {
    const status = stubStatus()
    let landed = false
    status.registerView.mockImplementation((descriptor: WarmupStatusViewDescriptor) => {
      void descriptor
      if (status.registerView.mock.calls.length <= 2) return undefined
      // The override replaces the stub's bookkeeping, so track the landing
      // with a flag the disposer reverses.
      landed = true
      return () => {
        landed = false
      }
    })
    const { ctx, warns } = stubCtx({ tuiStatus: status.runtime })
    wireSetup(ctx)

    expect(status.registerView).toHaveBeenCalledTimes(1)
    expect(landed).toBe(false)

    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_DELAY_MS * 2)
    expect(status.registerView).toHaveBeenCalledTimes(3)
    expect(landed).toBe(true)
    expect(warns).toEqual([expect.stringContaining('registered on retry')])
  })

  it('burns the bounded budget on a permanent refusal and keeps warming up', async () => {
    const status = stubStatus()
    status.registerView.mockImplementation(() => undefined)
    const { ctx, warns } = stubCtx({ tuiStatus: status.runtime })
    const { scanner } = wireSetup(ctx)

    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_DELAY_MS * REGISTER_RETRY_MAX_ATTEMPTS)
    expect(warns).toEqual([expect.stringContaining('failed after')])

    // The refused view never blocks the sweep itself.
    await vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS)
    expect(scanner.calls).toHaveLength(1)
  })
})

describe('warm-up status view (real host ui kit)', () => {
  const store = new WarmupStore()

  /** Mount a view component against the real host ui kit with captured
   *  output — the same stream scaffolding the scene harness uses, minus
   *  the scene wiring. Ink re-renders differentially: the first frame is
   *  whole, later frames are deltas wrapped in the host's synchronized-
   *  output markers, so `latest()` isolates the most recent frame the way
   *  the scene harness does. */
  async function mountView(
    component: WarmupViewComponent,
  ): Promise<{ output(): string; latest(): string; unmount(): void }> {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      setRawMode(mode: boolean): PassThrough
      ref(): void
      unref(): void
    }
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => {}
    stdin.unref = () => {}
    let output = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }) as Writable & { isTTY: boolean; columns: number; rows: number; getColorDepth(): number }
    stdout.isTTY = true
    stdout.columns = 80
    stdout.rows = 12
    stdout.getColorDepth = () => 8
    const instance = await hostUi.render(React.createElement(component, { React, ui: hostUi as WarmupViewUi }), {
      stdout,
      stdin,
      stderr: process.stderr,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    return {
      output: () => stripAnsi(output),
      latest: () => {
        const start = output.lastIndexOf('\u001b[?2026h')
        return stripAnsi(start < 0 ? output : output.slice(start))
      },
      unmount: () => {
        // Ink's TTY cleanup uses writeSync on fd 1 when no fd is present;
        // mark the stream non-TTY first so the test stays quiet.
        stdout.isTTY = false
        instance.unmount()
      },
    }
  }

  afterEach(() => {
    setLangOverride(undefined)
    store.update('idle', 0, undefined)
  })

  it('renders a localized one-row progress and follows the store live', async () => {
    const cancels: number[] = []
    const view = buildWarmupView(store, () => {
      cancels.push(1)
    })
    setLangOverride('en')
    store.update('running', 3, 57)
    const mounted = await mountView(view)
    try {
      // The host kit's Text normalizes whitespace runs, so the assertions
      // match token-wise rather than pinning exact spacing.
      expect(mounted.output()).toMatch(/dsh-tui-find\s*·\s*Indexing\s*3\/57/)

      // Live store updates re-render the mounted component: the newest
      // differential frame carries the changed count.
      store.update('running', 9, 57)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mounted.latest()).toContain('9')

      // Settling clears the row — the erase frame carries no row text: the
      // view is chrome, never furniture.
      store.update('idle', 0, undefined)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mounted.latest()).not.toContain('Indexing')
    } finally {
      mounted.unmount()
    }
    expect(cancels).toHaveLength(0)
  })

  // Production-unreachable today — scan.ts sets `total` at the top of its
  // per-file loop, so every between-file onProgress tick carries one, and the
  // driver only ever forwards those ticks — but the ScanProgress contract
  // allows a total-less tick before enumeration finishes. This pins the
  // tolerant rendering a future enumeration-phase yield must keep.
  it('renders the zh copy and an enumeration-pending state without a total', async () => {
    const view = buildWarmupView(store, () => {})
    setLangOverride('zh')
    store.update('running', 0, undefined)
    const mounted = await mountView(view)
    try {
      expect(mounted.output()).toContain('后台索引中…')
    } finally {
      mounted.unmount()
    }
  })

  it('renders nothing while idle', async () => {
    const view = buildWarmupView(store, () => {})
    setLangOverride('en')
    const mounted = await mountView(view)
    try {
      expect(mounted.output().trim()).toBe('')
    } finally {
      mounted.unmount()
    }
  })
})
