/**
 * Session-root resolution, mirroring the persistence backend's own priority
 * chain (dsh-TUI `src/dsh-adapter/compat/sessionLog.ts` `sessionsRoots()`):
 *
 *   1. `DSH_TUI_SESSION_ROOT` — explicit override, always outranks defaults.
 *   2. `$DSH_HOME || ~/.dsh` + `/sessions` — profile installs.
 *   3. `~/.dsh-tui/sessions` — bare/legacy installs.
 *
 * A plugin-level manual override (the settings `sessionRoot` field) is
 * prepended by the caller when set. All candidates are returned; the scanner
 * probes each and merges what it finds (first hit wins per session id).
 *
 * @module dsh-tui-find/core/roots
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Session-log storage roots.
 *
 * A manual override is EXCLUSIVE — when set, it is the only root probed
 * (that is what "override" means, and it is how tests isolate from the real
 * library). Otherwise the backend's own priority chain applies: the
 * `DSH_TUI_SESSION_ROOT` env var, then `$DSH_HOME || ~/.dsh` + `/sessions`,
 * then the bare/legacy `~/.dsh-tui/sessions`.
 */
export function sessionsRoots(manualOverride?: string): string[] {
  const trimmed = manualOverride?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return [resolve(trimmed)]
  const home = homedir()
  const envOverride = process.env['DSH_TUI_SESSION_ROOT']
  if (envOverride !== undefined && envOverride.trim().length > 0) return [resolve(envOverride.trim())]
  const dshHome = process.env['DSH_HOME']
  const roots = [
    join(
      dshHome !== undefined && dshHome.trim().length > 0 ? resolve(dshHome.trim()) : join(home, '.dsh'),
      'sessions',
    ),
    join(home, '.dsh-tui', 'sessions'),
  ]
  return [...new Set(roots)]
}
