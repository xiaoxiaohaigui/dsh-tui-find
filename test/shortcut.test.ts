/**
 * Global-entry shortcut tests — the regression behind the `shortcut` config
 * knob: Ctrl+Shift+F never reached the plugin on mainstream terminals
 * (Windows Terminal, VS Code, GNOME Terminal bind the chord locally for
 * their own find UI and swallow the keypress), so the default must be a
 * terminal-safe combo and the knob must flow through `apply` into the LIVE
 * `tuiShortcuts` registry.
 *
 * The mounts run the real host extensions row (dsh-tui-extensions), so the
 * registration asserts face the same grammar/reserved/caller-fiber checks
 * as a real TUI boot — not a stub.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as extensionsApply, name as extensionsName } from '@deepseek-harness-tui/dsh-tui/extensions'
import plugin, { apply } from '../dist/main.js'
import { DEFAULT_SHORTCUT, isPlausibleShortcut, resolveConfig, resolveShortcut, type Config } from '../dist/config.js'

// These mounts activate the real plugin; keep the watermark journal off so
// no test ever writes against the real ~/.dsh-tui tree.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Mount the real extensions row (tuiShortcuts included) plus the plugin on
 * a fresh composition, then read the shortcut registry INSIDE the plugin's
 * fiber — the registry scopes `list()` to the registering caller.
 */
async function mountAndList(config: Config): Promise<string[]> {
  const root = new Context()
  root.plugin({ name: extensionsName, apply: extensionsApply })
  await sleep(30)
  const observed: string[] = []
  let applied = false
  root.plugin({
    name: plugin.name,
    apply: (ctx: Context) => {
      apply(ctx, config)
      const shortcuts = ctx.get('tuiShortcuts', false)
      observed.push(...(shortcuts?.list().map(entry => entry.combo) ?? []))
      applied = true
    },
  })
  // Wait on the apply completion, not on the registration result — an
  // intentionally empty registry (`shortcut: 'off'`) must be observable too.
  await vi.waitFor(() => expect(applied).toBe(true), { timeout: 5000, interval: 10 })
  return observed
}

describe('resolveShortcut (config normalization)', () => {
  it('defaults to the terminal-safe combo — never Ctrl+Shift+F', () => {
    expect(DEFAULT_SHORTCUT).not.toBe('ctrl+shift+f')
    expect(resolveShortcut(undefined)).toEqual({ combo: DEFAULT_SHORTCUT, invalid: false })
    expect(resolveShortcut('   ')).toEqual({ combo: DEFAULT_SHORTCUT, invalid: false })
  })

  it('normalizes case and whitespace', () => {
    expect(resolveShortcut('  Ctrl+Alt+G ')).toEqual({ combo: 'ctrl+alt+g', invalid: false })
  })

  it('disables the global entry on off/none/disabled (any case)', () => {
    expect(resolveShortcut('off')).toEqual({ combo: undefined, invalid: false })
    expect(resolveShortcut(' OFF ')).toEqual({ combo: undefined, invalid: false })
    expect(resolveShortcut('disabled')).toEqual({ combo: undefined, invalid: false })
  })

  it('flags implausible values and falls back to the default', () => {
    // Bare letter = typing per the host grammar; shift alone is not a meta
    // modifier — both would be refused by the registry, dropping the entry.
    expect(resolveShortcut('f')).toEqual({ combo: DEFAULT_SHORTCUT, invalid: true })
    expect(resolveShortcut('shift+f')).toEqual({ combo: DEFAULT_SHORTCUT, invalid: true })
    expect(resolveShortcut('ctrl+')).toEqual({ combo: DEFAULT_SHORTCUT, invalid: true })
  })

  it('plausibility requires a meta modifier and a key', () => {
    expect(isPlausibleShortcut('alt+f')).toBe(true)
    expect(isPlausibleShortcut('ctrl+f5')).toBe(false)
    expect(isPlausibleShortcut('ctrl+home')).toBe(true)
    expect(isPlausibleShortcut('ctrl+escape')).toBe(false)
    expect(isPlausibleShortcut('ctrl+unknown')).toBe(false)
    expect(isPlausibleShortcut('f')).toBe(false)
    expect(isPlausibleShortcut('shift+return')).toBe(false)
    expect(isPlausibleShortcut('alt+')).toBe(false)
  })

  it('maps the normalized combo into the resolved config (undefined = off)', () => {
    expect(resolveConfig({}).shortcut).toBe(DEFAULT_SHORTCUT)
    expect(resolveConfig({ shortcut: 'ALT+F' }).shortcut).toBe('alt+f')
    expect(resolveConfig({ shortcut: 'off' }).shortcut).toBeUndefined()
  })
})

