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
  registerSeamWithRetry,
  whenSeamMounted,
} from '../dist/seam.js'

const LIVENESS_ERROR = new Error('dsh-tui: tuiScenes.register requires a live Cordis activation context')

/** Minimal activation-context stand-in: warn/info capture + effect collection. */
function stubCtx() {
  const warns: string[] = []
  const infos: string[] = []
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
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  } as unknown as Context
  return { ctx, warns, infos, disposers }
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

  it('gives up after the bounded budget with a single warning', () => {
    const { ctx, warns } = stubCtx()
    const register = vi.fn(() => {
      throw LIVENESS_ERROR
    })
    const attach = vi.fn()
    registerSeamWithRetry(ctx, 'scene', register, attach, LIVENESS_ERROR)

    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * REGISTER_RETRY_MAX_ATTEMPTS)
    expect(register).toHaveBeenCalledTimes(REGISTER_RETRY_MAX_ATTEMPTS)
    expect(attach).not.toHaveBeenCalled()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('failed after')
    expect(warns[0]).toContain(LIVENESS_ERROR.message)
    // Past the give-up the timer must stay cleared.
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 10)
    expect(register).toHaveBeenCalledTimes(REGISTER_RETRY_MAX_ATTEMPTS)
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

  it('gives up after the bounded budget with a single info and stops probing', () => {
    const { ctx, warns, infos } = stubCtx()
    const probe = vi.fn(() => undefined)
    const use = vi.fn()
    whenSeamMounted(ctx, 'tuiScenes', probe, use)
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * SEAM_MOUNT_MAX_ATTEMPTS)
    expect(use).not.toHaveBeenCalled()
    // Give-up is the designed no-op posture on compositions without the
    // TUI runtimes — an info naming the seam, exactly once.
    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('tuiScenes never mounted')
    // One synchronous probe plus one per tick, including the giving-up one.
    expect(probe).toHaveBeenCalledTimes(SEAM_MOUNT_MAX_ATTEMPTS + 1)
    // Past the give-up the timer must stay cleared.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 10)
    expect(probe).toHaveBeenCalledTimes(SEAM_MOUNT_MAX_ATTEMPTS + 1)
    expect(warns).toHaveLength(0)
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
