/**
 * Plugin row config (cordis.patch.yml / `dsh plugin add`), following the
 * working-activity pattern: an exported schemastery schema validates the row
 * config, `apply(ctx, config)` receives the resolved value with schema
 * defaults applied, and every key is optional with a sane default.
 *
 * Two host generations read this schema differently, and both must keep
 * working (docs/decisions/2026-09-24-settings-generation-adaptation.md):
 *
 * - `dsh-settings` ≤0.1.6 (dsh-TUI 0.9.x/0.10.x): the `/settings` namespace is
 *   registered by the plugin and its form values come from that registration
 *   schema (settings.ts). The row config is a frozen value.
 * - `dsh-settings` ≥0.1.7 (dsh-TUI 0.11+): there is no registration API — the
 *   namespace is the profile entry id (`dsh-tui-find`) and the form schema is
 *   *this* schema projected onto the fields marked `.volatile()`. Those fields
 *   then reach `apply` as live refs whose value changes in place, so every
 *   read goes through `readConfigValues` before validation.
 *
 * `.volatile()` landed in schemastery 3.18.3 while the 0.9.x baseline ships
 * 3.18.1, hence the capability probe in `liveField` — never a version parse.
 *
 * @module dsh-tui-find/config
 */
import z from '@deepseek-ai/schemastery'

/** Default global-entry combo. Deliberately NOT Ctrl+Shift+F: mainstream
 *  terminal emulators (Windows Terminal, VS Code, GNOME Terminal, …) bind
 *  that chord locally for their own find UI and never forward the keypress,
 *  so the TUI would never see it. Alt+F keeps the F-for-find muscle memory
 *  without the Ctrl+Alt+F conflict with QQ's global shortcut. */
export const DEFAULT_SHORTCUT = 'alt+f'

/** Modifier tokens that satisfy the host grammar's hard rule (a combo must
 *  carry ctrl or alt; aliases mirror keymap.ts's parser). */
const META_MODIFIERS = new Set(['ctrl', 'control', 'alt', 'meta', 'option'])
const NAMED_SHORTCUT_KEYS = new Set([
  'enter',
  'return',
  'esc',
  'escape',
  'tab',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
])

/** Structural sanity check matching the host combo grammar: modifiers are
 *  unique, the key is one code point or one of the host's named keys, and a
 *  combo carries ctrl or alt. Reserved combos remain the registry's concern. */
export function isPlausibleShortcut(combo: string): boolean {
  const parts = combo
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length < 2) return false
  const modifiers = parts.slice(0, -1)
  const key = parts[parts.length - 1]!
  const seen = new Set<string>()
  for (const modifier of modifiers) {
    const canonical = modifier === 'control' ? 'ctrl' : modifier === 'meta' || modifier === 'option' ? 'alt' : modifier
    if (canonical !== 'shift' && canonical !== 'ctrl' && canonical !== 'alt') return false
    if (seen.has(canonical)) return false
    seen.add(canonical)
  }
  if (!seen.has('ctrl') && !seen.has('alt')) return false
  if ([...key].length !== 1 && !NAMED_SHORTCUT_KEYS.has(key)) return false
  if (key === 'escape') return false
  return true
}

/** Result of normalizing the user-facing `shortcut` value. */
export interface ShortcutResolution {
  /** The combo to register, or undefined when the global entry is off. */
  readonly combo: string | undefined
  /** True when the user's own value was unusable and the default was
   *  substituted — apply() turns this into a warning so a typo never
   *  silently drops the global entry. */
  readonly invalid: boolean
}

/** Normalize the `shortcut` config value: blank → default, `off` (also
 *  `none`/`disabled`) → disabled, anything else lowercased and structurally
 *  checked (implausible → default, flagged via `invalid`). */
export function resolveShortcut(raw: string | undefined): ShortcutResolution {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (text === '') return { combo: DEFAULT_SHORTCUT, invalid: false }
  if (text === 'off' || text === 'none' || text === 'disabled') return { combo: undefined, invalid: false }
  return isPlausibleShortcut(text) ? { combo: text, invalid: false } : { combo: DEFAULT_SHORTCUT, invalid: true }
}

