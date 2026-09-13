/**
 * The host's slash-command suggestion metadata seam (`tuiCommandTrees`),
 * merged into the `/` suggestion overlay by the host's own channel: the
 * ROOT row's localized description comes from the provider's `descriptions`
 * (the overlay's `localizedDescription` picks `descriptions[getLang()]`
 * live, before the `cmd-desc-<name>` dict fallback — external commands have
 * no dict entry, so without a provider the zh UI falls back to the English
 * `CommandDefinition.description`), and any token typed after the root name
 * resolves through the merged providers' `children`.
 *
 * This is NOT a 0.10-only seam: 0.9.3 and 0.10.1 declare the same service
 * (both compositions mount the `dsh-tui-command-trees` row) and merge
 * providers identically — the task file's batch-3 premise said otherwise
 * and was corrected while implementing. The dual-version strategy still
 * governs the call shape: soft-probe `ctx.get(..., false)` and no-op on a
 * composition without the service row; never inject.
 *
 * @module dsh-tui-find/command-tree
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TuiCommandTreeProvider } from '@deepseek-harness-tui/dsh-tui/command-trees'
import { registerSeamWithRetry, whenSeamMounted } from './seam.js'

/** Registration options, named after the seam's own shape: the root row this
 *  provider describes plus its zh/en descriptions. The descriptions are
 *  explicit here rather than derived from the root inside this module — this
 *  file owns no copy, so a future second root must bring its own pair (and a
 *  forgotten one fails at compile time instead of showing /find's metadata). */
export interface CommandTreeOptions {
  readonly root: string
  readonly descriptions: NonNullable<TuiCommandTreeProvider['descriptions']>
}

/** Build the provider for one registration attempt. Fresh object per call:
 *  the host normalizes and stores the instance it receives, and the retry
 *  path re-invokes `register` after a failed attempt must not reuse state
 *  the host may have kept from the rejected one. */
function provider(options: CommandTreeOptions): TuiCommandTreeProvider {
  return {
    root: options.root,
    // Both languages up front: the HOST picks `descriptions[getLang()]` at
    // render time, so a mid-session /lang switch follows without us
    // re-registering anything (the same contract the settings card uses).
    descriptions: options.descriptions,
    // /find's argument is a free-text query, not a subcommand path — an
    // empty tree keeps the overlay's current behavior for `/find <token>`
    // input (a fabricated child would complete into a nonsense query).
    // The provider exists for the root row's localized description.
    children: () => [],
  }
}

/**
 * Register a command-tree provider; no-ops when the composition
 * has no `tuiCommandTrees` row. Same guarded posture as every other seam:
 * a boot-window liveness rejection retries (see seam.ts), and a permanent
 * failure (e.g. a foreign provider already owns the root) burns the bounded
 * budget and warns once — suggestion metadata never fails the activation.
 *
 * @param ctx - the plugin activation context.
 * @param options - the seam shape; see {@link CommandTreeOptions}. `root` is
 *   the command name without the slash and must match the command registry
 *   entry the provider describes; `descriptions` is the root row's zh/en
 *   pair (for /find: `dict['cmd-desc-find']`, the same entry the
 *   CommandDefinition's fallback description comes from).
 */
export function registerCommandTree(ctx: Context, options: CommandTreeOptions): void {
  const runtime = ctx.get('tuiCommandTrees', false)
  const registerOn = (treeRuntime: NonNullable<typeof runtime>): void => {
    try {
      const dispose = treeRuntime.register(provider(options))
      ctx.effect(() => dispose)
    } catch (error) {
      registerSeamWithRetry(
        ctx,
        'command tree',
        () => treeRuntime.register(provider(options)),
        dispose => ctx.effect(() => dispose),
        error,
      )
    }
  }
  whenSeamMounted(ctx, 'command trees', () => ctx.get('tuiCommandTrees', false), registerOn)
}
