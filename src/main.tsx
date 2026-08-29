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
 * them all; nothing here touches a session log (read-only scanner) and
 * nothing here writes outside the plugin storage namespace.
 *
 * @module dsh-tui-find
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Config, resolveConfig, type Config as PluginConfig, type ResolvedConfig } from './config.js'
import { setLangOverride } from './i18n.js'
import { FindScene } from './scene.js'
import { registerSettingsSection } from './settings.js'

export const name = 'dsh-tui-find'

/** Cordis injection requirements: the agent loop (commands ride on it). */
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
 * Wire the plugin.
 *
 * @param ctx - Cordis context (plugin activation).
 * @param config - Validated row config (schema defaults applied by the host).
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolved = resolveActivationConfig(config)
  // Soft-probe (never inject) the TUI plugin-host row per the host's own
  // skew guidance; every seam below is optional — the plugin must mount
  // cleanly on a composition without the TUI (bare cordis.yml) and simply
  // do nothing there.
  const host = ctx.get('tuiPluginHost', false)

  // The search scene itself.
  const scenesRuntime = ctx.get('tuiScenes', false)
  if (scenesRuntime !== undefined) {
    const component = (props: TuiSceneProps) => (
      <FindScene
        {...props}
        config={resolved}
        initialQuery={() => {
          const value = pendingQuery
          pendingQuery = ''
          return value
        }}
      />
    )
    const dispose = scenesRuntime.register({ id: SCENE_ID, title: 'dsh-tui-find', component }, ctx)
    ctx.effect(() => dispose)
  }

  // /find — declared as contribution `dsh-tui-find.find` in the manifest;
  // registerCommand verifies the binding against the admitted identity.
  if (host !== undefined) {
    try {
      const definition: CommandDefinition = {
        name: COMMAND_NAME,
        description: 'Search all local dsh sessions (cross-session full-text)',
        input: { hint: '<keywords>' },
        // Opening the scene is UI state, not conversation content — keep
        // the raw input out of the session log.
        recordInput: false,
        handler: invocation => {
          pendingQuery = invocation.rawInput.trim()
          const scenes = ctx.get('tuiScenes', false)
          if (scenes === undefined) {
            return { kind: 'error', text: 'dsh-tui-find: TUI scenes seam unavailable' }
          }
          // An already-open scene does not remount on re-open, so a new
          // `/find <words>` while the scene is up would silently drop the
          // query — cycle the scene to force a remount that consumes it.
          if (scenes.active?.id === SCENE_ID) scenes.close()
          const opened = scenes.open(SCENE_ID)
          return opened
            ? { kind: 'success' }
            : { kind: 'error', text: 'dsh-tui-find: failed to open the find scene' }
        },
      }
      const dispose = host.registerCommand(ctx, COMMAND_CONTRIBUTION_ID, definition)
      ctx.effect(() => dispose)
    } catch (error) {
      ctx.logger.warn(
        `dsh-tui-find: /find registration failed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  // Ctrl+Shift+F — global entry into the scene. Registration failures are
  // contained like the command path: a bad binding must not fail the whole
  // plugin activation. The registry itself refuses reserved combos with a
  // logged warning (never a throw), so a user remap that collided with this
  // binding degrades to command-only access.
  const shortcutsRuntime = ctx.get('tuiShortcuts', false)
  if (shortcutsRuntime !== undefined) {
    try {
      const dispose = shortcutsRuntime.register(
        SHORTCUT_COMBO,
        {
          description: 'Find in all sessions (dsh-tui-find)',
          handler: () => {
            const scenes = ctx.get('tuiScenes', false)
            if (scenes !== undefined) {
              if (scenes.active?.id === SCENE_ID) scenes.close()
              scenes.open(SCENE_ID)
            }
          },
        },
        ctx,
      )
      ctx.effect(() => dispose)
    } catch (error) {
      ctx.logger.warn(
        `dsh-tui-find: ${SHORTCUT_COMBO} registration failed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  // Settings card over the host settings service.
  registerSettingsSection(ctx, resolved)
}

export default { name, inject, Config, apply }
