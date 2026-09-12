/**
 * The host toast seam (0.10+ `tuiToast`): the notifier routes feedback to
 * the service with a tone-picked colour and auto-dismiss window, resolves
 * the service lazily per call, and no-ops when the host has none (0.9.x) —
 * every existing channel stands alone either way.
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
})
