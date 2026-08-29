/**
 * Settings card over the host seams, following the host's own two-part
 * pattern (`plugin.ts`):
 *
 * 1. register a settings-service namespace so `/settings` can edit the
 *    values (the section was 命名空间未注册 without this);
 * 2. register the `tuiSettingsSections` card whose fields map onto that
 *    namespace's schema paths.
 *
 * The settings service is a host peer (`@deepseek-ai/dsh-settings`) that may
 * be absent on minimal compositions; its import is therefore dynamic and
 * every failure degrades to "section renders unavailable" — the row config
 * (cordis.patch.yml) remains the always-works path.
 *
 * @module dsh-tui-find/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TuiSettingsSection } from '@deepseek-harness-tui/dsh-tui/settings-sections'
import type { ResolvedConfig } from './config.js'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'dsh-tui-find'

/** The card, mirroring the row config keys one-to-one. */
function section(): TuiSettingsSection {
  return {
    ns: SETTINGS_NS,
    title: 'dsh-tui-find (session search)',
    fields: [
      {
        path: ['defaultScope'],
        label: 'Default scope',
        hint: 'Initial search scope for /find (repo = current workspace)',
        kind: 'select',
        options: [
          { value: 'repo', label: 'This repo' },
          { value: 'all', label: 'All sessions' },
        ],
      },
      {
        path: ['caseSensitive'],
        label: 'Case-sensitive',
        hint: 'Case-sensitive substring matching (default: insensitive)',
        kind: 'boolean',
      },
      {
        path: ['indexTools'],
        label: 'Index tool calls',
        hint: 'Index tool-call summaries ([name] arguments) for search',
        kind: 'boolean',
      },
      {
        path: ['indexThinking'],
        label: 'Index thinking',
        hint: 'Index assistant thinking text (noisy and private; default off)',
        kind: 'boolean',
      },
      {
        path: ['sessionRoot'],
        label: 'Session root override',
        hint: 'Manual session directory override (env/defaults apply when blank)',
        kind: 'text',
        placeholder: 'e.g. C:\\Users\\me\\.dsh\\sessions',
      },
    ],
  }
}

/**
 * Register the settings card; the namespace lands only when the host
 * settings service is present (dynamic import, contained failure).
 */
export function registerSettingsSection(ctx: Context, resolved: ResolvedConfig): void {
  const sectionsRuntime = ctx.get('tuiSettingsSections', false)
  if (sectionsRuntime === undefined) return
  try {
    const dispose = sectionsRuntime.register(section())
    ctx.effect(() => dispose)
  } catch (error) {
    ctx.logger.warn(
      `dsh-tui-find: settings section registration failed (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  // Namespace registration is best-effort: without it the card renders
  // unavailable instead of editable, which is the documented degradation.
  ctx.inject?.(['settings'], (settingsCtx: Context) => {
    const settings = (settingsCtx as unknown as Record<string, unknown>)['settings'] as
      | { register(ns: unknown, schema: unknown): unknown }
      | undefined
    if (settings === undefined) return
    void (async () => {
      try {
        const mod = (await import('@deepseek-ai/dsh-settings')) as {
          settingsNamespace: (name: string) => unknown
        }
        const schema = z.object({
          defaultScope: z.union(['repo', 'all']).default(resolved.defaultScope),
          caseSensitive: z.boolean().default(resolved.caseSensitive),
          indexTools: z.boolean().default(resolved.indexTools),
          indexThinking: z.boolean().default(resolved.indexThinking),
          sessionRoot: z.string().required(false).default(resolved.sessionRoot ?? ''),
          maxMessageChars: z.number().default(resolved.maxMessageChars),
        })
        settings.register(mod.settingsNamespace(SETTINGS_NS), schema)
      } catch {
        // No dsh-settings copy reachable from the plugin: the section stays
        // unavailable; the row config keeps working.
      }
    })()
  })
}
