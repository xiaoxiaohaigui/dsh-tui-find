/**
 * Settings card over the host seams, following the host's own two-part
 * pattern (`dsh-adapter/plugin.js`):
 *
 * 1. register the `tuiSettingsSections` card whose fields map onto the
 *    settings values one-to-one;
 * 2. feed those values: a settings-service namespace on hosts that still have
 *    the registration API, or the plugin's own live Config on hosts that
 *    replaced it.
 *
 * The settings service is a host peer (`@deepseek-ai/dsh-settings`) that may
 * be absent on minimal compositions; the injection is therefore optional and
 * every failure degrades to "section renders unavailable" — the row config
 * (cordis.patch.yml) remains the always-works path.
 *
 * Two generations, branched by capability (never by version):
 *
 * - **≤0.1.6** — `settings.register(ns, schema)` owns the namespace. The card's
 *   paths resolve against the scope schema declared here, and `scope.watch`
 *   pushes edits into the plugin.
 * - **≥0.1.7** — there is no registration API at all (`SettingsForms` projects
 *   each profile entry's *Config* instead). The namespace is this plugin's
 *   profile entry id — which equals {@link SETTINGS_NS} — and the form schema
 *   is `Config` filtered to its `.volatile()` fields (config.ts). Edits land in
 *   the profile patch, the loader rewrites those same refs in place, and
 *   `loader/volatile-update` announces it; this module re-reads the live config
 *   on that event. The card stays ours, so the auto-generated page is turned
 *   off with `configure({ auto: false })`.
 *
 * A miss in either direction is silent and user-visible only as a card that
 * renders but never saves (≤0.1.6) or a `命名空间未注册` badge (≥0.1.7) — hence
 * the branch below logs its failure instead of swallowing it.
 * Background: docs/decisions/2026-09-24-settings-generation-adaptation.md.
 *
 * @module dsh-tui-find/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TuiSettingsSection } from '@deepseek-harness-tui/dsh-tui/settings-sections'
import type { ResolvedConfig } from './config.js'
import { DEFAULT_SHORTCUT, resolveConfig } from './config.js'
import { registerSeamWithRetry, whenSeamMounted } from './seam.js'

/** Settings namespace owned by this plugin. It is also the plugin's profile
 *  entry id (`cordis.patch.yml`), which is what the ≥0.1.7 generation keys
 *  namespaces by — cite both when one of them ever changes. */
export const SETTINGS_NS = 'dsh-tui-find'

/** Keep the settings service structural rather than importing its types into
 *  the plugin's required surface; the peer remains optional at runtime. */
interface SettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** The union of both generations' surfaces: ≤0.1.6 registration and the
 *  ≥0.1.7 Config-derived forms with their per-instance page policy. */
interface SettingsService {
  register?(ns: string, schema: unknown): unknown
  configure?(presentation: { auto?: boolean }, owner?: unknown): unknown
}

