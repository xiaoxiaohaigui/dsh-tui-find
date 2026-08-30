/**
 * Plugin row config (cordis.patch.yml / `dsh plugin add`), following the
 * working-activity pattern: an exported schemastery schema validates the row
 * config, `apply(ctx, config)` receives the resolved value with schema
 * defaults applied, and every key is optional with a sane default.
 *
 * @module dsh-tui-find/config
 */
import z from '@deepseek-ai/schemastery'

/** Configurable knobs; every key has a sane default. */
export type Config = {
  /** Initial search scope: `repo` (default) or `all`. */
  defaultScope?: 'repo' | 'all'
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
}

export const Config: Schemastery<Config> = z.object({
  defaultScope: z.union(['repo', 'all']).default('repo'),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  indexTools: z.boolean().default(true),
  indexThinking: z.boolean().default(false),
  sessionRoot: z.string().required(false),
  maxMessageChars: z.number().step(100).min(200).max(65536).default(4000),
  lang: z.union(['auto', 'zh', 'en']).default('auto'),
})

/** Resolved, validated config used at runtime. */
export interface ResolvedConfig {
  readonly defaultScope: 'repo' | 'all'
  readonly caseSensitive: boolean
  readonly regex: boolean
  readonly indexTools: boolean
  readonly indexThinking: boolean
  readonly sessionRoot: string | undefined
  readonly maxMessageChars: number
  readonly lang: 'auto' | 'zh' | 'en'
}

/** Defensive resolution over a possibly-partial config (tests, drift). */
export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  const value = raw ?? {}
  return {
    defaultScope: value.defaultScope === 'all' ? 'all' : 'repo',
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
  }
}
