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
    const root = new Context()
    root.reflect.provide('agents', {})

    // Start the plugin before dsh-tui-extensions. The first activation cannot
    // read the optional service synchronously; its injected binding callback
    // must attach when the service is provided below.
    const first = root.plugin(
      { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
      { shortcut: 'alt+f' },
    )
    await first

    const extensions = root.plugin({ name: extensionsName, apply: extensionsApply })
    await extensions
    await vi.waitFor(() => expect(root.get('tuiShortcuts', false)).toBeDefined(), { timeout: 5000, interval: 10 })
    await sleep(50)

    // A second activation with the same combo is a probe: if the late bind
    // succeeded it is rejected as a duplicate and this activation's list is
    // empty; with the old captured-undefined bug it would claim alt+f itself.
    const observed: string[] = []
    const probe = root.plugin({
      name: 'dsh-tui-find-shortcut-probe',
      apply: (ctx: Context) => {
        apply(ctx, { shortcut: 'alt+f' })
        observed.push(...(ctx.get('tuiShortcuts', false)?.list().map(entry => entry.combo) ?? []))
      },
    })
    await probe
    expect(observed).toEqual([])
  })
})