/** Configurable knobs; every key has a sane default. */
export type Config = {
  /** Initial search scope: `repo` (default) or `all`. */
  defaultScope?: 'repo' | 'all'
  /** Initial time window when /find opens: `all` (default), `7d` or `30d`.
   *  Alt+T still cycles it live in the scene. */
  defaultTime?: 'all' | '7d' | '30d'
  /** The /find scene's layout form. `split` (default) shows the list and a
   *  conversation reader side by side when the terminal is at least 100
   *  columns wide (narrower terminals fall back to the classic rendering
   *  automatically); `classic` always renders the single-column list with
   *  the full-screen Alt+P preview. */
  layout?: 'split' | 'classic'
  /** Case-sensitive matching. Default OFF (spec §6 freeze). */
  caseSensitive?: boolean
  /** Treat queries as JavaScript regular expressions by default. Default
   *  OFF (substring stays the baseline; Alt+R toggles it live in the scene). */
  regex?: boolean
  /** Match letter-only query terms against Chinese characters through
   *  their pinyin (full toneless syllables and initials). Default ON. */
  pinyin?: boolean
  /** Restrict matching to session titles (messages are not searched).
   *  Alt+N toggles it live in the scene. Default OFF. */
  titleOnly?: boolean
  /** Index tool-call summaries (`[name] arguments`). Default OFF. */
  indexTools?: boolean
  /** Index assistant thinking text. Default OFF (noisy + private). */
  indexThinking?: boolean
  /** Manual session-root override, prepended to the resolution chain. */
  sessionRoot?: string
  /** Per-message index budget in characters. Default 4000. */
  maxMessageChars?: number
  /** Background warm-up index: one delayed sweep after startup (on the same
   *  scanner the scene uses) so the first /find open pays per-file stats
   *  instead of a cold decode. Default ON. */
  warmup?: boolean
  /** UI language: `auto` (default) follows the host language contract. */
  lang?: 'auto' | 'zh' | 'en'
  /** Global-entry combo for the search scene; must carry ctrl or alt
   *  (e.g. `alt+f`). `off` disables the global entry (the `/find`
   *  command keeps working). Default `alt+f` — Ctrl+Shift+F is
   *  swallowed by mainstream terminals' own find UI before dsh-TUI can
   *  see it. */
  shortcut?: string
}

/**
 * Keys the `/settings` card owns, and therefore the keys the host may edit
 * live. On `dsh-settings` ≥0.1.7 these are exactly the fields the plugin's
 * form projects, so the card's field paths, this list and the marked fields
 * must stay equal — a card field outside the list would render editable yet
 * never be served (the failure mode the host's own status-bar `cost` field
 * shows: `（未设置）` forever), and a marked key without a field would be
 * live-editable with no UI. test/settings.test.ts pins both directions.
 */
export const LIVE_CONFIG_KEYS = [
  'defaultScope',
  'defaultTime',
  'layout',
  'caseSensitive',
  'regex',
  'pinyin',
  'titleOnly',
  'indexTools',
  'indexThinking',
  'sessionRoot',
  'maxMessageChars',
  'warmup',
  'shortcut',
] as const

function isLiveConfigKey(key: string): boolean {
  return (LIVE_CONFIG_KEYS as readonly string[]).includes(key)
}

/**
 * Mark one schema field live-editable when the host's schemastery supports it.
 *
 * Capability-probed, never version-parsed: `.volatile()` landed in
 * schemastery 3.18.3 while the 0.9.x/0.10.x host baseline ships 3.18.1, where
 * the method is simply absent — the legacy namespace registration covers that
 * generation instead (settings.ts). Calling it twice throws, so the marker is
 * applied exactly once, from the single `LIVE_CONFIG_KEYS` list.
 *
 * Exported for the capability test: the repo's own schemastery is the 3.18.1
 * baseline, so the marked branch can only be exercised with a stand-in field.
 */
export function liveField<T>(field: T): T {
  const candidate = field as T & { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : field
}

/**
 * Read a row config down to plain values.
 *
 * On `dsh-settings` ≥0.1.7 (schemastery ≥3.18.3) the loader hands every
 * `.volatile()` field to `apply` as a live ref — a frozen `{ get() }` whose
 * value the loader rewrites in place — so reading the config object again
 * after `loader/volatile-update` yields the edited values (settings.ts rides
 * exactly that). Structural, not an import: the refs are cosmokit's Volatile
 * protocol and cosmokit is not a dependency of this plugin. The row config is
 * flat, so one unwrap level per key is enough; a nested knob would need a
 * recursive walk here.
 */
export function readConfigValues(config: Config | undefined): Config {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config ?? {})) plain[key] = readRef(value)
  return plain as Config
}

