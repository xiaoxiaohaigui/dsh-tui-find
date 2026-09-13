/** Regression coverage for the dsh-settings namespace API transition. */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.js'
import { registerSettingsSection, SETTINGS_NS } from '../src/settings.js'

describe('settings namespace', () => {
  it('uses the lowercase raw value accepted by dsh-settings alpha.2', () => {
    expect(SETTINGS_NS).toBe('dsh-tui-find')
  })

  it('registers the raw namespace synchronously when settings is injected', () => {
    const registered: unknown[] = []
    const ctx = {
      get: (key: string) => (key === 'tuiSettingsSections' ? { register: () => () => {} } : undefined),
      effect: (factory: () => () => void) => factory(),
      inject: (_deps: string[], callback: (injected: unknown) => void) =>
        callback({
          settings: {
            register: (namespace: unknown) => {
              registered.push(namespace)
              return { get: () => ({}), watch: () => () => {} }
            },
          },
          effect: (factory: () => () => void) => factory(),
        }),
    } as unknown as Context

    registerSettingsSection(ctx, resolveConfig(undefined))
    expect(registered).toEqual([SETTINGS_NS])
  })

  it('carries a layout select field mirroring the row config knob', () => {
    // The card's fields must map onto the namespace schema one-to-one: a
    // knob the card exposes but the namespace drops would render editable
    // and silently never persist.
    let card: { fields: Array<{ path: string[]; kind: string; options?: Array<{ value: string }> }> } | undefined
    const ctx = {
      get: (key: string) =>
        key === 'tuiSettingsSections'
          ? {
              register: (section: unknown) => {
                card = section as NonNullable<typeof card>
                return () => {}
              },
            }
          : undefined,
      effect: (factory: () => () => void) => factory(),
      inject: () => undefined,
    } as unknown as Context

    registerSettingsSection(ctx, resolveConfig(undefined))
    const field = card?.fields.find(candidate => candidate.path[0] === 'layout')
    expect(field?.kind).toBe('select')
    expect(field?.options?.map(option => option.value)).toEqual(['split', 'classic'])
  })

  it('defaults the namespace layout to the resolved value and round-trips classic', () => {
    let schema: ((value: Record<string, unknown>) => Record<string, unknown>) | undefined
    const ctx = {
      get: (key: string) => (key === 'tuiSettingsSections' ? { register: () => () => {} } : undefined),
      effect: (factory: () => () => void) => factory(),
      inject: (_deps: string[], callback: (injected: unknown) => void) =>
        callback({
          settings: {
            register: (_namespace: unknown, registered: unknown) => {
              schema = registered as NonNullable<typeof schema>
              return { get: () => ({}), watch: () => () => {} }
            },
          },
          effect: (factory: () => () => void) => factory(),
        }),
    } as unknown as Context

    registerSettingsSection(ctx, resolveConfig(undefined))
    expect(schema?.({})['layout']).toBe('split')
    expect(schema?.({ layout: 'classic' })['layout']).toBe('classic')
  })
})
