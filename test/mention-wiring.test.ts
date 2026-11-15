/**
 * Seam wiring for the composer `@` provider: the structural soft probe, the
 * late-mount poll (the profile interleaves its rows), the give-up posture on
 * a host WITHOUT the seam, and the `mention` row's on/off holder.
 *
 * The real `TuiMentionRuntime` is not importable from the 0.9.3 dev baseline
 * (the seam shipped in 0.20.1), so these tests drive the plugin half against
 * a faithful stub — the same split test/admission.test.ts uses for the panel
 * runtime, which is likewise a matrix-only shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as Ctx } from '@deepseek-ai/cordis'

import { resolveConfig } from '../src/config.js'
import type { ResolvedConfig } from '../src/config.js'
import type { ScannedSession, ScanOptions, SessionScanner } from '../src/core/scan.js'
import {
  MentionRegistration,
  registerMentionProvider,
  type MentionProvider,
  type MentionSurface,
} from '../src/mention.js'
import { REGISTER_RETRY_DELAY_MS, SEAM_TOTAL_BUDGET_MS } from '../src/seam.js'

/** Minimal activation context stand-in: warn capture + effect collection. */
function stubCtx(runtime: unknown) {
  const warns: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    logger: {
      warn: (message: string) => {
        warns.push(message)
      },
      info: () => {},
    },
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    get: () => runtime,
  } as unknown as Ctx
  return { ctx, warns, disposers }
}

/** A tuiMentions stand-in: keeps the providers, refuses duplicates. */
function stubMentions() {
  const providers = new Map<string, MentionProvider>()
  const surface = {
    providers,
    register(provider: MentionProvider): () => void {
      if (providers.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
      providers.set(provider.id, provider)
      return () => {
        providers.delete(provider.id)
      }
    },
  }
  return surface
}

function stubScanner(): SessionScanner {
  return { scan: async () => [] as ScannedSession[] } as unknown as SessionScanner
}

function wiring(scanner: SessionScanner = stubScanner(), config: Partial<ResolvedConfig> = {}) {
  const resolved: ResolvedConfig = { ...resolveConfig({ mention: true }), ...config }
  return { scanner, config: () => resolved, isSceneOpen: () => false }
}

describe('registerMentionProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers through the seam when it is already mounted', () => {
    const surface = stubMentions()
    const { ctx } = stubCtx(surface)
    registerMentionProvider(ctx, wiring())
    expect([...surface.providers.keys()]).toEqual(['dsh-tui-find'])
  })

  it('registers nothing, warns nothing and toasts nothing on a host without the seam', () => {
    // R-227: the give-up goes through logger.info + the optional toast, never
    // logger.warn — so observing `warns` alone passed even without `quiet`.
    // Capture all three channels and assert the SILENT posture on each.
    const infos: string[] = []
    const toasts: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: (message: string) => { infos.push(message) } },
      effect: (callback: () => () => void) => callback(),
      get: (name: string) =>
        name === 'tuiToast'
          ? { show: (text: string) => { toasts.push(text); return true } }
          : undefined,
    } as unknown as Ctx
    registerMentionProvider(ctx, wiring())
    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS + REGISTER_RETRY_DELAY_MS)
    // No provider, no toast; the give-up is a single info line naming the
    // seam (that line is the ONLY trace, which is why it is asserted).
    expect(toasts).toHaveLength(0)
    expect(infos.filter(line => line.includes('@ mention provider'))).toHaveLength(1)
  })

  it('lands on a late-mounted service instead of dropping the provider', () => {
    const surface = stubMentions()
    let mounted = false
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      effect: (callback: () => () => void) => callback(),
      get: () => (mounted ? surface : undefined),
    } as unknown as Ctx
    registerMentionProvider(ctx, wiring())
    expect(surface.providers.size).toBe(0)
    mounted = true
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 3)
    expect([...surface.providers.keys()]).toEqual(['dsh-tui-find'])
  })

  it('retries a refused registration instead of losing the provider for the session', () => {
    // R-215: the cold-boot liveness window is a TRANSIENT refusal, so the
    // attempt must be retried (the panel and the scene both do). A one-shot
    // try/catch would leave the whole session without @ completion.
    let attempts = 0
    const surface = {
      register(provider: MentionProvider): () => void {
        attempts += 1
        if (attempts <= 2) throw new Error('dsh-tui: tuiMentions.register requires a live activation')
        return stubMentions().register(provider)
      },
    }
    const { ctx, warns } = stubCtx(surface)
    registerMentionProvider(ctx, wiring())
    expect(attempts).toBe(1)
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 4)
    expect(attempts).toBe(3)
    // The recovery is reported once (a silent retry would hide a real
    // degradation behind a working-looking boot).
    expect(warns.some(line => line.includes('registered on retry'))).toBe(true)
  })
})

describe('MentionRegistration', () => {
  it('registers once while on and releases the provider when switched off', () => {
    let registrations = 0
    let releases = 0
    const holder = new MentionRegistration(() => {
      registrations += 1
      return {
        dispose: () => {
          releases += 1
        },
      }
    })
    holder.sync(true)
    holder.sync(true)
    expect(registrations).toBe(1)
    expect(holder.isEnabled()).toBe(true)
    holder.sync(false)
    expect(releases).toBe(1)
    expect(holder.isEnabled()).toBe(false)
    holder.sync(true)
    expect(registrations).toBe(2)
  })

  it('releases on dispose so a reload starts from a clean slate', () => {
    let releases = 0
    const holder = new MentionRegistration(() => ({ dispose: () => { releases += 1 } }))
    holder.sync(true)
    holder.dispose()
    holder.dispose()
    expect(releases).toBe(1)
  })
})

describe('MentionRegistration against the real registration path (R-218)', () => {
  // The earlier cases hand the holder a stub that really releases, so they
  // only exercise the holder arithmetic — the production wiring (which hands
  // over a MentionHandle) was never in the loop, and R-214 slipped through.
  // This case drives registerMentionProvider itself.
  it('releases the host provider when the row goes off, and re-registers cleanly', () => {
    const surface = stubMentions()
    const { ctx, warns } = stubCtx(surface)
    const holder = new MentionRegistration(() => registerMentionProvider(ctx, wiring()))
    holder.sync(true)
    expect([...surface.providers.keys()]).toEqual(['dsh-tui-find'])
    holder.sync(false)
    // R-214: the index dispose is NOT the registration release — the host
    // map must be empty here, or `mention: false` is a lie.
    expect(surface.providers.size).toBe(0)
    holder.sync(true)
    expect([...surface.providers.keys()]).toEqual(['dsh-tui-find'])
    // A second registration of the same id would be refused as duplicate,
    // which the plugin would log — so a clean re-open must stay silent.
    expect(warns).toHaveLength(0)
    holder.dispose()
    expect(surface.providers.size).toBe(0)
  })
})
