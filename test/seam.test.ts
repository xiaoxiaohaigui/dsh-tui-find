/**
 * Unit tests for the guarded-seam helpers (src/seam.ts) — the mechanisms
 * that keep the cold-boot liveness race from failing the activation. The
 * host-facing regressions themselves (real TuiSceneRuntime, real fiber
 * interleaving) live in boot-race.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  REGISTER_RETRY_DELAY_MS,
  REGISTER_RETRY_MAX_ATTEMPTS,
  SEAM_MOUNT_DELAY_MS,
  SEAM_MOUNT_MAX_ATTEMPTS,
  SEAM_SLOW_DELAY_MS,
  SEAM_TOTAL_BUDGET_MS,
  registerSeamWithRetry,
  whenSeamMounted,
} from '../dist/seam.js'

const LIVENESS_ERROR = new Error('dsh-tui: tuiScenes.register requires a live Cordis activation context')

/** Ticks the two-phase budget yields before giving up: the fast window, then
 *  the slow cadence over whatever is left of the total budget. */
const TICKS_BEFORE_GIVE_UP =
  SEAM_MOUNT_MAX_ATTEMPTS + Math.floor((SEAM_TOTAL_BUDGET_MS - SEAM_MOUNT_MAX_ATTEMPTS * SEAM_MOUNT_DELAY_MS) / SEAM_SLOW_DELAY_MS)

/** Minimal activation-context stand-in: warn/info capture + effect collection. */
function stubCtx() {
  const warns: string[] = []
  const infos: string[] = []
  const toasts: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    logger: {
      warn: (message: string) => {
        warns.push(message)
      },
      info: (message: string) => {
        infos.push(message)
      },
    },
    // The give-up announcement probes the host toast seam (0.10+); without
    // it the plugin's own log line stands alone.
    get: (name: string) => (name === 'tuiToast' ? { show: (text: string) => (toasts.push(text), true) } : undefined),
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  } as unknown as Context
  return { ctx, warns, infos, toasts, disposers }
}

describe('registerSeamWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lands the registration on a retry once the boot window closes', () => {
    const { ctx, warns } = stubCtx()
    let attempts = 0
    const dispose = (): void => {}
    const attach = vi.fn()
    registerSeamWithRetry(
      ctx,
      'scene',
      () => {
        attempts += 1
        if (attempts <= 2) throw LIVENESS_ERROR
        return dispose
      },
      attach,
      LIVENESS_ERROR,
    )

    // The first (rejected) attempt is the caller's own synchronous one.
    expect(attempts).toBe(0)
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS)
    expect(attempts).toBe(1)
    expect(attach).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 2)
    expect(attempts).toBe(3)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledWith(dispose)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('registered on retry #3')
    // After success the timer is gone: no further attempts, no further logs.
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 10)
    expect(attempts).toBe(3)
    expect(warns).toHaveLength(1)
  })

  it('gives up after the bounded budget with a single warning and a toast', () => {
    const { ctx, warns, toasts } = stubCtx()
    const register = vi.fn(() => {
      throw LIVENESS_ERROR
    })
    const attach = vi.fn()
    registerSeamWithRetry(ctx, 'scene', register, attach, LIVENESS_ERROR)

    // R-107: the give-up is the END of a 5 s fast window plus a 5 s slow
    // cadence, not a 0.5 s guess — and it is terminal, so it must reach the
    // user instead of only the log.
    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS)
    expect(register).toHaveBeenCalledTimes(TICKS_BEFORE_GIVE_UP)
    expect(attach).not.toHaveBeenCalled()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('failed after')
    expect(warns[0]).toContain(LIVENESS_ERROR.message)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('dsh-tui-find')
    // Past the give-up the timer must stay cleared.
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 10)
    expect(register).toHaveBeenCalledTimes(TICKS_BEFORE_GIVE_UP)
    expect(toasts).toHaveLength(1)
  })

  it('keeps retrying on the slow cadence past the old 500 ms window', () => {
    const { ctx, warns } = stubCtx()
    // The pre-R-107 budget gave up after 20 attempts (500 ms). This one keeps
    // failing for 250 — long past it — and must still be polling.
    const lastFailure = REGISTER_RETRY_MAX_ATTEMPTS + 50
    let attempts = 0
    const dispose = (): void => {}
    const attach = vi.fn()
    registerSeamWithRetry(
      ctx,
      'scene',
      () => {
        attempts += 1
        if (attempts <= lastFailure) throw LIVENESS_ERROR
        return dispose
      },
      attach,
      LIVENESS_ERROR,
    )
    // 200 fast ticks (5 s), then 50 slow ticks (250 s): still nothing attached.
    vi.advanceTimersByTime(
      REGISTER_RETRY_DELAY_MS * REGISTER_RETRY_MAX_ATTEMPTS + SEAM_SLOW_DELAY_MS * 50,
    )
    expect(attach).not.toHaveBeenCalled()
    // One slow tick later the retry lands, well inside the total budget.
    vi.advanceTimersByTime(SEAM_SLOW_DELAY_MS)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledWith(dispose)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain(`registered on retry #${lastFailure + 1}`)
  })

  it('cleans the retry timer up when the activation disposes', () => {
    const { ctx, warns, disposers } = stubCtx()
    const register = vi.fn(() => {
      throw LIVENESS_ERROR
    })
    registerSeamWithRetry(ctx, 'scene', register, () => {}, LIVENESS_ERROR)
    expect(disposers).toHaveLength(1)
    // Deactivation runs the activation's effects — the timer must not
    // outlive it (no ghost retries, no give-up warning on a dead fiber).
    disposers[0]!()
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * (REGISTER_RETRY_MAX_ATTEMPTS + 5))
    expect(register).not.toHaveBeenCalled()
    expect(warns).toHaveLength(0)
  })
})