describe('global entry registration (live tuiShortcuts registry)', () => {
  it('binds the terminal-safe default, not Ctrl+Shift+F', async () => {
    const combos = await mountAndList({})
    expect(combos).toContain('alt+f')
    expect(combos).not.toContain('ctrl+shift+f')
  })

  it('binds a custom combo from the shortcut config', async () => {
    expect(await mountAndList({ shortcut: 'alt+f' })).toEqual(['alt+f'])
  })

  it('registers nothing when the shortcut is off', async () => {
    expect(await mountAndList({ shortcut: 'off' })).toEqual([])
  })

  it('falls back to the default on an implausible value', async () => {
    expect(await mountAndList({ shortcut: 'shift+f' })).toEqual([DEFAULT_SHORTCUT])
  })

  it('falls back to the default when the host rejects a reserved combo', async () => {
    // ctrl+v is reserved by the host's built-in paste action but passes the
    // plugin's structural shortcut validation.
    expect(await mountAndList({ shortcut: 'ctrl+v' })).toEqual([DEFAULT_SHORTCUT])
  })

  it('binds after tuiShortcuts mounts later in the profile boot', async () => {
    // The late-mount path is the whenSeamMounted poll (seam.ts): the
    // plugin's apply can win the race against the TUI runtime's own startup,
    // and a bare soft-probe would silently skip the binding for the whole
    // session. The bind contract is pinned against a stub registry under
    // fake timers — the real extensions registry routes every seam call
    // through the host's caller-fiber liveness gate, which transiently
    // rejects timer-originated calls in a bare-cordis test environment
    // (register() swallows the rejection into a no-op disposer, list()
    // throws), so the live registry cannot deterministically exercise the
    // poll here; the real boot was verified on an actual 0.10.1 host.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const root = new Context()
      root.reflect.provide('agents', {})

      // Start the plugin before the shortcuts service exists. The first
      // activation cannot read the optional service synchronously; its
      // late-mount poll must attach once the service is provided below.
      const first = root.plugin(
        { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
        { shortcut: 'alt+f' },
      )
      await first

      // Host duplicate rule: a second register of a live combo is refused
      // with a no-op disposer, not an error.
      const registered: string[] = []
      const service = {
        register(combo: string): () => void {
          if (registered.includes(combo)) return () => {}
          registered.push(combo)
          return () => {
            const index = registered.indexOf(combo)
            if (index >= 0) registered.splice(index, 1)
          }
        },
        list(): Array<{ combo: string; description: string }> {
          return registered.map(combo => ({ combo, description: 'stub' }))
        },
      }
      root.reflect.provide('tuiShortcuts', service)
      await Promise.resolve()

      // One poll tick past the mount must land the bind.
      vi.advanceTimersByTime(30)
      expect(registered).toEqual(['alt+f'])

      // A second activation with the same combo is a probe: the host refuses
      // the duplicate and the plugin must not claim the combo again.
      const probe = root.plugin({
        name: 'dsh-tui-find-shortcut-probe',
        apply: (ctx: Context) => {
          apply(ctx, { shortcut: 'alt+f' })
        },
      })
      await probe
      expect(registered).toEqual(['alt+f'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('binds the settings-restored combo when the settings service mounts first', async () => {
    // R-048 regression. The settings restore (`ctx.inject(['settings'])` →
    // `apply(scope.get())`) can run while tuiShortcuts is still missing —
    // cordis runs the injected callback inline once its dependencies exist,
    // and the restore's own bindShortcut call early-returns on the unmounted
    // runtime. The late-mount poll must then bind the LIVE runtimeConfig
    // value: binding the apply-time row-config combo would silently override
    // the user's saved setting for the whole session.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const root = new Context()
      root.reflect.provide('agents', {})
      // Settings already mounted, carrying a persisted shortcut that differs
      // from the row config below.
      root.reflect.provide('settings', {
        register(): {
          get(): Record<string, unknown>
          watch(callback: (next: unknown, prev: unknown) => void): () => void
        } {
          return { get: () => ({ shortcut: 'alt+g' }), watch: () => () => {} }
        },
      })

      const registered: string[] = []
      await root.plugin(
        { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
        { shortcut: 'alt+f' },
      )
      root.reflect.provide('tuiShortcuts', {
        register(combo: string): () => void {
          if (registered.includes(combo)) return () => {}
          registered.push(combo)
          return () => {
            const index = registered.indexOf(combo)
            if (index >= 0) registered.splice(index, 1)
          }
        },
        list(): Array<{ combo: string }> {
          return registered.map(combo => ({ combo }))
        },
      })
      await Promise.resolve()

      // One poll tick past the mount must land the SAVED combo, not the
      // row-config one.
      vi.advanceTimersByTime(30)
      expect(registered).toEqual(['alt+g'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the global entry unbound when the saved setting is off and settings mounts first', async () => {
    // The same ordering as above with a persisted `off`: the restore is
    // dropped on the unmounted runtime and the poll must not resurrect the
    // row-config combo.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const root = new Context()
      root.reflect.provide('agents', {})
      root.reflect.provide('settings', {
        register(): {
          get(): Record<string, unknown>
          watch(callback: (next: unknown, prev: unknown) => void): () => void
        } {
          return { get: () => ({ shortcut: 'off' }), watch: () => () => {} }
        },
      })

      const registered: string[] = []
      await root.plugin(
        { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
        { shortcut: 'alt+f' },
      )
      root.reflect.provide('tuiShortcuts', {
        register(combo: string): () => void {
          if (registered.includes(combo)) return () => {}
          registered.push(combo)
          return () => {
            const index = registered.indexOf(combo)
            if (index >= 0) registered.splice(index, 1)
          }
        },
        list(): Array<{ combo: string }> {
          return registered.map(combo => ({ combo }))
        },
      })
      await Promise.resolve()

      vi.advanceTimersByTime(30)
      expect(registered).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
