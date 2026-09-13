/**
 * The `/find` command-tree provider (src/command-tree.ts): suggestion
 * metadata on the host's `tuiCommandTrees` runtime — localized root-row
 * description, deliberately empty children — behind the same soft-probe +
 * guarded-retry posture as every other seam.
 *
 * Unit tests stub the runtime (a duplicate-root-faithful stand-in). The
 * integration tests drive the REAL host class on a live cordis fiber (the
 * boot-race.test.ts scaffold) and probe through the host's own ownership
 * semantics: the runtime's `descriptions`/`children` serve the REGISTERING
 * fiber (called from the same apply), and a second plugin's register
 * collides with "already registered" iff the provider landed — the public
 * subpath module does not export the host-internal merged facade.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Context as Ctx } from '@deepseek-ai/cordis'
import TuiCommandTreeRuntime from '@deepseek-harness-tui/dsh-tui/command-trees'
import plugin from '../dist/main.js'
import { registerCommandTree } from '../src/command-tree.js'
import { dict } from '../src/i18n.js'
import { REGISTER_RETRY_DELAY_MS, REGISTER_RETRY_MAX_ATTEMPTS } from '../src/seam.js'

// The end-to-end test mounts the real plugin row; keep the watermark
// journal off so no test ever writes against the real ~/.dsh-tui tree.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

const LIVENESS_ERROR = new Error('dsh-tui: tuiCommandTrees.register requires a live Cordis activation context')

interface RegisteredProvider {
  root: string
  descriptions?: { zh?: string; en?: string }
  children(canonicalPath: readonly string[]): readonly unknown[]
}

/** Stand-in for TuiCommandTreeRuntime.register, duplicates included — the
 *  host rejects a second registration of the same root, which is exactly
 *  what the dispose test and the canary probe rely on. */
function stubRuntime() {
  const registered: RegisteredProvider[] = []
  return {
    registered,
    register(provider: RegisteredProvider): () => void {
      if (registered.some(entry => entry.root === provider.root)) {
        throw new Error(`TUI command-tree root "${provider.root}" is already registered`)
      }
      registered.push(provider)
      return () => {
        const at = registered.indexOf(provider)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  }
}

/** Minimal activation-context stand-in: warn capture + effect collection. */
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

describe('registerCommandTree (stub runtime)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers the provider with the localized description and an empty tree', () => {
    const stub = stubRuntime()
    const { ctx, disposers } = stubCtx(stub)

    registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })

    expect(stub.registered).toHaveLength(1)
    const provider = stub.registered[0]!
    expect(provider.root).toBe('find')
    expect(provider.descriptions).toEqual({ zh: dict['cmd-desc-find'].zh, en: dict['cmd-desc-find'].en })
    // Any canonical path resolves to an empty tree: /find takes a free-text
    // query, and a fabricated child would complete into a nonsense query.
    expect(provider.children(['find'])).toEqual([])
    expect(provider.children(['find', 'anything'])).toEqual([])
    // The disposer is scoped to the activation.
    expect(disposers).toHaveLength(1)
  })

  it('unwinds through the activation effect so a re-register cannot collide', () => {
    const stub = stubRuntime()
    const { ctx, disposers } = stubCtx(stub)

    registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })
    expect(stub.registered).toHaveLength(1)
    disposers[0]!()
    expect(stub.registered).toHaveLength(0)

    // The duplicate-root rejection must never fire for a re-registered
    // activation (reload/restart of the plugin row).
    expect(() => registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })).not.toThrow()
    expect(stub.registered).toHaveLength(1)
  })

  it('arms the late-mount poll and registers nothing when the service never appears', () => {
    const stub = stubRuntime()
    const { ctx, disposers } = stubCtx(undefined)

    expect(() => registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })).not.toThrow()
    expect(stub.registered).toHaveLength(0)
    // The service can mount after this plugin's apply (interleaved profile
    // loader), so a bare no-op would silently drop the provider for the
    // whole session. The late-mount poll stays armed — one cleanup effect —
    // until the budget runs out or the activation ends.
    expect(disposers).toHaveLength(1)
  })

  it('retries through the boot window and lands the provider once the gate opens', () => {
    const stub = stubRuntime()
    let attempts = 0
    const runtime = {
      register(provider: RegisteredProvider): () => void {
        attempts += 1
        if (attempts <= 2) throw LIVENESS_ERROR
        return stub.register(provider)
      },
    }
    const { ctx, warns } = stubCtx(runtime)

    // First attempt is the caller's synchronous one, rejected by the gate.
    registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })
    expect(attempts).toBe(1)
    expect(stub.registered).toHaveLength(0)

    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 3)
    expect(attempts).toBe(3)
    expect(stub.registered).toHaveLength(1)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('registered on retry')
    // Past success the timer is gone: no further attempts, no further logs.
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 10)
    expect(attempts).toBe(3)
    expect(warns).toHaveLength(1)
  })

  it('gives up after the bounded budget with a single warning', () => {
    const stub = stubRuntime()
    const runtime = {
      register(): () => void {
        throw LIVENESS_ERROR
      },
    }
    const { ctx, warns } = stubCtx(runtime)

    registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * REGISTER_RETRY_MAX_ATTEMPTS)
    expect(stub.registered).toHaveLength(0)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('failed after')
    expect(warns[0]).toContain(LIVENESS_ERROR.message)
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 10)
    expect(warns).toHaveLength(1)
  })
})

