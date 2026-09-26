/** Regression coverage for the dsh-settings generation split.
 *
 * ≤0.1.6 hosts own a plugin-registered namespace; ≥0.1.7 hosts project the
 * plugin's Config onto its `.volatile()` fields and have no registration API
 * at all. Both paths, plus the card-field/live-key parity that keeps a field
 * from rendering editable while nothing serves it (the failure the host's own
 * status-bar `cost` field shows as a permanent `（未设置）`).
 * See docs/decisions/2026-09-24-settings-generation-adaptation.md.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LIVE_CONFIG_KEYS, resolveConfig } from '../src/config.js'
import {
  registerSettingsSection,
  resolveSettingsNamespace,
  SETTINGS_NS,
  type SettingsWiring,
} from '../src/settings.js'

type Card = { ns: string; fields: Array<{ path: string[]; kind: string; options?: Array<{ value: string }> }> }

type FakeOptions = {
  settings?: Record<string, unknown> | undefined
  /** Loader entry id the plugin's fiber reports (what a ≥0.1.7 host keys by). */
  entryId?: string
  on?: (event: string, listener: () => void) => () => void
}

type Recorded = { cards: Card[]; logs: string[]; effects: Array<() => void>; events: string[] }

/** A context stub carrying exactly the surface settings.ts touches. */
function fakeContext(options: FakeOptions = {}): { ctx: Context; seen: Recorded } {
  const seen: Recorded = { cards: [], logs: [], effects: [], events: [] }
  const cardRuntime = {
    register: (section: Card) => {
      seen.cards.push(section)
      return () => {}
    },
  }
  const child = {
    settings: options.settings,
    effect: (factory: () => () => void) => {
      const dispose = factory()
      seen.effects.push(dispose)
      return dispose
    },
    logger: {
      warn: (message: string) => seen.logs.push(`warn: ${message}`),
      info: (message: string) => seen.logs.push(`info: ${message}`),
    },
  }
  const ctx = {
    get: (key: string) => (key === 'tuiSettingsSections' ? cardRuntime : undefined),
    effect: (factory: () => () => void) => {
      const dispose = factory()
      seen.effects.push(dispose)
      return dispose
    },
    inject: (_deps: string[], callback: (injected: unknown) => void) => callback(child),
    on: (event: string, listener: () => void) => {
      seen.events.push(event)
      return options.on?.(event, listener)
    },
    fiber:
      options.entryId === undefined ? undefined : { entry: { options: { id: options.entryId } } },
    logger: child.logger,
  }
  return { ctx: ctx as unknown as Context, seen }
}

/** Wiring over a mutable raw config, mirroring main.tsx's thunk. */
function wiringOver(raw: { current: Record<string, unknown> }): SettingsWiring & {
  applied: Array<{ layout: string; warmup: boolean }>
} {
  const applied: Array<{ layout: string; warmup: boolean }> = []
  return {
    resolved: resolveConfig(undefined),
    readRaw: () => raw.current,
    onResolved: next => applied.push({ layout: next.layout, warmup: next.warmup }),
    applied,
  }
}