describe('whenSeamMounted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses an already-mounted seam synchronously and never arms a timer', () => {
    const { ctx, warns, infos, disposers } = stubCtx()
    const seam = { register: () => () => {} }
    const use = vi.fn()
    whenSeamMounted(ctx, 'scene', () => seam, use)
    expect(use).toHaveBeenCalledTimes(1)
    expect(use).toHaveBeenCalledWith(seam)
    // No polling past the hit: no further use calls, no give-up info.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * (SEAM_MOUNT_MAX_ATTEMPTS + 5))
    expect(use).toHaveBeenCalledTimes(1)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(0)
    expect(disposers).toHaveLength(0)
  })

  it('lands exactly once on the tick the seam mounts, then stops probing', () => {
    const { ctx, warns, infos } = stubCtx()
    const seam = { mounted: true }
    let mounted = false
    const probe = vi.fn(() => (mounted ? seam : undefined))
    const use = vi.fn()
    whenSeamMounted(ctx, 'scene', probe, use)
    // The synchronous first probe misses; ticks before the mount do nothing.
    expect(probe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 3)
    expect(use).not.toHaveBeenCalled()
    // The first tick past the mount lands the seam and clears the timer.
    mounted = true
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS)
    expect(use).toHaveBeenCalledTimes(1)
    expect(use).toHaveBeenCalledWith(seam)
    const probesAtHit = probe.mock.calls.length
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 10)
    expect(probe).toHaveBeenCalledTimes(probesAtHit)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })

  it('gives up after the total budget with a single info, a toast and no further probing', () => {
    const { ctx, warns, infos, toasts } = stubCtx()
    const probe = vi.fn(() => undefined)
    const use = vi.fn()
    whenSeamMounted(ctx, 'tuiScenes', probe, use)
    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS)
    expect(use).not.toHaveBeenCalled()
    // Give-up is the designed no-op posture on compositions without the
    // TUI runtimes — an info naming the seam, exactly once, plus the toast
    // that makes it visible to a TUI user (R-107).
    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('tuiScenes never mounted')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('dsh-tui-find')
    // One synchronous probe plus one per tick, including the giving-up one.
    expect(probe).toHaveBeenCalledTimes(TICKS_BEFORE_GIVE_UP + 1)
    // Past the give-up the timer must stay cleared.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 10)
    expect(probe).toHaveBeenCalledTimes(TICKS_BEFORE_GIVE_UP + 1)
    expect(warns).toHaveLength(0)
    expect(toasts).toHaveLength(1)
  })

  it('keeps polling on the slow cadence past the old 5 s mount window', () => {
    const { ctx, infos } = stubCtx()
    const seam = { mounted: true }
    let mounted = false
    const probe = vi.fn(() => (mounted ? seam : undefined))
    const use = vi.fn()
    whenSeamMounted(ctx, 'scene', probe, use)
    // The pre-R-107 window gave up here (200 × 25 ms). This one must not.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * SEAM_MOUNT_MAX_ATTEMPTS)
    expect(infos).toHaveLength(0)
    expect(use).not.toHaveBeenCalled()
    // A slow tick later the seam mounts and still lands.
    mounted = true
    vi.advanceTimersByTime(SEAM_SLOW_DELAY_MS)
    expect(use).toHaveBeenCalledTimes(1)
    expect(use).toHaveBeenCalledWith(seam)
    expect(infos).toHaveLength(0)
  })

  it('cleans the poll timer up when the activation disposes', () => {
    const { ctx, warns, infos, disposers } = stubCtx()
    const probe = vi.fn(() => undefined)
    whenSeamMounted(ctx, 'scene', probe, () => {})
    expect(disposers).toHaveLength(1)
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 5)
    disposers[0]!()
    const probesAtDispose = probe.mock.calls.length
    // Deactivation runs the activation's effects — no ghost ticks and no
    // give-up info on a dead fiber afterwards.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * (SEAM_MOUNT_MAX_ATTEMPTS + 5))
    expect(probe).toHaveBeenCalledTimes(probesAtDispose)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(0)
  })

  it('contains a throwing use callback to a single warning', () => {
    const { ctx, warns, infos } = stubCtx()
    const boom = new Error('setup exploded')
    const use = vi.fn(() => {
      throw boom
    })
    // Synchronous path: the exception must not propagate into the caller's
    // apply (it would fail the whole activation).
    expect(() => whenSeamMounted(ctx, 'scene', () => ({ mounted: true }), use)).not.toThrow()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('scene setup failed')
    expect(warns[0]).toContain('setup exploded')
    expect(infos).toHaveLength(0)
    // Poll path: the tick must not raise an uncaughtException either.
    warns.length = 0
    let mounted = false
    whenSeamMounted(ctx, 'shortcuts', () => (mounted ? { mounted: true } : undefined), use)
    mounted = true
    expect(() => vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS)).not.toThrow()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('shortcuts setup failed')
    expect(warns[0]).toContain('setup exploded')
  })
})