describe('command-tree registration on the real host runtime', () => {
  it('serves the provider to its registering fiber through the real class', async () => {
    const root = new Context()
    await root.plugin(TuiCommandTreeRuntime)

    // The runtime's descriptions()/children() resolve the caller fiber and
    // serve only the owner — called from the same apply that registered,
    // they must see the provider; a foreign root stays empty.
    const observed: unknown[] = []
    await root.plugin({
      name: 'cmd-tree-under-test',
      apply: (ctx: Ctx) => {
        registerCommandTree(ctx, { root: 'find', descriptions: dict['cmd-desc-find'] })
        const runtime = ctx.get('tuiCommandTrees', false)!
        observed.push(runtime.descriptions('find'))
        observed.push(runtime.children(['find']))
        observed.push(runtime.descriptions('model'))
      },
    })

    expect(observed[0]).toEqual({ zh: dict['cmd-desc-find'].zh, en: dict['cmd-desc-find'].en })
    expect(observed[1]).toEqual([])
    expect(observed[2]).toBeUndefined()
  })

  it('the real plugin apply wires the seam end to end', async () => {
    const root = new Context()
    root.reflect.provide('agents', {})
    // Runtime mounted (and its fiber trust-table listeners installed) before
    // the plugin fiber exists: registration lands on the first attempt.
    await root.plugin(TuiCommandTreeRuntime)
    await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })

    // Duplicate-root canary (the boot-race probe pattern): the host rejects
    // a second registration of 'find' iff the plugin's provider landed.
    const observed: string[] = []
    await root.plugin({
      name: 'cmd-tree-canary',
      apply: (ctx: Ctx) => {
        try {
          const dispose = ctx.get('tuiCommandTrees', false)!.register({ root: 'find', children: () => [] })
          dispose()
          observed.push('provider-absent')
        } catch (error) {
          observed.push((error as Error).message)
        }
      },
    })
    expect(observed[0]).toContain('already registered')
  })
})

describe('command-tree copy', () => {
  it('keeps the en description in lockstep with the manifest command description', () => {
    const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8')) as {
      contributes: { commands: Array<{ id: string; description: string }> }
    }
    // Locate by contribution id, not position: the commands array may grow.
    const command = manifest.contributes.commands.find(entry => entry.id === 'dsh-tui-find.find')
    expect(command).toBeDefined()
    // The CommandDefinition description (the overlay's fallback text) is
    // sourced from this dict entry in main.tsx, so the fallback and the
    // provider's en description cannot drift apart.
    expect(dict['cmd-desc-find'].en).toBe(command!.description)
  })
})
