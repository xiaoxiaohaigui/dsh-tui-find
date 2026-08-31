/**
 * Plugin row config (cordis.patch.yml / `dsh plugin add`), following the
 * working-activity pattern: an exported schemastery schema validates the row
 * config, `apply(ctx, config)` receives the resolved value with schema
 * defaults applied, and every key is optional with a sane default.
 *
 * @module dsh-tui-find/config
 */
import z from '@deepseek-ai/schemastery'

/** Default global-entry combo. Deliberately NOT Ctrl+Shift+F: mainstream
 *  terminal emulators (Windows Terminal, VS Code, GNOME Terminal, …) bind
 *  that chord locally for their own find UI and never forward the keypress,
 *  so the TUI would never see it. Ctrl+Alt+F clears every common terminal
 *  default and every host-reserved combo while keeping the F-for-find
 *  muscle memory. */
export const DEFAULT_SHORTCUT = 'ctrl+alt+f'

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
  /** Case-sensitive matching. Default OFF (spec §6 freeze). */
  caseSensitive?: boolean
  /** Treat queries as JavaScript regular expressions by default. Default
   *  OFF (substring stays the baseline; Alt+R toggles it live in the scene). */
  regex?: boolean
  /** Index tool-call summaries (`[name] arguments`). Default ON. */
  indexTools?: boolean
  /** Index assistant thinking text. Default OFF (noisy + private). */
  indexThinking?: boolean
  /** Manual session-root override, prepended to the resolution chain. */
  sessionRoot?: string
  /** Per-message index budget in characters. Default 4000. */
  maxMessageChars?: number
  /** UI language: `auto` (default) follows the host language contract. */
  lang?: 'auto' | 'zh' | 'en'
  /** Global-entry combo for the search scene; must carry ctrl or alt
   *  (e.g. `ctrl+alt+f`). `off` disables the global entry (the `/find`
   *  command keeps working). Default `ctrl+alt+f` — Ctrl+Shift+F is
   *  swallowed by mainstream terminals' own find UI before dsh-TUI can
   *  see it. */
  shortcut?: string
}

export const Config: Schemastery<Config> = z.object({
  defaultScope: z.union(['repo', 'all']).default('repo'),
  defaultTime: z.union(['all', '7d', '30d']).default('all'),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  indexTools: z.boolean().default(true),
  indexThinking: z.boolean().default(false),
  sessionRoot: z.string().required(false),
  maxMessageChars: z.number().step(100).min(200).max(65536).default(4000),
  lang: z.union(['auto', 'zh', 'en']).default('auto'),
  shortcut: z.string().default(DEFAULT_SHORTCUT),
})

/** Resolved, validated config used at runtime. */
export interface ResolvedConfig {
  readonly defaultScope: 'repo' | 'all'
  readonly defaultTime: 'all' | '7d' | '30d'
  readonly caseSensitive: boolean
  readonly regex: boolean
  readonly indexTools: boolean
  readonly indexThinking: boolean
  readonly sessionRoot: string | undefined
  readonly maxMessageChars: number
  readonly lang: 'auto' | 'zh' | 'en'
  /** Normalized global-entry combo; undefined = disabled (`off`). */
  readonly shortcut: string | undefined
}

/** Defensive resolution over a possibly-partial config (tests, drift). */
export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  const value = raw ?? {}
  return {
    defaultScope: value.defaultScope === 'all' ? 'all' : 'repo',
    defaultTime:
      value.defaultTime === '7d' || value.defaultTime === '30d' ? value.defaultTime : 'all',
    caseSensitive: value.caseSensitive === true,
    regex: value.regex === true,
    indexTools: value.indexTools !== false,
    indexThinking: value.indexThinking === true,
    sessionRoot:
      typeof value.sessionRoot === 'string' && value.sessionRoot.trim().length > 0
        ? value.sessionRoot.trim()
        : undefined,
    maxMessageChars:
      typeof value.maxMessageChars === 'number' && Number.isFinite(value.maxMessageChars)
        ? Math.min(Math.max(Math.trunc(value.maxMessageChars), 200), 65536)
        : 4000,
    lang: value.lang === 'zh' || value.lang === 'en' ? value.lang : 'auto',
    shortcut: resolveShortcut(value.shortcut).combo,
  }
}
