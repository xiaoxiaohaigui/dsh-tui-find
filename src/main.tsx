/**
 * dsh-tui-find — cross-session full-text search for dsh-TUI.
 *
 * A community plugin (independent Cordis package, no dsh-TUI source
 * changes). On activation it wires the host's seams:
 *
 * - `tuiPluginHost.registerCommand` — `/find` (declared in dsh-plugin.json
 *   as contribution `dsh-tui-find.find`), opening the scene, optionally
 *   seeding the query from the command's raw input.
 * - `tuiScenes.register` — the full-screen search scene.
 * - `tuiShortcuts.register` — `Ctrl+Shift+F` as a global entry (verified
 *   against the fixed reserved list; the registry itself re-checks user
 *   remaps and refuses reserved combos with a warning).
 * - `tuiSettingsSections.register` — the plugin's settings card (mirrors
 *   the row config onto the host settings service namespace).
 *
 * Every registration is scoped with `ctx.effect` so deactivation unwinds
 * them all; guarded registrations tolerate the host's cold-boot liveness
 * window with a bounded retry (`src/seam.ts`) instead of failing the
 * activation. Nothing here touches a session log (read-only scanner) and
 * nothing here writes outside the plugin storage namespace.
 *
 * @module dsh-tui-find
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Config, resolveConfig, type Config as PluginConfig, type ResolvedConfig } from './config.js'
import { SessionScanner } from './core/scan.js'
import { setLangOverride } from './i18n.js'
import { FindScene } from './scene.js'
import { registerSeamWithRetry } from './seam.js'
import { registerSettingsSection } from './settings.js'

export const name = 'dsh-tui-find'

/** Cordis injection requirements: the agent loop (commands ride on it).
 *  Required, not soft-probed: a composition without `agents` keeps the
 *  plugin pending (cordis never applies it there — no degraded half-state).
 *  Compositions that DO have `agents` but lack TUI runtimes are handled at
 *  apply time, where every seam below is optional. */
export const inject = ['agents']

export { Config }

/** Scene id (kebab-case, per tuiScenes grammar). */
export const SCENE_ID = 'dsh-tui-find-scene'

/** Command name without the slash. */
export const COMMAND_NAME = 'find'

/** Contribution id declared in dsh-plugin.json. */
export const COMMAND_CONTRIBUTION_ID = 'dsh-tui-find.find'

/** Global entry combo (verified absent from FIXED_RESERVED_COMBOS; the
 *  shortcut registry re-validates against live user remaps). */
export const SHORTCUT_COMBO = 'ctrl+shift+f'

/**
 * Query seeded by a `/find <words>` invocation and consumed by the scene on
 * mount. Process-lifetime module state is safe here: the TUI is single-
 * window, the scene is a singleton, and the value is consumed exactly once.
 */
let pendingQuery = ''

/** Resolve the effective plugin config once per activation. */
function resolveActivationConfig(config: PluginConfig | undefined): ResolvedConfig {
  const resolved = resolveConfig(config)
  // Unconditional: 'auto' must RESET a previously pinned override, not
  // leave it sticking until the process restarts.
  setLangOverride(resolved.lang === 'auto' ? undefined : resolved.lang)
  return resolved
}

/**
 * Whether this is the mediated path's designed rejection: a verified
 * Component identity is required for C-041 attribution, and the current
 * host runtime never issues one (the loader never calls admit) — so this
 * exact rejection is the documented trigger for the C-070 direct-registration
 * fallback, not a failure. Matched structurally (error name + code) because
 * `ComponentIdentityError` is a host internal the plugin must not import; a
 * drifted shape falls through to the warn path and stays loud.
 */
export function isExpectedAdmissionRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ComponentIdentityError' &&
    (error as { code?: unknown }).code === 'COMPONENT_NOT_ADMITTED'
  )
}