/** How the wiring reaches the plugin's live configuration. */
export interface SettingsWiring {
  /** Apply-time resolved row config: the ≤0.1.6 namespace schema's defaults
   *  and the fallback whenever the live source is unreadable. */
  readonly resolved: ResolvedConfig
  /** The live row config, volatile-aware (config.ts `readConfigValues`). On
   *  ≥0.1.7 hosts the loader rewrites the refs inside this object in place, so
   *  reading it again after `loader/volatile-update` yields the edited values. */
  readRaw(): ConfigValue | undefined
  /** Receives each resolved value the plugin should run with — the initial one
   *  and every later edit. */
  onResolved(next: ResolvedConfig, raw: ConfigValue): void
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
        path: ['layout'],
        label: 'Layout',
        descriptions: zh('界面布局'),
        hint: 'Split panes (list + reader side by side, needs >= 100 columns) or classic (single list + full-screen preview); default split',
        hintDescriptions: zh(
          '分栏（左列表 · 右内容，需终端 ≥ 100 列，不足自动回退）或经典（单栏列表 + 全屏预览）；默认分栏',
        ),
        kind: 'select',
        options: [
          { value: 'split', label: 'Split panes', descriptions: zh('分栏（左列表 · 右内容）') },
          { value: 'classic', label: 'Classic', descriptions: zh('经典（单栏列表 + 全屏预览）') },
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
        path: ['pinyin'],
        label: 'Pinyin matching',
        descriptions: zh('拼音搜索'),
        hint: 'Letter-only terms also match Chinese via pinyin (full readings + initials; default on)',
        hintDescriptions: zh('纯字母词同时按拼音匹配汉字（全拼 + 首字母；默认开启）'),
        kind: 'boolean',
      },
      {
        path: ['titleOnly'],
        label: 'Title-only search',
        descriptions: zh('仅搜索标题'),
        hint: 'Match session titles only — messages are not searched (Alt+N toggles it live; default off)',
        hintDescriptions: zh('只匹配会话标题——消息正文不参与搜索（场景内 Alt+N 实时切换；默认关闭）'),
        kind: 'boolean',
      },
      {
        path: ['indexTools'],
        label: 'Index tool calls',
        descriptions: zh('索引工具调用'),
        hint: 'Index tool-call summaries ([name] arguments) for search (default off)',
        hintDescriptions: zh('把工具调用摘要（[名称] 参数）纳入搜索索引（默认关闭）'),
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
        path: ['warmup'],
        label: 'Background warm-up index',
        descriptions: zh('后台预热索引'),
        hint: 'Index sessions in the background after startup so /find opens instantly (default on)',
        hintDescriptions: zh('启动后在后台预建会话索引，让 /find 秒开（默认开启）'),
        kind: 'boolean',
      },
      {
        path: ['shortcut'],
        label: 'Global shortcut',
        descriptions: zh('全局快捷键'),
        hint: 'Combo that opens /find from anywhere (needs ctrl or alt; "off" disables; default alt+f)',
        hintDescriptions: zh('打开 /find 的全局组合键（需含 ctrl 或 alt；off 关闭全局入口；默认 alt+f）'),
        kind: 'text',
        placeholder: DEFAULT_SHORTCUT,
      },
    ],
  }
}

/**
 * Register the settings card and wire it to the host's settings service.
 * The value source depends on which generation the host ships (see the module
 * doc); every failure stays contained — the card, the row config and `/find`
 * itself keep working.
 */
export function registerSettingsSection(ctx: Context, wiring: SettingsWiring): void {
  registerCard(ctx)

  const apply = (value: ConfigValue): void => {
    wiring.onResolved(resolveConfig(value), value)
  }

  // Namespace wiring is best-effort: without it the card renders unavailable
  // instead of editable, which is the documented degradation.
  ctx.inject?.(['settings'], (settingsCtx: Context) => {
    const settings = (settingsCtx as unknown as Record<string, unknown>)['settings'] as
      | SettingsService
      | undefined
    if (settings === undefined) return

    if (typeof settings.register === 'function') {
      registerNamespaceScope(settingsCtx, settings, wiring, apply)
      return
    }
    if (typeof settings.configure !== 'function') {
      ctx.logger.info(
        'dsh-tui-find: the settings service exposes neither the namespace registration nor the Config-derived surface; the card stays unavailable this session',
      )
      return
    }
    configureOwnPage(ctx, settingsCtx, settings)
    // Initial value: the row config already carries the host-resolved layers
    // (defaults → composition base → profile patch), so an unchanged session
    // needs nothing else.
    apply(wiring.readRaw() ?? {})
    watchLiveConfig(ctx, () => apply(wiring.readRaw() ?? {}))
  })
}

/** The card itself: one registration, retried across the boot-liveness window. */
function registerCard(ctx: Context): void {
  const sectionsRuntime = ctx.get('tuiSettingsSections', false)
  const register = (cardRuntime: NonNullable<typeof sectionsRuntime>): void => {
    try {
      const dispose = cardRuntime.register(section())
      ctx.effect(() => dispose)
    } catch (error) {
      // A boot-window liveness rejection must retry, not degrade: a plain warn
      // would silently drop the settings card for the whole session (see
      // seam.ts for the mechanism). Permanent failures (e.g. a duplicate ns)
      // burn the bounded budget and warn once — acceptable for a card.
      registerSeamWithRetry(
        ctx,
        'settings section',
        () => cardRuntime.register(section()),
        dispose => ctx.effect(() => dispose),
        error,
      )
    }
  }
  whenSeamMounted(ctx, 'settings sections', () => ctx.get('tuiSettingsSections', false), register)
}

/**
 * ≤0.1.6 generation: own the namespace and follow its scope.
 *
 * The schema spells out the same bounds the row-config schema enforces
 * (config.ts) — the namespace must not accept values the row config would
 * reject — and its defaults come from the apply-time resolved config so an
 * untouched namespace resolves to what the plugin is running with.
 */
