/**
 * Unit tests for the guarded-seam retry helper (src/seam.ts) — the mechanism
 * that keeps the cold-boot liveness race from failing the activation. The
 * host-facing regression itself (real TuiSceneRuntime, real fiber
 * interleaving) lives in boot-race.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  REGISTER_RETRY_DELAY_MS,
  REGISTER_RETRY_MAX_ATTEMPTS,
  registerSeamWithRetry,
} from '../dist/seam.js'

const LIVENESS_ERROR = new Error('dsh-tui: tuiScenes.register requires a live Cordis activation context')

/** Minimal activation-context stand-in: warn capture + effect collection. */
function stubCtx() {
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
  } as unknown as Context
  return { ctx, warns, disposers }
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