/**
 * Wire the plugin.
 *
 * @param ctx - Cordis context (plugin activation).
 * @param config - Validated row config (schema defaults applied by the host).
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolved = resolveActivationConfig(config)
  // setLangOverride pins module-level state; the disposer reverts it on
  // deactivation so a removed/reloaded row cannot leave a stale pin behind
  // (the next apply re-pins unconditionally — this matters while inactive).
  ctx.effect(() => () => setLangOverride(undefined))
  // Soft-probe (never inject) the TUI seams per the host's own skew
  // guidance; every seam below is optional — on a composition that has
  // `agents` but no TUI runtimes the plugin activates and simply does
  // nothing (compositions without `agents` stay pending; see `inject`).
  const host = ctx.get('tuiPluginHost', false)

  // The search scene itself.
  const scenesRuntime = ctx.get('tuiScenes', false)
  if (scenesRuntime !== undefined) {
    // One scanner per plugin activation (scan.ts's lifecycle contract): the
    // per-file decode cache survives scene close/open, so re-opening /find
    // after a warm sweep pays only per-file stats. A plugin restart rebuilds
    // it — the optionsKey guard would invalidate every entry anyway.
    const scanner = new SessionScanner()
    const component = (props: TuiSceneProps) => (
      <FindScene
        {...props}
        config={resolved}
        scanner={scanner}
        initialQuery={() => {
          const value = pendingQuery
          pendingQuery = ''
          return value
        }}
      />
    )
    try {
      const dispose = scenesRuntime.register({ id: SCENE_ID, title: 'dsh-tui-find', component }, ctx)
      ctx.effect(() => dispose)
    } catch (error) {
      // The host's liveness gate can reject registrations made during the
      // cold-boot window (runtime listeners installed between this fiber's
      // LOADING transition and its apply). A throw here would fail the whole
      // activation and, via the fail-closed plugin loader, the TUI boot —
      // that was the 0.1.5 startup breakage. Retry instead; see seam.ts.
      registerSeamWithRetry(
        ctx,
        'scene',
        () => scenesRuntime.register({ id: SCENE_ID, title: 'dsh-tui-find', component }, ctx),
        dispose => ctx.effect(() => dispose),
        error,
      )
    }
  }

  // /find — declared as contribution `dsh-tui-find.find` in the manifest.
  //
  // Preferred path: the mediated registration (C-041 attribution). It
  // requires a verified admission identity — which the current host runtime
  // does not issue (the cordis-plugin-loader never calls admit), so in
  // practice this throws COMPONENT_NOT_ADMITTED. Fallback: the documented
  // C-070 boundary — a direct registration through the commands service,
  // the same surface the host's own commands use. When the commands service
  // is absent entirely (bare cordis.yml), the registration degrades to a
  // logged warning; the scene and shortcut keep working.
  const commandDefinition: CommandDefinition = {
    name: COMMAND_NAME,
    description: 'Search all local dsh sessions (cross-session full-text)',
    input: { hint: '<keywords>' },
    // Opening the scene is UI state, not conversation content — keep
    // the raw input out of the session log.
    recordInput: false,
    handler: invocation => {
      const scenes = ctx.get('tuiScenes', false)
      if (scenes === undefined) {
        return { kind: 'error', text: 'dsh-tui-find: TUI scenes seam unavailable' }
      }
      pendingQuery = invocation.rawInput.trim()
      // An already-open scene does not remount on re-open, so a new
      // `/find <words>` while the scene is up would silently drop the
      // query — cycle the scene to force a remount that consumes it.
      if (scenes.active?.id === SCENE_ID) scenes.close()
      const opened = scenes.open(SCENE_ID)
      // A failed open leaves no scene to consume the seed; keeping it
      // would leak these words into a later shortcut-opened scene.
      if (!opened) pendingQuery = ''
      return opened
        ? { kind: 'success' }
        : { kind: 'error', text: 'dsh-tui-find: failed to open the find scene' }
    },
  }
  let commandRegistered = false
  if (host !== undefined) {
    try {
      const dispose = host.registerCommand(ctx, COMMAND_CONTRIBUTION_ID, commandDefinition)
      ctx.effect(() => dispose)
      commandRegistered = true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (isExpectedAdmissionRejection(error)) {
        // The by-design fallback on this host: info, not warn — a warn on
        // every boot for the expected path trains the eye to ignore warnings.
        ctx.logger.info(
          `dsh-tui-find: mediated /find registration unavailable (${detail}); using direct registration (C-070)`,
        )
      } else {
        ctx.logger.warn(
          `dsh-tui-find: mediated /find registration unavailable (${detail}); falling back to direct registration`,
        )
      }
    }
  }
  if (!commandRegistered) {
    const commandsRuntime = ctx.get('commands', false)
    if (commandsRuntime !== undefined) {
      try {
        const dispose = commandsRuntime.register(commandDefinition)
        ctx.effect(() => dispose)
      } catch (error) {
        ctx.logger.warn(
          `dsh-tui-find: /find registration failed (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    } else {
      ctx.logger.warn('dsh-tui-find: /find unavailable — the commands service is not mounted')
    }
  }

  // Ctrl+Shift+F — global entry into the scene. Registration failures are
  // contained like the command path: a bad binding must not fail the whole
  // plugin activation. The registry itself refuses reserved combos with a
  // logged warning (never a throw), so a user remap that collided with this
  // binding degrades to command-only access.
  const shortcutsRuntime = ctx.get('tuiShortcuts', false)
  if (shortcutsRuntime !== undefined) {
    const registerShortcut = () =>
      shortcutsRuntime.register(
        SHORTCUT_COMBO,
        {
          description: 'Find in all sessions (dsh-tui-find)',
          handler: () => {
            const scenes = ctx.get('tuiScenes', false)
            if (scenes === undefined) return
            // Already open: leave it running. Unlike /find there is no seed
            // to consume here, and the command path's close/open cycle would
            // erase the user's in-progress query.
            if (scenes.active?.id === SCENE_ID) return
            scenes.open(SCENE_ID)
          },
        },
        ctx,
      )
    try {
      const dispose = registerShortcut()
      ctx.effect(() => dispose)
    } catch (error) {
      // Same boot-window race as the scene registration above; a plain warn
      // would silently drop the shortcut for the whole session.
      registerSeamWithRetry(ctx, SHORTCUT_COMBO, registerShortcut, dispose => ctx.effect(() => dispose), error)
    }
  }

  // Settings card over the host settings service.
  registerSettingsSection(ctx, resolved)
}

export default { name, inject, Config, apply }
