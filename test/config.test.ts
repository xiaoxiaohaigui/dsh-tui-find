/**
 * Unit tests for the row-config resolution (src/config.ts) — the defensive
 * `resolveConfig` over a possibly-partial config. Focused on `defaultTime`
 * (the initial time window the find scene opens with) and the value-class
 * behavior of its neighbours: unknown/garbage values must fall back to the
 * documented defaults, not crash or leak through.
 */
import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'

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

describe('resolveConfig — schema defaults stay in sync with the defensive layer', () => {
  it('applies the documented default for every knob', () => {
    const resolved = resolveConfig(undefined)
    expect(resolved).toEqual({
      defaultScope: 'repo',
      defaultTime: 'all',
      caseSensitive: false,
      regex: false,
      indexTools: true,
      indexThinking: false,
      sessionRoot: undefined,
      maxMessageChars: 4000,
      lang: 'auto',
      shortcut: 'ctrl+alt+f',
    })
  })

  it('the schemastery schema default resolves to the same shape', () => {
    // The schema defaults (what the host row config feeds apply()) and the
    // defensive defaults (what tests/drift feed) must agree — a drift would
    // make /settings rows and README-documented defaults diverge.
    expect(resolveConfig(Config({}))).toEqual(resolveConfig(undefined))
  })
})
