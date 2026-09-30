/**
 * Session-root resolution (src/core/roots.ts): the persistence backend's own
 * priority chain — the plugin-level manual override (exclusive), then
 * `DSH_TUI_SESSION_ROOT`, then `$DSH_HOME || ~/.dsh` + `/sessions`, then the
 * bare/legacy `~/.dsh-tui/sessions`.
 *
 * Every other scan test isolates itself by passing the manual override, which
 * is exactly why the DEFAULT chain needs this test: on a real machine it is
 * what decides which session library the plugin reads, and a dropped or
 * reordered candidate means /find silently searches the wrong directory (or
 * nothing at all). The environment is set and restored explicitly rather than
 * via `vi.stubEnv` so a developer shell that already exports `DSH_HOME` or
 * `DSH_TUI_SESSION_ROOT` cannot leak into the assertions.
 */
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionsRoots } from '../src/core/roots.js'

const HOME = homedir()
/** The bare/legacy root, always the last candidate. */
const LEGACY = join(HOME, '.dsh-tui', 'sessions')
/** The profile root under a plain home: `~/.dsh/sessions`. */
const PROFILE = join(HOME, '.dsh', 'sessions')

const KEYS = ['DSH_HOME', 'DSH_TUI_SESSION_ROOT'] as const
const original = new Map(KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('sessionsRoots (default priority chain)', () => {
  it('returns the profile root before the legacy root', () => {
    // Order IS the contract: the scanner probes in order and the first hit
    // wins per session id.
    expect(sessionsRoots()).toEqual([PROFILE, LEGACY])
  })

  it('keeps a manual override exclusive, trimmed and resolved', () => {
    process.env['DSH_HOME'] = join(tmpdir(), 'dsh-home-ignored')
    process.env['DSH_TUI_SESSION_ROOT'] = join(tmpdir(), 'dsh-root-ignored')
    // "Override" means the only root probed (that is how tests, and the
    // settings `sessionRoot` field, isolate themselves from the real library).
    expect(sessionsRoots('  ./local/sessions  ')).toEqual([resolve('./local/sessions')])
  })

  it('treats a blank manual override as absent and falls through to the chain', () => {
    expect(sessionsRoots('   ')).toEqual([PROFILE, LEGACY])
    expect(sessionsRoots('')).toEqual([PROFILE, LEGACY])
  })

  it('reads DSH_TUI_SESSION_ROOT as the env override', () => {
    const root = join(tmpdir(), 'dsh-explicit-root')
    process.env['DSH_TUI_SESSION_ROOT'] = `  ${root}  `
    expect(sessionsRoots()).toEqual([resolve(root)])
    // It still outranks the profile/legacy candidates below it.
    process.env['DSH_HOME'] = join(tmpdir(), 'dsh-home')
    expect(sessionsRoots()).toEqual([resolve(root)])
  })

  it('ignores blank env-override values', () => {
    process.env['DSH_TUI_SESSION_ROOT'] = '   '
    expect(sessionsRoots()).toEqual([PROFILE, LEGACY])
  })

  it('prepends $DSH_HOME/sessions and keeps the legacy root as the fallback', () => {
    const home = join(tmpdir(), 'dsh-alternate-home')
    process.env['DSH_HOME'] = home
    expect(sessionsRoots()).toEqual([join(resolve(home), 'sessions'), LEGACY])
  })

  it('resolves a relative $DSH_HOME against the working directory', () => {
    process.env['DSH_HOME'] = '  ./alt-dsh-home  '
    expect(sessionsRoots()).toEqual([join(resolve('./alt-dsh-home'), 'sessions'), LEGACY])
  })

  it('ignores a blank $DSH_HOME', () => {
    process.env['DSH_HOME'] = '   '
    expect(sessionsRoots()).toEqual([PROFILE, LEGACY])
  })

  it('deduplicates when both candidates collapse onto one path', () => {
    // `DSH_HOME=~/.dsh-tui` makes the profile root the legacy root; probing
    // the same directory twice would double every enumerated log.
    process.env['DSH_HOME'] = join(HOME, '.dsh-tui')
    expect(sessionsRoots()).toEqual([LEGACY])
  })
})
