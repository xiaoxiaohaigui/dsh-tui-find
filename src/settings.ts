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
 * be absent on minimal compositions; the injection is therefore optional and
 * every failure degrades to "section renders unavailable" — the row config
 * (cordis.patch.yml) remains the always-works path.
 *
 * @module dsh-tui-find/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TuiSettingsSection } from '@deepseek-harness-tui/dsh-tui/settings-sections'
import type { ResolvedConfig } from './config.js'
import { DEFAULT_SHORTCUT, resolveConfig } from './config.js'
import { registerSeamWithRetry } from './seam.js'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'dsh-tui-find'

/** Keep the settings service structural rather than importing its types into
 *  the plugin's required surface; the peer remains optional at runtime. */
interface SettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** The zh translation for an English base text, per the host's field i18n
 *  contract: the plain string is the English text and the fallback, and the
 *  settings screen picks `descriptions[getLang()]` live at render time — so
 *  the card follows the TUI language setting (including a mid-session /lang
 *  switch) without re-registering anything. */
const zh = (text: string): { zh: string } => ({ zh: text })

/** The card, mirroring the row config keys one-to-one. */
function section(): TuiSettingsSection {
  return {
    ns: SETTINGS_NS,
    title: 'dsh-tui-find (session search)',
    descriptions: zh('dsh-tui-find（会话搜索）'),
    fields: [
      {
        path: ['defaultScope'],
        label: 'Default scope',
        descriptions: zh('默认搜索范围'),
        hint: 'Initial search scope for /find (repo = current workspace)',
        hintDescriptions: zh('/find 打开时的初始搜索范围（repo = 当前工作区）'),
        kind: 'select',
        options: [
          { value: 'repo', label: 'This repo', descriptions: zh('本仓库') },
          { value: 'all', label: 'All sessions', descriptions: zh('全部会话') },
        ],
      },
      {
        path: ['defaultTime'],
        label: 'Default time window',
        descriptions: zh('默认搜索时间'),
        hint: 'Initial time window for /find (Alt+T cycles it live; default all)',
        hintDescriptions: zh('/find 打开时的初始时间窗口（场景内 Alt+T 实时切换；默认全部）'),
        kind: 'select',
        options: [
          { value: 'all', label: 'All time', descriptions: zh('全部时间') },
          { value: '7d', label: 'Last 7 days', descriptions: zh('近 7 天') },
          { value: '30d', label: 'Last 30 days', descriptions: zh('近 30 天') },
        ],
      },
      {
        path: ['caseSensitive'],
        label: 'Case-sensitive',
        descriptions: zh('大小写敏感'),
        hint: 'Case-sensitive substring matching (default: insensitive)',
        hintDescriptions: zh('子串匹配区分大小写（默认不敏感）'),
        kind: 'boolean',
      },
      {
        path: ['regex'],
        label: 'Regex matching',
        descriptions: zh('正则匹配'),
        hint: 'Treat the query as a JavaScript regular expression (Alt+R toggles it live; default off)',
        hintDescriptions: zh('把查询当作 JavaScript 正则表达式（场景内 Alt+R 实时切换；默认关闭）'),
        kind: 'boolean',
      },
      {
        path: ['indexTools'],
        label: 'Index tool calls',
        descriptions: zh('索引工具调用'),
        hint: 'Index tool-call summaries ([name] arguments) for search',
        hintDescriptions: zh('把工具调用摘要（[名称] 参数）纳入搜索索引'),
        kind: 'boolean',
      },
      {
        path: ['indexThinking'],
        label: 'Index thinking',
        descriptions: zh('索引 thinking 文本'),
        hint: 'Index assistant thinking text (noisy and private; default off)',
        hintDescriptions: zh('把助手 thinking 文本纳入索引（噪音大且偏私密，默认关闭）'),
        kind: 'boolean',
      },
      {
        path: ['sessionRoot'],
        label: 'Session root override',
        descriptions: zh('会话目录覆盖'),
        hint: 'Manual session directory override (env/defaults apply when blank)',
        hintDescriptions: zh('手动指定会话根目录（留空时按环境变量与默认探测）'),
        kind: 'text',
        placeholder: 'C:\\Users\\me\\.dsh\\sessions',
      },
      {
        path: ['maxMessageChars'],
        label: 'Per-message index budget',
        descriptions: zh('单条消息索引字符上限'),
        hint: 'Per-message character budget for the index (200–65536, default 4000)',
        hintDescriptions: zh('索引时单条消息保留的字符数（200–65536，默认 4000）'),
        kind: 'number',
        placeholder: '4000',
      },
      {
        path: ['shortcut'],
        label: 'Global shortcut',
        descriptions: zh('全局快捷键'),
        hint: 'Combo that opens /find from anywhere (needs ctrl or alt; "off" disables; default ctrl+alt+f)',
        hintDescriptions: zh('打开 /find 的全局组合键（需含 ctrl 或 alt；off 关闭全局入口；默认 ctrl+alt+f）'),
        kind: 'text',
        placeholder: DEFAULT_SHORTCUT,
      },
    ],
  }
}