describe('settings namespace', () => {
  it('uses the lowercase raw value accepted by dsh-settings alpha.2', () => {
    expect(SETTINGS_NS).toBe('dsh-tui-find')
  })

  it('registers the raw namespace synchronously on the ≤0.1.6 generation', () => {
    const registered: unknown[] = []
    const { ctx, seen } = fakeContext({
      settings: {
        register: (namespace: unknown) => {
          registered.push(namespace)
          return { get: () => ({}), watch: () => () => {} }
        },
      },
    })

    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(registered).toEqual([SETTINGS_NS])
    expect(seen.cards).toHaveLength(1)
    expect(seen.logs).toEqual([])
  })

  it('adopts the ≥0.1.7 generation: page policy, no namespace registration', () => {
    const configured: Array<{ presentation: unknown; owner: unknown }> = []
    const { ctx, seen } = fakeContext({
      settings: {
        configure: (presentation: unknown, owner: unknown) => {
          configured.push({ presentation, owner })
          return () => {}
        },
      },
      entryId: 'dsh-tui-find',
      on: () => () => {},
    })
    const wiring = wiringOver({ current: { layout: 'classic' } })

    registerSettingsSection(ctx, wiring)

    // The card is the plugin's own page: opt out of the auto-generated one,
    // attached to the Config-owning fiber rather than the injected child.
    expect(configured).toEqual([
      { presentation: { auto: false }, owner: (ctx as unknown as { fiber: unknown }).fiber },
    ])
    expect(seen.logs).toEqual([])
    // The initial value comes from the live row config, not from a scope.
    expect(wiring.applied.at(-1)).toEqual({ layout: 'classic', warmup: true })
    // Exactly one listener, on the loader's live-config event.
    expect(seen.events).toEqual(['loader/volatile-update'])
  })

  it('follows the Loader entry id, on both generations', () => {
    // A ≥0.1.7 host keys the namespace by `entry.options.id` (and the settings
    // screen matches sections by that same string), so a renamed row must move
    // the card with it — dsh-TUI #990's fragility. The legacy registration uses
    // the same string so the card and the stored section cannot disagree.
    const registered: unknown[] = []
    const { ctx, seen } = fakeContext({
      settings: {
        register: (namespace: unknown) => {
          registered.push(namespace)
          return { get: () => ({}), watch: () => () => {} }
        },
      },
      entryId: 'my-find',
    })

    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(resolveSettingsNamespace(ctx)).toBe('my-find')
    expect(seen.cards[0]?.ns).toBe('my-find')
    expect(registered).toEqual(['my-find'])
  })

  it('falls back to the constant namespace when the entry id is unusable', () => {
    // Plugin-owned sections must satisfy the host's lowercase-kebab grammar, so
    // an id like `Custom.TUI` cannot be registered — the card keeps the stable
    // name and the new generation says why nothing will be served.
    const { ctx, seen } = fakeContext({
      settings: { configure: () => () => {} },
      entryId: 'Custom.TUI',
      on: () => () => {},
    })

    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(resolveSettingsNamespace(ctx)).toBe(SETTINGS_NS)
    expect(seen.cards[0]?.ns).toBe(SETTINGS_NS)
    expect(seen.logs.join('\n')).toContain('keys namespaces by Loader entry id "Custom.TUI"')
  })

  it('re-reads the live config on loader/volatile-update', () => {
    const listeners: Array<() => void> = []
    const { ctx } = fakeContext({
      settings: { configure: () => () => {} },
      on: (event, listener) => {
        expect(event).toBe('loader/volatile-update')
        listeners.push(listener)
        return () => {}
      },
    })
    const raw = { current: { layout: 'split', warmup: true } }
    const wiring = wiringOver(raw)

    registerSettingsSection(ctx, wiring)
    expect(wiring.applied).toEqual([{ layout: 'split', warmup: true }])

    // What a /settings save looks like: the loader rewrites the same refs, the
    // event fires, the plugin re-resolves.
    raw.current = { layout: 'classic', warmup: false }
    for (const listener of listeners) listener()
    expect(wiring.applied.at(-1)).toEqual({ layout: 'classic', warmup: false })
  })

  it('logs (never swallows) a failing namespace registration', () => {
    const { ctx, seen } = fakeContext({
      settings: {
        register: () => {
          throw new Error('settings namespace "dsh-tui-find" is already registered')
        },
      },
    })

    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(seen.logs.join('\n')).toContain('already registered')
  })

  it('explains a settings service that has neither generation surface', () => {
    const { ctx, seen } = fakeContext({ settings: {} })
    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(seen.logs.join('\n')).toContain('neither the namespace registration nor the Config-derived surface')
  })

  it('serves the card from the live Config keys one-to-one', () => {
    // The card's paths, the live Config keys and the marked fields are the
    // same set: a card field outside it renders editable but never receives a
    // value (and its writes are refused as "not volatile"), while a live key
    // without a field would be editable with no UI to show it.
    const { ctx, seen } = fakeContext({ settings: undefined })
    registerSettingsSection(ctx, wiringOver({ current: {} }))
    const paths = (seen.cards[0]?.fields ?? []).map(field => field.path.join('.'))
    expect([...paths].sort()).toEqual([...LIVE_CONFIG_KEYS].sort())
  })

  it('carries a layout select field mirroring the row config knob', () => {
    // The card's fields must map onto the live keys one-to-one: a knob the
    // card exposes but the Config drops would render editable and silently
    // never persist.
    const { ctx, seen } = fakeContext({ settings: undefined })
    registerSettingsSection(ctx, wiringOver({ current: {} }))
    const field = seen.cards[0]?.fields.find(candidate => candidate.path[0] === 'layout')
    expect(field?.kind).toBe('select')
    expect(field?.options?.map(option => option.value)).toEqual(['split', 'classic'])
  })

  it('defaults the ≤0.1.6 namespace layout to the resolved value and round-trips classic', () => {
    let schema: ((value: Record<string, unknown>) => Record<string, unknown>) | undefined
    const { ctx } = fakeContext({
      settings: {
        register: (_namespace: unknown, registered: unknown) => {
          schema = registered as NonNullable<typeof schema>
          return { get: () => ({}), watch: () => () => {} }
        },
      },
    })

    registerSettingsSection(ctx, wiringOver({ current: {} }))
    expect(schema?.({})['layout']).toBe('split')
    expect(schema?.({ layout: 'classic' })['layout']).toBe('classic')
  })
})
