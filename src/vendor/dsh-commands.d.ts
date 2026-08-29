/**
 * Vendored type surface of `@deepseek-ai/dsh-commands` (v0.1.1-rc.2), exact
 * to its published `lib/types` declarations.
 *
 * Why vendored: the package's dependency graph does not resolve through npm
 * outside the harness monorepo, and the plugin only consumes its TYPES —
 * the runtime `commands` service is mounted by the host, and registrations
 * go through `ctx.tuiPluginHost.registerCommand`, which takes the definition
 * structurally. If the real package becomes installable, this file can be
 * deleted in favor of a devDependency.
 */

declare module '@deepseek-ai/dsh-commands' {
  /** Branded command id (string at runtime). */
  export type CommandId = string & { readonly __brand: 'CommandId' }

  /** Placeholder shown before the user supplies free-form input. */
  export interface CommandInputDescriptor {
    readonly hint: string
    readonly images?: boolean
  }

  /** Expected command outcome rendered directly by the dispatching UI. */
  export type CommandResult =
    | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: 'error'; readonly text: string }

  /** Invocation passed to one registered command handler. */
  export interface CommandInvocation {
    /** Pairing id already written to this invocation's `command/run` event. */
    readonly commandId: CommandId
    /** Exact agent whose UI received the command. */
    readonly agent: unknown
    /** Exact text following the registered command name, including separator whitespace. */
    readonly rawInput: string
    /** Durably admitted image blocks; empty unless the definition declares `input.images`. */
    readonly attachments: readonly unknown[]
    /** Cancellation signal owned by the dispatching UI request. */
    readonly signal: AbortSignal
  }

  /** Plugin-owned command registration. */
  export interface CommandDefinition {
    /** Lowercase command name without the leading slash. */
    readonly name: string
    /** Human-readable summary used in discovery UI. */
    readonly description: string
    /** Optional free-form input hint advertised to capable clients. */
    readonly input?: CommandInputDescriptor
    /**
     * Whether `command/run` records `rawInput`. Defaults to true. A command
     * whose domain event owns the payload sets this false to avoid
     * duplicating that payload in the session log — which is exactly this
     * plugin's case: opening the scene is UI state, not conversation content.
     */
    readonly recordInput?: boolean
    /** Execute against the receiving agent without sending the command to the model. */
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }
}