/**
 * Register the settings card; the namespace lands only when the host
 * settings service is present (dynamic import, contained failure).
 */
export function registerSettingsSection(
  ctx: Context,
  resolved: ResolvedConfig,
  onResolvedConfig?: (next: ResolvedConfig, raw: ConfigValue) => void,
): void {
  const sectionsRuntime = ctx.get('tuiSettingsSections', false)
  if (sectionsRuntime === undefined) return
  try {
    const dispose = sectionsRuntime.register(section())
    ctx.effect(() => dispose)
  } catch (error) {
    // A boot-window liveness rejection must retry, not degrade: a plain warn
    // would silently drop the settings card for the whole session (see
    // seam.ts for the mechanism). Permanent failures (e.g. a duplicate ns)
    // burn the bounded budget and warn once — acceptable for a card.
    registerSeamWithRetry(
      ctx,
      'settings section',
      () => sectionsRuntime.register(section()),
      dispose => ctx.effect(() => dispose),
      error,
    )
  }

  // Namespace registration is best-effort: without it the card renders
  // unavailable instead of editable, which is the documented degradation.
  ctx.inject?.(['settings'], (settingsCtx: Context) => {
    const settings = (settingsCtx as unknown as Record<string, unknown>)['settings'] as
      | { register(ns: unknown, schema: unknown): unknown }
      | undefined
    if (settings === undefined) return
    try {
      const schema = z.object({
        defaultScope: z.union(['repo', 'all']).default(resolved.defaultScope),
        defaultTime: z.union(['all', '7d', '30d']).default(resolved.defaultTime),
        caseSensitive: z.boolean().default(resolved.caseSensitive),
        regex: z.boolean().default(resolved.regex),
        indexTools: z.boolean().default(resolved.indexTools),
        indexThinking: z.boolean().default(resolved.indexThinking),
        sessionRoot: z.string().required(false).default(resolved.sessionRoot ?? ''),
        // Same bounds the row-config schema enforces (config.ts) — the
        // namespace must not accept values the row config would reject.
        maxMessageChars: z
          .number()
          .step(100)
          .min(200)
          .max(65536)
          .default(resolved.maxMessageChars),
        // 'off' (the disabled state of resolved.shortcut) is the namespace
        // default; combo validation stays with the shortcut registry at
        // apply time — the namespace only carries the string.
        shortcut: z.string().default(resolved.shortcut ?? 'off'),
      })
      // Namespace brands are type-only; alpha.2 validates the raw string in
      // register() itself, and the constant satisfies the older provider too.
      const scope = settings.register(SETTINGS_NS, schema) as SettingsScope<ConfigValue>
      const apply = (value: ConfigValue): void => {
        onResolvedConfig?.(resolveSettingsValue(value), value)
      }
      apply(scope.get())
      const unwatch = scope.watch(next => {
        apply(next)
      })
      settingsCtx.effect(() => unwatch)
    } catch {
      // The provider or schema is unavailable: the section stays unavailable;
      // the row config keeps working.
    }
  })
}

/** Schema output is validated by the host, but this boundary is optional and
 *  must still tolerate an older provider returning a partial object. */
type ConfigValue = {
  defaultScope?: 'repo' | 'all'
  defaultTime?: 'all' | '7d' | '30d'
  caseSensitive?: boolean
  regex?: boolean
  indexTools?: boolean
  indexThinking?: boolean
  sessionRoot?: string
  maxMessageChars?: number
  shortcut?: string
}

function resolveSettingsValue(value: ConfigValue): ResolvedConfig {
  return resolveConfig(value)
}
