/**
 * Unit tests for the row-config resolution (src/config.ts) — the defensive
 * `resolveConfig` over a possibly-partial config, plus the two host-generation
 * concerns that live here: the capability-probed `.volatile()` marking and the
 * unwrapping of the live refs such a field arrives as.
 * Focused on `defaultTime` (the initial time window the find scene opens
 * with) and the value-class behavior of its neighbours: unknown/garbage values
 * must fall back to the documented defaults, not crash or leak through.
 */
import { describe, expect, it } from 'vitest'
import { Config, LIVE_CONFIG_KEYS, hasLiveConfigFields, liveField, readConfigValues, resolveConfig } from '../src/config.js'

describe('resolveConfig — defaultTime', () => {
  it('defaults to all when unset', () => {
    expect(resolveConfig(undefined).defaultTime).toBe('all')
    expect(resolveConfig({}).defaultTime).toBe('all')
  })

  it('accepts each window the scene cycles through', () => {
    expect(resolveConfig({ defaultTime: 'all' }).defaultTime).toBe('all')
    expect(resolveConfig({ defaultTime: '7d' }).defaultTime).toBe('7d')
    expect(resolveConfig({ defaultTime: '30d' }).defaultTime).toBe('30d')
  })

  it('coerces unknown values to all instead of leaking through', () => {
    // The schema validates real rows, but resolveConfig is also fed by tests
    // and drift — an unknown window must degrade to 'all', never to an
    // unfiltered-list bug or a NaN cutoff.
    expect(resolveConfig({ defaultTime: 'tomorrow' as never }).defaultTime).toBe('all')
    expect(resolveConfig({ defaultTime: 7 as never }).defaultTime).toBe('all')
  })
})

describe('resolveConfig — layout', () => {
  it('defaults to split when unset', () => {
    expect(resolveConfig(undefined).layout).toBe('split')
    expect(resolveConfig({}).layout).toBe('split')
  })

  it('passes classic through', () => {
    expect(resolveConfig({ layout: 'classic' }).layout).toBe('classic')
    expect(resolveConfig({ layout: 'split' }).layout).toBe('split')
  })

  it('coerces unknown values to split instead of leaking through', () => {
    // The schema validates real rows, but resolveConfig is also fed by tests
    // and drift — an unknown layout must degrade to the default form, never
    // to a broken render branch.
    expect(resolveConfig({ layout: 'wide' as never }).layout).toBe('split')
    expect(resolveConfig({ layout: 1 as never }).layout).toBe('split')
  })
})

describe('resolveConfig — schema defaults stay in sync with the defensive layer', () => {
  it('applies the documented default for every knob', () => {
    const resolved = resolveConfig(undefined)
    expect(resolved).toEqual({
      defaultScope: 'repo',
      defaultTime: 'all',
      layout: 'split',
      caseSensitive: false,
      regex: false,
      pinyin: true,
      titleOnly: false,
      indexTools: false,
      indexThinking: false,
      sessionRoot: undefined,
      maxMessageChars: 4000,
      warmup: true,
      lang: 'auto',
      shortcut: 'alt+f',
    })
  })

  it('warmup defaults on and only an explicit false disables it', () => {
    expect(resolveConfig({}).warmup).toBe(true)
    expect(resolveConfig({ warmup: true }).warmup).toBe(true)
    expect(resolveConfig({ warmup: false }).warmup).toBe(false)
    expect(resolveConfig({ warmup: 'no' as never }).warmup).toBe(true)
  })

  it('titleOnly defaults off and only an explicit true enables it', () => {
    expect(resolveConfig({}).titleOnly).toBe(false)
    expect(resolveConfig({ titleOnly: true }).titleOnly).toBe(true)
    expect(resolveConfig({ titleOnly: false }).titleOnly).toBe(false)
    expect(resolveConfig({ titleOnly: 'yes' as never }).titleOnly).toBe(false)
  })

  it('the schemastery schema default resolves to the same shape', () => {
    // The schema defaults (what the host row config feeds apply()) and the
    // defensive defaults (what tests/drift feed) must agree — a drift would
    // make /settings rows and README-documented defaults diverge.
    expect(resolveConfig(Config({}))).toEqual(resolveConfig(undefined))
  })
})