function registerNamespaceScope(
  settingsCtx: Context,
  settings: SettingsService,
  wiring: SettingsWiring,
  apply: (value: ConfigValue) => void,
): void {
  const resolved = wiring.resolved
  try {
    const schema = z.object({
      defaultScope: z.union(['repo', 'all']).default(resolved.defaultScope),
      defaultTime: z.union(['all', '7d', '30d']).default(resolved.defaultTime),
      layout: z.union(['split', 'classic']).default(resolved.layout),
      caseSensitive: z.boolean().default(resolved.caseSensitive),
      regex: z.boolean().default(resolved.regex),
      pinyin: z.boolean().default(resolved.pinyin),
      titleOnly: z.boolean().default(resolved.titleOnly),
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
      warmup: z.boolean().default(resolved.warmup),
      // 'off' (the disabled state of resolved.shortcut) is the namespace
      // default; combo validation stays with the shortcut registry at
      // apply time — the namespace only carries the string.
      shortcut: z.string().default(resolved.shortcut ?? 'off'),
    })
    // Namespace brands are type-only; alpha.2 validates the raw string in
    // register() itself, and the constant satisfies the older provider too.
    const scope = settings.register?.(SETTINGS_NS, schema) as SettingsScope<ConfigValue>
    apply(scope.get())
    const unwatch = scope.watch(next => {
      apply(next)
    })
    settingsCtx.effect(() => unwatch)
  } catch (error) {
    // Contained, but never silent: swallowing the provider's error is what
    // made the ≥0.1.7 transition surface as a bare `命名空间未注册` badge with
    // no line in the log to explain it.
    settingsCtx.logger.warn(
      `dsh-tui-find: settings namespace registration failed (${error instanceof Error ? error.message : String(error)}); the card stays unavailable and the row config keeps working`,
    )
  }
}

/**
 * ≥0.1.7 generation: the namespace is this profile entry and its form schema
 * is `Config` filtered to the `.volatile()` fields, so there is nothing to
 * register. The card is the plugin's own page, so opt out of the
 * auto-generated one; the policy must be attached to the plugin's own fiber
 * (the entry that owns the Config), not to the injected child.
 */
function configureOwnPage(ctx: Context, settingsCtx: Context, settings: SettingsService): void {
  try {
    const dispose = settings.configure?.({ auto: false }, ctx.fiber)
    if (typeof dispose === 'function') {
      const stop = dispose as () => void
      settingsCtx.effect(() => stop)
    }
  } catch (error) {
    // Decorative: the card renders and saves either way; a future
    // auto-generated page would merely duplicate it.
    settingsCtx.logger.info(
      `dsh-tui-find: settings page policy not applied (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/**
 * Follow the loader's live-config announcements.
 *
 * Registered on the plugin's own context: the loader emits
 * `loader/volatile-update` on the Config-owning fiber, which is the same
 * reason the host's compat shim passes the Config owner rather than the
 * injected child. Without the event the initial read stands for the session —
 * logged, because that means `/settings` edits would not reach the running
 * scene until the plugin reloads.
 */
function watchLiveConfig(ctx: Context, refresh: () => void): void {
  const events = ctx as unknown as { on?: (event: string, listener: () => void) => unknown }
  let dispose: unknown
  try {
    dispose = events.on?.('loader/volatile-update', refresh)
  } catch {
    dispose = undefined
  }
  if (typeof dispose !== 'function') {
    ctx.logger.info(
      'dsh-tui-find: loader/volatile-update is unavailable; /settings edits apply at the next plugin reload',
    )
    return
  }
  ctx.effect(() => dispose as () => void)
}

/** Schema output is validated by the host, but this boundary is optional and
 *  must still tolerate an older provider returning a partial object — and, on
 *  the ≥0.1.7 generation, the live Config's refs (resolved by `resolveConfig`,
 *  which unwraps them). */
type ConfigValue = {
  defaultScope?: 'repo' | 'all'
  defaultTime?: 'all' | '7d' | '30d'
  layout?: 'split' | 'classic'
  caseSensitive?: boolean
  regex?: boolean
  pinyin?: boolean
  titleOnly?: boolean
  indexTools?: boolean
  indexThinking?: boolean
  sessionRoot?: string
  maxMessageChars?: number
  warmup?: boolean
  shortcut?: string
}
