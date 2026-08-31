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
})