describe('live config fields (dsh-settings ≥0.1.7)', () => {
  /** The cosmokit Volatile brand, read by name exactly as the runtime does
   *  (`cosmokit/src/volatile.ts`: `Symbol.for('cosmokit.volatile.write')`). */
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

  /** The loader's Volatile protocol: a frozen branded ref whose value it
   *  rewrites. `extra` models a ref that carries more than `get` — the shape
   *  the brand probe exists for (REVIEW R-086). */
  const ref = (value: unknown, extra: Record<string, unknown> = {}) =>
    Object.freeze({ get: () => value, [VOLATILE_WRITE]: () => {}, ...extra })

  it('prefers .volatile() and falls back to the meta marker without it', () => {
    // Capability order, not a version check: `.volatile()` exists from
    // schemastery 3.18.3 and is the validated path; below that the settings
    // projection still reads `meta.volatile`, so the marker is written
    // directly (dsh-TUI #990's fix for its own Config).
    const capable = { volatile: () => ({ marked: true }), meta: {} }
    expect(liveField(capable)).toEqual({ marked: true })
    const legacy = { meta: {} as { volatile?: unknown } }
    expect(liveField(legacy)).toBe(legacy)
    expect(legacy.meta.volatile).toBe(true)
    // A host that froze its meta must degrade, not throw.
    const frozen = { meta: Object.freeze({}) as { volatile?: unknown } }
    expect(liveField(frozen)).toBe(frozen)
    expect(frozen.meta.volatile).toBeUndefined()
  })

  it('marks the shipped Config on this repo 3.18.1 baseline via meta', () => {
    // The real end-to-end proof of the fallback: the repo's schemastery has no
    // `.volatile()`, so these markers exist only because the meta path ran —
    // exactly what a 0.1.7 host projects when the plugin resolved an old copy.
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: unknown } }> }).dict
    expect(dict['layout']?.meta?.volatile).toBe(true)
    expect(dict['shortcut']?.meta?.volatile).toBe(true)
    expect(dict['lang']?.meta?.volatile).toBeUndefined()
    expect(hasLiveConfigFields()).toBe(true)
  })

  it('readConfigValues unwraps live refs and leaves plain values alone', () => {
    expect(readConfigValues({ layout: ref('classic'), warmup: false, shortcut: 'off' })).toEqual({
      layout: 'classic',
      warmup: false,
      shortcut: 'off',
    })
    // Absent config and a missing key both read as "unset", never as a ref.
    expect(readConfigValues(undefined)).toEqual({})
  })

  it('unwraps a branded ref that carries more than `get`', () => {
    // R-086's failure mode: the protocol brand is the authority, so a ref with
    // an extra ordinary key must still unwrap. Under the old shape heuristic
    // (`own enumerable keys exactly ['get']`) this returned the ref object
    // itself, resolveConfig then read it as "value not equal to the default"
    // and silently fell back to `alt+f` — no warning at all.
    expect(readConfigValues({ shortcut: ref('ctrl+alt+g', { id: 'live-1' }) })).toEqual({
      shortcut: 'ctrl+alt+g',
    })
    expect(resolveConfig({ shortcut: ref('ctrl+alt+g', { id: 'live-1' }) }).shortcut).toBe('ctrl+alt+g')
    // The shape check stays as a fallback for a hand-rolled ref without the
    // brand (and for a stub built before the protocol was modelled here).
    expect(readConfigValues({ layout: { get: () => 'classic' } })).toEqual({ layout: 'classic' })
    // A `get` that is not a function is never unwrapped, branded or not.
    expect(readConfigValues({ layout: { get: 'classic' } })).toEqual({ layout: { get: 'classic' } })
  })

  it('resolveConfig reads the same values through a live ref and a plain value', () => {
    const live = readConfigValues({ layout: ref('classic'), shortcut: ref('ctrl+alt+g'), warmup: ref(false) })
    expect(resolveConfig(live)).toEqual(
      resolveConfig({ layout: 'classic', shortcut: 'ctrl+alt+g', warmup: false }),
    )
  })

  it('keeps lang off the live list (row-config knob, no card field)', () => {
    expect(LIVE_CONFIG_KEYS).not.toContain('lang')
  })
})