/** Unwrap one live config ref (a `{ get }`-only object), if that is what it is. */
function readRef(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'get') return value
  const ref = value as { get?: unknown }
  return typeof ref.get === 'function' ? readRef((ref.get as () => unknown)()) : value
}

/** The row-config fields, in declaration order. Live marking is applied
 *  afterwards from {@link LIVE_CONFIG_KEYS} so the card's editable set and the
 *  marked set cannot drift apart (test/settings.test.ts pins the equality). */
const configFields = {
  defaultScope: z.union(['repo', 'all']).default('repo'),
  defaultTime: z.union(['all', '7d', '30d']).default('all'),
  layout: z.union(['split', 'classic']).default('split'),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  pinyin: z.boolean().default(true),
  titleOnly: z.boolean().default(false),
  indexTools: z.boolean().default(false),
  indexThinking: z.boolean().default(false),
  sessionRoot: z.string().required(false),
  maxMessageChars: z.number().step(100).min(200).max(65536).default(4000),
  warmup: z.boolean().default(true),
  // Deliberately NOT live: `lang` is pinned by DSH_TUI_LANG and has no
  // /settings field, so it stays an ordinary row-config knob.
  lang: z.union(['auto', 'zh', 'en']).default('auto'),
  shortcut: z.string().default(DEFAULT_SHORTCUT),
}

export const Config: Schemastery<Config> = z.object(
  Object.fromEntries(
    Object.entries(configFields).map(([key, field]) => [
      key,
      isLiveConfigKey(key) ? liveField(field) : field,
    ]),
  ) as unknown as typeof configFields,
)

/** Resolved, validated config used at runtime. */
export interface ResolvedConfig {
  readonly defaultScope: 'repo' | 'all'
  readonly defaultTime: 'all' | '7d' | '30d'
  readonly layout: 'split' | 'classic'
  readonly caseSensitive: boolean
  readonly regex: boolean
  readonly pinyin: boolean
  readonly titleOnly: boolean
  readonly indexTools: boolean
  readonly indexThinking: boolean
  readonly sessionRoot: string | undefined
  readonly maxMessageChars: number
  readonly warmup: boolean
  readonly lang: 'auto' | 'zh' | 'en'
  /** Normalized global-entry combo; undefined = disabled (`off`). */
  readonly shortcut: string | undefined
}

/** Defensive resolution over a possibly-partial config (tests, drift). Live
 *  refs are unwrapped first, so a ≥0.1.7 apply-time config (volatile refs) and
 *  a frozen row config both resolve to the same value. */
export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  const value = readConfigValues(raw)
  return {
    defaultScope: value.defaultScope === 'all' ? 'all' : 'repo',
    defaultTime:
      value.defaultTime === '7d' || value.defaultTime === '30d' ? value.defaultTime : 'all',
    // Defensive: any unknown value lands on the split default (the schema
    // validates real rows; this layer also feeds tests and drift).
    layout: value.layout === 'classic' ? 'classic' : 'split',
    caseSensitive: value.caseSensitive === true,
    regex: value.regex === true,
    pinyin: value.pinyin !== false,
    titleOnly: value.titleOnly === true,
    indexTools: value.indexTools === true,
    indexThinking: value.indexThinking === true,
    sessionRoot:
      typeof value.sessionRoot === 'string' && value.sessionRoot.trim().length > 0
        ? value.sessionRoot.trim()
        : undefined,
    maxMessageChars:
      typeof value.maxMessageChars === 'number' && Number.isFinite(value.maxMessageChars)
        ? Math.min(Math.max(Math.trunc(value.maxMessageChars), 200), 65536)
        : 4000,
    warmup: value.warmup !== false,
    lang: value.lang === 'zh' || value.lang === 'en' ? value.lang : 'auto',
    shortcut: resolveShortcut(value.shortcut).combo,
  }
}
