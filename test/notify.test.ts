/**
 * The host toast seam (0.10+ `tuiToast`): the notifier routes feedback to
 * the service with a tone-picked colour and auto-dismiss window, resolves
 * the service lazily per call, and no-ops when the host has none (0.9.x) —
 * every existing channel stands alone either way. A host that THROWS on the
 * probe or on the delivery is a drop too: the toast is the additive channel,
 * and some callers sit on an error path where an escaping throw would report
 * the reporter's own failure instead (REVIEW R-109).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { makeNotifier, type ToastSurface } from '../src/notify.js'

function ctxWith(toast: ToastSurface | undefined): Context {
  return { get: (_name: string, _strict?: boolean) => toast } as unknown as Context
}

describe('makeNotifier', () => {
  it('delivers info feedback as a success-coloured toast', () => {
    const show = vi.fn(() => true)
    const notify = makeNotifier(ctxWith({ show }))
    notify('copied', 'info')
    expect(show).toHaveBeenCalledWith('copied', { color: 'success', timeoutMs: 2500 })
  })

  it('delivers errors with the error colour and a longer window', () => {
    const show = vi.fn(() => true)
    const notify = makeNotifier(ctxWith({ show }))
    notify('failed', 'error')
    expect(show).toHaveBeenCalledWith('failed', { color: 'error', timeoutMs: 4000 })
  })

  it('no-ops when the host has no toast service (0.9.x)', () => {
    const notify = makeNotifier(ctxWith(undefined))
    expect(() => notify('anything', 'info')).not.toThrow()
  })

  it('re-resolves the service on every call (cold-boot liveness)', () => {
    let toast: ToastSurface | undefined
    const show = vi.fn(() => true)
    const ctx = { get: () => toast } as unknown as Context
    const notify = makeNotifier(ctx)
    notify('before mount', 'info')
    expect(show).not.toHaveBeenCalled()
    toast = { show }
    notify('after mount', 'info')
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('swallows a delivery that throws — the error path must survive', () => {
    // Reachable on purpose: the scene's copy/resume catch blocks and
    // main.tsx's shortcut-rejection warnings all call the notifier from
    // inside the very handler that reports a failure. A toast that throws
    // there (the host's liveness gate does, for timer- and event-originated
    // calls) would escape as a second, unexplained error.
    const show = vi.fn((): boolean => {
      throw new Error('dsh-tui: tuiToast.show requires a live activation')
    })
    const notify = makeNotifier(ctxWith({ show }))
    expect(() => notify('copy failed', 'error')).not.toThrow()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('swallows a probe that throws (liveness gate on ctx.get)', () => {
    const ctx = {
      get: () => {
        throw new Error('dsh-tui: requires a live Cordis activation context')
      },
    } as unknown as Context
    const notify = makeNotifier(ctx)
    expect(() => notify('anything', 'info')).not.toThrow()
  })
})
